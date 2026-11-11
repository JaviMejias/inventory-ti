import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { identityGroupReleaseSchema, identityGroupReviewDigest, identityGroupReviewSchema } from '../src/imports/identity-group-review-schemas.js';

function input() {
  return { requestId: randomUUID(), planId: 'f'.repeat(64), confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: {
    expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: ['a'.repeat(64), 'b'.repeat(64)], note: 'Independently verified physical groups',
    groups: ['a', 'b'].map((letter) => ({ groupId: randomUUID(), recordIds: [letter.repeat(64)], serialNumber: 'PHYSICAL-' + letter,
      assetTag: null, evidenceReference: 'Physical label checked' })) } };
}
test('identity group review requires separate staging confirmation, complete strict plan and retry identity', () => {
  const request = input(); assert.equal(identityGroupReviewSchema.safeParse(request).success, true);
  for (const change of [{ confirmation: 'APPLY' }, { requestId: null }, { planId: randomUUID() }, { force: true },
    { plan: { ...request.plan, historicalActorId: randomUUID() } }]) assert.equal(identityGroupReviewSchema.safeParse({ ...request, ...change }).success, false);
  assert.equal(identityGroupReviewSchema.parse({ ...request, requestId: request.requestId.toUpperCase() }).requestId, request.requestId);
});
test('identity group review retry digest normalizes membership ordering but binds physical identity, plan and proof', () => {
  const request = input(); const baseline = identityGroupReviewDigest(request);
  assert.equal(identityGroupReviewDigest({ ...request, plan: { ...request.plan, candidateIds: [...request.plan.candidateIds].reverse(), groups: [...request.plan.groups].reverse() } }), baseline);
  for (const change of [{ planId: 'e'.repeat(64) }, { plan: { ...request.plan, note: 'Other intent' } },
    { plan: { ...request.plan, groups: request.plan.groups.map((group) => ({ ...group, evidenceReference: 'Other proof' })) } }]) {
    assert.notEqual(identityGroupReviewDigest({ ...request, ...change }), baseline);
  }
});
test('identity grouping release requires an explicit reason and cannot rewrite the approved groups or inventory', () => {
  const request = { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Review abandoned after physical verification' };
  assert.equal(identityGroupReleaseSchema.safeParse(request).success, true);
  for (const change of [{ note: ' ' }, { confirmation: 'APPLY' }, { groups: [] }, { status: 'AVAILABLE' }, { force: true }]) {
    assert.equal(identityGroupReleaseSchema.safeParse({ ...request, ...change }).success, false);
  }
});
