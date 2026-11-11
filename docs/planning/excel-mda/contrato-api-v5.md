# Contrato API V5: plan de piloto sin aplicación

Implementado en código al 2026-10-05. Extiende V4 sin modificar sus DTOs, eventos ni migración. No está desplegado. Requiere las migraciones previas 0013–0015 para metadatos y staging; no introduce otra migración ni las aplica a la base operativa.

## Alcance y permiso

`POST /inventory/imports/batches/:id/plan`, solo JEFE autenticado y CSRF. Devuelve 200 tanto para un plan válido como bloqueado. Solo lecturas, en una transacción PostgreSQL RepeatableRead: fuente, revisión, inventario y catálogo corresponden al mismo snapshot. No cambia lote/versiones, no guarda planes, no genera auditoría, no crea activos ni modifica stock/asignaciones.

Piloto parcial de 1–25 candidatos físicos. No exige resolver todos los targets del Excel para analizar una selección, pero informa los omitidos. No recibe archivos ni repite el workbook: usa el origen inmutable del lote V4. Límite HTTP habitual de 1 MiB.

`canApply=false` y `persisted=false` siempre, incluso si `planValidationComplete=true`. No existe endpoint de aplicación. Tampoco una aprobación persistida, reserva de identidad ni bloqueo operativo. Frontend no debe habilitar Aplicar a partir de este resultado.

## Request

Objeto estricto `{ expectedVersion: number, operations: Operation[] }`. Versión entera 1..2147483647, sin coerción de strings. No se permiten dos operaciones para el mismo candidato ni dos actualizaciones del mismo activo.

Cada operación lleva `candidateId` (digest de V3), `note` (motivo explícito, trim, 1–2000 caracteres) y `acknowledgedWarnings?: string[]` (IDs SHA-256 de advertencias devueltas por V5; default [], únicos, máximo 500). Reconocer una advertencia no resuelve una incidencia bloqueante ni acredita revisión humana fuera de lo declarado.

### CREATE_ASSET

```json
{
  "expectedVersion": 2,
  "operations": [{
    "type": "CREATE_ASSET",
    "candidateId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "confirmation": "AVAILABLE_UNASSIGNED",
    "note": "Identidad y disponibilidad física verificadas",
    "acknowledgedWarnings": [],
    "values": {
      "productId": "00000000-0000-4000-8000-000000000001",
      "serialNumber": "SERIE-PILOTO-001",
      "assetTag": "ACTIVO-PILOTO-001",
      "location": "Bodega 2"
    }
  }]
}
```

`values` reutiliza el DTO de creación de activos V1: productId UUID obligatorio y metadatos opcionales con sus límites/validación IP. No permite status/isActive/fechas/asignaciones. Producto elegido explícitamente, existente, activo y ASSET; no se crea ni se deduce uno automáticamente. Tipo/marca/modelo no vacíos del producto no pueden contradecir evidencias no vacías de origen.

Última decisión V4 debe ser PROPOSE_NEW. No puede haber coincidencias operativas ni identidades inventadas/omitidas: serie y tag normalizados deben coincidir con los del candidato. Para identidad ausente se usa null/omisión; N/A y otros placeholders no se guardan como identidad real. No se permite reparar aquí una serie numérica dudosa.

Toda observación del candidato debe tener evidencia AVAILABLE; la confirmación del operador es adicional, no sustituye ese requisito. Bajas, destinatarios, préstamos, fechas de uso, tickets/OT de salida y detalles históricos impiden este piloto. Estado resultante AVAILABLE y sin asignación; cualquier otro circuito requiere su workflow propio. Referencias entrantes e historia permanecen en el origen guardado, no se convierten en eventos operativos.

### UPDATE_METADATA

Objeto con `type: UPDATE_METADATA`, `assetId` UUID y `values` con al menos un campo de technicalCondition, usagePurpose, location, sector, ipAddress, hostname, loanCode, notes. Misma semántica opcional/null/trim y límites V1; null borra explícitamente un valor.

Última decisión V4 debe ser LINK_EXISTING al mismo activo, y este debe estar sugerido para el candidato. Activo existente, activo y no DECOMMISSIONED. Se conserva su producto, serie, tag y estado, incluso si está ASSIGNED; esta operación no devuelve ni reasigna equipos. Una actualización sin diferencias queda bloqueada. No permite importar baja histórica por medio de metadatos.

## Response

- `mode: PILOT_PLAN`, `scope: ASSET_PILOT`, `persisted:false`, `canApply:false`.
- `planRulesVersion: mda-pilot-1`, `planId` SHA-256 determinista. Vincula versión del lote, preview actual/guardado, fecha evaluada, intención, decisiones seleccionadas, valores actuales del catálogo/activos, cambios y bloqueos. No es token de autorización ni garantía de vigencia futura.
- `batchId`, `batchVersion`, `stagedPreviewId`, `currentPreviewId`, `checkedAsOf` (America/Santiago).
- `freshness`: stale, rulesChanged, databaseChanged, reviewDateChanged. Base/reglas distintas bloquean todas las operaciones seleccionadas. Cambio de día solo no bloquea, pero fechas e incidencias se recalculan al día actual.
- `omittedTargetCount`: targets V4 fuera de la selección, no activos ni saldo faltante. Excluidos, pendientes y consumibles también pueden estar incluidos en este número. `planValidationComplete` describe únicamente las operaciones seleccionadas, no todo el Excel ni cobertura de revisión.
- `summary`: operationCount, validCount, blockedCount, createCount, updateCount. Create/update cuentan intenciones, incluidas las bloqueadas; nunca cantidades importadas.
- `operations`, ordenadas por candidateId: intención normalizada, decisionId vigente o null, product elegido o null, before (activo actual o null), changes (`field`, `before`, `after`), resultingStatus (propuesto, no aplicado), source (`recordId`, `sheet`, `row`), warnings, blockers, valid.
- `changes` incluye únicamente valores explícitos distintos, y no incluye productId: el producto completo se informa por separado. Valores omitidos no se copian del Excel ni generan un borrado.

Advertencias incluyen la incidencia V3 más `id`. Frontend puede presentar el primer plan, obtener IDs y reenviar la intención reconociendo exactamente las advertencias revisadas. Incidencias se acotan al candidato, sus filas y sus hojas; una Tinta omitida no bloquea un equipo de otra hoja. Incidencias BLOCKING relevantes se mantienen y no admiten force/ignore. Resolverlas requiere un mecanismo posterior, no editar el origen guardado ni fabricar un lote corregido sin procedencia.

Bloqueos adicionales: BATCH_SNAPSHOT_STALE, WARNINGS_NOT_ACKNOWLEDGED, UNKNOWN_WARNING_ACKNOWLEDGEMENT, PRODUCT_NOT_FOUND, PRODUCT_INACTIVE, PRODUCT_NOT_ASSET, SELECTED_PRODUCT_EQUIPMENTTYPE_CONFLICT, SELECTED_PRODUCT_BRAND_CONFLICT, SELECTED_PRODUCT_MODEL_CONFLICT, RETIREMENT_REQUIRES_SEPARATE_WORKFLOW, NEW_ASSET_REVIEW_REQUIRED, EXISTING_ASSET_MATCH, SOURCE_AVAILABILITY_UNCONFIRMED, SOURCE_HISTORY_REQUIRES_SEPARATE_WORKFLOW, MISSING_ASSET_IDENTITY, IDENTITY_PLACEHOLDER_NOT_ALLOWED, SOURCE_IDENTITY_MISMATCH, CROSS_CANDIDATE_IDENTITY_CONFLICT, EXISTING_ASSET_REVIEW_REQUIRED, ASSET_NOT_FOUND, ASSET_DECOMMISSIONED, NO_METADATA_CHANGE. Incidencias de origen tienen también issueId; bloqueos operativos solo code.

## Errores y continuidad

400 VALIDATION_ERROR por DTO/límite/operación no admitida; INVALID_REVIEW_TARGET si no es candidato físico del lote. 401 sin sesión, 403 rol/CSRF, 404 lote inexistente. 409 REVIEW_VERSION_CONFLICT con currentVersion; INVALID_REVIEW_SNAPSHOT o PREVIEW_DATABASE_LIMIT para origen inválido/inventario fuera del límite V3. 413 por cuerpo excesivo, 503 IMPORT_REVIEW_NOT_READY si faltan tablas de staging. Las migraciones de metadatos también deben estar instaladas antes de usar V5.

Las lecturas consistentes no impiden cambios posteriores. La futura aplicación debe recalcular el plan bajo locks, exigir el planId/versión esperados, persistir autor/procedencia/idempotencia y aplicar todo o nada con auditoría. No invocar las rutas CRUD desde frontend para simular la aplicación del plan: se perderían esas garantías. Carga histórica, estados no disponibles y unidad/circuito de Tintas siguen pendientes.

## Validación

226 pruebas aprobadas en PostgreSQL 18.6 descartable, incluyendo 15 pruebas nuevas de DTO, planner y API: permisos/CSRF, límites, identidad, estado/historia, advertencias, catálogo, última decisión, antes/después, vigencia y ausencia de escrituras. Compilación API, lint acotado y diff-check correctos. Smoke del motor compilado en Node 24.19 Windows aprobado; suite completa ejecutada en Node 26 WSL, repetirla en Node 24 soportado antes de despliegue.
