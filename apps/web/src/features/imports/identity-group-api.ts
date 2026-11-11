import { ApiRequestError, apiRequest, getApiErrorMessage, getCsrfToken } from '../../lib/api';
import { validHistoricalInstant } from './closed-assignment-model';
import { sameSnapshot } from './history-evidence-api';
import { importReviewPath, readBatch } from './import-review-api';
import type { ImportPreview } from './import-review-model';
import { readResolvedReviewSource, validSourceCell } from './source-review-api';
import { identityGroupScope, normalizeIdentityGroupInput, validateIdentityGroupsDraft, type IdentityGroupInput, type IdentityGroupPlan } from './identity-group-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function integer(value: unknown, max = 2147483647) { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max; }
function text(value: unknown) { return value === null || typeof value === 'string'; }
function list(value: unknown, item: (entry: unknown) => boolean): value is unknown[] { return Array.isArray(value) && value.every(item); }
function unique(values: unknown[]) { return new Set(values).size === values.length; }
function onlyKeys(value: Value, keys: string[]) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function issue(value: unknown) {
  return object(value) && typeof value.code === 'string' && ['BLOCKING', 'WARNING', 'INFO'].includes(String(value.severity)) &&
    text(value.sheet) && (value.row === null || integer(value.row) && Number(value.row) > 0) && text(value.cell) && (value.candidateId === null || hash(value.candidateId));
}
function cells(value: unknown) {
  return object(value) && Object.keys(value).length === 2 && ['serialNumber', 'assetTag'].every((key) => Object.hasOwn(value, key) && validSourceCell(value[key]));
}
function invalid(): never { throw new ApiRequestError('Unexpected identity group plan', 200, 'INVALID_RESPONSE'); }
function bounded(signal: globalThis.AbortSignal) { return globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)]); }
export function captureIdentityGroupInput(value: unknown, original: ImportPreview): IdentityGroupInput {
  const invalidInput = () => { throw new ApiRequestError('Revisa candidatos, pertenencia, identificadores y respaldo antes de simular.', 400, 'VALIDATION_ERROR'); };
  const keys = ['expectedVersion', 'expectedSourceRevision', 'confirmation', 'candidateIds', 'note', 'groups'];
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)) ||
    !integer(value.expectedVersion) || Number(value.expectedVersion) < 1 || !integer(value.expectedSourceRevision, 1000) || value.confirmation !== 'REVIEW_PHYSICAL_IDENTITY_GROUPS' ||
    !list(value.candidateIds, hash) || !unique(value.candidateIds) || typeof value.note !== 'string' || value.note !== value.note.trim() ||
    !list(value.groups, (group) => object(group) && Object.keys(group).length === 5 && uuid(group.groupId) &&
      list(group.recordIds, hash) && group.recordIds.length > 0 && group.recordIds.length <= 25 &&
      ['serialNumber', 'assetTag'].every((key) => group[key] === null || typeof group[key] === 'string' && group[key] === group[key].trim()) &&
      typeof group.evidenceReference === 'string' && group.evidenceReference === group.evidenceReference.trim())) return invalidInput();
  const captured = value as unknown as IdentityGroupInput;
  const records = captured.groups.flatMap((group) => group.recordIds);
  if (!unique(records) || Object.keys(validateIdentityGroupsDraft(original, {
    candidateIds: captured.candidateIds, note: captured.note, confirmed: true,
    assignments: Object.fromEntries(captured.groups.flatMap((group) => group.recordIds.map((id) => [id, group.groupId]))),
    groups: captured.groups.map((group) => ({ groupId: group.groupId, serial: { mode: group.serialNumber === null ? 'absent' : 'verified', value: group.serialNumber ?? '' },
      tag: { mode: group.assetTag === null ? 'absent' : 'verified', value: group.assetTag ?? '' }, evidenceReference: group.evidenceReference }))
  })).length) return invalidInput();
  return normalizeIdentityGroupInput(captured);
}
export async function readIdentityGroupContext(batchId: string, original: ImportPreview, signal: globalThis.AbortSignal) {
  if (!uuid(batchId)) throw new ApiRequestError('Revisa el lote seleccionado.', 400, 'VALIDATION_ERROR');
  const deadline = bounded(signal);
  const [detail, source] = await Promise.all([readBatch(batchId, deadline), readResolvedReviewSource(batchId, deadline)]);
  if (detail.batch.version !== source.batchVersion || detail.batch.previewId !== original.previewId || detail.batch.sourceHash !== original.source.sha256 ||
    source.preview.source.sha256 !== original.source.sha256 || !hash(original.source.sha256) || source.sourceContext.revision > 1000) invalid();
  return source;
}
function existingAsset(value: unknown) {
  return object(value) && uuid(value.id) && uuid(value.productId) && text(value.serialNumber) && text(value.assetTag) && typeof value.status === 'string' && typeof value.isActive === 'boolean' &&
    typeof value.updatedAt === 'string' && validHistoricalInstant(value.updatedAt) && object(value.product) && typeof value.product.name === 'string';
}
function candidate(value: unknown, recordIds: Set<string>) {
  return object(value) && hash(value.id) && list(value.serials, (entry) => typeof entry === 'string') && list(value.tags, (entry) => typeof entry === 'string') &&
    list(value.selectedRecordIds, (entry) => hash(entry) && recordIds.has(entry)) && unique(value.selectedRecordIds) && integer(value.outsideRecordCount) &&
    list(value.existingAssets, existingAsset) && unique(value.existingAssets.map((entry) => (entry as Value).id)) && integer(value.existingAssetCount) &&
    value.existingAssets.length === Math.min(10, Number(value.existingAssetCount)) && value.hasMoreExistingAssets === (Number(value.existingAssetCount) > 10);
}
export function validateIdentityGroupPlan(value: unknown, batchId: string, input: IdentityGroupInput, original: ImportPreview): IdentityGroupPlan {
  const scope = identityGroupScope(original, input.candidateIds); const recordIds = new Set(scope.records.map((record) => record.id));
  const candidateIds = new Set(input.candidateIds); const groups = new Map(normalizeIdentityGroupInput(input).groups.map((group) => [group.groupId, group]));
  const originals = new Map(scope.candidates.flatMap((entry) => entry.recordIds.map((id) => [id, entry.id])));
  if (!object(value) || value.scope !== 'PHYSICAL_IDENTITY_GROUP_PLAN' || value.rulesVersion !== 'mda-identity-group-plan-1' ||
    ['canApply', 'persisted', 'affectsCurrentState', 'lineagePersistenceImplemented'].some((key) => value[key] !== false) ||
    value.batchId !== batchId || value.batchVersion !== input.expectedVersion || value.sourceRevision !== input.expectedSourceRevision || value.sourceHash !== original.source.sha256 ||
    typeof value.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf) || !validHistoricalInstant(value.asOf + 'T00:00:00Z') || value.timeZone !== 'America/Santiago' ||
    !['planId', 'currentPreviewDigest', 'simulatedPreviewDigest', 'sourceContextDigest'].every((key) => hash(value[key])) ||
    !sameSnapshot(value.request, normalizeIdentityGroupInput(input)) || !['IDENTITY_ONLY', 'SPLIT', 'MERGE', 'REPARTITION'].includes(String(value.operationKind)) ||
    !['LINEAGE_WORKFLOW_NOT_IMPLEMENTED', 'IDENTITY_REVIEW_SCOPE_WORKFLOW_NOT_IMPLEMENTED', 'COORDINATED_IDENTITY_WORKFLOW_NOT_IMPLEMENTED', 'V8_IDENTITY_REVIEW'].includes(String(value.nextWorkflow))) invalid();
  if (!list(value.originalCandidates, (entry) => object(entry) && candidateIds.has(String(entry.candidateId)) &&
    list(entry.recordIds, (id) => hash(id) && originals.get(id) === entry.candidateId) && unique(entry.recordIds) &&
    entry.recordIds.length === scope.candidates.find((candidate) => candidate.id === entry.candidateId)?.recordIds.length) ||
    value.originalCandidates.length !== candidateIds.size || !unique(value.originalCandidates.map((entry) => (entry as Value).candidateId)) ||
    !list(value.observations, (entry) => object(entry) && recordIds.has(String(entry.recordId)) && originals.get(String(entry.recordId)) === entry.originalCandidateId &&
      groups.get(String(entry.proposedGroupId))?.recordIds.includes(String(entry.recordId)) === true &&
      scope.records.some((record) => record.id === entry.recordId && record.sheet === entry.sheet && record.row === entry.row) && cells(entry.originalIdentityCells) && cells(entry.currentIdentityCells)) ||
    value.observations.length !== recordIds.size || !unique(value.observations.map((entry) => (entry as Value).recordId))) invalid();
  if (!list(value.proposedGroups, (entry) => {
    if (!object(entry)) return false;
    const requested = groups.get(String(entry.groupId));
    return Boolean(requested && ['groupId', 'recordIds', 'serialNumber', 'assetTag', 'evidenceReference'].every((key) => sameSnapshot(entry[key], requested[key as keyof typeof requested])) &&
      list(entry.originalCandidateIds, (id) => hash(id) && candidateIds.has(id)) && unique(entry.originalCandidateIds) &&
      sameSnapshot([...entry.originalCandidateIds].sort(), [...new Set(requested.recordIds.map((id) => originals.get(id)))].sort()) &&
      list(entry.candidates, (candidateValue) => candidate(candidateValue, recordIds)) && unique(entry.candidates.map((candidateValue) => (candidateValue as Value).id)) &&
      list(entry.simulatedCandidateIds, hash) && sameSnapshot([...entry.simulatedCandidateIds].sort(), entry.candidates.map((candidateValue) => (candidateValue as Value).id).sort()));
  }) || value.proposedGroups.length !== groups.size || !unique(value.proposedGroups.map((entry) => (entry as Value).groupId))) invalid();
  const observations = new Map(value.observations.map((entry) => [(entry as Value).recordId, entry as Value]));
  if (!list(value.changes, (entry) => {
    if (!object(entry) || !recordIds.has(String(entry.recordId)) || !['serialNumber', 'assetTag'].includes(String(entry.field)) || entry.action !== 'REPLACE' ||
      typeof entry.column !== 'string' || !/^[A-Z]{1,3}$/.test(entry.column) || ![entry.originalCell, entry.beforeCell, entry.afterCell].every(validSourceCell)) return false;
    const row = observations.get(entry.recordId)!; const group = groups.get(String(row.proposedGroupId))!;
    return entry.candidateId === row.originalCandidateId && entry.sheet === row.sheet && entry.row === row.row && entry.value === group[entry.field as 'serialNumber' | 'assetTag'] &&
      sameSnapshot(entry.originalCell, (row.originalIdentityCells as Value)[String(entry.field)]) && sameSnapshot(entry.beforeCell, (row.currentIdentityCells as Value)[String(entry.field)]) &&
      object(entry.afterCell) && entry.afterCell.type === 'text' && entry.afterCell.value === entry.value;
  }) || value.changes.length > 50 || !unique(value.changes.map((entry) => (entry as Value).recordId + ':' + (entry as Value).field)) ||
    !list(value.issues, issue) || !list(value.warnings, issue) || !sameSnapshot(value.warnings, value.issues.filter((entry) => (entry as Value).severity === 'WARNING')) ||
    !list(value.blockers, (entry) => object(entry) && typeof entry.code === 'string' && (entry.groupId === undefined || groups.has(String(entry.groupId))) &&
      (entry.recordId === undefined || recordIds.has(String(entry.recordId))) && (entry.relatedId === undefined || typeof entry.relatedId === 'string') && (entry.issue === undefined || issue(entry.issue)))) invalid();
  if (!validIdentityGroupImpacts(value.impacts, candidateIds, recordIds)) invalid();
  if (value.requiresEvidenceLineageReview !== (value.impacts.evidence.length > 0) || value.requiresDecisionRenewal !== (value.impacts.decisions.length > 0) || typeof value.requiresCoordinatedIdentityReview !== 'boolean' ||
    value.proposalValidationComplete !== (value.blockers.length === 0) || !object(value.summary) ||
    !sameSnapshot(value.summary, { originalCandidateCount: candidateIds.size, proposedGroupCount: groups.size, observationCount: recordIds.size, changedCellCount: value.changes.length, blockingCount: value.blockers.length, warningCount: value.warnings.length })) invalid();
  return globalThis.structuredClone(value) as unknown as IdentityGroupPlan;
}
export async function readIdentityGroupPlan(batchId: string, input: IdentityGroupInput, original: ImportPreview, signal: globalThis.AbortSignal) {
  if (!uuid(batchId)) throw new ApiRequestError('Revisa el lote seleccionado.', 400, 'VALIDATION_ERROR');
  const captured = captureIdentityGroupInput(input, original);
  const deadline = bounded(signal); const body = JSON.stringify(captured);
  const token = await getCsrfToken(deadline);
  const response = await apiRequest<unknown>(importReviewPath + '/' + encodeURIComponent(batchId) + '/identity-group-plan', {
    method: 'POST', signal: deadline, headers: { 'X-CSRF-Token': token }, body
  });
  return validateIdentityGroupPlan(response, batchId, captured, original);
}
export function identityGroupErrorMessage(error: unknown) {
  return getApiErrorMessage(error, 'No se pudo simular la agrupación. Conserva el borrador, actualiza el contexto y vuelve a revisar.');
}

export { issue as validIdentityGroupIssue, cells as validIdentityGroupCells, candidate as validIdentityGroupCandidate };
export function validIdentityGroupImpacts(value: unknown, candidateIds: Set<string>, recordIds: Set<string>): value is IdentityGroupPlan['impacts'] {
  return !(!object(value) || !list(value.pilotItems, (entry) => object(entry) && onlyKeys(entry, ['id', 'candidateId', 'assetId', 'applicationId']) && ['id', 'assetId', 'applicationId'].every((key) => uuid(entry[key])) && candidateIds.has(String(entry.candidateId))) ||
    !list(value.decisions, (entry) => object(entry) && onlyKeys(entry, ['id', 'targetType', 'targetId', 'action', 'linkedAssetId', 'batchVersion', 'sourceRevision']) && uuid(entry.id) && entry.targetType === 'CANDIDATE' && candidateIds.has(String(entry.targetId)) &&
      ['HOLD', 'EXCLUDE', 'LINK_EXISTING', 'PROPOSE_NEW'].includes(String(entry.action)) && (entry.linkedAssetId === null || uuid(entry.linkedAssetId)) && integer(entry.batchVersion) && Number(entry.batchVersion) > 0 && integer(entry.sourceRevision, 1000)) ||
    !list(value.evidence, (entry) => object(entry) && onlyKeys(entry, ['id', 'recordId', 'candidateId', 'captureId', 'captureBatchId', 'capturedAssetId', 'currentAssetId', 'capturedSourceRevision', 'sourceRevision', 'evidenceVersion', 'amendmentId', 'assignmentUse', 'retirementUse']) && ['id', 'captureId', 'captureBatchId'].every((key) => uuid(entry[key])) && recordIds.has(String(entry.recordId)) && hash(entry.candidateId) &&
      [entry.capturedAssetId, entry.currentAssetId].every((id) => id === null || uuid(id)) && integer(entry.capturedSourceRevision, 1000) && integer(entry.sourceRevision, 1000) && integer(entry.evidenceVersion, 1000) &&
      (entry.evidenceVersion === 0 ? entry.amendmentId === null : uuid(entry.amendmentId)) &&
      (entry.assignmentUse === null || object(entry.assignmentUse) && uuid(entry.assignmentUse.itemId) && ['START', 'END'].includes(String(entry.assignmentUse.endpoint))) &&
      (entry.retirementUse === null || object(entry.retirementUse) && uuid(entry.retirementUse.id) && uuid(entry.retirementUse.assetId))) || value.evidence.length > 100 ||
    !['pilotItems', 'decisions', 'evidence'].every((key) => unique(((value as Value)[key] as Value[]).map((entry) => entry.id))));
}

