# Contrato API V18 — vista efectiva de grupos revisados

Fecha:2026-10-05. Implementado en backend, solo lectura. Requiere almacenamiento hasta0023; no añade migración ni dependencia. No acredita despliegue, carga del Excel, renovación de decisiones ni piloto de grupos.

## Endpoint y alcance

GET `/inventory/imports/batches/:id/identity-group-reviews/:reviewId/effective-preview`

Solo JEFE autenticado. No requiere CSRF porque no escribe. UUID de lote/revisión aceptado en mayúsculas o minúsculas; respuesta canónica. No admite parámetros de consulta, overrides de fechas/revisiones/identidades, filtros ni force.

Lee una revisión V17 activa, valida snapshot/comprobante/procedencia y recalcula sus grupos sobre la interpretación V7/V8 actual, con el inventario y la evidencia vigentes. Una sola transacción REPEATABLE READ mantiene consistente lote, revisión, reservas, decisiones, fuente, evidencia e inventario aunque otro escritor confirme cambios durante la lectura. Una consulta posterior refleja el nuevo estado.

Aplica serie/tag verificados **solo a una copia en memoria** de las filas cubiertas. Conserva origen y cambios de interpretación explícitos. No modifica XLSX, workbook/lote, revisiones/decisiones, reserva/comprobante V17, activos/asignaciones, stock, evidencia ni auditoría. resolved-preview anterior conserva sus candidatos originales.

Cobertura completa y distinta de las mismas1–25 observaciones reservadas. No agrega filas externas por coincidencia; si la identidad propuesta ahora absorbería otra fila, muestra bloqueantes y conteos, sin ampliar el grupo solicitado. Inventario máximo25000 activos, evidencia seleccionada máxima100; excesos fallan, no truncan una respuesta supuestamente completa.

## Identidad estable y procedencia

Cada grupo añade `groupKey`, SHA-256 determinista de `['IMPORT_IDENTITY_GROUP', sourceHash, reviewId, groupId]`.

- groupId es el UUID de la propuesta dentro de una revisión.
- groupKey identifica ese grupo **dentro del comprobante concreto**; permanece estable ante nuevas coincidencias, fechas de consulta, correcciones ajenas a la selección, decisiones o enmiendas de evidencia.
- Una revisión nueva, aunque reuse groupId, tiene groupKey distinto. Una cancelación no reactiva ni recicla grupos anteriores.
- originalCandidateIds/recordIds conservan procedencia; simulatedCandidateIds son resultados del motor de coincidencias, no identidad persistente del grupo.

Ni groupKey ni groupId ni simulatedCandidateIds son targets válidos de decisiones/pilotos V4–V14. No usar esta vista para llamar al importador anterior o a CRUD de activos como sustituto del piloto nuevo.

## Respuesta200

```text
{
  rulesVersion: "mda-identity-group-projection-1",
  scope: "IDENTITY_GROUP_EFFECTIVE_PREVIEW",
  projectionId, reviewId, sourceHash, batchId, batchVersion, sourceRevision,
  asOf, timeZone: "America/Santiago",
  reviewedPlanId, currentScenarioPlanId,
  currentPreviewDigest, projectedPreviewDigest, sourceContextDigest,
  freshness: {
    reviewSnapshotCurrent, batchVersionChanged, sourceRevisionChanged,
    asOfChanged, sourceContextChanged, currentPreviewChanged
  },
  operationKind: "IDENTITY_ONLY" | "SPLIT" | "MERGE" | "REPARTITION",
  groups: [{
    groupKey, reviewId, groupId, recordIds,
    serialNumber, assetTag, evidenceReference,
    originalCandidateIds, simulatedCandidateIds,
    candidates: [{id, serials, tags, selectedRecordIds, outsideRecordCount,
                  existingAssets, existingAssetCount, hasMoreExistingAssets}],
    observations: [{
      recordId, sheet, row, hidden, kind, originalCandidateId, groupKey,
      originalIdentityCells, reviewedIdentityCells, currentIdentityCells,
      projectedIdentity: {serialKey, tagKey},
      fields, statusEvidence
    }],
    evidence: [{...metadatos actuales V16,
                linkedToGroup: false, requiresExplicitLineageReview: true}],
    originalDecisions, requiresNewDecision: true,
    requiresEvidenceLineageReview
  }],
  changes, blockers, issues, warnings, impacts,
  requiresNewDecisions: true,
  requiresEvidenceLineageReview,
  persisted: false, reviewPersisted: true,
  canApply: false, affectsCurrentState: false,
  groupedPilotImplemented: false,
  projectionValidationComplete,
  summary: {
    originalCandidateCount, proposedGroupCount, observationCount,
    changedCellCount, blockingCount, warningCount
  }
}
```

Grupos ordenados por groupId y observaciones por recordId, sin paginación porque la revisión completa está acotada. candidates conserva hasta10 coincidencias operativas por candidato, con contador/hasMore explícitos. Incidencias/bloqueantes conservan groupId/recordId/relatedId/issue cuando corresponde.

Identidades de celda: `{serialNumber: SourceCell|null, assetTag: SourceCell|null}`. SourceCell conserva tipo/valor/formato original; no ejecuta fórmulas. originalIdentityCells procede del XLSX; reviewedIdentityCells es la interpretación existente al guardar V17; currentIdentityCells es la interpretación V7/V8 actual antes de aplicar los grupos en memoria. Una reserva activa sella esas celdas seleccionadas: discrepancias con el comprobante fallan como procedencia inconsistente, no se corrigen silenciosamente. Las correcciones de otras filas pueden avanzar sourceRevision.

projectedIdentity son claves normalizadas por el motor, mientras serialNumber/assetTag del grupo son textos verificados. Los campos y statusEvidence describen evidencia interpretada de la fila, **no** el estado operativo definitivo de un equipo. No convierten No Disponible en ASSIGNED ni rellenan fechas/desconocidos.

## Vigencia y autoridad

projectionId identifica el contenido actual; no autoriza escritura. reviewedPlanId es la huella histórica guardada; currentScenarioPlanId resulta de recalcular las mismas pertenencias con las versiones/contexto actuales. freshness indica diferencias, sin modificar ni renovar V17. currentPreviewChanged puede deberse a inventario, fuente o día de consulta: no atribuirlo exclusivamente a una causa.

projectionValidationComplete solo significa ausencia de bloqueantes actuales de identidad/fuente/consumo en esta proyección. Puede ser true aunque el snapshot histórico ya no sea actual. Ni ese indicador ni reviewSnapshotCurrent permiten aplicar: hacen falta decisiones propias de grupo, tratamiento explícito de evidencia y un plan/piloto nuevo.

originalDecisions son antecedentes del candidato original, incluso si LINK_EXISTING/PROPOSE_NEW estaban aprobados. **Todos los grupos requieren una nueva decisión** para el futuro flujo; no heredan un vínculo operativo por compartir filas.

La evidencia muestra recordId/candidateId/captureId/captureBatchId, vínculo capturado y vínculo vigente, versión/amendmentId/revisiones y usos V11/V14. Una desvinculación explícita mantiene currentAssetId=null; no se reemplaza por capturedAssetId. linkedToGroup siempre false: esta consulta no transfiere autoridad histórica ni religa observaciones a grupos. La evidencia usada previamente bloquea la proyección, igual que V16. Fechas efectivas/actores históricos desconocidos no se inventan.

## Cancelación, integridad y errores

Una revisión cancelada responde409 IDENTITY_GROUP_ALREADY_RELEASED; su comprobante original sigue consultable por la ruta V17. No se devuelve como agrupación vigente ni se restablece la reserva.

Valida reglas/snapshot compatible, huella guardada, headers/versiones/hash, pertenencia original completa, reserva activa por fila y coincidencia exacta de snapshots/procedencia. No acepta grupos parcialmente reservados, celdas de origen reescritas ni interpretaciones seleccionadas alteradas.

- 400 VALIDATION_ERROR: parámetros/UUID inválidos.
- 401 no autenticado;403 sin rol JEFE;404 revisión inexistente o perteneciente a otro lote.
- 409 IDENTITY_GROUP_ALREADY_RELEASED / INVALID_IDENTITY_GROUP_REVIEW.
- 409 PREVIEW_DATABASE_LIMIT / IDENTITY_GROUP_EVIDENCE_LIMIT / límites de interpretación de fuente.
- 503 IMPORT_REVIEW_NOT_READY si falta almacenamiento hasta0023.

No hay endpoint de aplicación ni nueva tabla de decisiones en V18. [V19](contrato-api-v19.md) añade decisiones y revisión explícita/versionada de pertenencia de evidencia por groupKey mediante rutas distintas; no modifica esta vista ni aplica/religa archivo. Sigue pendiente piloto dedicado compatible con reservas y deduplicación global. V17/V6/V11/V14 mantienen sus guardas. Tintas, bajas sin fecha, corrección operativa de historia, integración frontend y carga real autorizada conservan sus pendientes.

## Verificación

462 pruebas aprobadas en Node24.19.0 Linux/PostgreSQL18.6 descartable, incluidas16 nuevas de V18 (8 unitarias/8 integración). Compilación API forzada, lint API/tests completo, Prisma validate y diff-check correctos. Bases de pruebas eliminadas; sin despliegue, migración operativa ni carga real. Detalle en [informe de verificación](verificacion-backend-node24.md).
