# Contrato API V22 — plan de vínculo histórico de grupos aplicados

Actualización posterior: [V23](contrato-api-v23.md) añade confirmación/persistencia independientes y requiere0026. El plan actualizado usa reglas2 y muestra savedGroupLink/bloqueante de vínculo ya guardado; sus banderas conservadoras de lectura se mantienen. El resto de este documento conserva el alcance y verificación originales de V22.

Fecha:2026-10-20. Implementado en backend, exclusivamente de lectura. Requiere el almacenamiento existente hasta0025; no añade migraciones ni aplica vínculos, enmiendas, asignaciones o bajas. El usuario informó aplicación correcta de0025 y Node24.22.0/pnpm11.19.0. Este bloque no volvió a migrar ni modificó la base operativa.

## Objetivo y alcance

Preparar una revisión explícita de evidencia archivada respecto del equipo resultante de una operación V21. El comprobante de carga y su consumo global por fila establecen pertenencia; una coincidencia de serie o una decisión anterior de candidato no sustituyen esa prueba.

El plan distingue original capturado, interpretación/vínculo vigente y propuesta al grupo aplicado. Permite revisar evidencia de una fuente dividida/fusionada sin usar los endpoints legacy como bypass de reservas/consumo. Las guardas V6/V11/V14/V17/V21 no se relajan.

## Endpoint y request

POST `/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId/items/:itemId/history-link-plan`

JEFE autenticado y CSRF. Todos los UUID se normalizan a minúsculas. Ruta y cuerpo estrictos; no admite query adicional, assetId, fechas operativas, force, snapshots o flags de aprobación del cliente.

```text
{
  expectedApplicationPlanId: SHA256 del comprobante V21,
  operations: [{
    evidenceId: UUID,
    expectedEvidenceVersion: integer 0..1000,
    action: "LINK_TO_APPLIED_GROUP",
    note: texto no vacío <=2000,
    evidenceReference: respaldo no vacío <=500,
    acknowledgedWarnings: [SHA256] // default[], distintos, máximo50
  }]
}
```

Selecciona1–25 evidencias distintas del grupo completo identificado por el item. El activo propuesto se obtiene del comprobante, no se elige libremente. La selección puede ser parcial; se muestran las evidencias omitidas del grupo sin presentarlas como revisadas.

## Comprobaciones de procedencia y vigencia

- Una transacción REPEATABLE READ lee comprobante/items/usos, activo/producto actual, archivo/enmienda latest/usos históricos y revisiones de los lotes de captura. No realiza escrituras ni auditoría por consultar.
- Valida regla/huella del plan V20 almacenado y digest de intención V21 reconstruida. Operaciones, grupos, decisiones, resultados de identidad y cobertura de todas las filas deben concordar con el comprobante y el consumo sourceHash+recordId. Corrupción produce409; no usa una parte aparentemente sana de un comprobante incompleto.
- Lote/revisión/comprobante/item deben coincidir. Un evidenceId de otro grupo, aunque pertenezca al mismo candidato original o aplicación, no es seleccionable.
- La captura puede provenir de otro lote del mismo hash de fuente. Debe coincidir la fila física y el candidato original registrados en el consumo V21; no absorbe filas nuevas ni permite otros hashes.
- Exige versión vigente de cada evidencia seleccionada. Conserva null explícito de enmiendas, versión/amendmentId actuales, vínculo capturado separado del vigente y original completo sin modificaciones.
- Revisiones posteriores relevantes del candidato en su lote de captura bloquean con EVIDENCE_SOURCE_REVISED. No refresca evidencia automáticamente. Cambios del contexto actual alteran historyLinkPlanId.
- Se admite consultar después de cancelar las reservas administrativas: el comprobante y el consumo aplicado permanecen. La cancelación no transfiere autoridad a endpoints históricos anteriores.

## Diagnósticos y propuesta

Cada operación conserva originalSnapshot/currentSnapshot, hoja/fila/recordId/candidato original, captura/versiones, fecha conocida o desconocida y historicalActorId=null. appliedById/appliedAt de V21 son importador/captura de aplicación, nunca ejecutor histórico.

Se propone assetId e identidad exclusivamente desde el resultado V21. Si la interpretación archivada conserva la identidad anterior del Excel, se muestra requiresIdentityProjection=true y la advertencia GROUP_HISTORY_IDENTITY_PROJECTION_REQUIRED; requiere reconocimiento exacto de su ID. Ese reconocimiento no cambia ninguna celda ni autoriza aplicación.

assetApplicationReview muestra versión/disposición revisadas al aplicar V21, o null si la evidencia no estaba archivada entonces. Siempre antecedentOnly=true. EXCLUDE_FROM_GROUP_PILOT se conserva como antecedente; no se convierte en confirmación de pertenencia histórica. La intención del request V22 es una revisión nueva, y aun así solo produce un plan.

Bloqueantes:

- GROUP_ASSET_NOT_FOUND / GROUP_ASSET_IDENTITY_CHANGED / PRODUCT_NOT_ASSET.
- EVIDENCE_ALREADY_APPLIED: evidencia usada en un periodo o retiro; requiere corrección operativa separada, no otra vinculación.
- EVIDENCE_LINKED_TO_ANOTHER_ASSET: no propone transferencia silenciosa. Resolver explícitamente el vínculo archivístico anterior mediante su flujo autorizado y volver a revisar.
- EVIDENCE_RULES_CHANGED / EVIDENCE_SOURCE_REVISED.
- NO_HISTORY_LINK_CHANGE: ya vinculado al mismo activo y sin proyección de identidad pendiente.
- WARNINGS_NOT_ACKNOWLEDGED / UNKNOWN_WARNING_ACKNOWLEDGEMENT: no hay waiver de bloqueantes.

Un activo actualmente asignado/inactivo/terminal puede ser objeto de consulta histórica si mantiene identidad/producto compatibles. El plan no modifica ese estado, custodia o fecha terminal. Fecha/actor desconocidos no se completan con hoy/el importador. Una propuesta de vínculo válida no acredita fechas, destinatarios o periodos válidos para una aplicación operativa posterior.

## Respuesta200

```text
{
  rulesVersion: "mda-group-history-link-plan-1",
  scope: "IDENTITY_GROUP_HISTORY_LINK_PLAN",
  batchId, reviewId, applicationId, applicationPlanId,
  itemId, groupKey, groupId, sourceHash,
  appliedById, appliedAt, checkedAsOf, timeZone: "America/Santiago",
  asset: snapshot actual|null,
  sourceRows: consumo V21 completo del item,
  revisions: contexto de revisión de los lotes de captura,
  operations: [{
    ...request normalizado,
    evidenceVersion, amendmentId, captureId, captureBatchId,
    recordId, originalCandidateId, sheet, row, kind,
    capturedAssetId, currentAssetId, proposedAssetId,
    originalSnapshot, currentSnapshot,
    assetApplicationReview: {evidenceVersion, disposition, antecedentOnly:true}|null,
    effectiveSourceRevision, capturedSourceRevision,
    effectiveDay, datePrecision, historicalActorId:null,
    requiresIdentityProjection, proposedIdentity,
    assignmentUse, retirementUse, warnings, blockers, valid
  }],
  omittedEvidence: [{evidenceId, recordId, kind, currentAssetId, evidenceVersion}],
  historyLinkPlanId,
  persisted:false, canApply:false, affectsCurrentState:false,
  evidenceRelinked:false, historyLinkApplicationImplemented:false,
  planValidationComplete,
  summary:{selectedEvidenceCount, validCount, blockedCount, omittedEvidenceCount}
}
```

Orden determinista por evidenceId; sourceRows/revisiones ordenados por servicio. La huella incluye prueba de aplicación, contexto actual, intención/respaldo/advertencias, fuente y versiones. Reordenar la selección no cambia la huella. planValidationComplete solo evalúa los seleccionados, no todos los grupos/archivo/Excel, y no habilita botón Aplicar.

## Errores y límites

- 400 VALIDATION_ERROR;401/403 autenticación/JEFE/CSRF;404 ámbitos o evidencia ajenos al grupo.
- 409 IDENTITY_GROUP_APPLICATION_CHANGED / EVIDENCE_VERSION_CONFLICT.
- 409 INVALID_IDENTITY_GROUP_APPLICATION / INVALID_HISTORICAL_EVIDENCE / INVALID_SOURCE_REVISION: procedencia no interpretable, no aprobación parcial.
- 409 GROUP_HISTORY_PLAN_LIMIT: más de100 evidencias o1000 revisiones en el contexto; sin truncamiento silencioso. Límites V21 de25 grupos/filas para comprobante aplicados nuevamente.
- 503 IMPORT_REVIEW_NOT_READY: falta almacenamiento existente requerido.

No existe endpoint `/history-link-plan/apply` en este bloque. No convertir la propuesta en una llamada V12/CRUD/V11/V14 ni reconstruir candidatos originales para sortear consumo global.

## Verificación y siguiente bloque

Pruebas unitarias/API/PostgreSQL cubren DTO/roles/CSRF, comprobantes reales multifila/separados, huellas/procedencia, selecciones ajenas, read-only/auditoría intacta, cancelación, archivo vigente/null/enmiendas, advertencias/no-op, estado asignado/terminal, cambios concurrentes y límites/corrupción. Resultado final en [verificación Node24](verificacion-backend-node24.md).

Suite completa final:556 aprobadas,0 fallos/omitidas/canceladas,97.911s en Node24.22.0/PostgreSQL18.6;25 nuevas (15 unitarias/10 integración). Base descartable eliminada, build forzado/lint API/tests completo/Prisma validate/diff-check correctos. Instancia temporal independiente de la base de la app; sin migración nueva.

La verificación también reforzó la cancelación V17: su fecha de captura se obtiene explícitamente del reloj PostgreSQL y se trunca a milisegundos antes del INSERT. Evita depender del default del cliente frente al guard SQL que rechaza fechas futuras; permisos, cobertura, inmutabilidad, consumo global y huellas de reintento se mantienen. Regresión específica y recorridos de cancelación anteriores cubiertos; sin migración nueva.

Siguiente: persistencia transaccional propia del vínculo/proyección con confirmación nueva, versiones, comprobante inmutable, idempotencia, auditoría y guardas SQL. Después, aplicación histórica propia compatible con esa procedencia; corrección operativa ya aplicada, Tintas/bajas inciertas e integración/piloto real conservan pendientes. Este bloque no modifica frontend, Excel, esquema/dependencias ni datos operativos.
