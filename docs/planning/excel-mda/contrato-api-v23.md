# Contrato API V23 — confirmación de vínculos históricos de grupos aplicados

Actualización posterior: [V24](contrato-api-v24.md) prepara periodos operativos cerrados utilizando estos vínculos, todavía sin aplicarlos. No añade migración; los comprobantes/proyecciones V23 conservan su significado y las guardas anteriores.

Fecha:2026-10-20. Extiende [V22](contrato-api-v22.md) con persistencia propia. Requiere migración aditiva `0026_import_group_history_links`. Preparada en código y verificada exclusivamente en bases descartables; no aplicada a la base operativa. No carga el Excel real ni modifica frontend/dependencias.

## Qué guarda y qué no

Guarda una confirmación nueva de pertenencia histórica de1–25 evidencias del mismo item aplicado V21, con comprobante, proyecciones independientes y auditoría atómicos. Selección parcial permitida: la evidencia omitida no se considera revisada y puede confirmarse después con un plan nuevo.

No actualiza `ImportHistoricalEvidence`, sus enmiendas ni la vista `ImportHistoricalEvidenceCurrent`. La interpretación archivística vigente y la proyección confirmada al equipo reagrupado son conceptos distintos. No crea asignaciones, devoluciones, retiros, saldos ni movimientos; tampoco cambia activo/producto, estado, custodia, fecha terminal o reservas/consumo permanente. `evidenceRelinked=false` significa que el archivo original/legacy no se volvió a vincular; `historyProjectionPersisted=true` acredita la nueva proyección, no historial operativo aplicado.

Cada evidenceId admite una sola proyección inicial global, versión1. No existen reemplazo, desvinculación, borrado ni corrección V23. Una enmienda V12 posterior a ese vínculo queda bloqueada también en SQL: requiere el futuro flujo de corrección de historia agrupada, no alterar el comprobante ni sortear la reserva/consumo original.

## Preparación del plan

Se conserva POST V22 `.../items/:itemId/history-link-plan`, JEFE+CSRF y request original estricto. Ahora sus reglas son `mda-group-history-link-plan-2`: operaciones y omittedEvidence incluyen `savedGroupLink:null|{id,historyApplicationId,assetId,version}`. Una selección ya confirmada muestra bloqueante `GROUP_HISTORY_LINK_ALREADY_SAVED`; cambia la huella.

Se conservan las banderas conservadoras del plan: persisted/canApply/affectsCurrentState/evidenceRelinked/historyLinkApplicationImplemented=false. Ninguna consulta escribe o confirma. El endpoint de confirmación V23 es un contrato separado; no habilitar operaciones legacy por esas banderas. Planes anteriores a0026 o con reglas1 deben regenerarse antes de confirmar.

Se mantienen validación completa del comprobante V21, consumo físico global, versiones exactas de evidencia/enmienda/revisión, exclusiones como mero antecedente, advertencias explícitas y límites V22. Otra fila/grupo/activo no puede elegirse mediante el request. Una captura en otro lote del mismo hash de fuente sigue siendo admisible si coincide exactamente con fila y candidato original consumidos.

## Confirmar

Base de rutas:

```text
/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId/items/:itemId
```

POST `BASE/history-link-plan/apply`, solo JEFE autenticado+CSRF. UUID normalizados a minúsculas; sin parámetros query adicionales.

```text
{
  requestId: UUID nuevo y estable para reintentos de esta intención,
  historyLinkPlanId: SHA256 del plan revisado con reglas2,
  confirmation: "SAVE_GROUP_HISTORY_LINKS_ONLY",
  plan: {
    expectedApplicationPlanId: SHA256 del comprobante V21,
    operations: [{
      evidenceId: UUID,
      expectedEvidenceVersion: integer0..1000,
      action: "LINK_TO_APPLIED_GROUP",
      note: texto1..2000,
      evidenceReference: respaldo1..500,
      acknowledgedWarnings: [SHA256]
    }]
  }
}
```

No admite assetId libre, projection/snapshot, fecha/actor histórico, force, overrides de bloqueantes ni confirmaciones V4/V12/V21. El activo se obtiene exclusivamente del item V21 y se compara su identidad actual con el resultado inmutable.

Transacción READ COMMITTED: bloqueo del lote y advisory por hash de fuente; recuperación idempotente; locks NOWAIT compatibles con V21 sobre catálogo/activos/captura/archivo/enmiendas; reconstrucción completa del plan dentro de la misma transacción; comparación de huella; comprobante, vínculos y auditoría. No usa el resultado de otra transacción para autorizar escritura. No intenta obtener después del advisory los locks de otros lotes de captura, evitando inversión de orden con sus escritores.

Mismo item+requestId+actor+intención devuelve el comprobante anterior antes de revalidar estado vivo. Reordenar operaciones/advertencias no cambia intención; cambiar selección/versiones/nota/respaldo/huella/actor sí. Dos claves con evidencia superpuesta no pueden crear dos vínculos. Una cancelación administrativa o cambio posterior del activo no impide recuperar un comprobante existente ni lo reescribe.

## Respuesta201, o200 al reutilizar

```text
{
  scope: "IDENTITY_GROUP_HISTORY_LINK_APPLICATION",
  persisted:true, canApply:false, affectsCurrentState:false,
  evidenceRelinked:false, historyProjectionPersisted:true,
  operationalHistoryApplied:false,
  reused:false|true,
  application: {
    id, itemId, requestId, requestDigest, planId,
    rulesVersion:"mda-group-history-link-application-1",
    plan: plan completo revisado y guardado,
    appliedById, appliedAt,
    links:[{
      id, historyApplicationId, evidenceId, assetId, version:1,
      evidenceVersion, amendmentId:null|UUID, sourceRevision,
      operation: operación completa del plan,
      projection: snapshot histórico con identidad efectiva del grupo
    }]
  }
}
```

La proyección conserva todos los campos del snapshot vigente, incluido original completo, fecha conocida/desconocida, precisión, actor histórico null, incidencias y datos operativos observados. Cambia exclusivamente assetId, identityLinkBlocked=false, linkBasis={type:"APPLIED_IDENTITY_GROUP",id:itemId} y serie/tag efectivos (keys y fields). No resuelve automáticamente incidencias ni acredita un periodo operativo válido. `operation` conserva interpretación anterior, versiones, fundamento humano y advertencias exactas. `appliedById/appliedAt` son responsable y momento de esta confirmación, nunca actor o fecha del evento histórico.

El activo puede estar actualmente asignado, inactivo o terminal: si su identidad/producto son compatibles, confirmar historia archivística no modifica su situación actual.

## Consulta y recuperación

- GET `BASE/history-link-applications?limit=25&offset=0`: solo JEFE, sin CSRF. Metadatos paginados, limit1..100, offset0..2147483647, orden appliedAt/id descendente. Respuesta con scope anterior, applications,total,limit,offset,hasMore; cada registro contiene id,itemId,requestId,planId,rulesVersion,appliedById,appliedAt,_count.links, sin snapshots pesados.
- GET `BASE/history-link-applications/:historyApplicationId`: solo JEFE, sin query adicional. Mismo scope con application completa y links ordenados por evidenceId. Todos los padres deben concordar;404 para comprobante de otro item/lote/revisión/aplicación.

Estas consultas muestran lo confirmado entonces, no una aprobación nueva de la identidad actual. Tampoco sustituyen las consultas legacy de evidencia. La futura aplicación operativa debe usar esta procedencia explícita y volver a validar su contexto.

## Errores

- 400 VALIDATION_ERROR;401/403 sesión/JEFE/CSRF;404 padres o evidencia ajenos.
- 409 IDEMPOTENCY_KEY_REUSED: misma clave con otra intención o actor; no reintentar modificando el cuerpo.
- 409 GROUP_HISTORY_LINK_PLAN_CHANGED: regenerar/revisar plan antes de nueva confirmación.
- 409 GROUP_HISTORY_LINK_BLOCKED: `details.operations[{evidenceId,blockers}]`; incluye advertencias sin reconocer, vínculo ya guardado, evidencia aplicada, identidad cambiada y los demás V22. No hay force.
- 409 EVIDENCE_VERSION_CONFLICT / IDENTITY_GROUP_APPLICATION_CHANGED y errores de procedencia/límites V22 conservados.
- 409 GROUP_HISTORY_LINK_CONFLICT: evidencia/plan duplicados a nivel SQL; recuperar comprobante y refrescar contexto.
- 409 GROUP_HISTORY_LINK_BUSY: transacción/bloqueo ocupado; reintento acotado con misma clave y cuerpo. Resultado de red incierto: tampoco generar otra clave por defecto.
- 503 IMPORT_REVIEW_NOT_READY: falta almacenamiento; instalar0026 antes de utilizar las rutas nuevas y el plan actualizado.

## Integridad y migración

0026 crea dos tablas vacías con FKs restrictivas, unicidad global por evidencia, huella de plan única y clave idempotente por item. Guards rechazan UPDATE/DELETE, actor no configurado, ámbito/identidad distintos, evidencia ajena/usada/desactualizada, proyección que altere original/fechas/actores/campos no autorizados y advertencias no reconocidas. Guard diferido exige cobertura completa, auditoría y contexto sin cambios al construir el comprobante. No reemplaza guardas anteriores ni la vista de evidencia vigente. Añade un bloqueo específico de enmiendas legacy sobre evidencia con vínculo confirmado. La guarda adicional de enmiendas también exige READ COMMITTED: una transacción SQL con snapshot antiguo no puede ignorar un vínculo confirmado mientras esperaba locks.

Antes de usar V23 en tu entorno, desde `/home/javier/inventory-ti`, con Node24 activo y `.env` apuntando a la base correcta:

```bash
pnpm db:migrate
node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma
```

Esto genera cliente y aplica migraciones pendientes; en el estado comunicado por el usuario solo falta0026. Realizar el respaldo habitual antes del despliegue. Este bloque no ejecutó esos comandos contra la base operativa.

## Traspaso al frontend

1. Mostrar los equipos/items ya aplicados V21, archivo original, interpretación vigente y propuesta histórica por separado.
2. Solicitar plan actualizado, permitir selección parcial y mostrar omitidas; reconocer advertencias exactas sin heredar decisiones V19.
3. Pedir confirmación humana explícita «Guardar vínculos históricos»; nunca «Aplicar asignaciones» o «Dar de baja».
4. Enviar plan exacto+huella con requestId estable; deshabilitar doble envío, conservar clave al fallar red y recuperar comprobante tras éxito/reintento.
5. Mostrar comprobante/proyecciones y paginación. Ante savedGroupLink, ofrecer consulta del comprobante, no otro botón de guardado ni una enmienda V12 como alternativa.
6. Manejar409 por contexto/versión/bloqueantes con nueva revisión,409 busy con reintento acotado y503 como falta de migración. No inferir éxito parcial.

No se envió ningún mensaje al otro chat ni se implementó su interfaz. Falta integrar/verificar esos recorridos y ejecutar el piloto autorizado con Excel real. La aplicación histórica operativa de grupos y sus correcciones siguen como próximos bloques backend, junto con las reglas pendientes de Tintas/bajas inciertas.

## Verificación

Consultar [informe Node24](verificacion-backend-node24.md) para el resultado final. Las pruebas nuevas cubren DTO/proyección, lectura conservadora, permisos, guardado parcial, idempotencia/concurrencia, omisiones posteriores, ámbitos, advertencias/vigencia, cancelación, enmiendas/null, fechas/actores desconocidos, estado asignado/terminal, rollback/auditoría, locks, almacenamiento ausente, guards SQL y migración sobre tablas pobladas. Solo datos sintéticos y bases descartables; no se afirma carga real ni integración frontend.

Resultado final:581 aprobadas,0 fallos/omitidas/canceladas,114.321s.25 nuevas (5 unitarias/20 integración), incluida la regresión de snapshot SQL antiguo detectada en revisión independiente. Build API forzado, lint API/tests completo, Prisma validate/generate y revisión de whitespace correctos.0026 aplicada solo en bases descartables eliminadas; ningún despliegue/migración operativa.
