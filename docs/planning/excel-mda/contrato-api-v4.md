# Contrato API V4: revisión persistente de lotes

Estado: implementado en código, 2026-10-05. Extiende V3 sin cambiar su preview stateless. Requiere migración **0015_import_review_staging**, nueva y aditiva; no aplicada a la base operativa por este chat. El lote guarda evidencia y decisiones, no activos ni movimientos. `canApply=false` en todas las respuestas de este bloque. No existe endpoint de aplicación.

## Permisos y despliegue

Todas las rutas son solo JEFE autenticado. POST también requiere CSRF vigente. COORDINADOR/SOPORTE reciben 403. Si las tablas/columnas nuevas no están instaladas, las rutas de revisión devuelven 503 `IMPORT_REVIEW_NOT_READY`; no inventar persistencia local como sustituto.

El preview V3 de solo lectura sigue disponible sin 0015. Antes de habilitar revisión persistente, planificar respaldo, entorno destino y migraciones pendientes con el responsable. Esta implementación no migra automáticamente la base ni guarda el archivo real allí. Las pruebas usan PostgreSQL descartable.

## Rutas

| Método/ruta | Uso |
| --- | --- |
| POST /inventory/imports/batches | Guardar el origen y el preview visto. |
| GET /inventory/imports/batches | Listar metadatos, sin celdas ni notas de revisión. |
| GET /inventory/imports/batches/:id | Recuperar metadatos y resumen de decisiones actuales. |
| GET /inventory/imports/batches/:id/preview | Recuperar snapshot completo e inmutable de V3. |
| GET /inventory/imports/batches/:id/freshness | Comparar reglas/inventario actuales con el snapshot. |
| POST /inventory/imports/batches/:id/decisions | Añadir una decisión con control de versión y reintento. |
| GET /inventory/imports/batches/:id/decisions | Decisiones actuales o historial paginado. |

`:id` es UUID de lote. JSON estricto; propiedades adicionales y campos de aprobación/forzado son rechazados. No hay DELETE ni PATCH: cambiar una decisión genera un evento nuevo, nunca reescribe el anterior.

## Guardar lote

Request: `{ workbook: <envelope completo V3>, previewId: <digest V3 visto> }`. Límite local de 16 MiB; mismas reglas de filas/celdas que V3. No acepta binario XLSX/multipart ni un preview calculado por cliente.

Si el preview todavía no está guardado, backend lo reconstruye con los datos actuales y la fecha actual del servidor. Si el ID no coincide, 409 `PREVIEW_STALE`: generar/verificar nuevo preview. No reemplazar el origen silenciosamente.

Respuesta: `{ batch, reused }`, 201 cuando crea y 200 cuando recupera el mismo preview. `previewId` es único: solicitudes simultáneas o repetidas no duplican lote/auditoría. Una recuperación posterior a timeout devuelve el lote ya guardado incluso si desde entonces cambiaron inventario/reglas/fecha, **siempre que el payload coincida**. Mismo previewId con otro payload devuelve 409 `PREVIEW_PAYLOAD_CONFLICT`.

Mismo archivo con un preview diferente puede producir otro lote. No hay idempotencia de carga operativa todavía. El primer creador y origen quedan intactos; no trasladar automáticamente decisiones entre lotes.

`batch` contiene id, previewId, sourceFileName, sourceHash, payloadDigest, databaseSnapshotDigest, rulesVersion, asOf, version, targetCount, createdById, createdAt, updatedAt y `mode="REVIEW"`, `persisted=true`, `canApply=false`.

- `version` empieza en 1 y aumenta exactamente una vez por decisión añadida.
- `targetCount` cuenta grupos de candidatos físicos más registros independientes no físicos. No suma registros físicos individuales que ya pertenecen a un candidato, ni headers/títulos excluidos.
- `sourceHash` sigue siendo el hash declarado por el extractor, no una firma/verificación del binario recibido; payloadDigest verifica el envelope real que se guarda.
- Fuente, preview, hashes, autor y fecha original son inmutables. Solo versión/updatedAt avanzan por revisión. No convertir el snapshot guardado en una imagen de la base actual.

Lista: query `sourceHash?`, `limit` 1..100 default 25, `offset` 0..2147483647 default 0. Respuesta `{ batches, total, limit, offset, hasMore }`, orden createdAt/id descendente. No devuelve JSON de origen ni snapshot.

Detalle: `{ batch, reviewSummary }`. Resumen: targetCount, reviewedTargetCount, unreviewedCount, holdCount, excludedCount, linkedCount, newProposalCount, pendingTargetCount y decisionCoverageComplete. Usa la **última decisión** por target. `pendingTargetCount = unreviewedCount + holdCount`. Cobertura completa significa que todos tienen una decisión distinta de HOLD; no significa conflictos resueltos ni lote aprobado/aplicable.

Snapshot: `{ batchId, persisted:true, canApply:false, snapshot:<V3 original> }`. El `persisted=false` dentro del snapshot corresponde a la respuesta V3 original que se conserva literalmente; el contenedor y el lote sí están guardados. Separar esta ruta del detalle/lista para evitar transferir celdas grandes en cada consulta.

## Añadir decisión

```json
{
  "expectedVersion": 1,
  "requestId": "UUID nuevo para esta intención",
  "targetType": "CANDIDATE",
  "targetId": "id de 64 caracteres del candidato",
  "action": "HOLD",
  "note": "Confirmar modelo y destinatario antes de proponer la carga"
}
```

`expectedVersion`: entero JSON 1..2147483646, versión vista del lote. `requestId`: UUID de idempotencia, conservarlo en reintentos de la misma intención. `note`: motivo obligatorio, trim, 1..2000 caracteres. Nunca rellenarlo con un mensaje de aprobación ficticio ni copiar una instrucción ejecutable del documento.

Targets:

- CANDIDATE: `id` de snapshot.candidates, representa observaciones agrupadas por identidad.
- RECORD: `id` de snapshot.records cuyo kind no sea ASSET_OBSERVATION/RETIREMENT_HISTORY (Tintas, resumen, notas, no mapeados). Los físicos se revisan por candidato; no duplicar su decisión como RECORD. Headers/títulos excluidos no son targets.

Acciones:

- HOLD: dejar pendiente, conservando motivo.
- EXCLUDE: intención de no cargar ese target. No elimina el origen ni borra activos de la app.
- LINK_EXISTING: intención de vincular con uno de candidate.existingAssets. Requiere `linkedAssetId` UUID sugerido; no acepta otro activo arbitrario. No actualiza el activo ni reactiva una baja.
- PROPOSE_NEW: intención de crear más adelante. Requiere identidad utilizable y ninguna coincidencia existente. No crea producto/activo, no escoge modelo/estado ni resuelve incidencias del snapshot.

RECORD solo admite HOLD/EXCLUDE. `linkedAssetId` solo se acepta para LINK_EXISTING. Las demás acciones deben omitirlo.

Respuesta: `{ batch, decision, reused }`; 201 nueva, 200 reintento idéntico. `decision`: id UUID, batchId, batchVersion, requestId, targetType, targetId, action, linkedAssetId|null, note, reviewedById, createdAt. Autor/fecha vienen del servidor.

Transacción: bloquear lote, verificar versión, validar target/vigencia cuando corresponde, incrementar versión, insertar evento y auditoría. Fallo de auditoría revierte todo. Dos revisores con la misma expectedVersion: solo uno escribe, el otro recibe 409 `REVIEW_VERSION_CONFLICT` con details.currentVersion; debe refrescar, no sobrescribir ni repetir automáticamente con la versión nueva.

Mismo requestId y misma intención/autor/versión original devuelve el evento previo sin duplicarlo, incluso tras cambios posteriores. Mismo requestId con contenido o autor distinto devuelve 409 `IDEMPOTENCY_KEY_REUSED`. Un evento recuperado puede ser anterior a la decisión actual; refrescar el modo latest antes de pintar estado vigente.

## Vigencia e historial

Freshness devuelve batchId, stale, rulesChanged, databaseChanged, reviewDateChanged, checkedAsOf, currentPreviewId, canApply=false. Cambiar cualquier activo/nombre de producto del conjunto consultado o versión de reglas marca stale; no solo los activos coincidentes. Es una comprobación puntual, no un bloqueo del inventario.

LINK_EXISTING/PROPOSE_NEW comprueban vigencia y devuelven 409 `BATCH_SNAPSHOT_STALE` si cambió base/reglas. HOLD/EXCLUDE siguen permitidos para documentar por qué no continuar. Cambiar de día expone reviewDateChanged, sin reescribir el snapshot ni borrar revisión; por sí solo no bloquea decisiones de esta etapa. La futura aplicación necesitará revalidación completa con fecha vigente, datos de producto/estado/eventos y concurrencia operativa.

Query de decisiones: `mode=latest|history` default latest, `targetType?`, `targetId?` (requiere targetType), limit/offset con mismos límites. Respuesta `{ decisions, mode, total, limit, offset, hasMore }`, batchVersion descendente. Latest cuenta targets con decisión, no eventos; history cuenta todos los eventos. Paginación/resumen usan snapshot consistente de lectura. No ocultar el historial cuando una decisión cambia.

Otros errores: 400 VALIDATION_ERROR/INVALID_REVIEW_TARGET; 404 NOT_FOUND; 409 ASSET_NOT_SUGGESTED/NEW_ASSET_PROPOSAL_CONFLICT/INVALID_REVIEW_SNAPSHOT; 413 PAYLOAD_TOO_LARGE; autenticación/CSRF según contrato vigente. No enviar notes/celdas/credenciales en logs de errores. Solo JEFE accede a datos personales del lote; auditoría general conserva IDs/hashes/acción, no contenido de notas/celdas.

## Validación y siguiente bloque

Migración probada sobre tablas heredadas pobladas, sin modificar usuarios/activos. Tests de permisos/CSRF, origen/historial inmutables, solicitudes concurrentes, reintentos tras cambios, versiones, rollback de auditoría, límites/paginación, targets separados y ausencia de writes operativos. Validación completa registrada en backend.md. PostgreSQL 18.6 y Prisma 6.19.3; suite WSL en Node 26, pendiente repetirla completa en Node 24 soportado antes de despliegue.

Pendiente: revisión explícita de productos/metadatos/estados/fechas/eventos, semántica Tintas, rebase entre lotes, plan de operaciones con vigencia, piloto transaccional, idempotencia de carga real y autorización del entorno destino. No mostrar botón Aplicar, historial importado ni inventario actualizado por guardar decisiones.
