# Contrato API V27 — rectificaciones históricas versionadas

Fecha:2026-10-20. Extiende [V26](contrato-api-v26.md) con confirmación, persistencia, comprobantes y lecturas efectivas. Requiere migración aditiva `0028_import_group_assignment_corrections` y cliente Prisma actualizado. Se prepara/prueba solo en bases descartables; no se instala en la base operativa durante este bloque. Validación final:686 pruebas aprobadas,0 fallos/omitidas/canceladas, Node24.22.0/PostgreSQL18.6,162.918s; build API forzado, lint API/tests completo, Prisma validate/generate y whitespace correctos. [Informe Node24](verificacion-backend-node24.md). No acredita integración ni carga real.

## Qué se guarda y qué permanece intacto

Cada rectificación confirmada añade un evento inmutable para un item V25, con versión, evento anterior, motivo/respaldo propios, propuesta completa, autor actual, captura, huellas y auditoría. No actualiza ni borra Assignment original, comprobantes V21/V23/V25, archivo, enmiendas ni consumo de extremos. No crea otra asignación, destinatario/usuario, stock ni movimiento.

La última versión define los hechos históricos efectivos: instantes de entrega/retorno, destinatario PERSON/OFFICE, STANDARD/LOAN, condición histórica de retorno, nota y respaldos. Tickets/OT siguen derivados de las fuentes. Activo, periodo y dos evidencias no se sustituyen. Las reglas V26 de día conocido, respaldo temporal, advertencias exactas, identidad/producto, no-op, futuro, baja y solapamientos siguen vigentes.

No modifica custodia, estado, metadatos ni updatedAt actuales del activo. Puede corregir historia de un activo hoy asignado o terminal si respeta sus límites. El corrector no se convierte en actor histórico; los actores desconocidos siguen null. Original capturado, rectificación y estado actual permanecen separados.

No corrige periodos legacy V11, archivo aplicado, bajas terminales, préstamos abiertos ni identidades. No hay DELETE/PATCH ni liberación de usos. Volver a valores originales exige una nueva versión y respaldo, y solo se acepta si sigue siendo válida frente al contexto actual.

## Plan actualizado V26

Misma ruta de revisión y mismo cuerpo V26, con `expectedCorrectionVersion` entero0..1000. Omitirlo equivale a0 por compatibilidad inicial; tras la primera rectificación se debe enviar la versión vigente. El servidor no aplica automáticamente sobre una versión diferente.

Además devuelve:

```text
currentCorrectionVersion,currentCorrectionId,correctionChainDigest,
proposedPeriod: periodo completo revisado con fuentes fijas
```

before es la última versión efectiva o el original si la versión es0. originalPeriod/originalAssignment siguen siendo originales. La revisión no escribe y conserva sus banderas false, incluido correctionApplicationImplemented, como contrato conservador de V26. La capacidad de confirmación pertenece a la ruta y contrato explícitos V27; no se deduce de las banderas del plan.

Mantener la zona y las pruebas de proposedPeriod al preparar otra rectificación; no sustituir automáticamente confirmedAt por una fecha UTC formateada si eso altera el día local conocido de la fuente.

## Confirmación y consultas

Base del item histórico:

```text
/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId/items/:itemId/closed-assignment-applications/:groupApplicationId/items/:assignmentItemId
```

Solo JEFE autenticado. POST exige CSRF; UUID normalizados, cuerpos/parámetros estrictos y sin query extra en escritura/detalle.

POST `BASE/correction-plan/apply`:

```text
{
  requestId: UUID estable para esta intención y sus reintentos,
  correctionPlanId: SHA256 del plan V26 recién revisado,
  confirmation:"APPLY_GROUP_ASSIGNMENT_CORRECTION",
  plan:{
    expectedOriginPlanId: planId del comprobante V25,
    expectedCorrectionVersion: versión vigente,
    reason,supportingReference,
    correction:{start,end,recipient,assignmentType,returnStatus,note,evidenceReference,acknowledgedWarnings}
  }
}
```

No admite assetId, identificadores de extremos, versión nueva elegida, previousId, actor, fecha de captura, snapshots, force ni confirmaciones V25/V11 como sustituto. Se reconstruye y valida el plan dentro de la transacción de escritura.

Respuesta201 nueva /200 recuperación:

```text
{
  scope:"GROUP_CLOSED_ASSIGNMENT_CORRECTION",persisted:true,reused:false|true,
  affectsCurrentState:false,evidenceRelinked:false,operationalHistoryApplied:true,canApply:false,
  correction:{
    id,itemId,version,previousId,requestId,requestDigest,correctionPlanId,
    rulesVersion:"mda-group-assignment-correction-application-1",
    plan,reason,supportingReference,assetSnapshot,custodySnapshot,
    correctedById,correctedAt,createdTransactionId
  }
}
```

correctedAt es la captura UTC de PostgreSQL, no un instante histórico. Snapshots SQL y createdTransactionId son controles internos opacos, no campos reenviables ni sustitutos de fechas efectivas.

- GET `BASE/corrections?limit=25&offset=0`: metadatos sin planes/snapshots, total/limit/offset/hasMore; orden por versión descendente. Limit1..100 y offset0..2147483647.
- GET `BASE/corrections/:correctionId`: comprobante completo;404 para cualquier padre/item/evento ajeno.

Cada item admite versiones1..1000, secuenciales y con referencia exacta a la anterior. El plan devuelve un bloqueante al alcanzar el límite.

## Atomicidad, vigencia y reintentos

READ COMMITTED, lock de lote y advisory de fuente; contexto original limitado al item y búsqueda idempotente antes de revalidar inventario. Una intención nueva adquiere locks EXCLUSIVE NOWAIT de catálogo/activos/asignaciones/archivo/proyecciones/rectificaciones. Revalida origen V25 completo y padres V21/V23, cadena, versión y propuesta; compara huella, inserta evento y auditoría en una sola transacción. Ante fallo no queda una versión parcial ni se consume la clave.

Mismo item+requestId+actor+intención recupera exactamente el evento anterior, incluso después de cambios posteriores de inventario o nuevas versiones. La misma clave con otro actor/intención devuelve409. Advertencias reordenadas se normalizan; cambios en versión, fechas, notas, destinatario o respaldo sí cambian intención. Ante incertidumbre de red conservar clave y cuerpo; no generar otra clave para intentar duplicar la operación.

Dos solicitudes nuevas para una versión previa no pueden confirmar ambas. El segundo solicitante debe recargar/revisar la versión efectiva actual. Cancelar una revisión administrativa no revierte eventos, origen ni consumos.

## Lecturas y reglas temporales efectivas

Assignment físico y GET de comprobantes originales V25 siguen mostrando lo aplicado originalmente. La vista SQL `AssignmentEffective` calcula la última versión sin reescribir datos.

Las consultas normales `/assignments`, `/assignments/:id` y `/assets/:id/assignments` presentan los campos históricos efectivos en el nivel habitual. Solo para filas corregidas añaden:

```text
originalAssignment: registro original con sus relaciones de lectura,
historyCorrection:{id,version,correctedById,correctedAt}
```

Los filtros de destinatario/tipo/oficina, conteos, orden y paginación se calculan sobre valores efectivos, en un snapshot coherente. currentAssignment abierto no se sustituye por un periodo corregido, que siempre permanece cerrado.

El timeline del activo usa instantes/valores efectivos, conserva source=IMPORTED_HISTORY y procedencia agrupada, actor histórico null y captura/importador originales; añade historyCorrection y originalAssignment. El corrector/captura de la rectificación se muestra aparte, sin fingir una entrega/retorno nuevos.

Los planes de historia V11/V24/V26 y bajas/reconciliación V14/V15 usan periodos efectivos. También las guardas SQL de nuevas asignaciones, importaciones agrupadas y bajas, y el límite terminal del activo. Una fecha histórica ampliada bloquea solapamientos nuevos; una fecha acortada permite usar el intervalo realmente liberado, sin borrar ni liberar los extremos de evidencia originales.

Escrituras de Assignment y fechas terminales exigen READ COMMITTED para impedir bypass con snapshots SQL antiguos. Los servicios de escritura existentes lo usan por defecto; las lecturas de planificación/paginación continúan en REPEATABLE READ. No usar transacciones de escritura REPEATABLE READ externas para evitar vigencia.

## Integridad SQL y despliegue

0028 añade tabla de eventos/vista efectiva/FKs restrictivas/unicidad por item-versión y solicitud, y guardas de origen, autor, cadena, huellas, valores antes/después, fuentes, fechas, auditoría e inmutabilidad. UPDATE/DELETE/TRUNCATE de eventos son rechazados. No añade ni reescribe filas históricas existentes.

Reutiliza las reglas SQL de procedencia V25 conservando sus validaciones; cambia únicamente las lecturas temporales que deben consultar la versión efectiva. La migración comprueba que las funciones previas esperadas existan antes de adaptarlas, y falla de forma transaccional si hay una definición inesperada. Las protecciones de activo/custodia sobreviven constraints adelantados y SAVEPOINT liberados; cambios operativos posteriores legítimos siguen funcionando.

Instalar0028 antes de iniciar este backend actualizado, también por sus lecturas efectivas. Con respaldo habitual, Node24 y `.env` de la base destino revisado:

```bash
cd /home/javier/inventory-ti
pnpm db:migrate
node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma
```

Si sigue aplicada solo0025, se instalarán0026/0027/0028. Este bloque no ejecuta ese comando contra la base operativa ni presume que dichas migraciones ya estén allí.

## Errores y traspaso frontend

- 400 VALIDATION_ERROR;401/403 autenticación/JEFE/CSRF;404 ámbito ajeno.
- 409 GROUP_CORRECTION_VERSION_CONFLICT: recargar versión, no sobrescribir.
- 409 GROUP_CORRECTION_PLAN_CHANGED: regenerar/revisar la intención actual.
- 409 GROUP_CORRECTION_PLAN_BLOCKED: details.blockers, sin force ni guardado parcial.
- 409 IDEMPOTENCY_KEY_REUSED: clave ligada a otro actor/intención.
- 409 GROUP_CORRECTION_CONFLICT: unicidad de solicitud/versión/plan; recuperar comprobante y contexto.
- 409 GROUP_CORRECTION_BUSY: retry acotado con misma clave/cuerpo.
- 409 INVALID_GROUP_CORRECTION_CHAIN: cadena inconsistente, no reconstruirla con CRUD ni otra importación.
- Errores de origen/archivo/límites V26 se conservan;503 IMPORT_REVIEW_NOT_READY si falta almacenamiento/vista efectiva.

Frontend: revisar plan/diferencias, pedir confirmación «Guardar rectificación histórica», enviar literal/huella/versión exactos y requestId estable. Tras201/200 mostrar comprobante y refrescar lecturas efectivas. Mostrar original, última versión y corrector separados de custodia/importador/actores históricos. No llamar PATCH Assignment ni aplicar varias solicitudes para simular una rectificación. Frontend no modificado ni contactado.

Pendientes: correcciones legacy/documentales aplicadas, bajas agrupadas o inciertas, reglas Tintas, integración frontend/backend y piloto autorizado con respaldo/conciliación y Excel real.
