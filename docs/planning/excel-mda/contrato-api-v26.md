# Contrato API V26 — plan de rectificación de periodos agrupados

Fecha:2026-10-20. Implementado y probado como extensión de [V25](contrato-api-v25.md) para revisar rectificaciones de un periodo histórico cerrado ya aplicado. Solo lectura: no guarda rectificaciones ni modifica asignaciones/comprobantes. Usa las27 migraciones existentes, incluida0027; no añade migración ni dependencia. Verificación final:664 pruebas aprobadas,0 fallos/omitidas/canceladas, Node24.22.0/PostgreSQL18.6, build API forzado/lint completo/Prisma validate/whitespace correctos; [informe Node24](verificacion-backend-node24.md). No acredita integración ni carga real.

## Alcance

Actualización V27: la planificación permanece sin escritura, pero [V27](contrato-api-v27.md) añade su confirmación explícita, comprobantes versionados y lecturas efectivas. Su migración0028 es necesaria antes de iniciar el backend actualizado, también para leer. El cuerpo acepta expectedCorrectionVersion (0 por defecto); before refleja la última versión y originalPeriod/originalAssignment conservan el origen. Las afirmaciones de ausencia de persistencia que siguen describen el alcance original V26, no el estado posterior V27.

Prepara antes/después de un item V25 concreto, conservando activo, periodo, identidad de sus dos evidencias y propiedad permanente de extremos. Permite proponer fechas efectivas exactas, destinatario PERSON/OFFICE, STANDARD/LOAN, condición de retorno, nota y respaldos explícitos. Las referencias de ticket/OT siguen derivadas de las fuentes; no se sustituyen libremente.

El motivo y respaldo de la rectificación son distintos de la nota/respaldo del periodo y de las pruebas temporales de cada extremo. Cambiar solo motivo o representación horaria del mismo instante no constituye una rectificación material; cambiar únicamente un respaldo del periodo sí aparece como diferencia documental.

No corrige archivo original, proyecciones V23, vínculos/activos, retiros terminales, préstamos abiertos ni periodos legacy V11. No habilita PATCH/DELETE de historia. La confirmación persistente con rectificaciones append-only y su lectura efectiva queda para el siguiente bloque; no hay `/apply` de V26.

## Ruta y solicitud

Solo JEFE autenticado y CSRF. Parámetros UUID normalizados a minúsculas; padres y cuerpo estrictos, sin query adicional.

```text
POST /inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId/items/:itemId/closed-assignment-applications/:groupApplicationId/items/:assignmentItemId/correction-plan
```

groupApplicationId es el comprobante V25 y assignmentItemId uno de sus items, no el assignmentId operativo ni el item V21. Todos los padres deben concordar;404 para recursos ajenos.

```text
{
  expectedOriginPlanId: planId del comprobante V25,
  reason: motivo de la rectificación (1..2000),
  supportingReference: respaldo de la rectificación (1..500),
  correction: {
    start: {confirmedAt: instante con zona|null, dateEvidenceReference: texto1..500|null},
    end: {confirmedAt: instante con zona|null, dateEvidenceReference: texto1..500|null},
    recipient: {type:"PERSON"|"OFFICE",name:...}|null,
    assignmentType:"STANDARD"|"LOAN",
    returnStatus:"AVAILABLE"|"UNDER_REVIEW"|"IN_REPAIR"|null,
    note: nota del periodo (1..2000),
    evidenceReference: respaldo del periodo (1..500),
    acknowledgedWarnings:[SHA256,...]
  }
}
```

No acepta requestId, assetId, assignmentId, periodId, evidenceId, linkId, actores, snapshots, ticket/OT libres, force ni confirmación de escritura. El servidor deriva todos los identificadores del origen validado. Reutiliza formatos/límites temporales y de destinatario de V24; fechas desconocidas o datos incompletos permiten mostrar un plan con bloqueantes, no una propuesta aprobada.

## Validación y consistencia

Lee un snapshot REPEATABLE READ de comprobante completo V25, asignaciones reales, usos, auditoría, V21/V23, archivo/enmiendas, revisiones y estado/custodia actuales. Reconstruye la huella e intención originales, valida cobertura de todos los periodos del comprobante, propuesta realmente persistida, captura/importador, actores null, exclusividad de origen, dos usos exactos por periodo y auditoría raíz/por asignación.

No basta con que exista un assignmentId o un uso. Los comprobantes padre V21/V23 completos y la procedencia física se verifican otra vez. Datos malformados o inconsistentes devuelven409, sin otorgar excepciones a consumos.

Solo para esta validación local se reconoce que los extremos ya pertenecen al periodo rectificado. La exclusión de solapamiento corresponde exclusivamente a esa asignación, no a sus hermanas ni a la custodia actual. Los lectores/aplicadores V11/V24/V25 y las guardas SQL mantienen sus bloqueos; no se libera ni modifica consumo.

Mantiene fechas exactas y respaldo en ambos extremos, día conocido de fuente, destinatario informado/préstamo, advertencias reconocidas exactamente, orden temporal, ausencia de futuro y límite de baja. Un día desconocido permanece UNKNOWN/null en el archivo aunque se proponga un instante con prueba independiente. Cambiar un día conocido contradictorio requiere otro flujo documental; no se ignora aquí.

La identidad/producto actuales que ya no concuerdan producen bloqueantes. Una custodia actual distinta de la capturada originalmente, una devolución normal posterior o la cancelación administrativa de la revisión no invalidan por sí mismas el comprobante histórico. La fecha/importador de captura no se convierte en actor o fecha histórica.

Límites sin truncamiento: comprobante1..25 periodos, dos usos por item; contexto V24 de100 comprobantes/vínculos/evidencias,10000 asignaciones y1000 revisiones. Auditoría raíz+por periodo y hasta una custodia abierta. Un contexto excesivo/inconsistente falla explícitamente.

## Respuesta200

```text
{
  rulesVersion:"mda-group-assignment-correction-plan-1",
  scope:"GROUP_CLOSED_ASSIGNMENT_CORRECTION_PLAN",mode:"CORRECTION_REVIEW_ONLY",
  correctionPlanId,batchId,reviewId,applicationId,itemId,
  groupApplicationId,assignmentItemId,assignmentId,assetId,originPlanId,
  originReceiptDigest,originAuditDigest,currentContextDigest,validationContextPlanId,
  checkedAsOf,timeZone:"America/Santiago",reason,supportingReference,
  before,proposed,changes:[{field,before,after}],
  originalPeriod,originalAssignment,sources,ownership,currentAsset,currentCustody,
  acknowledgedWarnings,warnings,blockers,planValidationComplete,
  persisted:false,canApply:false,affectsCurrentState:false,
  evidenceRelinked:false,operationalHistoryApplied:false,
  correctionApplicationImplemented:false
}
```

before/proposed contienen valores efectivos comparables, note/evidenceReference y startDateEvidenceReference/endDateEvidenceReference. Instantes equivalentes se comparan por valor UTC, no por formato. originalPeriod/originalAssignment conservan lo aplicado; sources/ownership conservan las dos procedencias y su consumo. currentAsset/currentCustody son la foto actual de lectura, no el resultado de aplicar la propuesta.

Las huellas vinculan origen completo, auditoría, intención, fecha de revisión y contexto actual, incluidos metadatos completos aunque updatedAt se conserve. Son valores opacos del servidor, no hashes que deba reconstruir el frontend a partir de otros GET. validationContextPlanId es interno al diagnóstico: no enviarlo a V25/V11 para intentar una nueva aplicación. planValidationComplete=true solo indica ausencia de bloqueantes en la propuesta de revisión; todas las banderas de escritura siguen false.

## Errores y traspaso frontend

- 400 VALIDATION_ERROR;401/403 autenticación/JEFE/CSRF;404 padres/items ajenos.
- 409 GROUP_ASSIGNMENT_ORIGIN_CHANGED: seleccionar el planId del comprobante V25 correcto.
- 409 INVALID_GROUP_ASSIGNMENT_APPLICATION: origen, asignación, cobertura, usos o auditoría inconsistentes; no reintentar como carga nueva.
- 409 de comprobantes V21/V23, versiones/archivo y límites V24 se conservan.
- 409 GROUP_CORRECTION_CURRENT_STATE_INVALID: activo/custodia actuales no verificables.
- 503 IMPORT_REVIEW_NOT_READY: falta almacenamiento existente hasta0027.
- 200 con bloqueantes: incluye reglas V24 y GROUP_ASSIGNMENT_CORRECTION_UNCHANGED; mostrar motivos, no ofrecer aplicar.

Frontend puede mostrar «Revisar rectificación histórica» desde un item del comprobante V25. Mostrar original, propuesta y diferencias; pedir motivo/respaldo propios, conservar desconocidos y explicar que no cambia custodia actual. Permitir reconocer advertencias y regenerar. No mostrar botón Guardar/Aplicar mientras correctionApplicationImplemented=false. Frontend no modificado ni contactado.

Siguiente backend: persistencia append-only, versionado/idempotencia, auditoría y consultas efectivas de rectificaciones, sin reescribir original ni liberar extremos. Correcciones legacy/documentales aplicadas, bajas agrupadas/inciertas, reglas Tintas, integración y piloto real siguen pendientes.
