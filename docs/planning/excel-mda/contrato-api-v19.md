# Contrato API V19 — decisiones explícitas por grupo

Fecha:2026-10-05. Implementado en backend. Requiere migración0024, aditiva y todavía no instalada en la base operativa. No hay carga real ni piloto de aplicación de grupos. V18 sigue read-only y mantiene su huella/respuesta.

## Rutas y permisos

Prefijo: `/inventory/imports/batches/:id/identity-group-reviews/:reviewId`.

- POST `/decisions`: JEFE autenticado + CSRF;201 decisión nueva,200 recuperación de un reintento idéntico.
- GET `/decisions`: JEFE; listado paginado latest/history.
- GET `/decisions/:decisionId`: JEFE; comprobante individual con la proyección completa que fue revisada. No admite query adicional.

Lote/revisión/decisión se verifican juntos: otro lote no obtiene comprobantes ajenos. UUID aceptados en mayúsculas/minúsculas; requestId y linkedAssetId se normalizan a minúsculas. GET no requiere CSRF y no escribe.

## Guardar una decisión

```text
{
  requestId: UUID,
  confirmation: "RECORD_IDENTITY_GROUP_DECISION_ONLY",
  expectedDecisionVersion: integer >= 0,
  expectedBatchVersion: integer >= 1,
  expectedSourceRevision: integer 0..1000,
  projectionId: SHA256 actual de V18,
  groupKey: SHA256 estable de un grupo de esa revisión,
  action: "HOLD" | "EXCLUDE" | "LINK_EXISTING" | "PROPOSE_NEW",
  linkedAssetId?: UUID, // requerido exclusivamente para LINK_EXISTING
  note: texto no vacío <=2000,
  evidenceReference: texto no vacío <=500,
  evidenceReviews: [{
    evidenceId: UUID,
    expectedEvidenceVersion: integer 0..1000,
    disposition: "CONFIRM_GROUP_MEMBERSHIP" | "EXCLUDE_FROM_GROUP_PILOT",
    note: texto no vacío <=2000,
    evidenceReference: texto no vacío <=500
  }] // explícito, máximo100, sin duplicados
}
```

DTO estricto: no recibe projection/snapshots aportados por frontend, force, atributos operativos ni IDs simulados. No permite escribir una decisión de grupo en las rutas antiguas V4.

expectedDecisionVersion pertenece al historial **de la revisión V17 completa**, no al grupo ni al lote. Empieza en0 y cada decisión nueva aumenta1, incluso si se decide otro grupo. GET devuelve decisionVersion actual. No incrementa ImportBatch.version ni sourceRevision; las decisiones antiguas conservan su historial/versionado independiente.

El servidor recalcula V18 bajo locks antes de guardar. expectedBatchVersion, expectedSourceRevision y projectionId deben coincidir exactamente. Cambios de inventario/contexto/día/evidencia invalidan una huella anterior; no sustituye silenciosamente la vista que el usuario revisó.

## Semántica de acciones

- HOLD: grupo pendiente. EXCLUDE: excluye su propuesta del futuro piloto, sin liberar filas ni borrar origen.
- PROPOSE_NEW: propuesta administrativa independiente; requiere vista sin bloqueantes y ausencia total de coincidencias operativas.
- LINK_EXISTING: propuesta administrativa a la única coincidencia actual del grupo; no acepta un activo arbitrario, ambiguo ni una lista truncada. Otro grupo de la misma revisión no puede proponer simultáneamente ese activo; primero hay que revisar su decisión anterior.

HOLD/EXCLUDE pueden registrar el diagnóstico de una vista bloqueada, pero siempre requieren su huella/versiones actuales. LINK_EXISTING/PROPOSE_NEW exigen una vista completa sin bloqueantes. No hay producto, estado inicial, fecha de baja ni destinatario aprobados implícitamente; corresponden a reglas/plan de piloto propios.

Una nueva decisión sobre el mismo groupKey sustituye su intención **solo en la consulta latest**, conservando todos los eventos previos en history. Una revisión nueva obtiene groupKeys nuevos y no hereda decisiones. Una decisión original del candidato V4 sigue siendo antecedente, nunca autorización automática del grupo.

## Revisión de evidencias

Para LINK_EXISTING/PROPOSE_NEW, evidenceReviews debe cubrir exactamente **todos** los items archivados actuales de ese grupo, con su versión vigente. Si no existen items, se envía[]. No agrega evidencia de otro grupo/revisión/fuente ni duplica items. HOLD/EXCLUDE pueden enviar[] para dejarlos pendientes; si envían revisiones, también deben cubrir el conjunto completo.

CONFIRM_GROUP_MEMBERSHIP respalda administrativamente la pertenencia de esa observación al grupo, con documento y motivo explícitos. EXCLUDE_FROM_GROUP_PILOT mantiene la evidencia archivada fuera de la futura propuesta de historia del grupo. No excluye el registro del Excel ni cambia una asignación/baja pasada.

Ambas disposiciones son decisiones guardadas, **no** enmiendas V12 ni aplicaciones V11/V14: no reescriben ImportHistoricalEvidence, assetId, captura, fechas, actores o usos. La proyección guardada conserva capturedAssetId y currentAssetId, incluso null explícito. linkedToGroup de V18 sigue false; la interpretación decidida está en evidenceReviews. Evidencia consumida no admite nueva autoridad de agrupación. Una enmienda/captura posterior exige nueva revisión de la proyección actual.

## Comprobantes, vigencia e historial

POST responde:

```text
{
  scope: "IDENTITY_GROUP_DECISION_ONLY", persisted: true,
  canApply: false, affectsCurrentState: false,
  groupedPilotImplemented: false, evidenceRelinked: false,
  reused, decisionVersion,
  decision: {
    id, reviewId, version, requestId, requestDigest, rulesVersion,
    groupId, groupKey, batchVersion, sourceRevision, projectionId,
    projection, action, linkedAssetId, note, evidenceReference,
    evidenceReviews, reviewedById, createdAt
  }
}
```

rulesVersion=`mda-identity-group-decision-1`. projection es la vista V18 calculada por backend en el momento de guardar, no una consulta actual. Comprobante/proyección/motivo/autor son inmutables.

GET listado acepta únicamente limit1..100(default25), offset>=0(default0), mode latest|history(defaultlatest), groupKey opcional. Orden por version descendente; total/hasMore reales. Incluye scope/flags anteriores, decisionVersion, reviewActive, currentProjectionId y decisions (sin projection completa), mode/total/limit/offset/hasMore. Cada decisión añade projectionCurrent.

GET individual incluye decision completa, decisionVersion, reviewActive, currentProjectionId y projectionCurrent a nivel de respuesta.

**projectionCurrent solo compara la huella guardada con la vista actual y exige revisión activa**. No significa que una decisión histórica sea la última del grupo ni que se pueda aplicar; para la intención vigente usar mode=latest. Todas las respuestas conservan canApply=false. Tampoco un listado completo equivale a validación/aplicación de un piloto.

Tras cancelar V17, historial/comprobantes permanecen consultables, reviewActive=false/currentProjectionId=null/projectionCurrent=false. No se aceptan decisiones nuevas; un reintento idéntico recupera su comprobante original sin reactivar autoridad ni reservas. Cancelar no borra decisiones; EXCLUDE no es cancelar.

## Concurrencia, integridad y despliegue

- READ COMMITTED en escrituras, locks de lote y hash de fuente compatibles con V17/V7/V8/V12; serializa decisiones, revisiones y cancelaciones. Congela escritores de Product/Asset brevemente durante el recálculo, usando NOWAIT para fallar ocupado sin invertir locks de CRUD.
- Índices únicos reviewId+requestId y reviewId+version; índice reviewId+groupKey+version para latest/history. SQL valida JEFE activo/configurado, revisión/reservas completas/activas, versión consecutiva, key estable, pertenencia/identidad selladas, headers y cobertura/versiones/procedencia de evidencia. No altera tablas previas ni hace backfill.
- Auditoría y decisión en una transacción: fallo revierte ambas y no consume versión/requestId. Reintentos ligados a autor y contenido; reordenar evidenceReviews no cambia intención. Otro motivo/acción/evidencia/versión/autor con el mismo requestId falla.
- GET usa un snapshot RepeatableRead para historial, vigencia, conteos y versión. No renueva decisiones al consultar.

Errores:

- 400 VALIDATION_ERROR / INVALID_IDENTITY_GROUP_TARGET.
- 401 no autenticado;403 sin JEFE o sin CSRF;404 lote/revisión/decisión inexistente o ajena.
- 409 IDEMPOTENCY_KEY_REUSED / IDENTITY_GROUP_DECISION_VERSION_CONFLICT.
- 409 REVIEW_VERSION_CONFLICT / SOURCE_REVISION_CONFLICT / IDENTITY_GROUP_PROJECTION_CHANGED.
- 409 IDENTITY_GROUP_DECISION_BLOCKED / NEW_ASSET_PROPOSAL_CONFLICT / ASSET_NOT_SUGGESTED / IDENTITY_GROUP_ASSET_ALREADY_PROPOSED.
- 409 IDENTITY_GROUP_EVIDENCE_COVERAGE_REQUIRED / EVIDENCE_VERSION_CONFLICT / EVIDENCE_ALREADY_APPLIED.
- 409 IDENTITY_GROUP_ALREADY_RELEASED / INVALID_IDENTITY_GROUP_REVIEW y límites de V18.
- 409 IDENTITY_GROUP_REVIEW_BUSY / IDENTITY_GROUP_REVIEW_CONFLICT: recargar o reintentar con la misma intención/requestId según el caso.
- 503 IMPORT_REVIEW_NOT_READY si falta almacenamiento necesario, incluida0024.

No Aplicar por CRUD ni por pilotos antiguos: las reservas y guards V17 permanecen. [V20](contrato-api-v20.md) añade plan read-only propio de grupos con decisiones latest vigentes, reglas operativas explícitas y claves de deduplicación global por filas; todavía falta su aplicación transaccional con recibos/consumo. Tintas, bajas sin fecha verificable/terminales, corrección de historia operativa, integración frontend y piloto real autorizado siguen pendientes. Migración0024 preparada en código no significa instalada en producción.

## Verificación

484 pruebas aprobadas en Node24.19.0 Linux/PostgreSQL18.6, incluidas22 nuevas (8 unitarias/14 integración). Build API forzado, lint completo API/tests, Prisma validate/generate y diff-check correctos. Base descartable eliminada; sin modificación de Excel/frontend/dependencias ni migración operativa. Detalle en [informe de verificación](verificacion-backend-node24.md).
