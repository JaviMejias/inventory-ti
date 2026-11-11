# Contrato API V21 — aplicación del piloto de grupos

Fecha:2026-10-06. Backend implementado; requiere migración0025 y cliente Prisma regenerado. La0025 se valida solamente en bases descartables: no está aplicada a la base local ni autoriza cargar el Excel. Las0013–0024 sí se aplicaron localmente según [registro](migracion-local-2026-10-05.md).

Actualización2026-10-20: el usuario mostró aplicación correcta de0025 y migrate status al día. El estado sin instalación del párrafo anterior es histórico; no hubo carga del Excel. [V22](contrato-api-v22.md) añade el plan histórico read-only de items aplicados, sin relajar los usos/guardas V21.

## Aplicación

POST `/inventory/imports/batches/:id/identity-group-reviews/:reviewId/pilot-plan/apply`

JEFE autenticado y CSRF. Parámetros UUID normalizados; sin query/force. Request estricto:

```text
{
  requestId: UUID,
  planId: SHA256 del plan V20 revisado,
  confirmation: "APPLY_IDENTITY_GROUP_ASSET_PILOT",
  plan: request original de V20
}
```

`plan` es el DTO de operaciones/selección/versiones de V20, no su respuesta ni un snapshot del cliente. Mantiene límites1–25 grupos completos/25 filas de la revisión, producto explícito, advertencias reconocidas y decisiones latest vigentes. No admite cargas masivas, cantidades, asignaciones, fechas de baja o reactivaciones.

En READ COMMITTED bloquea lote/fuente y revalida V20 frente a inventario/catálogo/evidencia actuales. Locks de tablas Product/Asset y archivo histórico con NOWAIT impiden cambios concurrentes entre validación y aplicación; lecturas normales siguen permitidas. Conflictos de bloqueo retornan409 recuperable, no esperan indefinidamente ni continúan con un snapshot anterior.

Solo aplica:

- CREATE_ASSET disponible y sin asignación, con identidad física verificada y fuente explícitamente disponible/sin señales de uso. Una o varias observaciones completas generan un solo equipo.
- UPDATE_METADATA de equipo existente no terminal, conservando identidad/producto/estado/asignación vigente y campos omitidos. Null explícito conserva su semántica de borrado de metadato.

Comprobante, equipos/metadatos, usos globales por fila, auditorías habituales del activo y auditoría `IMPORT_IDENTITY_GROUP_PILOT_APPLIED` se guardan en una sola transacción. Cualquier fallo, incluida auditoría final o cobertura incompleta, revierte todos esos cambios. Fuente/lote/revisiones/decisiones no se reescriben; stock y movimientos QUANTITY permanecen intactos.

Respuesta201 inicial o200 al recuperar el mismo intento:

```text
{
  scope: "IDENTITY_GROUP_ASSET_APPLICATION", mode: "APPLIED",
  persisted: true, canApply: false, affectsCurrentState: true,
  groupedPilotImplemented: true, evidenceRelinked: false, reused,
  application: {
    id, batchId, reviewId, sourceHash, requestId, requestDigest,
    planId, plan, appliedById, appliedAt,
    items: [{id, applicationId, groupKey, groupId, decisionId,
             assetId, operation, result,
             rows: [{sourceHash, recordId, originalCandidateId, reviewId, itemId}]}]
  }
}
```

Items ordenados por groupKey y filas por recordId. `operation` conserva diferencias, decisión revisada, advertencias y toda la procedencia V20; `result` es el equipo al aplicar, no una lectura viva posterior. `affectsCurrentState=true` describe el efecto registrado; consultar/reintentar no lo repite. `canApply=false` evita tratar un comprobante como otra autorización.

## Reintentos y consumo global

La clave de reintento es reviewId+requestId. Intención normalizada liga planId, DTO, confirmación, notas y selección; orden de operaciones/advertencias no cambia la intención. Actor distinto o contenido distinto retorna409 IDEMPOTENCY_KEY_REUSED.

Antes de revalidar se recupera un comprobante existente de la misma intención/actor. Sigue recuperable tras cambios de inventario, nuevas decisiones o cancelación de revisión. Ante timeout consultar/reintentar con la misma clave; no fabricar una nueva carga.

`ImportIdentityGroupRowUse` impone unicidad permanente sourceHash+recordId, independiente de grupo/revisión/lote. Cada uso apunta al comprobante de grupo y a la procedencia reservada original. Reaplicar seleccionados devuelve409 IDENTITY_GROUP_SOURCE_ALREADY_APPLIED.

La aplicación parcial deja los grupos omitidos y sus reservas intactos. Los demás pueden aplicar después de refrescar V18 y renovar explícitamente las decisiones que hayan quedado obsoletas; no renueva aprobaciones automáticamente. V20 agrega un bloqueante por grupo seleccionado con filas ya consumidas y conserva su trazabilidad.

Cancelar V17 **no revierte equipos/metadatos ni borra comprobantes/usos**: solo libera reservas administrativas. Desde otro lote tampoco puede reaplicarse/corregirse/reagruparse la misma fuente consumida por los flujos anteriores. Si un candidato original se dividió y alguna fila ya se aplicó, el candidato completo no puede reutilizarse en el piloto antiguo; continuar los grupos restantes requiere la revisión activa propia, no crear otro lote/revisión para eludir consumo.

## Evidencia e historia separadas

V21 no modifica/vincula/enmienda ni aplica evidencia archivada, aunque V19 haya confirmado pertenencia. Vínculo capturado/vigente y null explícito se conservan; `appliedByThisPlan=false` sigue en cada evidencia del plan. Excluir archivo no elimina señales de uso o baja del Excel.

Los usos se verifican contra V6/V11/V14 antes de aplicar y las guardas legacy conservan reservas/consumo global. Historia asociada a identidades reagrupadas requiere su futuro flujo explícito: V21 no habilita el importador histórico anterior por cancelar, ni convierte un grupo en su candidato original.

## Consulta de comprobantes

- GET `/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications`: JEFE, limit1–100/default25, offset>=0, sin parámetros adicionales. Metadata paginada sin plan/items; applications,total,limit,offset,hasMore y flags de comprobante.
- GET `/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId`: JEFE, sin query. Detalle completo acotado por selección, incluso después de cancelar. Lote/revisión/comprobante deben coincidir;404 en caso contrario.

No hay ruta de edición/borrado del comprobante ni de sus usos. V20/V18/V19 conservan flags read-only; no habilitar Aplicar por su `canApply`, ni enviar sus decisiones al CRUD/piloto antiguo. El frontend debe implementar el contrato V21 con confirmación explícita y recuperación de comprobantes.

## Errores y migración

- 400 VALIDATION_ERROR: DTO/query/confirmación/límites inválidos;401/403 autenticación/JEFE/CSRF;404 ámbito incorrecto.
- 409 errores de versión/proyección/cancelación/integridad heredados de V20.
- 409 IDENTITY_GROUP_PILOT_BLOCKED: bloqueantes actuales, con groupKey y detalles;409 IDENTITY_GROUP_PILOT_CHANGED: planId ya no corresponde al plan válido actual.
- 409 IDENTITY_GROUP_SOURCE_ALREADY_APPLIED / IDENTITY_GROUP_APPLICATION_CONFLICT: recuperar comprobante o revisar selección, nunca forzar duplicación.
- 409 IDENTITY_GROUP_APPLY_BUSY: reintentar con la misma clave cuando termine la operación concurrente.
- 503 IMPORT_REVIEW_NOT_READY: almacenamiento requerido no instalado.

0025 añade tres tablas, índices, guardas inmutables y comprobación diferida de cobertura/resultado; amplía guardas de consumo para reservas nuevas y consumidores anteriores sin backfill ni borrar datos. Desde V21 también los flujos legacy que comprueban reservas requieren0025: coordinar migración antes de usar la API nueva. Instalar con respaldo verificado y cliente generado; no migrar por el solo hecho de que las pruebas pasen.

## Verificación y siguientes pasos

Pruebas PostgreSQL aisladas cubren DTO/permisos, múltiples filas, metadatos/custodia, reintentos, selección parcial, cancelación/concurrencia, archivo/null, consumo entre lotes, rollback de escrituras/auditoría, locks ocupados, guards SQL y migración sobre tablas pobladas. El resultado transversal final se registra en [verificación Node24](verificacion-backend-node24.md).

Suite completa final:531 aprobadas,0 fallos/omitidas/canceladas,97.525s en Node24.19.0/PostgreSQL18.6.20 nuevas (19 integración/DTO/migración y1 unitaria). Base descartable eliminada; build API forzado/lint API/tests completo/Prisma validate/generate/diff-check correctos.

Pendientes: instalación local de0025, integración frontend/roles/recuperación real; tratamiento operativo de Tintas y bajas sin fecha/terminales, historia ligada a grupos/corrección de historia ya aplicada; alinear API abierta con Node24 y piloto real autorizado con conciliación. V21 no sustituye esas decisiones ni habilita cargar todas las hojas.
