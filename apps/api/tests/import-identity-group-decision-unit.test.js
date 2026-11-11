import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { identityGroupDecisionDigest, identityGroupDecisionListSchema, identityGroupDecisionSchema } from '../src/imports/identity-group-decision-schemas.js';
import { validateIdentityGroupDecision } from '../src/imports/identity-group-decision.js';
import { buildIdentityGroupPlan } from '../src/imports/identity-group-plan.js';
import { buildIdentityGroupProjection } from '../src/imports/identity-group-projection.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { receptionRow, workbook } from './fixtures/workbook-preview.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
  const original = workbook('Recepción', [receptionRow(4, 'ORIGINAL'), receptionRow(5, 'ORIGINAL')]);
  const baseline = buildWorkbookPreview(original, [], '2026-10-05');
  const context = { batchId: randomUUID(), batchVersion: 1, sourceContext: { revision: 0, corrections: [], identityRevisions: [] } };
  const proposal = { expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: baseline.candidates.map((entry) => entry.id), note: 'Physically reviewed groups',
    groups: baseline.records.map((record, index) => ({ groupId: randomUUID(), recordIds: [record.id],
      serialNumber: 'UNIT-VERIFIED-' + index, assetTag: null, evidenceReference: 'Physical label' })) };
  const plan = buildIdentityGroupPlan(original, original, [], context, proposal, undefined, '2026-10-05');
  const review = { id: randomUUID(), batchId: context.batchId, batchVersion: 1, sourceRevision: 0, sourceHash: original.source.sha256,
    planId: plan.planId, plan, release: null, rows: [] };
  review.rows = plan.observations.map((observation) => ({ reviewId: review.id, sourceHash: review.sourceHash,
    recordId: observation.recordId, originalCandidateId: observation.originalCandidateId, groupId: observation.proposedGroupId,
    snapshot: clone(observation), isReserved: true }));
  const build = (existing = [], evidence = []) => buildIdentityGroupProjection(original, original, existing, context, review,
    { decisions: [], pilotItems: [], evidence }, '2026-10-05');
  const projection = build();
  const input = identityGroupDecisionSchema.parse({ requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
    expectedDecisionVersion: 0, expectedBatchVersion: 1, expectedSourceRevision: 0, projectionId: projection.projectionId,
    groupKey: projection.groups[0].groupKey, action: 'PROPOSE_NEW', note: 'Source identity independently reviewed',
    evidenceReference: 'Signed physical checklist', evidenceReviews: [] });
  return { projection, input, build };
}
const rejects = (projection, input, code) => assert.throws(() => validateIdentityGroupDecision(projection, input), (error) => error.code === code);
function evidence(recordId) {
  return { id: randomUUID(), recordId, candidateId: 'b'.repeat(64), captureId: randomUUID(), capturedAssetId: randomUUID(), currentAssetId: null,
    evidenceVersion: 2, amendmentId: randomUUID(), sourceRevision: 0, captureBatchId: randomUUID(), capturedSourceRevision: 0, assignmentUse: null, retirementUse: null };
}
const evidenceReview = (entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion,
  disposition: 'CONFIRM_GROUP_MEMBERSHIP', note: 'Original observation belongs to this group', evidenceReference: 'Physical and archival documents' });

test('group decision DTO requires its own explicit confirmation, strict stable target and separate version', () => {
  const { input } = fixture(); assert.equal(identityGroupDecisionSchema.safeParse(input).success, true);
  for (const change of [{ confirmation: 'APPLY' }, { groupKey: randomUUID() }, { expectedDecisionVersion: -1 },
    { expectedBatchVersion: 0 }, { expectedSourceRevision: 1001 }, { force: true }, { targetType: 'CANDIDATE' },
    { action: 'LINK_EXISTING' }, { linkedAssetId: randomUUID() }, { evidenceReviews: undefined }]) {
    assert.equal(identityGroupDecisionSchema.safeParse({ ...input, ...change }).success, false, JSON.stringify(change));
  }
  const parsed = identityGroupDecisionSchema.parse({ ...input, requestId: input.requestId.toUpperCase(), note: '  Physical review  ' });
  assert.equal(parsed.requestId, input.requestId); assert.equal(parsed.note, 'Physical review');
});

test('group decision retry digest preserves evidence intent and actor-independent payload ordering', () => {
  const { input } = fixture(); const first = evidenceReview(evidence('a'.repeat(64))); const second = evidenceReview(evidence('c'.repeat(64)));
  const intent = { ...input, evidenceReviews: [first, second] };
  assert.equal(identityGroupDecisionDigest(intent), identityGroupDecisionDigest({ ...intent, evidenceReviews: [second, first] }));
  for (const change of [{ note: 'Different proof' }, { groupKey: 'e'.repeat(64) }, { expectedDecisionVersion: 2 },
    { evidenceReviews: [{ ...first, disposition: 'EXCLUDE_FROM_GROUP_PILOT' }, second] }]) {
    assert.notEqual(identityGroupDecisionDigest(intent), identityGroupDecisionDigest({ ...intent, ...change }));
  }
  assert.equal(identityGroupDecisionSchema.safeParse({ ...input, evidenceReviews: [first, first] }).success, false);
});

test('group decisions require exact current projection and version without accepting original or simulated targets', () => {
  const { projection, input } = fixture();
  assert.equal(validateIdentityGroupDecision(projection, input).groupKey, input.groupKey);
  rejects(projection, { ...input, expectedBatchVersion: 2 }, 'REVIEW_VERSION_CONFLICT');
  rejects(projection, { ...input, expectedSourceRevision: 1 }, 'SOURCE_REVISION_CONFLICT');
  rejects(projection, { ...input, projectionId: '0'.repeat(64) }, 'IDENTITY_GROUP_PROJECTION_CHANGED');
  for (const groupKey of [projection.groups[0].groupId, projection.groups[0].simulatedCandidateIds[0], projection.groups[0].originalCandidateIds[0]]) {
    rejects(projection, { ...input, groupKey }, 'INVALID_IDENTITY_GROUP_TARGET');
  }
});

test('group decisions allow only unique current suggested matches and do not treat a new proposal as an inventory write', () => {
  const f = fixture(); const group = f.projection.groups[0];
  const asset = { id: randomUUID(), productId: randomUUID(), serialNumber: group.serialNumber, assetTag: null,
    status: 'AVAILABLE', isActive: true, updatedAt: '2026-01-01', product: { name: 'Notebook' } };
  const projection = f.build([asset]); const input = { ...f.input, projectionId: projection.projectionId };
  rejects(projection, input, 'NEW_ASSET_PROPOSAL_CONFLICT');
  rejects(projection, { ...input, action: 'LINK_EXISTING', linkedAssetId: randomUUID() }, 'ASSET_NOT_SUGGESTED');
  assert.equal(validateIdentityGroupDecision(projection, { ...input, action: 'LINK_EXISTING', linkedAssetId: asset.id }).groupKey, group.groupKey);
  assert.equal(projection.canApply, false);
  const truncated = clone(projection); truncated.groups[0].candidates[0].existingAssetCount = 11;
  truncated.groups[0].candidates[0].hasMoreExistingAssets = true;
  rejects(truncated, { ...input, action: 'LINK_EXISTING', linkedAssetId: asset.id }, 'ASSET_NOT_SUGGESTED');
});

test('hold and exclusion preserve diagnostics while blocked groups cannot acquire operational proposals', () => {
  const { projection, input } = fixture(); const blocked = { ...projection, projectionValidationComplete: false };
  rejects(blocked, input, 'IDENTITY_GROUP_DECISION_BLOCKED');
  for (const action of ['HOLD', 'EXCLUDE']) assert.equal(validateIdentityGroupDecision(blocked, { ...input, action }).groupKey, input.groupKey);
});

test('group evidence review requires exact complete current-version coverage with explicit provenance dispositions', () => {
  const f = fixture(); const first = evidence(f.projection.groups[0].recordIds[0]); const other = evidence(f.projection.groups[1].recordIds[0]);
  const projection = f.build([], [first, other]); const input = { ...f.input, projectionId: projection.projectionId };
  rejects(projection, input, 'IDENTITY_GROUP_EVIDENCE_COVERAGE_REQUIRED');
  rejects(projection, { ...input, evidenceReviews: [evidenceReview(other)] }, 'IDENTITY_GROUP_EVIDENCE_COVERAGE_REQUIRED');
  rejects(projection, { ...input, evidenceReviews: [{ ...evidenceReview(first), expectedEvidenceVersion: 1 }] }, 'EVIDENCE_VERSION_CONFLICT');
  for (const disposition of ['CONFIRM_GROUP_MEMBERSHIP', 'EXCLUDE_FROM_GROUP_PILOT']) {
    const before = clone(projection);
    validateIdentityGroupDecision(projection, { ...input, evidenceReviews: [{ ...evidenceReview(first), disposition }] });
    assert.deepEqual(projection, before); assert.equal(projection.groups[0].evidence[0].currentAssetId, null);
    assert.equal(projection.groups[0].evidence[0].linkedToGroup, false);
  }
});

test('used evidence is never reassigned and hold cannot hide partial or consumed evidence endorsements', () => {
  const f = fixture(); const first = evidence(f.projection.groups[0].recordIds[0]); first.assignmentUse = { itemId: randomUUID(), endpoint: 'START' };
  const projection = f.build([], [first]); const input = { ...f.input, projectionId: projection.projectionId, action: 'HOLD', evidenceReviews: [evidenceReview(first)] };
  rejects(projection, input, 'EVIDENCE_ALREADY_APPLIED');
  assert.equal(validateIdentityGroupDecision(projection, { ...input, evidenceReviews: [] }).groupKey, input.groupKey);
});

test('group decision history queries are bounded and strict without authorization overrides', () => {
  assert.deepEqual(identityGroupDecisionListSchema.parse({}), { limit: 25, offset: 0, mode: 'latest' });
  for (const query of [{ limit: 101 }, { offset: -1 }, { mode: 'apply' }, { groupKey: randomUUID() }, { force: true }]) assert.equal(identityGroupDecisionListSchema.safeParse(query).success, false);
  assert.equal(importPlanDigest(identityGroupDecisionListSchema.parse({ groupKey: 'a'.repeat(64) })).length, 64);
});
