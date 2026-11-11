# Contrato API V14: aplicación de bajas históricas verificadas

Estado al 2026-10-05: implementado en código y probado con fixtures en bases descartables. Requiere migración0022_import_verified_retirements, sus prerrequisitos, cliente Prisma generado y API correspondientes. No se aplicó a base operativa ni se cargó el Excel real. V14 prevalece sobre la ausencia de aplicación descrita inicialmente en V13; el endpoint de plan sigue siendo solo lectura.

## Alcance y efectos

Aplica **una baja verificada de un activo existente** desde el plan V13 vigente. Cambia únicamente status=DECOMMISSIONED, isActive=false, decommissionedAt al instante confirmado y updatedAt a la captura actual. Conserva identidad, metadatos, historia previa, origen y evidencia archivada. No genera movimientos QUANTITY ni modifica stock, asignaciones, productos o cuentas.

Fecha/hora/zona del retiro y respaldo explícitos son obligatorios. Recepción y año de hoja no prueban retiro. La observación fuente conserva effectiveDay=null/datePrecision=UNKNOWN; el instante confirmado pertenece a la operación importada, no se sobrescribe en la captura. El ejecutor histórico continúa desconocido/null; appliedById/appliedAt identifican al importador actual, no al responsable original.

No aplica bajas con fecha desconocida, equipos actualmente asignados, terminales existentes, identidades pendientes, origen bloqueado, evidencia revisada sin enmienda, ni periodos posteriores al retiro. No cierra entregas ni reactiva equipos. V13 conserva esas comprobaciones y límites.

## Rutas y permisos

- POST /assets/:id/imported-retirement-plan/apply: JEFE+CSRF, confirmación independiente,201 nueva aplicación/200 recuperación idempotente.
- GET /assets/:id/imported-retirement-applications: JEFE, lista de metadatos, limit25 por defecto/máximo100 y offset0 por defecto/máximo2147483647; total/limit/offset/hasMore. No repite plan/result ni evidencia privada en listas.
- GET /assets/:id/imported-retirement-applications/:applicationId: JEFE, detalle completo acotado al activo. Otro activo/inexistente→404. No endpoints de edición/borrado de comprobantes.

IDs UUID; requestId normalizado a minúsculas. Un activo admite una sola aplicación de retiro; la lista conserva paginación común aunque su máximo actual sea un comprobante.

## Request de aplicación

```json
{
  "requestId": "<uuid estable de la intención y sus reintentos>",
  "planId": "<SHA256 del plan V13 revisado>",
  "confirmation": "APPLY_VERIFIED_HISTORICAL_RETIREMENT",
  "plan": {
    "evidenceId": "<uuid de observación de baja>",
    "confirmation": "VERIFIED_HISTORICAL_RETIREMENT",
    "confirmedAt": "2005-01-01T09:00:00-03:00",
    "dateEvidenceReference": "Acta que confirma instante y zona del retiro",
    "note": "Retiro físico contrastado, independiente de recepción",
    "evidenceReference": "Acta de baja firmada",
    "acknowledgedWarnings": ["<IDs SHA256 exactos del plan>"]
  }
}
```

DTO estricto: requestId UUID, planId SHA256 minúsculo64, literal APPLY_VERIFIED_HISTORICAL_RETIREMENT y request V13 en plan. No acepta plan/snapshot de respuesta como request, force, actor original, estado elegido o campos extra. Confirmar la verificación del plan no confirma por sí solo su aplicación.

Frontend debe mostrar efecto terminal y fecha confirmada, pedir confirmación nueva y congelar body/requestId de la intención. Doble submit no genera otra clave. Desconexión/timeout/5xx no prueban rollback: recuperar comprobante o reintentar exactamente el mismo body/UUID. No llamar a /decommission corriente ni editar el estado mediante CRUD para simular importación.

## Transacción, concurrencia y recuperación

1. Consultar recuperación por activo/requestId antes de revalidar el dominio; si existe, actor e intención deben coincidir. Huella liga confirmación, planId, fecha, evidencia, referencias y acks; orden de acknowledgements no altera la intención.
2. Serializar por SHA real del origen, observación, activo y producto. Esperas de lock acotadas a3s, transacción ReadCommitted con maxWait5s/timeout15s. Enmiendas/correcciones y aplicaciones anteriores mantienen su orden y locks propios.
3. Reconsultar recuperación tras locks. Revalidar que el importador siga siendo JEFE activo con contraseña configurada y mantener bloqueo compartido durante la escritura.
4. Rechazar activo/evidencia ya aplicados con referencia al comprobante existente; regenerar el plan desde evidencia/enmienda/revisiones e historia vigentes y comparar planId. Plan cambiado o bloqueado→409, sin escritura parcial.
5. Crear comprobante inmutable con plan completo y result de estado terminal, versión exacta de evidencia/amendmentId/sourceRevision, instante del retiro y capturador actual. Unicidad global por assetId/evidenceId/planId y clave activo/requestId.
6. Actualizar estado terminal y guardar auditoría IMPORT_HISTORICAL_RETIREMENT_APPLIED en la misma transacción. Si falla cualquiera, no queda equipo retirado, comprobante, reserva ni auditoría parcial; la clave puede reintentarse.

Recuperar una aplicación previa no reinterpreta su evidencia ni exige que el origen siga igual. Devuelve el comprobante original, incluso después de revisiones descriptivas posteriores. No crea otro retiro ni actualiza su fecha. Misma clave con otro actor o body→IDEMPOTENCY_KEY_REUSED.

## Respuesta y comprobantes

POST devuelve scope=VERIFIED_HISTORICAL_RETIREMENT, mode=APPLIED, persisted=true, reused=false|true, affectsCurrentState=true y application. No es la respuesta del plan V13; no contiene una nueva aprobación canApply.

application contiene id/assetId/evidenceId/evidenceVersion/amendmentId/sourceRevision/decommissionedAt, requestId/requestDigest, planId/rulesVersion=mda-retirement-plan-1, plan consultado, result persistido y appliedById/appliedAt. historicalActorId=null permanece en plan.proposedRetirement. result conserva id/productId/identidad y estado/isActive/decommissionedAt/updatedAt resultantes; no es una lectura posterior del activo.

GET de detalle devuelve el mismo scope/mode/persisted/application, sin reused. GET de lista solo metadatos y paginación. affectsCurrentState=true describe el efecto de la **operación registrada**; consultar un comprobante no ejecuta cambios.

## Lecturas operativas y evidencia sellada

- Respuestas normales de activos con assetInclude añaden importRetirement=null o metadatos de procedencia: id/evidenceId/evidenceVersion/amendmentId/sourceRevision/decommissionedAt/appliedById/appliedAt. No incluyen plan, result ni pruebas privadas. No inferir que appliedById es el ejecutor histórico.
- GET /assets/:id/history, para cualquier rol autenticado, incorpora un evento ASSET_DECOMMISSIONED/source=IMPORTED_HISTORY, actor=null, effectiveAt=fecha del retiro, recordedAt=fecha actual de captura y recordedById=importador. No duplica ese evento como una baja corriente en la fecha del audit.
- V12 añade usado RETIREMENT al plan de enmienda y rechaza cualquier nueva enmienda de la observación aplicada, incluida una intención preparada antes de la baja. Intentos concurrentes de baja/enmienda solo pueden dejar aplicada la versión exacta o invalidar el plan de baja; no ambos cambios.
- V13 incluye uso de evidencia de retiro entre sus bloqueos. Sus flags continúan false y el plan no se persiste.
- Baja corriente, estados, metadatos/asignaciones y saldos conservan reglas anteriores; un retiro importado no se modifica ni se reactiva por SQL o API. Asignaciones nuevas no pueden extenderse más allá del instante importado; la evidencia de retiro no puede convertirse en extremo V11.

Las fuentes/revisiones originales son independientes del comprobante: una revisión posterior no modifica historia ya aplicada. Corregir una baja aplicada requeriría un flujo operativo nuevo, no enmienda V12 ni CRUD.

## Migración y guardas

0022 añade una tabla y sus índices/constraints/triggers, sin backfill ni reescritura de equipos o evidencia. Las bajas anteriores no reciben origen inventado. Verificada en base descartable y schema temporal poblado.

Guardas SQL comprueban propuesta/actor desconocido/instante/prueba, origen/vínculo/versiones exactos, activo/catálogo actuales, fuente sin bloqueos, recepción independiente, acks y periodos compatibles. El comprobante debe confirmar junto con la actualización terminal, sin cambios de identidad/metadatos. Comprobantes/estado importado son inmutables y la evidencia utilizada queda protegida también durante construcción. La API sigue siendo responsable de generar/revalidar huellas; los triggers no sustituyen el compilador del plan ni certifican documentos externos.

Despliegue coordinado: respaldo verificable y entorno autorizado; migrar0022 con prerrequisitos, generar Prisma y desplegar API antes de habilitar el circuito frontend. La API actual también lee0022 desde V12/V13 y lecturas normales de activos/historial; no desplegar este código contra una base sin su migración. No activar frontend por disponer de fixtures.

## Errores

- 400 VALIDATION_ERROR;401/403 por sesión/JEFE/CSRF o importador revocado.
- 404 NOT_FOUND: activo/evidencia/comprobante inexistentes o comprobante fuera del activo.
- 409 IDEMPOTENCY_KEY_REUSED: intención/actor distintos con misma clave.
- 409 RETIREMENT_ALREADY_APPLIED: activo/observación ya usados; details aporta metadatos del comprobante existente.
- 409 RETIREMENT_PLAN_CHANGED: hash ya no vigente; revisar nuevo plan.
- 409 RETIREMENT_PLAN_BLOCKED: plan vigente con bloqueos; details.blockers.
- 409 RETIREMENT_APPLICATION_CONFLICT: unicidad/plan/observación ocupados concurrentemente; recuperar comprobante antes de otra intención.
- 409 RETIREMENT_APPLICATION_BUSY: espera/deadlock/transacción agotada; reintentar misma intención/clave, no forzar.
- 409 HISTORICAL_PLAN_LIMIT / INVALID_HISTORICAL_EVIDENCE / INVALID_SOURCE_REVISION: límites/archivo inválido conforme aV13.
- 503 IMPORT_REVIEW_NOT_READY: almacenamiento de importación no instalado, antes de escribir dominio.
- 500 inesperado sanitizado: no indica si la respuesta de una escritura se perdió; usar recuperación.

## Validación y pendientes

Suite completa392/392 aprobada en PostgreSQL18.6 descartable con Node26 WSL, incluidas20 nuevas (3 unitarias y17 integración). Pruebas de DTO/huella/historial y API/PostgreSQL con datos ficticios: roles/CSRF, actualización exacta, actores/fechas separados, ausencia de movimientos/cambios de origen, solicitudes/reintentos simultáneos, plan antiguo/bloqueado, V12/versiones selladas, asignación concurrente, rollback de auditoría, lock timeout, comprobantes, SQL/legacy, migración poblada y almacenamiento ausente. Prisma validado/generado, compilación API, lint acotado y diff-check correctos. Las tres unitarias nuevas también pasaron empaquetadas temporalmente en Node24.19 Windows. Suite completa PostgreSQL Node24 pendiente antes de despliegue.

Pendientes: bajas sin fecha verificable/conciliación de terminales existentes, Tintas con unidades/reglas confirmadas, identidades reagrupadas, corrección operativa de historia aplicada, integración frontend y piloto real autorizado con respaldo/conciliación. Esta implementación no habilita cargar todo el Excel automáticamente.
