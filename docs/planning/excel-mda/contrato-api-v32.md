# Contrato API V32: confirmación documental propia de bajas agrupadas

Estado al2026-10-20: implementación backend, sin carga del workbook, despliegue ni cambios/contacto frontend. Migración0031 aditiva preparada; requiere migraciones anteriores y cliente Prisma regenerado. No confundir contratoV31 con migración0031: V31 no añadió almacenamiento, V32 sí.

## Política y alcance

V32 registra una versión específica de una observación de baja frente a un equipo previamente terminal, con comprobante y auditoría atómicos. No ejecuta otra baja, no completa fechas, no enlaza el archivo y no cambia equipo/updatedAt/metadatos, asignaciones, stock, movimientos, reservas ni consumos. Fecha/actor históricos desconocidos siguen siendo null. Una observación sin fecha sobre un equipo no terminal continúa pendiente.

Exige revisión agrupada activa, proyección vigente y última decisión explícita LINK_EXISTING para el equipo único. Hereda versiones, integridad, identidad física, procedencia por fila y cobertura completa del archivo de V18/V19/V28. Una revisión cancelada no autoriza un plan o comprobante nuevo; V31 continúa disponible para consultarla sin reactivarla.

Fuentes admitidas:

- Grupo reservado y todavía no consumido, con equipo terminal coherente fechado o sin fecha conocida.
- Grupo cuyas filas ya fueron consumidas íntegramente por su propio comprobante V29, mismo lote/revisión/grupo/equipo: permite documentar solo una observación adicional omitida, no la utilizada para ejecutar la baja. Se necesita una decisión V19 nueva contra la proyección actual después de V29. No libera ni vuelve a consumir filas y no modifica aquel comprobante.

Consumos V21, ajenos, mezclados o incompletos permanecen bloqueados. No se admite reutilización de evidencia aplicada a asignaciones/retiros ni una versión ya documentada en V30 o V32. La confirmación documental no es una nueva autoridad operativa sobre fuentes consumidas.

## Preparar un plan propio

Base `R=/inventory/imports/batches/:id/identity-group-reviews/:reviewId`.

`POST R/retirement-document-plan`, JEFE autenticado+CSRF, query vacía. Cuerpo estricto:

```json
{
  "expectedBatchVersion": 1,
  "expectedSourceRevision": 0,
  "expectedDecisionVersion": 1,
  "projectionId": "huella real de la proyección vigente",
  "groupKey": "huella real del grupo físico",
  "decisionId": "00000000-0000-4000-8000-000000000001",
  "expectedEvidenceVersion": 0,
  "acknowledgedGroupWarnings": [],
  "document": {
    "evidenceId": "00000000-0000-4000-8000-000000000002",
    "note": "Se revisó esta observación frente a la baja existente",
    "evidenceReference": "Referencia al archivo y comprobante revisados",
    "acknowledgedWarnings": []
  }
}
```

Las huellas deben ser los valores reales hexadecimales minúsculos de64 caracteres, no los textos explicativos del ejemplo. UUID normalizados a minúsculas; versiones de fuente/evidencia entre0 y1000. note1–2000/evidenceReference1–500 caracteres; hasta500 reconocimientos únicos de grupo y1000 históricos. Ambos conjuntos de advertencias deben coincidir exactamente con sus listas vigentes. No acepta fechas, confirmaciones de baja, force, actor, estado ni snapshots del cliente.

Respuesta200: scope=GROUP_RETIREMENT_DOCUMENT_RECONCILIATION, mode=GROUP_RETIREMENT_DOCUMENT_PLAN, rulesVersion=mda-group-retirement-document-1, planId y planValidationComplete. canApply/persisted/affectsCurrentState/evidenceRelinked/confirmsSourceDate/consumesOperationalEvidence/historicalActorKnown permanecen false. Un plan completo no guarda nada por sí mismo.

Contenido ligado por huella:

- Contexto: lote/revisión/grupo/hash, versiones, decisionId/decisionVersion/decisionProofDigest, projectionId, checkedAsOf y timeZone America/Santiago; request normalizado con ambos conjuntos de reconocimientos ordenados.
- Equipo: assetBefore con producto, assetSnapshot completo y existingRetirement. Esta última conserva effectiveAt real o null, precisión INSTANT|UNKNOWN y origen CURRENT_ASSET|VERIFIED_IMPORT_RECEIPT|GROUP_VERIFIED_IMPORT_RECEIPT; confirmsSourceDate=false.
- Archivo: sourceRows y evidenceCoverage de todas las observaciones del grupo, con versiones/incidencias/huellas; originalEvidence y currentEvidence sin reescribir. proposedEvidenceProjection es una propuesta en memoria REVIEWED_IDENTITY_GROUP_PROPOSAL, no un vínculo persistido. source mantiene captura, lote de origen, revisiones, versión, enmienda, campos y huella propuesta separados.
- sourceRetirement conserva effectiveAt=null/datePrecision=UNKNOWN/historicalActorId=null para baja; es null si se seleccionó otra clase de observación, con bloqueante RETIREMENT_EVIDENCE_KIND_REQUIRED.
- retirementReceipts conserva metadatos y padres reales de V14/V29; sourceConsumption describe las filas ya consumidas, no nuevas escrituras. Huellas de asignaciones efectivas y revisiones, warnings/groupWarnings y blockers.

Planificación en REPEATABLE READ, timeout15s; conserva límites previos de25 filas,100 observaciones,10000 asignaciones y1000 revisiones. Contextos demasiado grandes o corruptos fallan explícitamente, sin aprobar un resultado truncado.

## Confirmación explícita

`POST R/retirement-document-plan/confirm`, JEFE+CSRF, query vacía:

```json
{
  "requestId": "00000000-0000-4000-8000-000000000003",
  "planId": "huella real del plan documental revisado",
  "confirmation": "RECONCILE_GROUP_RETIREMENT_DOCUMENT_ONLY",
  "plan": { "...": "cuerpo de entrada exacto del plan anterior" }
}
```

El objeto plan del ejemplo es explicativo: enviar el cuerpo de entrada anterior completo, no la respuesta del servidor. Mantener requestId y cuerpo ante una respuesta incierta. No acepta assessmentId de V31 ni confirmaciones V14/V29/V30.

201 para un comprobante nuevo;200 para recuperación exacta del mismo requestId, actor e intención. Respuesta con scope, persisted=true, reused y reconciliation; todas las banderas de efecto operativo permanecen false. reconciliation incluye contexto, versión capturada, huellas, plan completo, recordedById y recordedAt de captura. El importador no se convierte en actor de la baja histórica.

Revalidación READ COMMITTED con lock de lote/fuente, contexto serializado y hora UTC milisegundos de PostgreSQL. Crea únicamente ImportGroupRetirementDocument y AuditLog IMPORT_GROUP_RETIREMENT_DOCUMENT_RECONCILED. Un fallo de auditoría revierte el comprobante. Reintentos ligan ambos conjuntos de reconocimientos independientemente del orden, pero no permiten cambiar intención/actor/versión/huella con la misma clave.

Recuperar un comprobante existente después de cancelar la revisión no genera autoridad nueva. Un requestId nuevo sigue rechazado. Cambios posteriores no modifican el plan/versión capturados ni convierten un reintento en una nueva conciliación.

## Consultar comprobantes

- `GET R/retirement-documents?limit=50&offset=0`, JEFE; paginación estándar V9 con reconciliations,total,limit,offset,hasMore. Metadatos de contexto/versiones/actor/captura, sin plan pesado.
- `GET R/retirement-documents/:reconciliationId`, JEFE; query vacía, detalle completo bajo lote y revisión exactos. Padres ajenos devuelven404, no redireccionan.

Ambas consultas conservan acceso tras cancelación. V31 sigue siendo diagnóstico de solo lectura y sus banderas conservadoras se refieren a ese endpoint; no usar su assessmentId como aprobación. Esta ruta V32 es el flujo explícito de confirmación independiente. documentAssociations de V31 mantiene su alcance V30; para comprobantes agrupados consultar los GET de V32.

Paginación: limit predeterminado25, máximo100; offset predeterminado0. No admite filtros extra.

## Errores y almacenamiento

401/403 autenticación/rol/CSRF;400 cuerpo/query inválidos;404 padres/equipo/grupo/evidencia inexistentes o ajenos;503 IMPORT_REVIEW_NOT_READY sin almacenamiento0031. Errores409 relevantes:

- GROUP_DOCUMENT_BLOCKED con details.blockers: revisar todos los conflictos, no recurrir a CRUD.
- GROUP_DOCUMENT_PLAN_CHANGED: regenerar y revisar el plan documental.
- IDENTITY_GROUP_PROJECTION_CHANGED/GROUP_DECISION_STALE/GROUP_DECISION_NOT_LATEST/IDENTITY_GROUP_DECISION_VERSION_CONFLICT y conflictos de versión previos: refrescar contexto/decisión antes del plan. Un cambio de equipo puede invalidar primero la proyección, sin llegar al error del plan documental.
- IDENTITY_GROUP_ALREADY_RELEASED: no reactivar la revisión cancelada para confirmar.
- IDEMPOTENCY_KEY_REUSED: misma clave para actor o intención diferentes.
- GROUP_DOCUMENT_BUSY: reintentar la misma solicitud; GROUP_DOCUMENT_CONFLICT: consultar comprobante y reevaluar versión.

Bloqueantes principales: EXISTING_TERMINAL_RETIREMENT_REQUIRED, RETIREMENT_DOCUMENT_ALREADY_RECONCILED, GROUP_DOCUMENT_SOURCE_CONSUMPTION_REQUIRES_REVIEW, EVIDENCE_ALREADY_APPLIED; se conservan conflictos de estado/custodia/cronología/identidad/fuente y ambas listas exactas de advertencias. No se pide prueba de fecha de baja para documentar un terminal existente ni se ignoran conflictos para inventarla.

0031 es aditiva, sin backfill ni reescritura de inventario. Tabla/FKs/índices, una captura por evidencia/versión, huellas/autor/contexto/fecha de captura, comprobación diferida de auditoría atómica e inmutabilidad de comprobantes/auditorías. SQL impide terminal creado o modificado en la propia transacción, falsa procedencia, versiones/consumos ajenos y contexto cambiado tras constraints adelantados/SAVEPOINT. Ambas tablas V30/V32 impiden duplicados cruzados con serialización por hash. V30 también informa el bloqueante al preparar su plan; sus bloqueos de reserva/consumo no se relajan.

Si la base sigue en0025, ejecutar `pnpm db:migrate` instala0026–0031 y regenera Prisma antes de iniciar el backend actualizado, incluidas lecturas V30/V32. No se ejecutó sobre la base operativa durante este bloque. Mantener respaldo y revisar DATABASE_URL según el procedimiento de despliegue existente.

## Traspaso y pendientes

Verificación:786 pruebas aprobadas,0 fallos/omitidas/canceladas,253.286s en Node24.22.0 Linux/PostgreSQL18.6 independiente.20 nuevas (2 unitarias/17 integración/1 migración); build forzado/lint API/tests/Prisma validate/generate/whitespace correctos. Base descartable eliminada, cero restantes y servidor temporal detenido. No equivale a despliegue ni carga real.

Frontend: separar «Consultar conciliación» V31 de «Guardar constancia documental» V32. Mostrar fuente/fecha terminal/captura y original/actual/proyección propuesta por separado; conservar prueba y notas, exigir ambas listas de avisos y plan vigente. Después de201/200 consultar el comprobante sin mostrar una nueva baja ni liberar filas. Para grupos V29 ya consumidos, renovar decisión V19 y seleccionar una observación adicional no aplicada; no asumir que una revisión cancelada o una fila consumida autoriza documentar cualquier evidencia.

Pendientes separados: rectificaciones legacy/documentales con contratos propios; consumos V21 o ajenos no admitidos aquí; significado/unidad de Tintas; integración frontend y piloto del workbook real con autorización, respaldo y conciliación. No equivale a carga real ni cierre de todos los pendientes del backend.

Ver resultados y alcance de verificación en [informe de backend](verificacion-backend-node24.md).
