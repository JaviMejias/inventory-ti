# Contrato API V9: evidencia histórica del Excel

Estado al 2026-10-05: implementado y probado con fixtures en bases PostgreSQL descartables. Requiere la migración aditiva `0019_import_historical_evidence`, después de las anteriores, y cliente Prisma generado. No se aplicó a la base operativa ni se cargó o modificó el Excel real. Complementa V1–V8; no modifica sus operaciones de activos/asignaciones.

## Alcance y distinción obligatoria

V9 conserva observaciones físicas de recepción, uso, préstamo y baja como **evidencia documental**, con origen, interpretación y respaldo. No reconstruye todavía acontecimientos operativos confirmados.

- No crea ni modifica Asset, Product, Assignment, InventoryMovement, stock o cuentas de destinatarios.
- No da de baja, entrega, devuelve, reactiva ni cambia disponibilidad/estado de un equipo.
- No convierte el texto de un destinatario/agente en usuario de la app ni ejecutor histórico.
- Puede archivar evidencia sin activo vinculado; una identidad dudosa sigue dudosa y sus incidencias permanecen visibles.
- Solo permite vincularla explícitamente mediante identidad revisada inequívoca o el comprobante de piloto V6 del mismo origen/candidato. No hace una búsqueda libre para asociarla arbitrariamente.

Todas las respuestas V9 incluyen `scope: "HISTORICAL_EVIDENCE_ONLY"`, `affectsCurrentState: false`, `canApply: false`. La captura sí persiste evidencia: `persisted: true` no significa que se aplicó inventario. El frontend debe decir «Guardar evidencia histórica», no «Importar asignaciones» ni «Aplicar baja».

## Rutas, acceso y paginación

| Método/ruta | Acceso | Resultado |
| --- | --- | --- |
| GET `/inventory/imports/batches/:id/history-preview` | JEFE | Observaciones derivadas, incidencias y opciones de vínculo; solo lectura. |
| POST `/inventory/imports/batches/:id/history-captures` | JEFE + CSRF | Captura atómica de 1–25 observaciones seleccionadas; 201 nueva / 200 reintento recuperado. |
| GET `/inventory/imports/batches/:id/history-captures` | JEFE | Lista de metadatos de comprobantes, sin selection/items/celdas. |
| GET `/inventory/imports/batches/:id/history-captures/:captureId` | JEFE | Comprobante completo e items; 404 si pertenece a otro lote. |
| GET `/assets/:id/imported-evidence` | Cualquier usuario autenticado | Evidencia capturada vinculada a ese activo, con metadatos de captura. |

Las tres listas y el preview aceptan exclusivamente `limit` entero 1–100 (default25) y `offset` entero 0–2147483647 (default0), y devuelven `total, limit, offset, hasMore`. IDs de ruta UUID. No se admiten filtros inventados. Evidencia vinculada se consulta separada de `/assets/:id/history`; este último conserva su significado operativo.

Orden de observaciones: recordId + kind, estable. Listas persistidas: capturedAt descendente, id descendente. Paginación offset, no cursor; nuevas capturas entre consultas pueden desplazar páginas. Preview/contadores se leen en una transacción RepeatableRead.

## Clasificación contextual, no duplicación de equipos

| kind | Indicios en una fila física mapeada | Fecha interpretada |
| --- | --- | --- |
| `RECEIPT_OBSERVATION` | receivedDate, incomingTicket, incomingOt o purchaseOrder informado | receivedDate |
| `USAGE_OBSERVATION` | usedDate, outgoingTicket, outgoingOt, recipientText, officeText o details informado | usedDate |
| `LOAN_OBSERVATION` | Hoja NB Prestamo, loanCode o loanDate informado | loanDate |
| `RETIREMENT_OBSERVATION` | Fila RETIREMENT_HISTORY o evidencia contextual DECOMMISSIONED | Desconocida; no existe mapeo de fecha de baja confirmada |

Una fila puede generar varias observaciones. No representan varios activos ni eventos independientes confirmados. Filas repetidas en otras hojas conservan su evidencia; no se deduplican como acontecimientos por coincidencia de fecha/ticket. Tintas, Disponible, notas sin fila física, encabezados y hojas no mapeadas no generan observaciones físicas V9. Su tratamiento propio sigue pendiente.

Tickets/OT/OC entrantes y salientes se conservan en sus campos separados dentro del registro; no se mezclan en una referencia genérica. Ubicación/destino/agente permanecen texto fuente, no hechos actuales confirmados.

## Fecha, autor y procedencia

Cada observación tiene:

- `recordId`, `candidateId`: IDs originales estables del lote, también tras correcciones V7/V8.
- `kind`, `effectiveDay`: string `YYYY-MM-DD` o null. No es timestamp y no debe convertirse a medianoche local/UTC para mostrarlo.
- `datePrecision`: `DAY` o `UNKNOWN`. Solo días calendario válidos desde 1900 hasta la fecha actual America/Santiago son conocidos. Una hora textual se conserva, pero no se presenta como instante verificado.
- `dateField`: receivedDate / usedDate / loanDate / null. `sourceDateText`: valor textual interpretado o null; las celdas tipadas originales siguen disponibles.
- `dateUncertainty`: null, `DATE_NOT_REPORTED`, `DATE_UNCONFIRMED` o `RETIREMENT_DATE_NOT_MAPPED`.
- `original`: registro de la fuente inmutable, incluyendo hoja/fila/fields/originalCells.
- `effective`: registro según correcciones vigentes. Sus `originalCells` son las celdas de esa interpretación efectiva; para el Excel original usar `original.originalCells`, no las de effective.
- `issues`: incidencias conservadas de fila/candidato/hoja; guardar evidencia no las resuelve ni reconoce automáticamente los warnings del piloto.
- `sourceCorrections`: correcciones aplicables a esa fila con procedencia V7/V8.
- `suggestedAssets`, `identityLinkBlocked`: coincidencias actuales y bloqueo de identidad; sugerencia no equivale a aprobación.
- `historicalActorId: null`, `affectsCurrentState: false`.

La Fecha de una hoja Baja puede ser recepción: genera recepción fechada y baja con fecha desconocida. No usar el año de hoja, hoy, capturedAt ni Fecha recibido como fecha de retiro. Fechas futuras, inválidas, fórmulas y errores se archivan como desconocidas, conservando texto/celda/incidencia; no se ejecutan fórmulas ni se confía en su cache para fechar.

El comprobante distingue `capturedById/capturedAt` (usuario actual que guarda y momento de captura) del ejecutor/momento histórico, que no se inventan.

## Preview y vínculo a un activo

GET history-preview devuelve los campos de scope anteriores más:

```json
{
  "mode": "HISTORY_PREVIEW",
  "persisted": false,
  "batchId": "<uuid>",
  "batchVersion": 2,
  "sourceRevision": 0,
  "historyRulesVersion": "mda-history-evidence-1",
  "historyPreviewId": "<sha256 de 64 caracteres>",
  "observations": [],
  "total": 0,
  "limit": 25,
  "offset": 0,
  "hasMore": false
}
```

Cada observación añade `stored` (null o `{id,captureId,recordId,kind,assetId,capturedAt}`) y `linkOptions: [{assetId,basis:{type,id}}]`. Un resultado previamente capturado debe mostrar su comprobante, no ofrecer capturarlo nuevamente. `persisted:false` describe que el preview no escribe; no niega la existencia de stored.

Bases de vínculo:

1. `REVIEW_DECISION`: última decisión CANDIDATE/LINK_EXISTING del lote apunta al mismo activo, coincidencia actual única y sin bloqueos de identidad en ninguna observación del candidato. Debe estar aprobada después de su última revisión/restauración de identidad. La API verifica el vínculo de nuevo al capturar.
2. `PILOT_RECEIPT`: ImportApplicationItem inmutable del mismo sourceHash/candidateId y activo exacto. Permite anexar evidencia después del piloto sin aplicarlo otra vez, incluso desde otro lote de esa misma fuente.

Estado terminal/activo asignado no impide un vínculo documental válido: no se modifica su estado. No aceptar libremente otro assetId por nombre/modelo/celda coincidente.

El preview histórico se recalcula contra la base actual. No exige que el snapshot operativo V4 permanezca fresco, pero liga su propia huella al estado actual de coincidencias, decisiones, sourceRevision, reglas, fecha, comprobantes V6 y capturas previas. Esto no levanta los bloqueos de vigencia del plan/piloto V5/V6.

## Captura explícita

Request estricto; placeholders del ejemplo deben sustituirse por los IDs reales:

```json
{
  "expectedVersion": 2,
  "expectedSourceRevision": 0,
  "requestId": "<uuid nuevo para esta intención>",
  "historyPreviewId": "<huella del preview revisado>",
  "confirmation": "STORE_HISTORICAL_EVIDENCE_ONLY",
  "note": "Observaciones revisadas; no representan una baja operativa",
  "evidenceReference": "Referencia documental de revisión",
  "records": [
    {
      "recordId": "<id del registro original>",
      "kind": "RETIREMENT_OBSERVATION",
      "assetId": null
    }
  ]
}
```

expectedVersion entero1–2147483647; expectedSourceRevision entero0–1000 obligatorio; requestId UUID; historyPreviewId SHA256 minúsculo64. note no vacío trim≤2000 y evidenceReference no vacío trim≤500. Records1–25, sin repetir recordId/kind. assetId UUID o null, opcional defaultnull (normalizado a minúsculas). No se aceptan effectiveDay, snapshot, autor histórico, estado, fechas de retorno, force ni efectos operativos enviados por el cliente. La selección y su contenido se derivan del servidor.

Respuesta de captura: `{scope,affectsCurrentState,canApply,persisted:true,reused,capture}`. capture contiene id, batchId/version, sourceRevision/sourceHash, requestId/requestDigest/historyPreviewId/rulesVersion, motivo/respaldo, selection derivada, capturedById/capturedAt e items. Cada item: id, captureId, sourceHash, recordId/candidateId, kind, effectiveDay, assetId, snapshot completo y capturedAt. La consulta del comprobante devuelve la misma información sin reused. La lista de comprobantes omite requestId/requestDigest, selection e items.

Guardar es atómico: cabecera, todos los items y auditoría `IMPORT_HISTORY_EVIDENCE_CAPTURED`, o nada. No incrementa batch.version ni sourceRevision. Serializa lote y sourceHash con correcciones/piloto/otras capturas y protege activos seleccionados durante la verificación.

## Reintentos, integridad y errores

requestId es único por lote y ligado a intención normalizada y usuario capturador. Reordenar records conserva intención. Un reintento idéntico recupera el comprobante anterior antes de verificar cambios posteriores de versiones/base, sin duplicar. Reutilizar la clave para otra intención/actor devuelve409.

Unicidad `sourceHash + recordId + kind` impide recapturar la misma observación incluso en otro lote de la misma fuente. No prueba que observaciones distintas sean acontecimientos distintos ni deduplica automáticamente archivos realmente diferentes. Cabeceras/items son inmutables; correcciones posteriores no reescriben capturas anteriores. Religar o enmendar evidencia ya archivada requiere un workflow futuro, no PATCH/DELETE ni una segunda captura.

| HTTP/código | Conducta |
| --- | --- |
| 400 VALIDATION_ERROR / INVALID_HISTORICAL_TARGET | Request inválido o selección no corresponde a observación física del lote. |
| 401 / 403 | Sesión, rol o CSRF insuficiente. |
| 404 NOT_FOUND | Lote, activo o comprobante no encontrado/en otro lote. |
| 409 REVIEW_VERSION_CONFLICT / SOURCE_REVISION_CONFLICT | Recargar revisión/interpretación; no sobrescribir silenciosamente. |
| 409 HISTORY_PREVIEW_CHANGED | Generar otro preview y revisar antes de confirmar. |
| 409 HISTORY_ASSET_LINK_UNCONFIRMED | Vínculo sin aprobación inequívoca/procedencia; revisar o guardar explícitamente sin vínculo. |
| 409 HISTORY_EVIDENCE_ALREADY_CAPTURED | Consultar evidenceId/captureId informados; no repetir la observación. |
| 409 IDEMPOTENCY_KEY_REUSED / HISTORY_CAPTURE_CONFLICT | Clave/intención u origen ya capturado; recuperar comprobante. |
| 409 HISTORY_CAPTURE_BUSY | Espera de lock acotada/contención; reintentar con la misma clave e intención. |
| 409 HISTORY_SOURCE_LIMIT | Fuente excede límites de lectura; no truncar ni capturar parcialmente por ese motivo. |
| 503 IMPORT_REVIEW_NOT_READY | Almacenamiento no instalado; no sustituir con CRUD ni fixtures simulando persistencia. |

Límites heredados V3: fuente JSON≤16MiB,≤32hojas,≤15000filas y≤150000celdas. Límite del snapshot operativo≤25000activos. Lecturas de historial por fuente≤60000observaciones y comprobantes de piloto≤15000items; si se exceden, error explícito. No es una carga masiva asíncrona. Captura tiene límite HTTP estándar de la API y selección≤25; no recibe celdas en el request.

SQL añade tablas, índices y guardas de origen/selección/vínculo/fechas/inmutabilidad y completitud. No altera ni hace backfill de tablas operativas. La clasificación y la interpretación efectiva se calculan en el servicio, no mediante un motor de reglas completo en triggers.

## Validación y continuación

Suite API completa: 296 pruebas en PostgreSQL18.6 descartable, incluidas24 nuevas V9 (9 unitarias y15 integración/migración). Cubre roles/CSRF, origen/interpretación, fechas desconocidas, asignaciones/bajas intactas, vínculo revisado/V6, reintentos/concurrencia entre lotes, lock ocupado/rollback, auditoría fallida, paginación, almacenamiento ausente y migración aditiva. Prisma validado/generado, compilación API, lint acotado y diff-check correctos. La base de pruebas se elimina al terminar. Smoke V9 en Node24.19 Windows con módulos empaquetados temporalmente: separación recepción/baja, fechas desconocidas, DTO estricto y huella de reintento aprobados. Suite completa ejecutada en Node26 WSL; repetirla en Node24 soportado antes del despliegue.

Pendiente: reconstrucción y aplicación de acontecimientos operativos confirmados (periodos de asignación/devolución/baja), workflow de enmienda/vínculo posterior de evidencia, Tintas, reagrupación de identidades, procesamiento masivo y piloto real autorizado con respaldo/conciliación. V9 aporta el archivo necesario sin fingir que la historia ambigua ya está resuelta.
