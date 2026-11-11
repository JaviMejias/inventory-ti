import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { validHistoricalInstant } from './closed-assignment-model';
import { sameSnapshot } from './history-evidence-api';
import { captureIdentityGroupInput, validateIdentityGroupPlan } from './identity-group-api';
import { freezeGroupReview, groupReviewUuid as uuid, type IdentityGroupRelease, type IdentityGroupReview, type IdentityGroupReviewIntent, type IdentityGroupReviewMetadata, type IdentityGroupReviewPage } from './identity-group-review-model';
import type { ImportPreview } from './import-review-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown, max = 2147483647) { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max; }
function instant(value: unknown): value is string { return typeof value === 'string' && validHistoricalInstant(value); }
function keys(value: Value, expected: string[]) { return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key)); }
function invalid(): never { throw new ApiRequestError('Invalid identity grouping receipt', 200, 'INVALID_RESPONSE'); }
function scope(value: unknown): value is Value { return object(value) && value.scope === 'IDENTITY_GROUP_REVIEW_ONLY' && value.persisted === true && ['canApply', 'affectsCurrentState', 'groupedPilotImplemented'].every((key) => value[key] === false); }
function release(value: unknown, reviewId: unknown): value is IdentityGroupRelease {
  return object(value) && keys(value, ['id', 'reviewId', 'requestId', 'requestDigest', 'note', 'releasedById', 'createdAt']) && value.reviewId === reviewId &&
    ['id', 'reviewId', 'requestId', 'releasedById'].every((key) => uuid(value[key])) && hash(value.requestDigest) && typeof value.note === 'string' && value.note === value.note.trim() && value.note.length > 0 && value.note.length <= 2000 && instant(value.createdAt);
}
function metadata(value: unknown, batchId: string): value is IdentityGroupReviewMetadata {
  return object(value) && value.batchId === batchId && ['id', 'batchId', 'reviewedById'].every((key) => uuid(value[key])) && hash(value.planId) && hash(value.sourceHash) &&
    integer(value.batchVersion) && Number(value.batchVersion) > 0 && integer(value.sourceRevision, 1000) && instant(value.createdAt) &&
    (value.release === null || release(value.release, value.id) && Date.parse(value.release.createdAt) >= Date.parse(value.createdAt));
}
const metadataKeys = ['id', 'batchId', 'batchVersion', 'sourceRevision', 'sourceHash', 'planId', 'reviewedById', 'createdAt', 'release'];
export function validateIdentityGroupReview(value: unknown, batchId: string, original: ImportPreview, expected: { id?: string; intent?: IdentityGroupReviewIntent } = {}): IdentityGroupReview {
  if (!scope(value) || !metadata(value.review, batchId) || !object(value.review)) invalid();
  const saved = value.review as unknown as Value;
  if (!keys(saved, [...metadataKeys, 'requestId', 'requestDigest', 'plan', 'rows']) || !uuid(saved.requestId) || !hash(saved.requestDigest) || !object(saved.plan) || (expected.id !== undefined && saved.id !== expected.id)) invalid();
  let plan;
  try { const input = captureIdentityGroupInput(saved.plan.request, original); plan = validateIdentityGroupPlan(saved.plan, batchId, input, original); } catch { return invalid(); }
  if (!plan.proposalValidationComplete || plan.blockers.length || plan.planId !== saved.planId || plan.batchVersion !== saved.batchVersion || plan.sourceRevision !== saved.sourceRevision || plan.sourceHash !== saved.sourceHash ||
    !Array.isArray(saved.rows) || saved.rows.length !== plan.observations.length || new Set(saved.rows.map((row) => object(row) && row.recordId)).size !== saved.rows.length ||
    !saved.rows.every((row) => object(row) && keys(row, ['reviewId', 'recordId', 'sourceHash', 'originalCandidateId', 'groupId', 'snapshot', 'isReserved']) && row.reviewId === saved.id && row.sourceHash === saved.sourceHash && row.isReserved === (saved.release === null) &&
      plan.observations.some((observation) => observation.recordId === row.recordId && observation.originalCandidateId === row.originalCandidateId && observation.proposedGroupId === row.groupId && sameSnapshot(observation, row.snapshot)))) invalid();
  const intent = expected.intent;
  if (intent) {
    if (typeof value.reused !== 'boolean' || intent.batchId !== batchId || !uuid(intent.actorId)) invalid();
    if (intent.kind === 'reserve') {
      if (saved.requestId !== intent.input.requestId || saved.reviewedById !== intent.actorId || saved.planId !== intent.input.planId || !sameSnapshot(plan.request, intent.input.plan)) invalid();
    } else {
      if (!release(saved.release, saved.id) || saved.id !== intent.review.id || saved.release.requestId !== intent.input.requestId || saved.release.note !== intent.input.note || saved.release.releasedById !== intent.actorId ||
        !sameSnapshot(Object.fromEntries(Object.entries(saved).filter(([key]) => !['release', 'rows'].includes(key))), Object.fromEntries(Object.entries(intent.review).filter(([key]) => !['release', 'rows'].includes(key)))) ||
        !sameSnapshot(saved.rows.map((row) => ({ ...row, isReserved: true })).sort((a, b) => a.recordId.localeCompare(b.recordId)), [...intent.review.rows].sort((a, b) => a.recordId.localeCompare(b.recordId)))) invalid();
    }
  } else if (value.reused !== undefined && typeof value.reused !== 'boolean') invalid();
  return freezeGroupReview(globalThis.structuredClone(saved)) as IdentityGroupReview;
}
function validRequest(batchId: string, id?: string, offset?: number) {
  if (!uuid(batchId) || id !== undefined && !uuid(id) || offset !== undefined && (!integer(offset) || offset % 25 !== 0)) throw new ApiRequestError('Revisa el lote, el comprobante y la página solicitada.', 400, 'VALIDATION_ERROR');
}
const path = (batchId: string) => '/inventory/imports/batches/' + encodeURIComponent(batchId) + '/identity-group-reviews';
function deadline(signal?: globalThis.AbortSignal) { const timeout = globalThis.AbortSignal.timeout(30_000); return signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout; }
export async function readIdentityGroupReviews(batchId: string, offset: number, signal: globalThis.AbortSignal): Promise<IdentityGroupReviewPage> {
  validRequest(batchId, undefined, offset);
  const value = await apiRequest<unknown>(path(batchId) + '?limit=25&offset=' + offset, { signal: deadline(signal) });
  if (!scope(value) || !Array.isArray(value.reviews) || !value.reviews.every((row) => metadata(row, batchId) && object(row) && keys(row, metadataKeys)) || value.limit !== 25 || value.offset !== offset || !integer(value.total) ||
    value.reviews.length !== Math.min(25, Math.max(0, Number(value.total) - offset)) || value.hasMore !== (offset + value.reviews.length < Number(value.total)) || new Set(value.reviews.map((row) => row.id)).size !== value.reviews.length) invalid();
  return freezeGroupReview(globalThis.structuredClone({ items: value.reviews as IdentityGroupReviewMetadata[], total: Number(value.total), limit: 25 as const, offset, hasMore: Boolean(value.hasMore) }));
}
export async function readIdentityGroupReview(batchId: string, id: string, original: ImportPreview, signal: globalThis.AbortSignal): Promise<IdentityGroupReview> {
  validRequest(batchId, id);
  return validateIdentityGroupReview(await apiRequest<unknown>(path(batchId) + '/' + id, { signal: deadline(signal) }), batchId, original, { id });
}
export async function writeIdentityGroupReview(intent: IdentityGroupReviewIntent, original: ImportPreview): Promise<IdentityGroupReview> {
  if (!object(intent) || !['reserve', 'release'].includes(intent.kind) || !object(intent.input) || intent.kind === 'release' && !object(intent.review) || !keys(intent, intent.kind === 'reserve' ? ['kind', 'batchId', 'actorId', 'input'] : ['kind', 'batchId', 'actorId', 'review', 'input'])) throw new ApiRequestError('Revisa la intención de agrupación.', 400, 'VALIDATION_ERROR');
  validRequest(intent.batchId, intent.actorId);
  const captured = globalThis.structuredClone(intent);
  if (!uuid(captured.input.requestId)) throw new ApiRequestError('Revisa la intención de reserva.', 400, 'VALIDATION_ERROR');
  if (captured.kind === 'reserve') {
    if (!keys(captured.input, ['requestId', 'planId', 'confirmation', 'plan']) || captured.input.confirmation !== 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY' || !hash(captured.input.planId)) throw new ApiRequestError('Revisa el escenario.', 400, 'VALIDATION_ERROR');
    captured.input.plan = captureIdentityGroupInput(captured.input.plan, original);
  } else {
    validRequest(captured.batchId, captured.review.id);
    if (!keys(captured.input, ['requestId', 'confirmation', 'note']) || captured.input.confirmation !== 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY' || typeof captured.input.note !== 'string' || !captured.input.note.trim() || captured.input.note !== captured.input.note.trim() || captured.input.note.length > 2000 || captured.review.batchId !== captured.batchId || captured.review.release) throw new ApiRequestError('Revisa la cancelación.', 400, 'VALIDATION_ERROR');
  }
  const signal = deadline(); const body = JSON.stringify(captured.input); const token = await getCsrfToken(signal);
  const target = path(captured.batchId) + (captured.kind === 'release' ? '/' + captured.review.id + '/release' : '');
  return validateIdentityGroupReview(await apiRequest<unknown>(target, { method: 'POST', signal, headers: { 'X-CSRF-Token': token }, body }), captured.batchId, original, { intent: captured });
}
export function identityGroupReviewNeedsRecovery(error: unknown) {
  return !(error instanceof ApiRequestError) || error.status >= 500 || ['NETWORK_ERROR', 'INVALID_RESPONSE', 'IDENTITY_GROUP_REVIEW_BUSY', 'IDENTITY_GROUP_REVIEW_CONFLICT'].includes(error.code ?? '');
}
