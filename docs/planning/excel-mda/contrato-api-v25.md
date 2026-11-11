# Contrato API V25 — aplicación de periodos cerrados de grupos

Extensión posterior: [V26](contrato-api-v26.md) prepara rectificaciones de periodos aplicados, sin guardarlas, sin relajar inmutabilidad/consumo y sin nueva migración. La confirmación de V25 sigue siendo solo de la importación original.

Fecha:2026-10-20. Implementado y probado como extensión de [V24](contrato-api-v24.md), con confirmación y persistencia operativa propias. Requiere migración aditiva `0027_import_group_assignments` sobre0026, probada exclusivamente en bases descartables. No se instala en la base operativa durante este bloque. Frontend, dependencias y Excel real no modificados.

## Alcance y separación de efectos

Aplica1–25 periodos cerrados seleccionados para el activo de un item V21, con extremos enlazados y confirmados en V23 y plan V24 vigente. Crea registros `Assignment` cerrados/importados, comprobantes propios por periodo, consumo único de evidencias/vínculos y auditoría. La operación es atómica: todos los periodos seleccionados o ninguno.

No actualiza el activo ni su custodia actual. Una asignación abierta existente permanece intacta; tampoco cambia estado, metadatos, disponibilidad, fecha terminal, saldos o movimientos. Una devolución histórica a UNDER_REVIEW no pone hoy al activo en ese estado. Puede cargar historia anterior de un activo hoy asignado/inactivo/terminal si cumple las reglas temporales y de identidad.

Conserva archivo original, enmiendas, proyecciones V23, comprobantes V21 y consumo físico permanente. No reconstruye candidatos ni llama al aplicador legacy V11. No aplica préstamos abiertos, retiros terminales, consumos Tintas ni correcciones de historia ya aplicada.

## Confirmar aplicación

Base:

```text
/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId/items/:itemId
```

POST `BASE/closed-assignment-plan/apply`, solo JEFE autenticado+CSRF; UUID normalizados a minúsculas, parámetros/cuerpo estrictos y sin query adicional.

```text
{
  requestId: UUID estable para esta intención y sus reintentos,
  planId: SHA256 del plan V24 recién revisado,
  confirmation: "APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY",
  plan: {
    expectedApplicationPlanId: SHA256 del comprobante V21,
    links: [{evidenceId,linkId,expectedLinkVersion,expectedEvidenceVersion}],
    plan: {periods:[...intención V24 completa...]}
  }
}
```

No admite assetId libre, snapshots/proyecciones del cliente, actores históricos, captura elegida por cliente, force ni confirmaciones V11/V23 como sustituto. Preserva V24: fechas exactas con zona y respaldo independiente en ambos extremos, destinatario PERSON/OFFICE, STANDARD/LOAN, retorno explícito, advertencias exactas y ausencia de solapamientos.

## Vigencia, locks e idempotencia

Transacción READ COMMITTED: lock del lote y advisory por hash de fuente, ámbito exacto del item y búsqueda de comprobante idempotente. Para una intención nueva adquiere locks EXCLUSIVE NOWAIT sobre catálogo/activos/asignaciones/archivo/enmiendas/proyecciones, verifica consumo de extremos y reconstruye V24 dentro de esa misma transacción antes de comparar planId. No autoriza escritura con un plan calculado fuera de los locks.

Valida nuevamente comprobante V21 completo, cobertura física permanente, comprobantes/proyecciones V23 completos, versiones, interpretación actual, estado/identidad/producto, asignaciones actuales, fechas, destinatario y advertencias. No transfiere autoridad de una revisión V19 o de una confirmación de pertenencia V23 a la aplicación operativa.

Mismo item+requestId+actor+intención devuelve el comprobante previo antes de revalidar inventario actual, sin volver a escribir. Reordenar links/periodos/advertencias no cambia intención. Cambiar selección, versión, fecha, respaldo, nota, destinatario, retorno, huella o actor bajo esa clave devuelve409. Mantener la misma clave y cuerpo cuando se desconoce si una solicitud llegó a confirmar.

Dos claves que compiten por un mismo extremo no pueden confirmar ambas: el consumo es único por evidenceId y linkId. La cancelación administrativa posterior no borra ni revierte asignaciones, vínculos o consumos. Comprobantes anteriores siguen recuperables aunque después cambie la identidad/custodia del activo.

## Respuesta201 nueva /200 reutilizada

```text
{
  scope:"GROUP_CLOSED_ASSIGNMENT_HISTORY", mode:"APPLIED",
  persisted:true, canApply:false, affectsCurrentState:false,
  evidenceRelinked:false, operationalHistoryApplied:true,
  reused:false|true,
  application:{
    id,itemId,assetId,requestId,requestDigest,planId,
    rulesVersion:"mda-group-closed-assignment-application-1",
    plan: plan V24 completo confirmado,
    assetSnapshot,custodySnapshot,
    appliedById,appliedAt,createdTransactionId,
    items:[{
      id,applicationId,periodId,assignmentId,startLinkId,endLinkId,
      snapshot: periodo V24 completo,
      assignment: Assignment histórico cerrado,
      evidenceUses:[{evidenceId,linkId,itemId,endpoint:"START"|"END"}]
    }]
  }
}
```

Cada asignación tiene importedHistory=true, endedAt posterior a startedAt, personId/createdById/endedById/expectedReturnAt=null. PERSON mantiene personName, OFFICE mantiene officeName. Referencias de salida y retorno son independientes; notas=period.note y returnNotes=period.evidenceReference. `createdAt` y `returnRecordedAt` son la captura UTC de PostgreSQL de esta aplicación, idéntica a appliedAt. Los instantes efectivos son los confirmados en el periodo, no la fecha de importación.

appliedById identifica al importador/capturador; no lo convierte en quien entregó o recibió históricamente. No crea usuarios para destinatarios u oficinas.

assetSnapshot/custodySnapshot son copias de control SQL del activo completo y de sus asignaciones abiertas, usadas para comprobar que permanecen idénticos al confirmar. Son snapshots inmutables, no el estado vivo ni valores que el frontend deba reenviar o reinterpretar como fechas locales. Para mostrar fechas efectivas/captura usar Assignment y appliedAt.

createdTransactionId es un marcador interno de PostgreSQL generado y verificado por la base; se devuelve como texto opaco. No representa una fecha, usuario o clave de reintento, no se acepta en la solicitud y no debe reenviarse.

## Consulta y trazabilidad

- GET `BASE/closed-assignment-applications?limit=25&offset=0`: solo JEFE; limit1..100, offset0..2147483647. Respuesta con scope/banderas anteriores, applications,total,limit,offset,hasMore. Metadatos id,itemId,assetId,requestId,planId,rulesVersion,appliedById,appliedAt,_count.items; sin planes/snapshots pesados. Orden appliedAt/id descendente.
- GET `BASE/closed-assignment-applications/:groupApplicationId`: solo JEFE, sin query adicional. Devuelve application completa, items ordenados por periodId y usos por endpoint. Todos los padres deben concordar;404 para comprobantes de otro item/revisión/lote/aplicación.

Las consultas normales de asignaciones incluyen `groupImportHistory`, separado de importHistory legacy, con aplicación, periodo y links/usos. El historial del activo genera eventos ASSET_ASSIGNED/ASSET_RETURNED conservando source=IMPORTED_HISTORY para compatibilidad con el timeline existente; distingue el origen nuevo con importScope=GROUP_CLOSED_ASSIGNMENT_HISTORY, importApplicationId, importGroupItemId y recordedById. Actor histórico continúa null; effectiveAt conserva el instante confirmado y recordedAt la captura. Eventos legacy/operativos conservan su contrato anterior. Un comprobante con importScope agrupado se consulta en las rutas propias V25, no en el detalle legacy V11.

V24 sigue solo lectura y con sus banderas false. Ahora sus vínculos seleccionados/omitidos incluyen groupAssignmentUse y bloquea ENDPOINT_EVIDENCE_ALREADY_APPLIED al seleccionar extremos consumidos en V25. Las banderas conservadoras del plan no se reutilizan como autorización de escritura: esta confirmación tiene contrato propio.

## Integridad SQL y migración

0027 añade tres tablas con FKs restrictivas, claves de idempotencia/plan, unicidad de extremos y comprobantes inmutables. Valida relación entre aplicación/item/grupo, identidad/producto, versiones vigentes, proyección y pertenencia física, fechas y respaldo, destinatario/préstamo/retorno, ausencia de uso anterior y coincidencia exacta del Assignment con el periodo confirmado.

Las guardas de origen histórico existentes se amplían únicamente para reconocer un origen agrupado completo; las rutas/guardas legacy de reservas y consumo no se relajan. Toda asignación importada sigue necesitando comprobante completo. Guardas diferidas exigen cobertura de todos los periodos, dos usos exactos por periodo, auditoría y activo/custodia sin cambios. Las asignaciones y comprobantes de este flujo no se editan ni borran; requieren un futuro flujo explícito de corrección.

Las escrituras sobre activo/custodia se protegen también durante la transacción creadora, aunque se adelante `SET CONSTRAINTS ALL IMMEDIATE` o se use/libere un SAVEPOINT. Solo se permite insertar sus periodos cerrados previstos. El marcador de transacción se complementa con la ventana de captura para no confundir recibos restaurados de otra instalación; los cambios operativos legítimos en transacciones posteriores siguen permitidos. Un recibo legacy posterior tampoco puede dar segundo origen a una asignación V25 ya confirmada.

Esta versión incorpora lecturas de las tablas nuevas en planificación y consultas de asignaciones/historial. Instalar0027 antes de ejecutar el backend actualizado, no solo antes de pulsar la nueva confirmación.

Antes de utilizar V25 en el entorno del usuario, con respaldo habitual, Node24 y `.env` apuntando a la base correcta:

```bash
cd /home/javier/inventory-ti
pnpm db:migrate
node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma
```

El último estado confirmado por el usuario era0025; si no se aplicó0026 desde entonces, este comando instalará0026 y0027. Este bloque no ejecuta migraciones contra esa base ni presume que ya estén instaladas.

## Errores

- 400 VALIDATION_ERROR;401/403 autenticación/JEFE/CSRF;404 ámbitos o recursos ajenos.
- 409 IDEMPOTENCY_KEY_REUSED: otra intención/actor bajo la misma clave.
- 409 GROUP_ASSIGNMENT_PLAN_CHANGED: regenerar y revisar el plan vigente antes de una nueva intención de aplicación.
- 409 GROUP_ASSIGNMENT_PLAN_BLOCKED: details.periods[{periodId,blockers}], sin aprobación parcial ni force.
- 409 GROUP_ASSIGNMENT_EVIDENCE_ALREADY_APPLIED: extremo consumido; recuperar aplicación/asignación indicadas en details, no generar otra clave para repetirlo.
- 409 GROUP_ASSIGNMENT_APPLICATION_CONFLICT: unicidad de plan/solicitud/extremo, recuperar comprobante y refrescar contexto.
- 409 GROUP_ASSIGNMENT_APPLY_BUSY: locks/transacción ocupados; reintento acotado con la misma clave y cuerpo.
- Conflictos de versión/procedencia/límites V24 se conservan.
- 503 IMPORT_REVIEW_NOT_READY: falta almacenamiento; completar0027 antes de usar las extensiones.

## Traspaso al frontend y pendientes

1. Preparar/revisar V24 y mostrar archivo, proyección, fechas confirmadas, destinatario/retorno y advertencias por separado.
2. Pedir confirmación humana «Importar periodos históricos cerrados», explicando que no cambia la custodia actual. No ofrecer aplicar con bloqueantes.
3. Enviar el plan exacto, su huella y requestId estable. Deshabilitar doble envío y conservar la clave ante incertidumbre de red.
4. Tras201/200, mostrar comprobante y refrescar historial/consumo. Ante409 recuperar o regenerar según código; no reconstruir periodos mediante varias llamadas CRUD/legacy.
5. Mostrar captura/importador separados de los actores/fechas históricas. Un periodo importado cerrado no es una asignación actual ni habilita devolución/edición de esa fila.

Frontend no modificado ni contactado. Permanecen pendientes las correcciones de historia aplicada, flujos de retiros/bajas agrupados o inciertos, reglas Tintas, integración y piloto autorizado con Excel real. No se afirma carga real del workbook ni finalización de todos los flujos históricos.

## Verificación

633 pruebas aprobadas,0 fallos/omitidas/canceladas en Node24.22.0/PostgreSQL18.6;27 nuevas en este bloque. Compilación API forzada, lint completo API/tests, Prisma validate/generate y whitespace correctos. Consultar [informe Node24](verificacion-backend-node24.md). Validación en bases descartables con fixtures sintéticas; no acredita integración frontend ni despliegue/importación operativos.
