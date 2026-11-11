# Contrato API V29 — aplicación de bajas agrupadas verificadas

Fecha:2026-10-20. Confirma el plan [V28](contrato-api-v28.md) para un grupo físico vinculado explícitamente a un equipo existente. Migración aditiva `0029_import_group_retirements` y cliente Prisma actualizado obligatorios antes de iniciar esta versión, también para sus lecturas. Preparada/probada solo en bases descartables; no se instala en la base operativa en este bloque.

Validación final:726 pruebas aprobadas,0 fallos/omitidas/canceladas, Node24.22.0/PostgreSQL18.6,164.372s.20 nuevas (3 unitarias/16 integración/1 migración), build API forzado, lint API/tests completo, Prisma validate/generate y whitespace correctos. [Informe Node24](verificacion-backend-node24.md). No acredita integración ni carga real.

## Alcance y cambios persistidos

Una confirmación añade un comprobante propio e inmutable, consume todas las filas físicas del grupo y cambia únicamente status/isActive/decommissionedAt/updatedAt del equipo. Guarda motivo/respaldos, plan completo, estado anterior/resultado, versiones, autor actual, captura UTC de PostgreSQL, huellas y auditoría en una sola transacción.

No crea un equipo terminal nuevo ni usuarios, stock, movimientos, asignaciones o vínculos V23. No modifica celdas, archivo capturado, enmiendas ni decisiones originales. La proyección de identidad queda en el comprobante como propuesta revisada, nunca sustituye el assetId del archivo original: evidenceRelinked=false.

La evidencia fuente de baja conserva fecha UNKNOWN/null e histórico actor null. La fecha efectiva procede exclusivamente de confirmación con prueba independiente; appliedAt/appliedById identifican captura/importador, no ejecución histórica. Recepción/año de hoja/fecha de importación no prueban retiro.

Se mantiene el bloqueo de bajas del piloto V20/V21 y de fuentes agrupadas en rutas legacy. V28 continúa solo lectura y conserva sus banderas false; disponer de un plan válido no ejecuta esta confirmación.

## Rutas y solicitud

Base: `/inventory/imports/batches/:id/identity-group-reviews/:reviewId`.

Solo JEFE autenticado. POST exige CSRF; UUID normalizados a minúsculas, cuerpos/parámetros/query estrictos.

```text
POST BASE/retirement-plan/apply
{
  requestId: UUID estable para esta intención y sus reintentos,
  planId: SHA256 del plan V28 recién revisado,
  confirmation:"APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT",
  plan: cuerpo de entrada V28 exacto,
        con versiones/projectionId/groupKey/decisionId/expectedEvidenceVersion,
        acknowledgedGroupWarnings y solicitud histórica anidada en plan.plan
}
```

No enviar la respuesta completa V28 como plan. No admite assetId, snapshots, result, autores, captura o force libres. No acepta el literal V14 `APPLY_VERIFIED_HISTORICAL_RETIREMENT` ni el literal de revisión como confirmación de esta escritura.

Revalida revisión activa, última decisión LINK_EXISTING exacta y contexto de lote/fuente/identidad/evidencia. Recalcula plan bajo locks y exige coincidencia de huella y cero bloqueantes. Reutiliza V28/V13: fecha/prueba independientes, no futuro, recepción como límite, custodia cerrada y coherente, ausencia de retiro previo, historia efectiva no posterior, fuente sin BLOCKING y avisos exactos separados.

Respuesta201 nueva /200 recuperación:

```text
{
  scope:"GROUP_VERIFIED_HISTORICAL_RETIREMENT",persisted:true,
  affectsCurrentState:true,evidenceRelinked:false,historicalActorKnown:false,
  reused:false|true,
  application:{
    id,batchId,reviewId,decisionId,groupId,groupKey,sourceHash,
    assetId,evidenceId,evidenceVersion,amendmentId,sourceRevision,decommissionedAt,
    requestId,requestDigest,planId,rulesVersion:"mda-group-retirement-application-1",
    plan,assetSnapshot,result,appliedById,appliedAt,createdTransactionId,
    rows:[{sourceHash,recordId,originalCandidateId,reviewId,applicationId},...]
  }
}
```

Snapshot SQL y createdTransactionId son controles internos opacos: no reenviarlos como autoridad ni interpretarlos como fechas históricas. `result` conserva todos los campos del equipo y cambia solamente sus cuatro campos terminales.

GET `BASE/retirement-applications?limit=25&offset=0` devuelve metadatos sin plan/snapshots, `_count.rows`, total/limit/offset/hasMore; orden appliedAt/id descendente. Limit1..100, offset0..2147483647.

GET `BASE/retirement-applications/:groupRetirementApplicationId` devuelve comprobante completo, incluidas sus filas;404 para cualquier lote/revisión/comprobante ajeno. Consultas permitidas tras cancelación administrativa, sin reabrir ni recalcular el origen.

## Atomicidad, consumo y reintentos

READ COMMITTED, lock de lote/advisory de fuente y locks de inventario/catálogo/archivo/revisión/asignaciones/consumos con EXCLUSIVE NOWAIT. Las nuevas solicitudes se validan dentro de la transacción; cualquier fallo revierte terminal, comprobante, filas y auditoría, sin consumir la clave.

Mismo reviewId+requestId+actor+intención recupera el comprobante exacto antes de revalidar contexto actual, incluso tras cancelar la revisión. Otra intención/actor con la misma clave devuelve409. Ambas listas de avisos se normalizan al calcular la huella; versiones, evidencia, fecha y respaldos sí cambian intención. Ante respuesta incierta conservar UUID y cuerpo, consultar/reintentar la misma intención; no generar una segunda clave para duplicar la baja.

Solo una baja agrupada por equipo y por observación, con plan único y consumo global por sourceHash+recordId. El consumo sobrevive a cancelación y cambio de lote del mismo archivo. Bloquea re-reserva, aplicaciones legacy, asignaciones y enmiendas de fuente consumida; no se libera mediante borrar/restaurar una revisión.

El comprobante consume todas las filas físicas del grupo, pero no transforma cada observación omitida en un acontecimiento operativo. Guarda la observación de baja elegida y deja los demás antecedentes visibles como omitidos. Grupos físicos independientes del mismo review pueden aplicarse por separado: después de cada cambio deben refrescar proyección y decisión de los restantes. No se permite que el consumo de un grupo se use para saltar la revisión de otro.

El equipo terminal importado no puede reactivarse, cambiar fecha/identidad/metadatos ni borrarse mediante SQL/API ordinarios. La escritura de asignaciones toma el lock del equipo antes de comprobar el límite terminal; snapshots SQL de escritura REPEATABLE READ no pueden evitar los controles. Constraints adelantados/SAVEPOINT no permiten modificar custodia o metadatos después de guardar el comprobante ni retirar su auditoría.

## Lecturas operativas y compatibilidad

Consultas habituales de activos añaden `groupRetirement` con metadatos de procedencia. `importRetirement` sigue siendo exclusivamente V14; no se falsifica ese comprobante ni se sustituye la interpretación legacy del archivo. Los comprobantes del piloto V6/V21 conservan su forma anterior: no incorporan esta relación derivada a su snapshot de resultado.

El historial del equipo incorpora un evento con source=IMPORTED_HISTORY, importScope=GROUP_HISTORICAL_RETIREMENT, groupRetirementApplicationId y padres. effectiveAt es la fecha confirmada; recordedAt/recordedById son captura/importador; actor sigue null. No agrega una entrega/devolución ni un segundo acontecimiento por la captura.

La evidencia archivada que estaba sin vínculo continúa sin vínculo en sus lecturas legacy; consultar la procedencia agrupada mediante groupRetirement/comprobante, no mediante un vínculo V23 inventado. Las reglas temporales usan AssignmentEffective V27, no fechas originales rectificadas.

## Integridad SQL y despliegue

0029 añade dos tablas vacías, FKs restrictivas, unicidad/índices y guardas. No reescribe activos, archivo ni historia preexistente. Comprueba revisión/decisión/versiones/identidad, origen físico completo, consumo exclusivo, evidencia actual, fecha/prueba, avisos, estado anterior/resultado, contexto temporal, huellas y auditoría; rechaza UPDATE/DELETE/TRUNCATE de recibos/consumos. Marcador de transacción/captura evita añadir filas a un comprobante ya finalizado.

Antes de iniciar el backend actualizado, con respaldo habitual, Node24 y `.env` destino revisado:

```bash
cd /home/javier/inventory-ti
pnpm db:migrate
node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma
```

Si sigue instalada solo0025, el comando instala0026/0027/0028/0029 en orden y genera Prisma. No se ejecutó contra la base operativa en este bloque. La migración nueva también es necesaria para lecturas normales que consultan procedencia/consumos.

## Errores y traspaso frontend

- 400 VALIDATION_ERROR;401/403 autenticación/JEFE/CSRF;404 padres o comprobantes ajenos.
- 409 GROUP_RETIREMENT_PLAN_BLOCKED: revisar details.blockers; sin force ni guardado parcial.
- 409 GROUP_RETIREMENT_PLAN_CHANGED: regenerar/revisar antes de confirmar.
- Conflictos de versión/proyección/decisión/evidencia V28 permanecen; un contexto obsoleto no se renueva automáticamente.
- 409 IDEMPOTENCY_KEY_REUSED: actor/intención distintos; no cambiar la clave para eludirlo.
- 409 GROUP_RETIREMENT_APPLICATION_CONFLICT: equipo/evidencia/fila/plan/solicitud ya aplicados; recuperar comprobante/contexto.
- 409 GROUP_RETIREMENT_APPLY_BUSY: reintento acotado conservando UUID/cuerpo.
- 503 IMPORT_REVIEW_NOT_READY: falta almacenamiento/migración, no presentar vacío.

Frontend: etapa de confirmación independiente «Aplicar baja histórica agrupada», alcance terminal permanente, plan exacto y requestId estable. Mostrar original/actual/proyección/fecha efectiva/captura separados. Ante201/200 mostrar comprobante y refrescar activos/archivo/timeline; ante respuesta incierta conservar intención y recuperar. No llamar varias rutas CRUD ni V14 para simular esta operación. Este bloque no modifica ni contacta frontend.

Extensión posterior [V30](contrato-api-v30.md): conserva bajas sin fecha como antecedentes pendientes sobre activos no terminales y permite conciliación documental auditada de evidencia independiente adicional sobre terminales existentes, sin aplicar otra baja ni cambiar su fecha. No admite fuentes internas reservadas/consumidas por grupos; su conciliación sigue pendiente, junto a correcciones legacy/documentales aplicadas, reglas Tintas e integración/piloto real autorizado con respaldo y conciliación. No se ha cargado el Excel real.
