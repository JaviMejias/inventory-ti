# Contrato API V20 — plan del piloto de grupos

Fecha inicial:2026-10-05. Implementado en backend, solo lectura. DesdeV21 consulta usos globales y requiere almacenamiento hasta0025. [V21](contrato-api-v21.md) añade aplicación separada; esta respuesta sigue sin guardar ni aplicar. No acredita despliegue ni carga real.

## Endpoint

POST `/inventory/imports/batches/:id/identity-group-reviews/:reviewId/pilot-plan`

JEFE autenticado + CSRF, igual que los otros planes POST. No admite query adicional/force. Lote y revisión se verifican juntos; revisión cancelada no se utiliza. UUID de ruta/operaciones/producto aceptados en mayúsculas/minúsculas, respuesta canónica.

Una sola transacción REPEATABLE READ lee V18, últimas decisiones V19, activos seleccionados y catálogo. No guarda el plan, consume reservas, crea comprobantes, registra auditoría ni cambia Excel/origen/lote/decisiones/activos/stock/asignaciones/evidencias.

## Request

```text
{
  expectedBatchVersion: integer >= 1,
  expectedSourceRevision: integer 0..1000,
  expectedDecisionVersion: integer >= 0,
  projectionId: SHA256 de la vista V18 actual,
  operations: [{
    type: "CREATE_ASSET",
    groupKey: SHA256 estable de V18,
    decisionId: UUID de la última decisión V19 de ese grupo,
    note: texto no vacío <=2000,
    acknowledgedWarnings: [SHA256], // default[], máximo500, sin duplicados
    confirmation: "AVAILABLE_UNASSIGNED",
    values: {
      productId: UUID de producto existente,
      serialNumber?: string|null,
      assetTag?: string|null,
      technicalCondition?, usagePurpose?, location?, sector?,
      ipAddress?, hostname?, loanCode?, notes?
    }
  } | {
    type: "UPDATE_METADATA",
    groupKey, decisionId, note, acknowledgedWarnings,
    assetId: UUID propuesto por LINK_EXISTING vigente,
    values: {
      technicalCondition?, usagePurpose?, location?, sector?,
      ipAddress?, hostname?, loanCode?, notes?
    } // al menos un atributo explícito; omisión y null son distintos
  }]
}
```

DTO estricto,1–25 operaciones; cada grupo y activo existente ocurre una sola vez. Usa validación/longitudes/IP de los metadatos vigentes del activo. CREATE no recibe estado/asignación/fecha; UPDATE no recibe identidad/producto/estado/fecha. No admite candidateId/recordIds/snapshots/decisiones aportadas por el cliente.

El cliente elige el grupo completo mediante groupKey; no puede cargar una parte de sus observaciones. Un grupo de varias filas produce una sola propuesta de activo y conserva todas las filas.

## Decisiones y vigencia

expectedDecisionVersion es el contador de toda la revisión V19, no el de un grupo ni la versión del lote. Los cuatro campos de vigencia deben coincidir con el snapshot actual, o responde409. No renueva decisiones ni cambia silenciosamente el request.

El servidor consulta únicamente las últimas decisiones por grupo. decisionId debe ser el comprobante latest exacto; otra decisión del candidato original o un comprobante histórico no sustituyen la intención vigente. Falta de decisión, referencia no latest, HOLD/EXCLUDE o decisión con huella V18 anterior son bloqueantes del plan.

Valida reglas, huellas de intención/proyección, cabeceras, propiedad y pertenencia de los comprobantes guardados. Evidencia de una decisión vigente se verifica nuevamente con V19. Comprobantes corruptos/versiones no interpretables fallan explícitamente, no se tratan como aprobaciones.

Cambios de catálogo no cubiertos por la huella V18 —por ejemplo modelo/tipo/activación del producto— se evalúan en este plan y forman parte de planId mediante su snapshot. Pueden bloquearlo/cambiar planId sin renovar decisiones automáticamente. Un siguiente request refleja nuevos cambios; la lectura en curso conserva su snapshot coherente.

## Reglas del piloto

CREATE_ASSET:

- Última decisión PROPOSE_NEW, vigente para V18, y ninguna coincidencia operativa.
- Producto existente, activo, ASSET y compatible con tipo/marca/modelo de todas las observaciones. No elige/crea productos.
- Serie/tag conservan exactamente las identidades verificadas del grupo mediante la normalización vigente; no acepta placeholders, identidades inventadas, omisiones ni reparaciones numéricas adicionales.
- Cada observación confirma AVAILABLE, sin destinatario/oficina/préstamo/uso/salida/detalles que exijan historia independiente. AVAILABLE_UNASSIGNED no sustituye evidencia contradictoria/desconocida del origen.

UPDATE_METADATA:

- Última decisión LINK_EXISTING vigente y coincidencia al activo exacto.
- Activo existente y no terminal/inactivo; producto ASSET activo/compatible.
- Diferencias explícitas de metadatos; no-op bloqueado. Null permite borrar un metadato, no una identidad. Conserva producto/serie/tag/estado/custodia, también si el activo está ASSIGNED.

Ambas operaciones rechazan evidencia de baja/RETIREMENT_HISTORY. Fuente/proyección bloqueada no puede habilitarse mediante acknowledgements; las advertencias requieren sus IDs exactos, y IDs desconocidos también bloquean. Reglas de catálogo/uso se comparten con el piloto antiguo, conservando su comportamiento.

Tintas, cantidades, entrega/devolución, préstamos, historia de asignaciones y bajas no se aplican por esta ruta.

## Evidencia y deduplicación

Cada operación conserva source con todas las observaciones del grupo: hoja/fila/recordId, candidato original, capas de identidad, campos interpretados y señales de estado. originalCandidateIds son procedencia, no targets de aplicación V6.

deduplication contiene por cada fila:

```text
{ sourceHash, recordId,
  key: SHA256(['IMPORT_SOURCE_ROW', sourceHash, recordId]) }
```

La clave es independiente de revisión/grupo/plan para preparar deduplicación global de la misma fila. Cambiar o reemplazar una revisión no cambia esas claves; sí cambia groupKey y exige decisiones nuevas. La procedencia ya consumida por los flujos anteriores sigue bloqueada por V18/V17.

**Consultar V20 no reserva ni consume filas.** DesdeV21 existe almacenamiento de comprobantes/usos globales; este plan comprueba filas consumidas y agrega IDENTITY_GROUP_SOURCE_ALREADY_APPLIED únicamente a los grupos seleccionados afectados, sin quitar su procedencia. La aplicación atómica se hace exclusivamente por el [endpoint V21](contrato-api-v21.md), compatible con reservas y consumidores anteriores.

evidence muestra la captura/vínculo/versiones vigentes y la revisión V19 por item, siempre appliedByThisPlan=false. EXCLUDE_FROM_GROUP_PILOT no borra la fila ni elimina sus señales de uso/baja; CONFIRM_GROUP_MEMBERSHIP tampoco aplica/religa historia. Null explícito sigue null y el vínculo capturado se conserva. La futura operación de activo no equivale a aplicación de archivo histórico.

## Respuesta200

```text
{
  planRulesVersion: "mda-identity-group-pilot-1",
  scope: "IDENTITY_GROUP_ASSET_PILOT",
  mode: "IDENTITY_GROUP_PILOT_PLAN",
  planId, batchId, reviewId, sourceHash,
  batchVersion, sourceRevision, decisionVersion,
  projectionId, reviewedPlanId, checkedAsOf, timeZone: "America/Santiago",
  operations: [{
    ...request de operación normalizado,
    groupId,
    decision: {id, version, action, projectionId, projectionCurrent,
               linkedAssetId, reviewedById, note, evidenceReference}|null,
    product: snapshot de catálogo|null,
    before: snapshot actual del activo|null,
    changes: [{field, before, after}],
    resultingStatus,
    source, originalCandidateIds, deduplication,
    evidence: [{...evidencia V18, review: revisión V19|null,
                appliedByThisPlan: false}],
    warnings: [{...incidencia, id}],
    blockers: [{code, issueId?}],
    valid
  }],
  omittedGroups: [{groupKey, recordIds, latestDecisionId}],
  persisted: false, canApply: false, affectsCurrentState: false,
  evidenceRelinked: false,
  groupedPilotPlanImplemented: true, groupedPilotImplemented: false,
  planValidationComplete,
  summary: {operationCount, validCount, blockedCount, createCount,
            updateCount, selectedObservationCount, omittedGroupCount}
}
```

Orden determinista por groupKey, observaciones por recordId. planId liga intención/acknowledgements, proyección, decisiones, selección/omisiones, evidencia y snapshots actuales de activos/productos. Reordenar operaciones no cambia la huella; modificar su contenido sí.

Plan parcial: omittedGroups identifica expresamente grupos fuera de esta selección, incluso sin decisión. planValidationComplete solo confirma las operaciones seleccionadas, no toda la revisión ni todo el Excel; no es autorización ni botón Aplicar. Todas las respuestas conservan canApply=false.

## Errores y límites

- 400 VALIDATION_ERROR / INVALID_IDENTITY_GROUP_TARGET.
- 401 no autenticado;403 sin JEFE/CSRF;404 revisión inexistente/ajena.
- 409 REVIEW_VERSION_CONFLICT / SOURCE_REVISION_CONFLICT / IDENTITY_GROUP_DECISION_VERSION_CONFLICT / IDENTITY_GROUP_PROJECTION_CHANGED.
- 409 IDENTITY_GROUP_ALREADY_RELEASED / INVALID_IDENTITY_GROUP_REVIEW / INVALID_IDENTITY_GROUP_DECISION.
- 409 IDENTITY_GROUP_DECISION_LIMIT, PREVIEW_DATABASE_LIMIT, IDENTITY_GROUP_EVIDENCE_LIMIT y límites de fuente heredados.
- 503 IMPORT_REVIEW_NOT_READY si falta almacenamiento necesario, incluida0024.

Errores de vigencia/integridad/límites impiden un resultado parcial. Diagnósticos operativos del plan se devuelven en200 con valid/planValidationComplete=false y blockers explícitos. No hay force ni waiver de bloqueantes.

La revisión mantiene sus límites1–25 filas físicas, hasta25 decisiones latest, máximo25000 activos de conciliación y100 items de evidencia. Excesos fallan, no truncan una respuesta presentada como completa.

ActualizaciónV21: aplicación propia implementada con recibos inmutables, idempotencia/revalidación bajo locks y deduplicación global por fila; no ejecutar este plan vía CRUD ni piloto antiguo. Instalación0025, Tintas, bajas sin fecha/terminales, historia de grupos/corrección operativa, integración frontend y piloto real autorizado conservan sus pendientes.

## Verificación

511 pruebas aprobadas en Node24.19.0 Linux/PostgreSQL18.6, incluidas27 nuevas (14 unitarias/13 integración). Build API forzado, lint completo API/tests, Prisma validate y diff-check correctos. Base descartable eliminada; sin migración/dependencia nueva ni cambios operativos/frontend/Excel. Detalle en [informe de verificación](verificacion-backend-node24.md).
