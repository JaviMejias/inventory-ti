import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { validHistoricalInstant } from './closed-assignment-model';
import { sameSnapshot } from './history-evidence-api';
import { readIdentityGroupProjection, validateArchivedIdentityGroupProjection, validateIdentityGroupProjection } from './identity-group-projection-api';
import { freezeGroupReview, groupReviewUuid as uuid, type IdentityGroupReview } from './identity-group-review-model';
import { importReviewPath } from './import-review-api';
import type { IdentityGroupProjection } from './identity-group-projection-model';
import type { GroupDecision, GroupDecisionContext, GroupDecisionInput, GroupDecisionIntent, GroupDecisionMetadata, GroupDecisionPage, GroupDecisionRead, GroupDecisionSaved } from './identity-group-decision-model';

type Value = Record<string, unknown>;
const metadataKeys = ['id', 'reviewId', 'version', 'requestId', 'requestDigest', 'rulesVersion', 'groupId', 'groupKey', 'batchVersion', 'sourceRevision', 'projectionId', 'action', 'linkedAssetId', 'note', 'evidenceReference', 'evidenceReviews', 'reviewedById', 'createdAt'];
const evidenceKeys = ['evidenceId', 'expectedEvidenceVersion', 'disposition', 'note', 'evidenceReference'];
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Value, expected: string[]) { return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key)); }
function integer(value: unknown, min = 0, max = 2147483647) { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max; }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max; }
function list(value: unknown, guard: (entry: unknown) => boolean): value is Value[] { return Array.isArray(value) && value.every(guard); }
function unique(rows: unknown[]) { return new Set(rows).size === rows.length; }
function invalid(): never { throw new ApiRequestError('Unexpected group decision receipt', 200, 'INVALID_RESPONSE'); }
function inputError(): never { throw new ApiRequestError('Revisa la decisión, su contexto y todas las evidencias antes de guardar.', 400, 'VALIDATION_ERROR'); }
function scope(value: unknown): value is Value { return object(value) && value.scope === 'IDENTITY_GROUP_DECISION_ONLY' && value.persisted === true && ['canApply', 'affectsCurrentState', 'groupedPilotImplemented', 'evidenceRelinked'].every((key) => value[key] === false); }
function action(value: unknown) { return ['HOLD', 'EXCLUDE', 'LINK_EXISTING', 'PROPOSE_NEW'].includes(String(value)); }
function evidenceReviews(value: unknown) {
  return list(value, (row) => object(row) && keys(row, evidenceKeys) && uuid(row.evidenceId) && integer(row.expectedEvidenceVersion, 0, 1000) &&
    ['CONFIRM_GROUP_MEMBERSHIP', 'EXCLUDE_FROM_GROUP_PILOT'].includes(String(row.disposition)) && text(row.note, 2000) && text(row.evidenceReference, 500)) && value.length <= 100 && unique(value.map((row) => row.evidenceId));
}
function metadata(value: unknown, review: IdentityGroupReview, extra: string[] = []): value is GroupDecisionMetadata & Value {
  return object(value) && keys(value, [...metadataKeys, ...extra]) && ['id', 'reviewId', 'requestId', 'reviewedById', 'groupId'].every((key) => uuid(value[key])) &&
    value.reviewId === review.id && review.plan.request.groups.some((group) => group.groupId === value.groupId) && value.rulesVersion === 'mda-identity-group-decision-1' &&
    integer(value.version, 1) && integer(value.batchVersion, review.batchVersion) && integer(value.sourceRevision, review.sourceRevision, 1000) &&
    ['requestDigest', 'groupKey', 'projectionId'].every((key) => hash(value[key])) && action(value.action) && (value.action === 'LINK_EXISTING' ? uuid(value.linkedAssetId) : value.linkedAssetId === null) &&
    text(value.note, 2000) && text(value.evidenceReference, 500) && evidenceReviews(value.evidenceReviews) && typeof value.createdAt === 'string' && validHistoricalInstant(value.createdAt);
}
function projectionPolicy(input: GroupDecisionInput, projection: IdentityGroupProjection) {
  const group = projection.groups.find((row) => row.groupKey === input.groupKey);
  if (!group || input.expectedBatchVersion !== projection.batchVersion || input.expectedSourceRevision !== projection.sourceRevision || input.projectionId !== projection.projectionId) return false;
  const operational = input.action === 'LINK_EXISTING' || input.action === 'PROPOSE_NEW';
  if (operational && !projection.projectionValidationComplete) return false;
  if (input.action === 'PROPOSE_NEW' && group.candidates.some((row) => row.existingAssetCount > 0)) return false;
  if (input.action === 'LINK_EXISTING') {
    const matches = new Set(group.candidates.flatMap((row) => row.existingAssets.map((asset) => asset.id)));
    if (matches.size !== 1 || !matches.has(input.linkedAssetId!) || group.candidates.some((row) => row.existingAssetCount !== 1 || row.hasMoreExistingAssets)) return false;
  }
  if (operational || input.evidenceReviews.length) {
    const evidence = new Map(group.evidence.map((row) => [row.id, row]));
    if (input.evidenceReviews.length !== evidence.size || input.evidenceReviews.some((row) => {
      const source = evidence.get(row.evidenceId); return !source || row.expectedEvidenceVersion !== source.evidenceVersion || source.assignmentUse || source.retirementUse;
    })) return false;
  }
  return true;
}
export function captureGroupDecisionIntent(value: GroupDecisionIntent): GroupDecisionIntent {
  if (!object(value) || !keys(value, ['review', 'actorId', 'projection', 'input']) || !uuid(value.actorId) || !object(value.review) || !uuid(value.review.id) || !uuid(value.review.batchId) || value.review.release || !object(value.input)) inputError();
  const projection = validateIdentityGroupProjection(value.projection, value.review as IdentityGroupReview);
  const input = value.input;
  const expected = ['requestId', 'confirmation', 'expectedDecisionVersion', 'expectedBatchVersion', 'expectedSourceRevision', 'projectionId', 'groupKey', 'action', 'note', 'evidenceReference', 'evidenceReviews'];
  if (!keys(input, input.action === 'LINK_EXISTING' ? [...expected, 'linkedAssetId'] : expected) || !uuid(input.requestId) || input.confirmation !== 'RECORD_IDENTITY_GROUP_DECISION_ONLY' ||
    !integer(input.expectedDecisionVersion, 0, 2147483646) || !integer(input.expectedBatchVersion, 1) || !integer(input.expectedSourceRevision, 0, 1000) || !hash(input.projectionId) || !hash(input.groupKey) ||
    !action(input.action) || input.action === 'LINK_EXISTING' && !uuid(input.linkedAssetId) || !text(input.note, 2000) || !text(input.evidenceReference, 500) || !evidenceReviews(input.evidenceReviews) ||
    !projectionPolicy(input as GroupDecisionInput, projection)) inputError();
  return freezeGroupReview(globalThis.structuredClone(value));
}
function decision(value: unknown, review: IdentityGroupReview): GroupDecision {
  if (!metadata(value, review, ['projection'])) invalid();
  const projection = validateArchivedIdentityGroupProjection(value.projection, review);
  const group = projection.groups.find((row) => row.groupKey === value.groupKey);
  const input: GroupDecisionInput = { requestId: value.requestId, confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY', expectedDecisionVersion: value.version - 1,
    expectedBatchVersion: value.batchVersion, expectedSourceRevision: value.sourceRevision, projectionId: value.projectionId, groupKey: value.groupKey,
    action: value.action, ...(value.linkedAssetId ? { linkedAssetId: value.linkedAssetId } : {}), note: value.note, evidenceReference: value.evidenceReference, evidenceReviews: value.evidenceReviews };
  if (!group || group.groupId !== value.groupId || !projectionPolicy(input, projection)) invalid();
  return { ...value, projection } as GroupDecision;
}
function current(value: Value) {
  return integer(value.decisionVersion) && typeof value.reviewActive === 'boolean' && (value.reviewActive ? hash(value.currentProjectionId) : value.currentProjectionId === null);
}
function path(review: IdentityGroupReview) {
  if (!uuid(review.id) || !uuid(review.batchId)) throw new ApiRequestError('Consulta una revisión del lote seleccionado.', 400, 'VALIDATION_ERROR');
  return `${importReviewPath}/${review.batchId}/identity-group-reviews/${review.id}/decisions`;
}
function deadline(signal?: globalThis.AbortSignal) { const timeout = globalThis.AbortSignal.timeout(30_000); return signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout; }
export async function readGroupDecisions(review: IdentityGroupReview, mode: 'latest' | 'history', groupKey: string, offset: number, signal: globalThis.AbortSignal): Promise<GroupDecisionPage> {
  if (!['latest', 'history'].includes(mode) || groupKey && !hash(groupKey) || !integer(offset)) throw new ApiRequestError('Revisa los filtros de decisiones.', 400, 'VALIDATION_ERROR');
  const query = new globalThis.URLSearchParams({ mode, limit: '25', offset: String(offset), ...(groupKey ? { groupKey } : {}) });
  const value = await apiRequest<unknown>(path(review) + '?' + query, { signal: deadline(signal) });
  if (!scope(value) || !current(value) || value.mode !== mode || value.limit !== 25 || value.offset !== offset || !integer(value.total) || typeof value.hasMore !== 'boolean' ||
    !list(value.decisions, (row) => metadata(row, review, ['projectionCurrent']) && row.version <= Number(value.decisionVersion) && typeof row.projectionCurrent === 'boolean' &&
      row.projectionCurrent === (value.reviewActive && row.projectionId === value.currentProjectionId) && (!groupKey || row.groupKey === groupKey)) ||
    value.decisions.length !== Math.min(25, Math.max(0, Number(value.total) - offset)) || value.hasMore !== (offset + value.decisions.length < Number(value.total)) ||
    !unique(value.decisions.map((row) => row.id)) || !unique(value.decisions.map((row) => row.version)) ||
    value.decisions.some((row, index, rows) => index > 0 && Number(rows[index - 1].version) <= Number(row.version)) ||
    mode === 'latest' && (!unique(value.decisions.map((row) => row.groupKey)) || Number(value.total) > review.plan.request.groups.length)) invalid();
  const identities = new Map<string, string>(); const groupKeys = new Map<string, string>();
  for (const row of value.decisions) {
    if (identities.has(String(row.groupKey)) && identities.get(String(row.groupKey)) !== row.groupId || groupKeys.has(String(row.groupId)) && groupKeys.get(String(row.groupId)) !== row.groupKey) invalid();
    identities.set(String(row.groupKey), String(row.groupId)); groupKeys.set(String(row.groupId), String(row.groupKey));
  }
  return freezeGroupReview({ items: value.decisions, decisionVersion: value.decisionVersion, reviewActive: value.reviewActive, currentProjectionId: value.currentProjectionId,
    mode, groupKey, total: value.total, offset, limit: 25, hasMore: value.hasMore }) as GroupDecisionPage;
}
export async function readGroupDecision(review: IdentityGroupReview, id: string, signal: globalThis.AbortSignal): Promise<GroupDecisionRead> {
  if (!uuid(id)) throw new ApiRequestError('Selecciona un comprobante de decisión válido.', 400, 'VALIDATION_ERROR');
  const value = await apiRequest<unknown>(path(review) + '/' + id, { signal: deadline(signal) });
  if (!scope(value) || !current(value)) invalid();
  const saved = decision(value.decision, review);
  if (saved.id !== id || saved.version > Number(value.decisionVersion) || value.projectionCurrent !== (value.reviewActive && saved.projectionId === value.currentProjectionId)) invalid();
  return freezeGroupReview({ decision: saved, decisionVersion: value.decisionVersion, reviewActive: value.reviewActive, currentProjectionId: value.currentProjectionId, projectionCurrent: value.projectionCurrent }) as GroupDecisionRead;
}
export async function readGroupDecisionContext(review: IdentityGroupReview, signal: globalThis.AbortSignal, initial?: IdentityGroupProjection): Promise<GroupDecisionContext> {
  const bounded = deadline(signal);
  const projection = initial ? validateIdentityGroupProjection(initial, review) : await readIdentityGroupProjection(review, bounded);
  const latest = await readGroupDecisions(review, 'latest', '', 0, bounded);
  if (!latest.reviewActive || latest.currentProjectionId !== projection.projectionId) throw new ApiRequestError('El contexto cambió durante la consulta.', 409, 'IDENTITY_GROUP_PROJECTION_CHANGED');
  if (latest.hasMore || latest.items.some((row) => !projection.groups.some((group) => group.groupKey === row.groupKey && group.groupId === row.groupId))) invalid();
  return freezeGroupReview({ projection, latest });
}
export async function writeGroupDecision(intent: GroupDecisionIntent): Promise<GroupDecisionSaved> {
  const captured = captureGroupDecisionIntent(intent); const body = JSON.stringify(captured.input); const signal = deadline();
  const csrf = await getCsrfToken(signal);
  const value = await apiRequest<unknown>(path(captured.review), { method: 'POST', signal, headers: { 'X-CSRF-Token': csrf }, body });
  if (!scope(value) || typeof value.reused !== 'boolean' || !integer(value.decisionVersion, 1)) invalid();
  const saved = decision(value.decision, captured.review); const input = captured.input;
  if (saved.reviewedById !== captured.actorId || saved.requestId !== input.requestId || saved.version !== input.expectedDecisionVersion + 1 ||
    Number(value.decisionVersion) < saved.version || !value.reused && value.decisionVersion !== saved.version || !sameSnapshot(saved.projection, captured.projection) ||
    !sameSnapshot({ action: saved.action, linkedAssetId: saved.linkedAssetId, note: saved.note, evidenceReference: saved.evidenceReference, evidenceReviews: saved.evidenceReviews },
      { action: input.action, linkedAssetId: input.linkedAssetId ?? null, note: input.note, evidenceReference: input.evidenceReference, evidenceReviews: [...input.evidenceReviews].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)) })) invalid();
  return freezeGroupReview({ decision: saved, decisionVersion: value.decisionVersion, reused: value.reused }) as GroupDecisionSaved;
}
export function groupDecisionNeedsRecovery(error: unknown) {
  return !(error instanceof ApiRequestError) || error.status >= 500 || ['NETWORK_ERROR', 'INVALID_RESPONSE', 'IDENTITY_GROUP_REVIEW_BUSY', 'IDENTITY_GROUP_REVIEW_CONFLICT'].includes(error.code ?? '');
}
