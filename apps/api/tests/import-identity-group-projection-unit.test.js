import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { identityGroupPlanSchema } from '../src/imports/identity-group-plan-schemas.js';
import { buildIdentityGroupPlan } from '../src/imports/identity-group-plan.js';
import { buildIdentityGroupProjection, identityGroupProjectionQuerySchema, validateIdentityGroupReview } from '../src/imports/identity-group-projection.js';
import { buildResolvedPreview } from '../src/imports/identity.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { numberCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture(rows = [receptionRow(4, 'REPEATED'), receptionRow(5, 'REPEATED')], selectedSerial = null) {
  const original = workbook('Recepción', rows); const baseline = buildWorkbookPreview(original, [], '2026-10-05');
  const candidates = selectedSerial ? baseline.candidates.filter((candidate) => candidate.serials.includes(selectedSerial)) : baseline.candidates;
  const records = baseline.records.filter((record) => candidates.some((candidate) => candidate.recordIds.includes(record.id)));
  const context = { batchId: randomUUID(), batchVersion: 1, sourceContext: { revision: 0, corrections: [], identityRevisions: [] } };
  const input = identityGroupPlanSchema.parse({ expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: candidates.map((candidate) => candidate.id), note: 'Independent physical verification',
    groups: records.map((record, index) => ({ groupId: randomUUID(), recordIds: [record.id], serialNumber: 'VERIFIED-' + index,
      assetTag: record.tagKey, evidenceReference: 'Original labels and records' })) });
  const makeReview = (proposal = input, effective = original) => {
    const plan = buildIdentityGroupPlan(original, effective, [], context, proposal, undefined, '2026-10-05');
    assert.equal(plan.proposalValidationComplete, true); const id = randomUUID();
    return { id, batchId: context.batchId, batchVersion: 1, sourceRevision: 0, sourceHash: original.source.sha256, planId: plan.planId, plan, release: null,
      rows: plan.observations.map((observation) => ({ reviewId: id, recordId: observation.recordId, sourceHash: original.source.sha256,
        originalCandidateId: observation.originalCandidateId, groupId: observation.proposedGroupId, snapshot: clone(observation), isReserved: true })) };
  };
  const review = makeReview();
  const build = (change = {}) => buildIdentityGroupProjection(change.original ?? original, change.effective ?? original, change.existing ?? [],
    change.context ?? context, change.review ?? review, change.impacts, change.asOf ?? '2026-10-05');
  return { original, baseline, context, input, review, makeReview, build };
}
const invalid = (operation) => assert.throws(operation, (error) => error.statusCode === 409 && error.code === 'INVALID_IDENTITY_GROUP_REVIEW');

test('identity group projection separates stable group identity from original and simulated candidate targets without mutations', () => {
  const f = fixture(); const before = clone({ original: f.original, review: f.review }); const projected = f.build();
  assert.equal(projected.groups.length, 2); assert.equal(projected.operationKind, 'SPLIT'); assert.equal(projected.projectionValidationComplete, true);
  assert.equal(projected.reviewPersisted, true); assert.equal(projected.persisted, false); assert.equal(projected.canApply, false); assert.equal(projected.affectsCurrentState, false);
  assert.equal(projected.groupedPilotImplemented, false); assert.equal(projected.requiresNewDecisions, true); assert.equal(projected.freshness.reviewSnapshotCurrent, true);
  for (const group of projected.groups) {
    assert.equal(group.groupKey.length, 64); assert.notEqual(group.groupKey, group.simulatedCandidateIds[0]); assert.notEqual(group.groupKey, f.baseline.candidates[0].id);
    assert.equal(group.requiresNewDecision, true); assert.equal(group.observations.length, 1);
    const observation = group.observations[0]; assert.equal(observation.originalCandidateId, f.baseline.candidates[0].id);
    assert.equal(observation.originalIdentityCells.serialNumber.value, 'REPEATED'); assert.equal(observation.reviewedIdentityCells.serialNumber.value, 'REPEATED');
    assert.equal(observation.currentIdentityCells.serialNumber.value, 'REPEATED'); assert.equal(observation.projectedIdentity.serialKey, group.serialNumber);
    assert.equal(observation.fields.serialNumber, group.serialNumber); assert.equal(observation.fields.model, 'Model G9');
  }
  assert.deepEqual({ original: f.original, review: f.review }, before); assert.equal(buildResolvedPreview(f.original, f.original).candidates.length, 1);
});

test('identity group projection supports merged and repartitioned memberships with one immutable origin per observation', () => {
  const f = fixture([receptionRow(4, 'ONE'), receptionRow(5, 'ONE'), receptionRow(6, 'TWO'), receptionRow(7, 'TWO')]);
  const records = f.baseline.records.map((record) => record.id);
  const merged = f.makeReview({ ...f.input, groups: [{ ...f.input.groups[0], recordIds: records }] });
  const merge = f.build({ review: merged }); assert.equal(merge.operationKind, 'MERGE'); assert.equal(merge.groups[0].originalCandidateIds.length, 2);
  assert.equal(merge.groups[0].observations.length, 4); assert.equal(merge.projectionValidationComplete, true);
  const repartitioned = f.makeReview({ ...f.input, groups: [{ ...f.input.groups[0], recordIds: [records[0], records[2]] }, { ...f.input.groups[1], recordIds: [records[1], records[3]] }] });
  const partition = f.build({ review: repartitioned }); assert.equal(partition.operationKind, 'REPARTITION');
  assert.equal(partition.groups.every((group) => group.originalCandidateIds.length === 2 && group.observations.length === 2), true);
  assert.equal(new Set(partition.groups.flatMap((group) => group.observations.map((record) => record.recordId))).size, 4);
});

test('identity group projection keeps group keys stable across inventory, as-of and context changes while fingerprinting current collisions', () => {
  const f = fixture(); const first = f.build();
  const asset = { id: randomUUID(), productId: randomUUID(), serialNumber: 'VERIFIED-0', assetTag: null, status: 'AVAILABLE', isActive: true,
    updatedAt: '2026-10-05T10:00:00Z', product: { name: 'Existing equipment' } };
  const changes = [f.build({ existing: [asset] }), f.build({ asOf: '2026-10-06' }),
    f.build({ context: { ...f.context, batchVersion: 2, sourceContext: { ...f.context.sourceContext, revision: 1 } } })];
  for (const projection of changes) {
    assert.deepEqual(projection.groups.map((group) => group.groupKey), first.groups.map((group) => group.groupKey));
    assert.notEqual(projection.projectionId, first.projectionId); assert.equal(projection.freshness.reviewSnapshotCurrent, false); assert.equal(projection.canApply, false);
  }
  const ambiguous = f.build({ existing: [asset, { ...asset, id: randomUUID(), productId: randomUUID() }] });
  assert.equal(ambiguous.projectionValidationComplete, false); assert.ok(ambiguous.blockers.some((entry) => entry.code === 'SOURCE_AMBIGUOUS_EXISTING_ASSET'));
  const review = clone(f.review); review.id = randomUUID(); review.rows.forEach((row) => { row.reviewId = review.id; });
  assert.notEqual(f.build({ review }).groups[0].groupKey, first.groups[0].groupKey);
  const reordered = clone(f.review); reordered.rows.reverse(); assert.equal(f.build({ review: reordered }).projectionId, first.projectionId);
});

test('identity group projection preserves uncertain original numeric cells and labels current V7/V8 interpretation separately', () => {
  const numeric = fixture([receptionRow(4, '', { F: numberCell(1600000000000), G: numberCell(1234) })]);
  const record = numeric.build().groups[0].observations[0]; assert.equal(record.originalIdentityCells.serialNumber.type, 'number');
  assert.equal(record.originalIdentityCells.assetTag.type, 'number'); assert.equal(record.projectedIdentity.serialKey, 'VERIFIED-0'); assert.equal(record.projectedIdentity.tagKey, '1234');
  const f = fixture(); const effective = clone(f.original); effective.sheets[0].rows.slice(1).forEach((row) => { row.cells.F = textCell('V8-VERIFIED'); });
  const review = f.makeReview(f.input, effective); const projected = f.build({ review, effective });
  assert.equal(projected.groups.every((group) => group.observations[0].originalIdentityCells.serialNumber.value === 'REPEATED'), true);
  assert.equal(projected.groups.every((group) => group.observations[0].reviewedIdentityCells.serialNumber.value === 'V8-VERIFIED'), true);
  assert.equal(projected.groups.every((group) => group.observations[0].currentIdentityCells.serialNumber.value === 'V8-VERIFIED'), true);
});

test('identity group projection displays captured/current evidence and original decisions without transferring their authority', () => {
  const f = fixture(); const evidence = { id: randomUUID(), recordId: f.review.rows[0].recordId, candidateId: f.review.rows[0].originalCandidateId,
    captureId: randomUUID(), capturedAssetId: randomUUID(), currentAssetId: null, evidenceVersion: 1, amendmentId: randomUUID(),
    sourceRevision: 0, captureBatchId: randomUUID(), capturedSourceRevision: 0, assignmentUse: null, retirementUse: null };
  const decision = { id: randomUUID(), targetType: 'CANDIDATE', targetId: f.input.candidateIds[0], action: 'LINK_EXISTING', linkedAssetId: evidence.capturedAssetId, batchVersion: 2, sourceRevision: 0 };
  const impacts = { pilotItems: [], decisions: [decision], evidence: [evidence] }; const projected = f.build({ impacts });
  const group = projected.groups.find((entry) => entry.recordIds.includes(evidence.recordId)); const [entry] = group.evidence;
  assert.equal(entry.currentAssetId, null); assert.equal(entry.capturedAssetId, evidence.capturedAssetId); assert.equal(entry.linkedToGroup, false);
  assert.equal(entry.requiresExplicitLineageReview, true); assert.equal(group.requiresNewDecision, true); assert.deepEqual(group.originalDecisions, [decision]);
  assert.equal(projected.groups.every((entry) => entry.requiresNewDecision), true);
  const applied = f.build({ impacts: { ...impacts, evidence: [{ ...evidence, assignmentUse: { itemId: randomUUID(), endpoint: 'START' } }] } });
  assert.equal(applied.projectionValidationComplete, false); assert.ok(applied.blockers.some((entry) => entry.code === 'SOURCE_OBSERVATION_ALREADY_APPLIED'));
});

test('identity group projection reports outside absorption without expanding selected provenance or hiding incompatible source', () => {
  const f = fixture([receptionRow(4, 'REPEATED'), receptionRow(5, 'REPEATED'), receptionRow(6, 'OUTSIDE')], 'REPEATED');
  const effective = clone(f.original); effective.sheets[0].rows.find((row) => row.row === 6).cells.F = textCell('VERIFIED-0');
  const projected = f.build({ effective }); assert.equal(projected.projectionValidationComplete, false);
  assert.ok(projected.blockers.some((entry) => entry.code === 'PROPOSED_GROUP_NOT_REALIZABLE'));
  assert.equal(projected.groups.flatMap((group) => group.observations).length, 2);
  assert.equal(projected.groups.some((group) => group.candidates.some((candidate) => candidate.outsideRecordCount === 1)), true);
});

test('identity group projection rejects released, incomplete, corrupt or unsupported saved lineage and never lets clients override interpretation', () => {
  const f = fixture();
  assert.throws(() => f.build({ review: { ...f.review, release: { id: randomUUID() } } }), (error) => error.code === 'IDENTITY_GROUP_ALREADY_RELEASED');
  for (const change of [{ planId: '0'.repeat(64) }, { batchId: randomUUID() }, { sourceHash: 'b'.repeat(64) },
    { rows: f.review.rows.slice(0, 1) }, { rows: f.review.rows.map((row) => ({ ...row, isReserved: false })) },
    { rows: f.review.rows.map((row) => ({ ...row, originalCandidateId: 'c'.repeat(64) })) },
    { rows: f.review.rows.map((row) => ({ ...row, snapshot: {} })) },
    { plan: { ...f.review.plan, rulesVersion: 'unsupported' } }, { plan: { ...f.review.plan, request: { ...f.input, note: 'Rewritten intent' } } }]) {
    invalid(() => f.build({ review: { ...f.review, ...change } }));
  }
  invalid(() => f.build({ context: { ...f.context, batchVersion: 0 } }));
  assert.equal(identityGroupProjectionQuerySchema.safeParse({}).success, true);
  for (const query of [{ force: true }, { asOf: '2000-01-01' }, { sourceRevision: 0 }, { groupId: randomUUID() }]) assert.equal(identityGroupProjectionQuerySchema.safeParse(query).success, false);
});

test('identity group projection checks approved snapshot digests and original cell provenance even when forged JSON is internally rehashed', () => {
  const f = fixture();
  const keys = ['planId', 'canApply', 'persisted', 'affectsCurrentState', 'lineagePersistenceImplemented', 'proposalValidationComplete', 'summary'];
  for (const field of ['originalIdentityCells', 'currentIdentityCells']) {
    const review = clone(f.review); review.plan.observations[0][field].serialNumber.value = 'FORGED CELL';
    review.rows[0].snapshot = clone(review.plan.observations[0]);
    review.planId = importPlanDigest(Object.fromEntries(Object.entries(review.plan).filter(([key]) => !keys.includes(key)))); review.plan.planId = review.planId;
    invalid(() => f.build({ review }));
  }
  const invalidScope = clone(f.review); invalidScope.plan.request.candidateIds = ['0'.repeat(64)];
  invalidScope.planId = importPlanDigest(Object.fromEntries(Object.entries(invalidScope.plan).filter(([key]) => !keys.includes(key)))); invalidScope.plan.planId = invalidScope.planId;
  invalid(() => validateIdentityGroupReview(invalidScope, f.original));
});
