import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { groupRetirementPlanSchema } from '../src/imports/group-retirement-plan-schemas.js';
import { buildGroupRetirementPlan } from '../src/imports/group-retirement-plan.js';
import { buildIdentityGroupPilot } from '../src/imports/identity-group-pilot.js';
import { identityGroupDecisionDigest, identityGroupDecisionSchema } from '../src/imports/identity-group-decision-schemas.js';
import { groupRetirementPlanFixture } from './fixtures/group-retirement-plan.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const codes = (plan) => plan.blockers.map((entry) => entry.code);
function build(f, input = f.input) { return buildGroupRetirementPlan(f.projection, f.decisions, f.asset, f.evidence, f.assignments, f.revisions, f.consumedRows, input, f.now); }
function acknowledged(f) { const first = build(f); f.input.plan.acknowledgedWarnings = first.warnings.map((entry) => entry.id);
  f.input.acknowledgedGroupWarnings = first.groupWarnings.map((entry) => entry.id); return build(f); }

test('group retirement DTO requires reviewed versions and a separate verified request, never free asset or application identifiers', () => {
  const f = groupRetirementPlanFixture(); assert.equal(groupRetirementPlanSchema.safeParse(f.input).success, true);
  for (const change of [{ assetId: f.asset.id }, { force: true }, { requestId: randomUUID() }, { expectedApplicationPlanId: 'a'.repeat(64) },
    { expectedEvidenceVersion: 1001 }, { expectedDecisionVersion: 0 }, { plan: { ...f.input.plan, confirmedAt: '2005-01-01' } },
    { plan: { ...f.input.plan, historicalActorId: randomUUID() } }, { acknowledgedGroupWarnings: ['a'.repeat(64), 'a'.repeat(64)] }]) {
    assert.equal(groupRetirementPlanSchema.safeParse({ ...f.input, ...change }).success, false);
  }
});

test('group retirement plans directly from reviewed existing identity without requiring the deliberately blocked V21 pilot', () => {
  const f = groupRetirementPlanFixture(); const before = clone(f); const result = acknowledged(f);
  assert.equal(result.planValidationComplete, true, JSON.stringify(result.blockers));
  assert.equal(result.scope, 'GROUP_HISTORICAL_RETIREMENT_PLAN');
  for (const key of ['persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'operationalHistoryApplied', 'retirementApplicationImplemented']) assert.equal(result[key], false);
  assert.equal(result.originalEvidence.assetId, null); assert.equal(result.proposedEvidenceProjection.assetId, f.asset.id);
  assert.equal(result.proposedEvidenceProjection.linkBasis.type, 'REVIEWED_IDENTITY_GROUP_PROPOSAL');
  assert.equal(result.originalEvidence.snapshot.original.fields.serialNumber, 'ORIGINAL-RETIREMENT'); assert.equal(result.source.fields.serialNumber, f.asset.serialNumber);
  assert.deepEqual(result.sourceRetirement, { effectiveAt: null, datePrecision: 'UNKNOWN', historicalActorId: null });
  assert.equal(result.source.sourceReceivedDay, '2000-01-01'); assert.equal(result.proposedRetirement.decommissionedAt, '2005-01-01T12:00:00.000Z');
  assert.equal(result.omittedEvidence.length, f.evidence.length - 1); assert.deepEqual({ ...clone(f), input: before.input }, before);
  const pilot = buildIdentityGroupPilot(f.projection, f.decisions, [{ ...f.asset.product, equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' }], [f.asset],
    { ...f.input, operations: [{ type: 'UPDATE_METADATA', groupKey: f.input.groupKey, decisionId: f.input.decisionId, assetId: f.asset.id, note: 'Cannot import disposal in metadata',
      values: { location: 'Warehouse' }, acknowledgedWarnings: [] }] });
  assert.ok(pilot.operations[0].blockers.some((entry) => entry.code === 'RETIREMENT_REQUIRES_SEPARATE_WORKFLOW'));
});

test('all retirement sheets preserve unknown source dates and require exact independent timestamp and proof', () => {
  for (const sheet of ['Baja 2026', 'Baja 2025', 'Baja 2024']) {
    const f = groupRetirementPlanFixture({ sheet }); acknowledged(f);
    for (const [change, expected] of [[{ confirmedAt: null }, 'EXACT_RETIREMENT_DATE_REQUIRED'], [{ dateEvidenceReference: null }, 'EXACT_RETIREMENT_DATE_PROOF_REQUIRED'],
      [{ confirmedAt: '2027-01-01T00:00:00Z' }, 'HISTORICAL_DATE_IN_FUTURE'], [{ confirmedAt: '1999-01-01T00:00:00Z' }, 'RETIREMENT_BEFORE_RECEIPT_DAY']]) {
      const result = build(f, { ...f.input, plan: { ...f.input.plan, ...change } }); assert.ok(codes(result).includes(expected)); assert.equal(result.planValidationComplete, false);
    }
  }
});

test('group retirement rejects stale envelope, latest decision, saved intent and evidence version independently', () => {
  const f = groupRetirementPlanFixture();
  for (const [change, expected] of [[{ expectedBatchVersion: 2 }, 'REVIEW_VERSION_CONFLICT'], [{ expectedSourceRevision: 1 }, 'SOURCE_REVISION_CONFLICT'],
    [{ projectionId: 'e'.repeat(64) }, 'IDENTITY_GROUP_PROJECTION_CHANGED'], [{ expectedDecisionVersion: 2 }, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT'],
    [{ decisionId: randomUUID() }, 'GROUP_DECISION_NOT_LATEST'], [{ expectedEvidenceVersion: 1 }, 'EVIDENCE_VERSION_CONFLICT']]) {
    assert.throws(() => build(f, { ...f.input, ...change }), (error) => error.code === expected);
  }
  f.decisions[0].requestDigest = 'e'.repeat(64); assert.throws(() => build(f), (error) => error.code === 'INVALID_IDENTITY_GROUP_DECISION');
});

test('group retirement validates complete archive ownership and original snapshot of selected and omitted observations', () => {
  for (const mutate of [(f) => { f.evidence[1].snapshot.original.row = 999; }, (f) => { f.evidence[0].captureId = randomUUID(); },
    (f) => { f.evidence[0].sourceHash = 'f'.repeat(64); }, (f) => { f.evidence.pop(); }, (f) => { f.evidence[0].snapshot = {}; },
    (f) => { f.evidence[0].amendments = [{ evidenceId: randomUUID(), version: 1 }]; }]) {
    const f = groupRetirementPlanFixture(); mutate(f); assert.throws(() => build(f), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
  }
  const f = groupRetirementPlanFixture(); assert.throws(() => build(f, { ...f.input, plan: { ...f.input.plan, evidenceId: randomUUID() } }), (error) => error.statusCode === 404);
});

test('group retirement preserves every evidence consumption and source blocking issue without warning waivers', () => {
  for (const use of ['assignmentUse', 'groupAssignmentUse', 'retirementUse']) {
    const f = groupRetirementPlanFixture(); f.retirement[use] = use === 'retirementUse' ? { id: randomUUID(), assetId: f.asset.id } : { itemId: randomUUID(), endpoint: 'START' };
    assert.ok(codes(build(f)).includes('EVIDENCE_ALREADY_APPLIED'));
  }
  const f = groupRetirementPlanFixture({ sourceIssue: 'INDEPENDENT_SOURCE_CONFLICT' }); assert.ok(codes(acknowledged(f)).includes('SOURCE_INDEPENDENT_SOURCE_CONFLICT'));
  f.consumedRows = [{ recordId: f.evidence[0].recordId }]; assert.ok(codes(build(f)).includes('IDENTITY_GROUP_SOURCE_ALREADY_APPLIED'));
});

test('group retirement blocks custody, terminal replacement and later effective history while binding current context', () => {
  const f = groupRetirementPlanFixture(); const first = acknowledged(f);
  f.assignments = [{ id: randomUUID(), startedAt: new Date('2001-01-01'), endedAt: new Date('2006-01-01') }];
  assert.ok(codes(build(f)).includes('ASSIGNMENT_AFTER_RETIREMENT')); assert.notEqual(build(f).planId, first.planId);
  f.assignments[0].endedAt = null; f.asset.status = 'ASSIGNED'; assert.ok(codes(build(f)).includes('ACTIVE_ASSIGNMENT_REQUIRES_RETURN'));
  f.assignments = []; f.asset.status = 'DECOMMISSIONED'; f.asset.isActive = false; f.asset.decommissionedAt = null;
  assert.ok(codes(build(f)).includes('EXISTING_RETIREMENT_REQUIRES_RECONCILIATION'));
});

test('group retirement keeps current asset identity, evidence linkage and exact separate warning acknowledgements', () => {
  const f = groupRetirementPlanFixture(); const plan = acknowledged(f); assert.ok(plan.warnings.length > 0);
  assert.ok(codes(build(f, { ...f.input, acknowledgedGroupWarnings: ['a'.repeat(64)] })).includes('UNKNOWN_GROUP_WARNING_ACKNOWLEDGEMENT'));
  assert.ok(codes(build(f, { ...f.input, plan: { ...f.input.plan, acknowledgedWarnings: ['b'.repeat(64)] } })).includes('UNKNOWN_WARNING_ACKNOWLEDGEMENT'));
  f.asset.serialNumber = 'CHANGED'; assert.ok(codes(build(f)).includes('GROUP_ASSET_IDENTITY_CHANGED'));
});

test('group retirement refuses excessive context instead of silently truncating reviews, archives and histories', () => {
  for (const [key, count] of [['decisions', 26], ['evidence', 101], ['assignments', 10001], ['revisions', 1001]]) {
    const f = groupRetirementPlanFixture(); f[key] = Array.from({ length: count }, () => f[key][0] ?? {});
    assert.throws(() => build(f), (error) => error.code === 'GROUP_RETIREMENT_PLAN_LIMIT');
  }
});

test('group retirement requires an independent LINK_EXISTING decision and rejects held or excluded group authority', () => {
  for (const action of ['HOLD', 'EXCLUDE']) {
    const f = groupRetirementPlanFixture(); const decision = f.decisions[0]; decision.action = action; decision.linkedAssetId = null;
    const intent = identityGroupDecisionSchema.parse({ requestId: decision.requestId, confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY', expectedDecisionVersion: 0,
      expectedBatchVersion: 1, expectedSourceRevision: 0, projectionId: decision.projectionId, groupKey: decision.groupKey, action, note: decision.note,
      evidenceReference: decision.evidenceReference, evidenceReviews: decision.evidenceReviews });
    decision.requestDigest = identityGroupDecisionDigest(intent);
    assert.throws(() => build(f), (error) => error.code === 'GROUP_RETIREMENT_EXISTING_ASSET_REQUIRED');
  }
});

test('group retirement digest binds notes, proof, source revisions and consumed rows while normalizing warning order', () => {
  const f = groupRetirementPlanFixture(); const first = acknowledged(f);
  const reordered = { ...f.input, acknowledgedGroupWarnings: [...f.input.acknowledgedGroupWarnings].reverse(),
    plan: { ...f.input.plan, acknowledgedWarnings: [...f.input.plan.acknowledgedWarnings].reverse() } };
  assert.equal(build(f, reordered).planId, first.planId);
  for (const change of [{ note: 'Another verified note' }, { dateEvidenceReference: 'Another exact timestamp source' }, { evidenceReference: 'Another certificate' }]) {
    assert.notEqual(build(f, { ...f.input, plan: { ...f.input.plan, ...change } }).planId, first.planId);
  }
  f.revisions = [{ batchId: f.retirement.capture.batchId, revision: 1, changes: [{ candidateId: f.retirement.candidateId }] }];
  assert.ok(codes(build(f)).includes('EVIDENCE_SOURCE_REVISED')); assert.notEqual(build(f).planId, first.planId);
});
