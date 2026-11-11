# Contrato API V24 — plan operativo de asignaciones cerradas de grupos

Actualización posterior: [V25](contrato-api-v25.md) añade confirmación/aplicación propia y requiere0027, también para las lecturas actualizadas V22/V24 y de asignaciones/historial. El plan actualizado consulta consumo agrupado y expone groupAssignmentUse en links seleccionados/omitidos; sus banderas de lectura permanecen false. El resto del documento conserva el alcance y verificación originales de V24.

Fecha:2026-10-20. Implementado como paso previo a la aplicación operativa de grupos. Solo lectura: no crea asignaciones/devoluciones ni comprobantes operativos. Usa el almacenamiento existente hasta0026; no añade migraciones, dependencias ni cambios frontend.0026 continúa pendiente de aplicación operativa según el último estado comunicado.

## Alcance

Prepara periodos históricos cerrados para el activo de un item aplicado V21, utilizando exclusivamente las proyecciones confirmadas V23 de ese mismo item. Guardar pertenencia histórica V23 no acredita fecha exacta, destinatario, devolución o ausencia de solapamientos. Cada periodo requiere esos datos y su respaldo independientes.

Se reutilizan las reglas puras del plan V10: fechas exactas con zona y precisión máxima de milisegundos, respaldo temporal por extremo, destinatario explícito PERSON/OFFICE, STANDARD/LOAN y estado de retorno AVAILABLE/UNDER_REVIEW/IN_REPAIR. No se llama al lector/aplicador legacy ni se relajan reservas o consumo permanente. El archivo original/interpretación legacy puede seguir con assetId=null; no se lo modifica para simular pertenencia al grupo.

No prepara entregas abiertas, préstamos sin devolución, bajas terminales, correcciones ni consumos Tintas. No selecciona por serie aproximada, fusiona grupos ni completa datos desconocidos con hoy/el importador.

## Endpoint

POST `/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId/items/:itemId/closed-assignment-plan`

Solo JEFE autenticado con CSRF. UUID normalizados a minúsculas. Parámetros/cuerpo estrictos, sin query adicional. No existe `.../closed-assignment-plan/apply` en este bloque.

```text
{
  expectedApplicationPlanId: SHA256 del comprobante V21,
  links: [{
    evidenceId: UUID,
    linkId: UUID de ImportGroupHistoryLink,
    expectedLinkVersion: integer1..1000, // actualmente solo versión1 persistida
    expectedEvidenceVersion: integer0..1000
  }],
  plan: {
    periods: [{
      periodId: UUID,
      confirmation: "VERIFIED_CLOSED_ASSIGNMENT",
      start: {
        evidenceId: UUID,
        confirmedAt: ISO8601 con zona|null, // defaultnull => bloqueante
        dateEvidenceReference: respaldo1..500|null
      },
      end: { evidenceId, confirmedAt, dateEvidenceReference },
      recipient: {type:"PERSON",name: nombre completo2..150}
        |{type:"OFFICE",name: nombre1..160}|null,
      assignmentType: "STANDARD"|"LOAN",
      returnStatus: "AVAILABLE"|"UNDER_REVIEW"|"IN_REPAIR"|null,
      note: texto1..2000,
      evidenceReference: respaldo1..500,
      acknowledgedWarnings: [SHA256] // default[]
    }]
  }
}
```

Entre1 y25 periodos; periodo/evidencia de cada extremo distintos. `links` contiene exactamente una entrada por extremo seleccionado,2–50 en total, con evidenceId/linkId distintos. No admite enlaces extra, assetId libre, snapshots/proyecciones, confirmación heredada V23, force ni overrides operativos. La cantidad efectiva también está limitada por las filas/evidencias del grupo físico original.

Los extremos pueden proceder de comprobantes V23 distintos (confirmaciones parciales sucesivas), pero todos deben pertenecer al mismo item V21. No es necesario confirmar todas las evidencias del grupo: las no seleccionadas y las archivadas aún sin vínculo se muestran por separado, sin presentarlas como revisadas.

## Procedencia y vigencia

- Una transacción REPEATABLE READ obtiene aplicación V21 completa, activo/producto actual, todos los comprobantes V23 del item con sus links, archivo/enmienda vigente/usos, asignaciones actuales e historial de revisiones de los lotes de captura. Ninguna escritura/auditoría por consultar.
- V21: valida huella de plan, digest de intención y cobertura completa de items/consumo global por sourceHash+recordId+candidato original, incluyendo grupos no seleccionados del mismo comprobante.
- V23: valida reglas/ámbito, huella del plan V22 almacenado, intención reconstruida, cobertura completa de todos los vínculos confirmados, snapshots originales/vigentes guardados, proyección exacta, identidad V21, advertencias reconocidas y versión1. No acepta una parte aparentemente sana de un comprobante incompleto o corrupto. También se verifican comprobantes del item que no aportan extremos seleccionados.
- Cada link seleccionado debe coincidir con evidencia, captura, hoja/fila y candidato original físicamente consumidos por ese item. Lotes de captura distintos con el mismo hash de fuente siguen permitidos si conservan esa pertenencia.
- Compara expectedApplicationPlanId, expectedLinkVersion y expectedEvidenceVersion. No rebasa una proyección confirmada sobre otra enmienda/interpretación: si archivo vigente difiere del fijado por V23, bloquea GROUP_HISTORY_EVIDENCE_CHANGED. Corrupción/procedencia ilegible falla explícitamente.
- Revisa identidad/producto actual contra V21; activo asignado/inactivo/terminal puede tener historial anterior si sigue compatible. La consulta no cambia custodia ni fecha terminal.
- Cancelar reservas administrativas no invalida comprobantes V21/V23 ni libera sus consumos. Los lectores/aplicadores V6/V11/V14 anteriores permanecen protegidos; no usar esta respuesta en esos endpoints.

## Reglas del periodo

Inicio: USAGE_OBSERVATION o LOAN_OBSERVATION. Fin: RECEIPT_OBSERVATION o USAGE_OBSERVATION. No usar dos kinds de la misma fila física como los dos extremos del mismo periodo.

Ambos instantes deben ser explícitos, anteriores o iguales al momento de consulta y con end>start. Cuando el archivo aporta un día conocido, el día del instante confirmado debe coincidir. Día desconocido permanece null/UNKNOWN en archivo/proyección; solo una confirmación temporal independiente puede proponer el instante exacto. El importador no se convierte en actor histórico.

Destinatario debe concordar con persona/oficina explícita del origen cuando exista. Evidencia de préstamo exige LOAN. Referencias salida/entrada permanecen separadas y con longitud válida. No se infieren destinatario o estado de retorno por ubicación/hoja/estado actual.

Se bloquean periodos que solapan asignaciones operativas ya registradas o propuestas entre sí, o terminan después de una baja terminal. Se exige coherencia del estado ASSIGNED con una única asignación abierta. Incidencias bloqueantes del origen no se levantan por reconocer advertencias; incidencias contextuales de estado y WARNING exigen sus IDs exactos. Advertencias desconocidas no sirven como aprobación.

Evidencia usada por asignación o retiro anteriores bloquea ENDPOINT_EVIDENCE_ALREADY_APPLIED. Revisiones posteriores relevantes del candidato bloquean EVIDENCE_SOURCE_REVISED. No se altera ningún comprobante para resolver esos conflictos.

## Respuesta200

```text
{
  rulesVersion:"mda-group-closed-assignment-plan-1",
  scope:"GROUP_CLOSED_ASSIGNMENT_HISTORY_PLAN",
  batchId, reviewId, applicationId, applicationPlanId,
  itemId, groupKey, groupId, sourceHash,
  checkedAsOf, timeZone:"America/Santiago", assetBefore,
  sourceRows, applicationProofDigest,
  historyReceiptProofs:[{id,planId,requestDigest,appliedById,appliedAt}],
  currentAssignmentsDigest, sourceRevisionsDigest,
  periods:[{
    ...intención normalizada,
    sources:[{
      endpoint, evidenceId, captureId, batchId, sourceHash, recordId,
      candidateId, kind, sheet, row, evidenceVersion, amendmentId,
      sourceRevision, capturedSourceRevision, effectiveDay, datePrecision,
      fields, snapshotDigest,
      groupHistoryLinkId, groupHistoryLinkVersion,
      historyApplicationId, historyLinkPlanId
    }],
    proposedAssignment, warnings, blockers, valid
  }],
  historyLinks:[{
    ...link V23 completo con operation/projection,
    historyLinkPlanId, confirmedById, confirmedAt,
    capturedAssetId, currentAssetId, currentEvidenceVersion,
    currentAmendmentId, currentSourceRevision, currentSnapshot
  }],
  unselectedHistoryLinks:[{
    id,evidenceId,assetId,version,evidenceVersion,
    historyApplicationId,historyLinkPlanId
  }],
  unlinkedEvidence:[{evidenceId,recordId,kind,evidenceVersion}],
  planId,
  persisted:false, canApply:false, affectsCurrentState:false,
  evidenceRelinked:false, operationalHistoryApplied:false,
  closedAssignmentApplicationImplemented:false,
  planValidationComplete,
  summary:{
    periodCount,validCount,blockingCount,warningCount,
    selectedEndpointCount,omittedLinkCount,unlinkedEvidenceCount
  }
}
```

`proposedAssignment` mantiene actor de entrega/devolución null, fechas efectivas propuestas y referencias separadas. confirmedById/confirmedAt de un vínculo identifican a quien confirmó pertenencia en V23, no al actor o momento de entrega/devolución.

Orden determinista por periodo/evidencia y comprobantes; reordenar `links`, periodos o IDs de advertencia no cambia planId. La huella combina intención, comprobantes físicos/históricos, versiones, contexto actual y diagnósticos. Otra asignación/identidad/interpretación o comprobante nuevo cambia el contexto o invalida la propuesta.

`planValidationComplete` evalúa exclusivamente los periodos seleccionados. No significa que todo el grupo/Excel esté revisado, que las evidencias omitidas sean válidas o que exista autorización/end-point de aplicación. No habilitar «Aplicar» a partir de esa bandera.

## Errores y límites

- 400 VALIDATION_ERROR;401/403 autenticación/JEFE/CSRF.
- 404 NOT_FOUND: padres/link/evidencia ajenos o activo no encontrado. Un link de otro item no se selecciona por coincidencia de serie.
- 409 IDENTITY_GROUP_APPLICATION_CHANGED / GROUP_HISTORY_LINK_VERSION_CONFLICT / EVIDENCE_VERSION_CONFLICT: recargar comprobantes/versiones.
- 409 INVALID_IDENTITY_GROUP_APPLICATION / INVALID_GROUP_HISTORY_APPLICATION / INVALID_HISTORICAL_EVIDENCE / INVALID_SOURCE_REVISION: procedencia corrupta/ininterpretable, no aprobación parcial.
- 409 GROUP_ASSIGNMENT_PLAN_LIMIT: más de100 comprobantes/links/evidencias del item,10000 asignaciones o1000 revisiones; sin truncamiento silencioso. Aplican también los límites de25 items/filas V21 y25 links por comprobante V23.
- 503 IMPORT_REVIEW_NOT_READY: falta almacenamiento existente; completar0026 antes de usar las rutas de grupos.

Los conflictos de negocio se presentan en `periods[].blockers` con código y, según corresponda, endpoint/relatedId. Incluyen reglas V10, GROUP_ASSET_IDENTITY_CHANGED y GROUP_HISTORY_EVIDENCE_CHANGED. Las banderas de solo lectura permanecen false incluso para un plan válido.

## Frontend y siguiente bloque

El frontend puede preparar/revisar propuestas usando comprobantes V21/V23, mostrar procedencia por extremo, fechas originales y confirmadas separadas, destinatario y retorno explícitos, advertencias/bloqueantes y omisiones. No implementar todavía un botón de aplicación de periodos agrupados ni llamar al aplicador legacy como alternativa.

Siguiente backend: confirmación y aplicación transaccional propia de estos periodos con comprobantes inmutables, idempotencia, consumo único de extremos, auditoría y guardas SQL compatibles con V21/V23, sin modificar custodia actual. Después: correcciones de historial ya aplicado y reglas pendientes Tintas/bajas inciertas; integración/piloto real siguen pendientes. Este bloque no requiere migraciones nuevas, no ejecuta migraciones operativas ni contacta al otro chat.

## Verificación

Resultado final en [informe Node24](verificacion-backend-node24.md). Pruebas unitarias y de integración verifican contratos, identidad/procedencia, comprobantes completos, versiones, fecha/actor desconocidos, reglas del periodo, permisos/CSRF, lectura sin escrituras, cancelación, bloqueos de legacy, snapshots coherentes ante cambios concurrentes y límites/almacenamiento ausente. Datos sintéticos y bases descartables; no acredita importación real ni integración frontend.

Suite completa:606 aprobadas,0 fallos/omitidas/canceladas,112.577s en Node24.22.0/PostgreSQL18.6;25 nuevas (13 unitarias/12 integración). Build API forzado, lint API/tests completo, Prisma validate y whitespace correctos. Sin migración nueva ni despliegue operativo; base descartable eliminada y servidor de pruebas independiente detenido al terminar.
