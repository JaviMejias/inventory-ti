import { identityGroupFixture } from './identity-group.mjs';

export const groupReviewActorId = '00000000-0000-4000-8000-000000000009';
export const groupReviewId = '00000000-0000-4000-8000-000000000601';
export const groupReviewRequestId = '00000000-0000-4000-8000-000000000602';
export const groupReleaseRequestId = '00000000-0000-4000-8000-000000000603';
// Synthetic V17 storage envelopes follow the backend serializer around the pure V16 fixture.
export function identityGroupReviewFixture(released = false) {
  const fixture = identityGroupFixture(); const plan = globalThis.structuredClone(fixture.plan);
  const release = released ? { id: '00000000-0000-4000-8000-000000000604', reviewId: groupReviewId,
    requestId: groupReleaseRequestId, requestDigest: 'd'.repeat(64), note: 'Se descarta esta propuesta de prueba', releasedById: groupReviewActorId, createdAt: '2026-10-25T17:00:00.000Z' } : null;
  const review = { id: groupReviewId, batchId: plan.batchId, batchVersion: plan.batchVersion, sourceRevision: plan.sourceRevision, sourceHash: plan.sourceHash,
    requestId: groupReviewRequestId, requestDigest: 'c'.repeat(64), planId: plan.planId, plan, reviewedById: groupReviewActorId, createdAt: '2026-10-25T16:00:00.000Z', release,
    rows: plan.observations.map(snapshot => ({ reviewId: groupReviewId, recordId: snapshot.recordId, sourceHash: plan.sourceHash, originalCandidateId: snapshot.originalCandidateId, groupId: snapshot.proposedGroupId, snapshot: globalThis.structuredClone(snapshot), isReserved: !released })) };
  const flags = { scope: 'IDENTITY_GROUP_REVIEW_ONLY', persisted: true, canApply: false, affectsCurrentState: false, groupedPilotImplemented: false };
  return { ...fixture, review, flags, receipt: { ...flags, review, reused: false } };
}
export function groupReviewMetadata(review) { return Object.fromEntries(Object.entries(review).filter(([key]) => !['plan', 'rows', 'requestId', 'requestDigest'].includes(key))); }
