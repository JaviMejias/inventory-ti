# Contrato API V13: plan de bajas históricas

Estado al 2026-10-05: implementado en código, solo lectura y sin migración nueva. No carga el Excel real ni aplica bajas. Requiere API/Prisma y almacenamiento V9–V12 con sus prerrequisitos, incluida0021 para consultar enmiendas vigentes. Este contrato no acredita despliegue.

Actualización V14: [contrato API V14](contrato-api-v14.md) añade aplicación separada y comprobantes; requiere0022 también para las lecturas actuales V12/V13 y activos. El endpoint de plan mantiene todos sus flags false. No se ha desplegado ni cargado el workbook.

## Alcance

Prepara una baja histórica de **un activo existente** desde una observación RETIREMENT_OBSERVATION archivada en V9, usando su interpretación/vínculo vigentes V12. Permite revisar procedencia, faltantes y conflictos antes de implementar su aplicación transaccional.

Siempre responde canApply=false, persisted=false y affectsCurrentState=false. planValidationComplete=true significa únicamente que las comprobaciones del plan no encontraron bloqueos; no autoriza ni ejecuta una baja. No modifica activos, asignaciones, cantidades, movimientos, evidencia, revisión, usuarios ni auditoría. No guarda ni reserva el plan.

Fecha en las hojas de bajas corresponde a recepción; el año del nombre de hoja tampoco prueba el momento del retiro. La fecha de baja fuente permanece effectiveDay=null/datePrecision=UNKNOWN. Si se confirma un instante de retiro mediante respaldo externo, solo aparece en proposedRetirement, sin reescribir la captura. El ejecutor histórico permanece null y no se atribuye al revisor actual.

Una baja sin fecha/hora/zona verificadas puede archivarse con V9 y revisarse aquí, pero permanece bloqueada para este flujo. No se completa con hoy, medianoche, capturedAt, receivedDate ni año de hoja. La resolución/aplicación de bajas con precisión desconocida requiere un tratamiento propio; V13 no la declara implementada.

## Ruta y acceso

POST /assets/:id/imported-retirement-plan, solo JEFE+CSRF. :id UUID de activo, normalizado a minúsculas. Respuesta200 tanto para planes válidos como incompletos/con conflictos.

No existe GET de plan persistido. /apply separado se documenta en V14 y exige su propio DTO/confirmación. Frontend puede obtener evidencia mediante /assets/:id/imported-evidence y las rutas V9/V12. No debe llamar a /assets/:id/decommission para simular esta importación: esa operación registra una baja corriente con fecha del servidor y actor actual, sin la procedencia histórica requerida.

## Request estricto

```json
{
  "evidenceId": "<uuid de observación histórica de baja>",
  "confirmation": "VERIFIED_HISTORICAL_RETIREMENT",
  "confirmedAt": "2005-01-01T09:00:00-03:00",
  "dateEvidenceReference": "Documento que confirma fecha, hora y zona del retiro",
  "note": "Retiro físico contrastado con documentación, independiente de recepción",
  "evidenceReference": "Acta de baja firmada",
  "acknowledgedWarnings": []
}
```

- evidenceId UUID obligatorio, normalizado a minúsculas; no candidateId, recordId ni ID de captura.
- confirmation literal obligatorio; es declaración de verificación humana, no confirmación de aplicación.
- confirmedAt ISO8601 con Z/offset, desde1900, fecha real y precisión máxima milisegundos. Null/omitido→null permite mostrar el faltante. No fecha sin hora/zona.
- dateEvidenceReference trim1–500, null/omitido→null. Aun con confirmedAt se exige respaldo explícito del instante. No se descarga ni certifica el contenido de esa referencia.
- note trim1–2000 y evidenceReference trim1–500, obligatorios. Referencias aportadas son datos, no instrucciones para acceder a archivos/URLs.
- acknowledgedWarnings array SHA256 minúsculo64, default[], máximo1000, sin repetidos. Son IDs exactos de warnings devueltos por el plan, no códigos de incidencia.

No acepta force, actor histórico, estado actual, datos de fuente/snapshot, canApply ni varios retiros. Valores mal formados devuelven400; faltantes admitidos por el DTO devuelven200 con bloqueos.

## Comprobaciones

1. Observación persistida de tipo RETIREMENT_OBSERVATION, vinculada al activo elegido, identidad resuelta y serie/tag coherentes con su identidad actual. No enlaza por coincidencia de texto ni usa recepción/uso/préstamo como prueba de baja.
2. Reglas de captura compatibles y snapshot/procedencia interpretables. Una fecha efectiva fabricada en una observación de baja no se interpreta como confirmada. Correcciones posteriores del mismo candidato bloquean hasta refrescar mediante V12; correcciones de otros candidatos no bloquean por sí solas.
3. Se consulta la versión/enmienda vigente. La captura original y su sourceRevision quedan diferenciadas de evidenceVersion/amendmentId/sourceRevision efectiva. Un vínculo original no sirve si la última enmienda lo eliminó.
4. Instante explícito no futuro y respaldo de fecha obligatorio. receivedDate solo se usa como límite cronológico por día, nunca como fecha de baja. Si se conoce un día de recepción válido, el día local escrito en confirmedAt no puede ser anterior. Una recepción ilegible, inválida o futura informada no se ignora. No se inventa hora/zona de recepción.
5. Producto ASSET. Un catálogo inactivo no impide por sí solo revisar el retiro de su equipo; no se reactiva el catálogo. Activo ya inactivo, DECOMMISSIONED o con decommissionedAt informado exige conciliación: no se sustituye su fecha ni se reabre.
6. Coherencia de ASSIGNED con exactamente una asignación abierta. Cualquier asignación vigente bloquea, incluso si empieza después de la fecha propuesta. No se cierra ni se devuelve automáticamente para forzar la baja.
7. Todas las asignaciones cerradas del activo deben terminar a más tardar en el instante de retiro; igualdad es admisible. Un periodo cerrado invertido/cero también bloquea. No borra ni modifica periodos conflictivos. Capturas/auditorías posteriores no se confunden con acontecimientos históricos posteriores.
8. Evidencia reservada por V11 no se reutiliza. V13 no hace una reserva nueva ni introduce persistencia/idempotencia de aplicación.
9. Todas las incidencias BLOCKING de origen conservan su bloqueo, incluidas las tres de estado que V10 permite reconocer como contexto de historia cerrada. Una baja futura cambiaría el estado actual; V13 no hereda esa excepción. Warnings requieren reconocimiento exacto; IDs ajenos bloquean.

Este plan comprueba la observación seleccionada, revisiones de su lote y asignaciones del activo. No certifica la totalidad del Excel, no elige automáticamente la última fila ni determina que no exista más evidencia contradictoria fuera de lo seleccionado.

## Respuesta y vigencia

- planRulesVersion=mda-retirement-plan-1, scope/mode=HISTORICAL_RETIREMENT_PLAN.
- checkedAsOf día UTC de comprobación; assetBefore con identidad, estado, fecha de baja, updatedAt y producto trackingMode/isActive/updatedAt.
- request normalizado; source con evidenceId/captureId/batchId/sourceHash/recordId/candidateId/kind, hoja/fila, versiones capturada/efectiva, enmienda, día/precisión originales vigentes, sourceReceivedDay, campos efectivos y snapshotDigest.
- proposedRetirement={assetId,status:DECOMMISSIONED,isActive:false,decommissionedAt:ISO-UTC|null,historicalActorId:null}. Es una propuesta consultiva, **no un DTO operativo ejecutable**.
- warnings=[{id,evidenceId,issue}], blockers=[{code,relatedId?}], planValidationComplete y summary={retirementCount:1,validCount:0|1,blockingCount,warningCount}.
- currentAssignmentsDigest, sourceRevisionsDigest y planId SHA256 vinculan propuesta/respaldo, observación/vínculo/versiones, reglas/día de comprobación y snapshots del activo/producto/historia/revisiones. Orden de asignaciones/revisiones y acknowledgements no altera la huella.
- canApply=false, persisted=false, affectsCurrentState=false, también cuando el plan es válido.

Lectura consistente RepeatableRead, timeout15s. No mantiene locks tras responder. La futura aplicación deberá revalidar bajo locks y añadir procedencia inmutable, comprobante, idempotencia, auditoría atómica y guardas de base. El planId no es una clave de reintento de escritura.

## Errores y límites

- 400 VALIDATION_ERROR: UUID/fecha/confirmación/prueba/acks o campos no admitidos.
- 401/403: sesión/rol JEFE/CSRF insuficientes.
- 404 NOT_FOUND: activo u observación inexistentes; /apply actual exige DTO V14, no un request V13 aislado.
- 409 INVALID_HISTORICAL_EVIDENCE / INVALID_SOURCE_REVISION: archivo persistido no interpretable de forma segura.
- 409 HISTORICAL_PLAN_LIMIT: más de10000 asignaciones del activo o1000 revisiones del lote seleccionado. No truncar ni producir validez parcial.
- 503 IMPORT_REVIEW_NOT_READY: almacenamiento histórico/de revisión/enmiendas ausente, conforme al wrapper existente.

Bloqueos200: RETIREMENT_EVIDENCE_KIND_REQUIRED, EVIDENCE_ASSET_LINK_REQUIRED/MISMATCH, EVIDENCE_IDENTITY_UNRESOLVED, EVIDENCE_RULES_CHANGED, EVIDENCE_SOURCE_REVISED, CURRENT_ASSET_IDENTITY_CONFLICT, EVIDENCE_ALREADY_APPLIED, PRODUCT_NOT_ASSET, EXISTING_RETIREMENT_REQUIRES_RECONCILIATION, CURRENT_ASSIGNMENT_STATE_INCONSISTENT, ACTIVE_ASSIGNMENT_REQUIRES_RETURN, EXACT_RETIREMENT_DATE_REQUIRED/PROOF_REQUIRED, HISTORICAL_DATE_IN_FUTURE, SOURCE_RECEIPT_DATE_UNCONFIRMED, RETIREMENT_BEFORE_RECEIPT_DAY, ASSIGNMENT_AFTER_RETIREMENT, OPERATIONAL_ASSIGNMENT_PERIOD_INVALID, WARNINGS_NOT_ACKNOWLEDGED, UNKNOWN_WARNING_ACKNOWLEDGEMENT y SOURCE_ seguido del código bloqueante original. relatedId identifica la asignación/uso de evidencia conflictivo cuando corresponde.

## Verificación y siguiente paso

Fixtures de las tres hojas de bajas, sin datos privados. Suite completa372/372 aprobada en PostgreSQL18.6 descartable con Node26 WSL, incluidas18 nuevas: diez unitarias y ocho de integración. Cubren DTO/fechas, roles/CSRF, ausencia de escrituras, fecha fuente desconocida, recepción independiente, actores, terminales/asignaciones actuales, periodos posteriores, vínculos/enmiendas/restauraciones, revisiones, huellas, almacenamiento ausente y límites. Compilación API, lint acotado y diff-check correctos. Las diez unitarias pasaron también empaquetadas temporalmente en Node24.19 Windows; la suite completa PostgreSQL en Node24 sigue pendiente antes de despliegue.

V14 implementa aplicación transaccional de bajas verificadas con procedencia y capturador separado del ejecutor desconocido, sin reutilizar la baja corriente ni alterar historia previa. Bajas sin fecha confirmable y conciliación de terminales existentes siguen sin aplicación; también Tintas, reagrupación/corrección operativa e integración/piloto real autorizado con respaldo.
