import { ApiRequestError } from '../../lib/api';
import { captureIdentityGroupInput, validateIdentityGroupPlan } from './identity-group-api';
import type { IdentityGroupInput, IdentityGroupPlan } from './identity-group-model';
import type { ImportPreview } from './import-review-model';

export type IdentityGroupRelease = { id: string; reviewId: string; requestId: string; requestDigest: string; note: string; releasedById: string; createdAt: string };
export type IdentityGroupReviewMetadata = {
  id: string; batchId: string; batchVersion: number; sourceRevision: number; sourceHash: string; planId: string; reviewedById: string; createdAt: string; release: IdentityGroupRelease | null;
};
export type IdentityGroupReview = IdentityGroupReviewMetadata & {
  requestId: string; requestDigest: string; plan: IdentityGroupPlan;
  rows: Array<{ reviewId: string; recordId: string; sourceHash: string; originalCandidateId: string; groupId: string; snapshot: IdentityGroupPlan['observations'][number]; isReserved: boolean }>;
};
export type IdentityGroupReviewPage = { items: IdentityGroupReviewMetadata[]; total: number; offset: number; limit: 25; hasMore: boolean };
type ReserveInput = { requestId: string; planId: string; confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY'; plan: IdentityGroupInput };
type ReleaseInput = { requestId: string; confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY'; note: string };
export type IdentityGroupReviewIntent =
  | { kind: 'reserve'; batchId: string; actorId: string; input: ReserveInput }
  | { kind: 'release'; batchId: string; actorId: string; review: IdentityGroupReview; input: ReleaseInput };

export function freezeGroupReview<T>(value: T): T {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freezeGroupReview(entry); Object.freeze(value); }
  return value;
}
export function groupReviewUuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function invalid(): never { throw new ApiRequestError('Revisa el escenario y la confirmación antes de reservar.', 400, 'VALIDATION_ERROR'); }
export function reserveIdentityGroupIntent(batchId: string, actorId: string, plan: IdentityGroupPlan, original: ImportPreview, requestId: string): IdentityGroupReviewIntent {
  if (!groupReviewUuid(batchId) || !groupReviewUuid(actorId) || !groupReviewUuid(requestId.toLowerCase())) invalid();
  const input = captureIdentityGroupInput(plan.request, original);
  const checked = validateIdentityGroupPlan(plan, batchId, input, original);
  if (!checked.proposalValidationComplete || checked.blockers.length) throw new ApiRequestError('El escenario tiene bloqueos.', 409, 'IDENTITY_GROUP_PLAN_BLOCKED');
  return freezeGroupReview({ kind: 'reserve', batchId, actorId, input: { requestId: requestId.toLowerCase(), planId: checked.planId, confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: input } });
}
export function releaseIdentityGroupIntent(batchId: string, actorId: string, review: IdentityGroupReview, note: string, requestId: string): IdentityGroupReviewIntent {
  if (!groupReviewUuid(batchId) || !groupReviewUuid(actorId) || !groupReviewUuid(requestId.toLowerCase()) || !groupReviewUuid(review.id) || review.batchId !== batchId || review.release || !note.trim() || note.trim().length > 2000) invalid();
  return freezeGroupReview({ kind: 'release', batchId, actorId, review: globalThis.structuredClone(review), input: { requestId: requestId.toLowerCase(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: note.trim() } });
}
