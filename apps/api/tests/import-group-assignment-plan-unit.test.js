import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { buildGroupClosedAssignmentPlan } from '../src/imports/group-assignment-plan.js';
import { groupClosedAssignmentPlanSchema } from '../src/imports/group-assignment-plan-schemas.js';
import { validateGroupApplicationProof } from '../src/imports/identity-group-application-proof.js';
import { validateGroupHistoryApplicationProof } from '../src/imports/group-history-application-proof.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { groupAssignmentPlanFixture } from './fixtures/group-assignment-plan.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function build(f, input = f.input) { return buildGroupClosedAssignmentPlan(f.application, f.item.id, f.asset, f.receipts, f.evidence, f.assignments, f.revisions, input, f.now); }
function acknowledge(f) {
  const plan = build(f);
  f.input.plan.periods.forEach((period) => { period.acknowledgedWarnings = plan.periods.find((entry) => entry.periodId === period.periodId).warnings.map((warning) => warning.id); });
  return build(f);
}
const codes = (plan) => plan.periods.flatMap((period) => period.blockers.map((blocker) => blocker.code));

test('group closed assignment DTO pins exactly one saved link per endpoint without accepting asset, snapshots or effects', () => {
  const f = groupAssignmentPlanFixture(); assert.equal(groupClosedAssignmentPlanSchema.safeParse(f.input).success, true);
  for (const change of [{ assetId: f.asset.id }, { force: true }, { persisted: true }, { expectedApplicationPlanId: 'bad' },
    { links: [] }, { links: [f.input.links[0], f.input.links[0]] }, { links: [{ ...f.input.links[0], expectedLinkVersion: 0 }, f.input.links[1]] },
    { links: [{ ...f.input.links[0], expectedEvidenceVersion: 1001 }, f.input.links[1]] },
    { links: [{ ...f.input.links[0], evidenceId: randomUUID() }, f.input.links[1]] },
    { links: [{ ...f.input.links[0], snapshot: {} }, f.input.links[1]] }]) assert.equal(groupClosedAssignmentPlanSchema.safeParse({ ...f.input, ...change }).success, false);
  const upper = { ...f.input, links: f.input.links.map((link) => ({ ...link, evidenceId: link.evidenceId.toUpperCase(), linkId: link.linkId.toUpperCase() })) };
  assert.deepEqual(groupClosedAssignmentPlanSchema.parse(upper), groupClosedAssignmentPlanSchema.parse(f.input));
});

test('group closed assignment validates whole V21 and V23 proofs before constructing a read-only operational proposal', () => {
  const f = groupAssignmentPlanFixture(); const before = clone(f); const plan = acknowledge(f);
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.scope, 'GROUP_CLOSED_ASSIGNMENT_HISTORY_PLAN');
  for (const key of ['persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'operationalHistoryApplied', 'closedAssignmentApplicationImplemented']) assert.equal(plan[key], false);
  assert.equal(plan.periods[0].proposedAssignment.assetId, f.asset.id); assert.equal(plan.periods[0].proposedAssignment.assignedById, null);
  assert.equal(plan.periods[0].proposedAssignment.returnedById, null); assert.equal(plan.periods[0].proposedAssignment.returnTicketReference, 'IN-TK');
  assert.equal(plan.historyLinks[0].currentAssetId, null); assert.equal(plan.historyLinks[0].projection.assetId, f.asset.id);
  assert.equal(plan.historyLinks[0].projection.original.fields.serialNumber, 'ORIGINAL-SERIAL');
  assert.equal(plan.periods[0].sources.every((source) => f.receipts[0].links.some((link) => link.id === source.groupHistoryLinkId)), true);
  assert.deepEqual({ ...clone(f), input: before.input }, before);
});

test('group closed assignment rejects incomplete, mismatched or corrupted history receipts including unselected saved links', () => {
  const f = groupAssignmentPlanFixture(); const proof = validateGroupApplicationProof(f.application)[0]; const original = f.receipts[0];
  for (const corrupt of [
    (copy) => { copy.requestDigest = 'e'.repeat(64); }, (copy) => { copy.planId = 'e'.repeat(64); },
    (copy) => { copy.itemId = randomUUID(); }, (copy) => { copy.rulesVersion = 'unsupported'; },
    (copy) => { copy.links.pop(); }, (copy) => { copy.links[0].historyApplicationId = randomUUID(); },
    (copy) => { copy.links[0].assetId = randomUUID(); }, (copy) => { copy.links[0].evidenceVersion = 1; },
    (copy) => { copy.links[0].version = 2; }, (copy) => { copy.links[0].sourceRevision = 1; },
    (copy) => { copy.links[0].projection.historicalActorId = randomUUID(); },
    (copy) => { copy.links[0].projection.original.fields.serialNumber = 'FORGED'; },
    (copy) => { copy.links[0].operation.note = 'Unreviewed'; }, (copy) => { copy.plan.operations[0].currentSnapshot.original.row = 999; }
  ]) {
    const copy = clone(original); corrupt(copy);
    assert.throws(() => validateGroupHistoryApplicationProof(copy, proof, f.application), (error) => error.code === 'INVALID_GROUP_HISTORY_APPLICATION');
  }
  const duplicate = { ...original, id: randomUUID() }; f.receipts.push(duplicate);
  assert.throws(() => build(f), (error) => error.code === 'INVALID_GROUP_HISTORY_APPLICATION');
});

test('group closed assignment rejects foreign links and mismatched application, link and evidence versions', () => {
  const f = groupAssignmentPlanFixture();
  for (const [input, expected] of [
    [{ ...f.input, expectedApplicationPlanId: 'e'.repeat(64) }, 'IDENTITY_GROUP_APPLICATION_CHANGED'],
    [{ ...f.input, links: [{ ...f.input.links[0], linkId: randomUUID() }, f.input.links[1]] }, 'NOT_FOUND'],
    [{ ...f.input, links: [{ ...f.input.links[0], expectedLinkVersion: 2 }, f.input.links[1]] }, 'GROUP_HISTORY_LINK_VERSION_CONFLICT'],
    [{ ...f.input, links: [{ ...f.input.links[0], expectedEvidenceVersion: 1 }, f.input.links[1]] }, 'EVIDENCE_VERSION_CONFLICT']
  ]) assert.throws(() => build(f, input), (error) => error.code === expected);
  f.application.items[0].rows.pop(); assert.throws(() => build(f), (error) => error.code === 'INVALID_IDENTITY_GROUP_APPLICATION');
});

test('group closed assignment does not use saved membership as proof of dates, recipient, return state or period order', () => {
  const f = groupAssignmentPlanFixture(); const period = f.input.plan.periods[0];
  const incomplete = build(f, { ...f.input, plan: { periods: [{ ...period, start: { evidenceId: f.start.id, confirmedAt: null, dateEvidenceReference: null },
    recipient: null, returnStatus: null }] } });
  for (const code of ['EXACT_DATE_REQUIRED', 'EXACT_DATE_PROOF_REQUIRED', 'CONFIRMED_RECIPIENT_REQUIRED', 'CONFIRMED_RETURN_STATUS_REQUIRED']) assert.ok(codes(incomplete).includes(code));
  const reversed = build(f, { ...f.input, plan: { periods: [{ ...period, end: { ...period.end, confirmedAt: '2000-01-01T12:00:00Z' } }] } });
  assert.ok(codes(reversed).includes('HISTORICAL_PERIOD_ORDER_INVALID')); assert.ok(codes(reversed).includes('SOURCE_DAY_MISMATCH'));
});

test('group closed assignment preserves unknown source days while accepting only separately confirmed exact dates', () => {
  const f = groupAssignmentPlanFixture({ unknownDates: true }); const plan = acknowledge(f);
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.periods[0].sources.every((source) => source.effectiveDay === null && source.datePrecision === 'UNKNOWN'), true);
  assert.equal(plan.periods[0].proposedAssignment.startedAt, '2001-01-01T12:00:00.000Z');
  assert.equal(plan.historyLinks.every((link) => link.projection.effectiveDay === null && link.projection.historicalActorId === null), true);
});

test('group closed assignment blocks identity changes and applied evidence, including retirement use, without waivers', () => {
  const f = groupAssignmentPlanFixture(); f.asset.assetTag = 'DIFFERENT-TAG';
  f.evidence.find((entry) => entry.id === f.start.id).assignmentUse = { itemId: randomUUID(), endpoint: 'START' };
  f.evidence.find((entry) => entry.id === f.end.id).retirementUse = { id: randomUUID(), assetId: f.asset.id };
  const plan = acknowledge(f); assert.ok(codes(plan).includes('GROUP_ASSET_IDENTITY_CHANGED'));
  assert.equal(codes(plan).filter((code) => code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED').length, 2);
});

test('group closed assignment retains assigned and terminal states and checks current and proposed period overlaps', () => {
  const f = groupAssignmentPlanFixture(); f.asset.status = 'ASSIGNED';
  f.assignments.push({ id: randomUUID(), startedAt: new Date('2005-01-01'), endedAt: null, recipientType: 'PERSON', personName: 'Current User', officeName: null, assignmentType: 'STANDARD', returnStatus: null });
  assert.equal(acknowledge(f).planValidationComplete, true);
  f.assignments[0].startedAt = new Date('2001-06-01'); assert.ok(codes(build(f)).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
  f.assignments = []; f.asset.status = 'DECOMMISSIONED'; f.asset.isActive = false; f.asset.decommissionedAt = new Date('2005-01-01');
  assert.equal(acknowledge(f).planValidationComplete, true);
  f.asset.decommissionedAt = new Date('2001-06-01'); assert.ok(codes(build(f)).includes('HISTORICAL_PERIOD_AFTER_DECOMMISSION'));
});

test('group closed assignment does not silently rebase confirmed projections onto altered archive versions or source revisions', () => {
  const f = groupAssignmentPlanFixture(); const current = f.evidence.find((entry) => entry.id === f.start.id);
  current.amendments = [{ id: randomUUID(), evidenceId: current.id, version: 1, sourceRevision: 0, assetId: null, effectiveDay: current.effectiveDay,
    snapshot: { ...current.snapshot, dateUncertainty: 'Changed interpretation' }, amendedAt: f.now }];
  f.input.links.find((entry) => entry.evidenceId === current.id).expectedEvidenceVersion = 1;
  const changed = acknowledge(f); assert.ok(codes(changed).includes('GROUP_HISTORY_EVIDENCE_CHANGED')); assert.equal(changed.planValidationComplete, false);
  const other = groupAssignmentPlanFixture(); other.revisions.push({ batchId: other.start.capture.batchId, revision: 1, changes: [{ candidateId: other.start.candidateId }] });
  assert.ok(codes(acknowledge(other)).includes('EVIDENCE_SOURCE_REVISED'));
});

test('group closed assignment fingerprint is stable under reordered selections but binds history proof, current context and intent', () => {
  const f = groupAssignmentPlanFixture({ separateConfirmations: true }); const baseline = acknowledge(f);
  assert.equal(baseline.planValidationComplete, true); assert.equal(new Set(baseline.periods[0].sources.map((source) => source.historyApplicationId)).size, 2);
  f.receipts.reverse(); assert.equal(build(f).planId, baseline.planId);
  assert.equal(build(f, { ...f.input, links: [...f.input.links].reverse() }).planId, baseline.planId);
  const changed = { ...f.input, plan: { periods: [{ ...f.input.plan.periods[0], note: 'Changed human intent' }] } };
  assert.notEqual(build(f, changed).planId, baseline.planId);
  f.asset.updatedAt = new Date('2026-10-20T14:00:00Z'); assert.notEqual(build(f).planId, baseline.planId);
  assert.equal(importPlanDigest(baseline), importPlanDigest(clone(baseline)));
});

test('group closed assignment warning acknowledgements cannot suppress blockers or approve unknown warnings', () => {
  const f = groupAssignmentPlanFixture(); const period = f.input.plan.periods[0];
  const bad = build(f, { ...f.input, plan: { periods: [{ ...period, acknowledgedWarnings: ['e'.repeat(64)], recipient: null }] } });
  assert.ok(codes(bad).includes('UNKNOWN_WARNING_ACKNOWLEDGEMENT')); assert.ok(codes(bad).includes('CONFIRMED_RECIPIENT_REQUIRED'));
});

test('group closed assignment requires fresh exact period warnings rather than inheriting V23 identity acknowledgements', () => {
  const f = groupAssignmentPlanFixture({ sourceWarning: true }); const initial = build(f);
  assert.equal(initial.periods[0].warnings.length, 1); assert.ok(codes(initial).includes('WARNINGS_NOT_ACKNOWLEDGED'));
  const savedIdentityWarnings = f.receipts[0].links.flatMap((link) => link.operation.acknowledgedWarnings);
  assert.equal(savedIdentityWarnings.includes(initial.periods[0].warnings[0].id), false);
  assert.equal(acknowledge(f).planValidationComplete, true);
  f.input.plan.periods[0].acknowledgedWarnings.push('e'.repeat(64)); assert.ok(codes(build(f)).includes('UNKNOWN_WARNING_ACKNOWLEDGEMENT'));
});

test('group closed assignment fails explicitly for corrupted archive, moved provenance, duplicate receipts and oversized context', () => {
  for (const field of ['receipts', 'evidence', 'assignments', 'revisions']) {
    const f = groupAssignmentPlanFixture(); const limit = field === 'assignments' ? 10001 : field === 'revisions' ? 1001 : 101;
    f[field] = Array(limit).fill(f[field][0] ?? {});
    assert.throws(() => build(f), (error) => error.code === 'GROUP_ASSIGNMENT_PLAN_LIMIT');
  }
  const f = groupAssignmentPlanFixture(); f.evidence.find((entry) => entry.id === f.start.id).snapshot = {};
  assert.throws(() => build(f), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
  const other = groupAssignmentPlanFixture(); other.evidence[0].candidateId = 'e'.repeat(64);
  assert.throws(() => build(other), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
});
