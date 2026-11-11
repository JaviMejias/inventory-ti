import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { validateGroupAssignmentApplicationProof } from '../src/imports/group-assignment-application-proof.js';
import { buildGroupAssignmentCorrectionPlan } from '../src/imports/group-assignment-correction-plan.js';
import { groupAssignmentCorrectionParamsSchema, groupAssignmentCorrectionPlanSchema } from '../src/imports/group-assignment-correction-schemas.js';
import { buildGroupClosedAssignmentPlan } from '../src/imports/group-assignment-plan.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { groupAssignmentCorrectionFixture } from './fixtures/group-assignment-correction.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function plan(f) { return buildGroupAssignmentCorrectionPlan(f.context, f.receipt, f.assignmentItem.id, f.audits, f.currentState, groupAssignmentCorrectionPlanSchema.parse(f.input), f.now); }
function invalid(operation) { assert.throws(operation, (error) => error.code === 'INVALID_GROUP_ASSIGNMENT_APPLICATION'); }

test('correction DTO fixes origin endpoints and forbids free asset, actor, replacement source, state and write authority', () => {
  const f = groupAssignmentCorrectionFixture(); assert.equal(groupAssignmentCorrectionPlanSchema.safeParse(f.input).success, true);
  for (const extra of [{ assetId: randomUUID() }, { requestId: randomUUID() }, { force: true }, { confirmation: 'APPLY' }, { expectedOriginPlanId: 'bad' },
    { reason: ' ' }, { supportingReference: '' }]) assert.equal(groupAssignmentCorrectionPlanSchema.safeParse({ ...f.input, ...extra }).success, false);
  for (const extra of [{ periodId: randomUUID() }, { createdById: randomUUID() }, { assetId: randomUUID() }, { ticketReference: 'Invented' },
    { start: { ...f.input.correction.start, evidenceId: randomUUID() } }, { end: { ...f.input.correction.end, groupHistoryLinkId: randomUUID() } }]) {
    assert.equal(groupAssignmentCorrectionPlanSchema.safeParse({ ...f.input, correction: { ...f.input.correction, ...extra } }).success, false);
  }
  const params = { id: f.application.batchId, reviewId: f.application.reviewId, applicationId: f.application.id, itemId: f.item.id,
    groupApplicationId: f.receipt.id, assignmentItemId: f.assignmentItem.id };
  assert.deepEqual(groupAssignmentCorrectionParamsSchema.parse(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value.toUpperCase()]))), params);
});

test('correction produces deterministic reviewed before and after without mutating origin, ownership, context or current state', () => {
  const f = groupAssignmentCorrectionFixture(); const before = clone(f); const first = plan(f); const second = plan(f);
  assert.equal(first.correctionPlanId, second.correctionPlanId); assert.equal(first.planValidationComplete, true);
  assert.deepEqual(first.changes, [{ field: 'note', before: f.assignmentItem.assignment.notes, after: 'Corrected historical note' }]);
  assert.equal(first.originalAssignment.createdById, null); assert.equal(first.proposed.assignedById, null); assert.equal(first.proposed.returnedById, null);
  assert.equal(first.originPlanId, f.receipt.planId); assert.equal(first.originReceiptDigest, importPlanDigest(f.receipt));
  for (const key of ['persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'operationalHistoryApplied', 'correctionApplicationImplemented']) assert.equal(first[key], false);
  assert.deepEqual(clone(f), before);
  const legacy = buildGroupClosedAssignmentPlan(f.application, f.item.id, f.asset, f.receipts, f.evidence, f.context.assignments, f.revisions, f.context.input, f.now);
  assert.equal(legacy.planValidationComplete, false); assert.ok(legacy.periods[0].blockers.some((entry) => entry.code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED'));
});

test('unchanged values and alternate formatting of the same instant do not create fictitious corrections', () => {
  const f = groupAssignmentCorrectionFixture(); f.input.correction.note = f.assignmentItem.assignment.notes;
  f.input.correction.start.confirmedAt = f.assignmentItem.assignment.startedAt.toISOString();
  const result = plan(f); assert.deepEqual(result.changes, []);
  assert.equal(result.planValidationComplete, false); assert.ok(result.blockers.some((entry) => entry.code === 'GROUP_ASSIGNMENT_CORRECTION_UNCHANGED'));
});

test('recipient, return and known-day exact-time corrections keep separate original and proposed values', () => {
  const f = groupAssignmentCorrectionFixture(); f.input.correction.recipient = { type: 'PERSON', name: 'Correct Recipient' };
  f.input.correction.returnStatus = 'IN_REPAIR'; f.input.correction.start.confirmedAt = '2001-01-01T10:00:00-03:00';
  const result = plan(f); assert.equal(result.planValidationComplete, true); assert.equal(result.proposed.personName, 'Correct Recipient');
  assert.equal(result.proposed.returnStatus, 'IN_REPAIR'); assert.equal(result.before.officeName, 'Central office');
  assert.equal(result.currentAsset.status, 'AVAILABLE'); assert.equal(result.originalAssignment.returnStatus, 'UNDER_REVIEW');
});

test('unknown archive days stay unknown while explicitly corrected instants retain independent proof', () => {
  const f = groupAssignmentCorrectionFixture({ unknownDates: true }); f.input.correction.start.confirmedAt = '2000-12-31T12:00:00Z';
  const result = plan(f); assert.equal(result.planValidationComplete, true); assert.equal(result.sources.every((source) => source.effectiveDay === null), true);
  f.input.correction.start.dateEvidenceReference = null;
  assert.ok(plan(f).blockers.some((entry) => entry.code === 'EXACT_DATE_PROOF_REQUIRED'));
});

test('changed source days, future instants, reversed periods and missing recipient or return remain blocked', () => {
  for (const [change, code] of [
    [(f) => { f.input.correction.start.confirmedAt = '2001-01-02T12:00:00Z'; }, 'SOURCE_DAY_MISMATCH'],
    [(f) => { f.input.correction.end.confirmedAt = '2030-01-01T12:00:00Z'; }, 'HISTORICAL_DATE_IN_FUTURE'],
    [(f) => { f.input.correction.end.confirmedAt = '2000-01-01T12:00:00Z'; }, 'HISTORICAL_PERIOD_ORDER_INVALID'],
    [(f) => { f.input.correction.recipient = null; }, 'CONFIRMED_RECIPIENT_REQUIRED'],
    [(f) => { f.input.correction.returnStatus = null; }, 'CONFIRMED_RETURN_STATUS_REQUIRED']
  ]) { const f = groupAssignmentCorrectionFixture(); change(f); assert.ok(plan(f).blockers.some((entry) => entry.code === code), code); }
});

test('only the exact original assignment is excluded from overlap checks, not sibling or current custody', () => {
  const f = groupAssignmentCorrectionFixture({ unknownDates: true }); const own = f.context.assignments[0];
  f.context.assignments.push({ ...own, id: randomUUID(), startedAt: new Date('2002-02-01'), endedAt: null });
  f.context.asset = { ...f.asset, status: 'ASSIGNED' }; f.currentState.asset = { ...f.currentState.asset, status: 'ASSIGNED' };
  f.currentState.custody = [{ ...f.assignmentItem.assignment, id: f.context.assignments[1].id, startedAt: new Date('2002-02-01'), endedAt: null }];
  f.input.correction.end.confirmedAt = '2002-03-01T12:00:00Z';
  const result = plan(f); assert.ok(result.blockers.some((entry) => entry.code === 'OPERATIONAL_ASSIGNMENT_OVERLAP' && entry.relatedId === f.context.assignments[1].id));
});

test('a terminal asset keeps current status and requires corrected history to end before its terminal instant', () => {
  const f = groupAssignmentCorrectionFixture({ unknownDates: true });
  f.context.asset = { ...f.asset, status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2003-01-01') };
  f.currentState.asset = { ...f.currentState.asset, ...f.context.asset };
  assert.equal(plan(f).planValidationComplete, true);
  f.input.correction.end.confirmedAt = '2004-01-01T12:00:00Z';
  assert.ok(plan(f).blockers.some((entry) => entry.code === 'HISTORICAL_PERIOD_AFTER_DECOMMISSION'));
});

test('warnings require recognition for this correction and unknown acknowledgements cannot waive issues', () => {
  const f = groupAssignmentCorrectionFixture({ sourceWarning: true }); f.input.correction.acknowledgedWarnings = [];
  const first = plan(f); assert.ok(first.blockers.some((entry) => entry.code === 'WARNINGS_NOT_ACKNOWLEDGED'));
  f.input.correction.acknowledgedWarnings = first.warnings.map((warning) => warning.id); assert.equal(plan(f).planValidationComplete, true);
  f.input.correction.acknowledgedWarnings.push('a'.repeat(64)); assert.ok(plan(f).blockers.some((entry) => entry.code === 'UNKNOWN_WARNING_ACKNOWLEDGEMENT'));
});

test('origin hash, item scope and current-state absence fail with explicit errors', () => {
  const f = groupAssignmentCorrectionFixture(); f.input.expectedOriginPlanId = 'a'.repeat(64);
  assert.throws(() => plan(f), (error) => error.code === 'GROUP_ASSIGNMENT_ORIGIN_CHANGED');
  f.input.expectedOriginPlanId = f.receipt.planId; f.currentState.asset = null;
  assert.throws(() => plan(f), (error) => error.code === 'GROUP_CORRECTION_CURRENT_STATE_INVALID');
  assert.throws(() => buildGroupAssignmentCorrectionPlan(f.context, f.receipt, randomUUID(), f.audits, f.currentState, f.input, f.now), (error) => error.statusCode === 404);
});

test('complete receipt proof rejects malformed, reparented and incomplete origin data', () => {
  for (const change of [
    (f) => { f.receipt.plan = {}; }, (f) => { f.receipt.itemId = randomUUID(); }, (f) => { f.receipt.planId = 'b'.repeat(64); },
    (f) => { f.receipt.requestDigest = 'c'.repeat(64); }, (f) => { f.receipt.items = []; },
    (f) => { f.receipt.assetSnapshot = {}; }, (f) => { f.receipt.custodySnapshot = [{ id: randomUUID() }]; },
    (f) => { f.receipt.createdTransactionId = '0'; }, (f) => { f.receipt.appliedAt = new Date('2030-01-01'); }
  ]) { const f = groupAssignmentCorrectionFixture(); change(f); invalid(() => validateGroupAssignmentApplicationProof(f.context, f.receipt, f.audits, f.now)); }
});

test('endpoint uses must retain both unique original link, period and permanent archive ownership', () => {
  for (const change of [
    (f) => { f.assignmentItem.evidenceUses.pop(); }, (f) => { f.assignmentItem.evidenceUses[0].itemId = randomUUID(); },
    (f) => { f.assignmentItem.evidenceUses[0].linkId = randomUUID(); }, (f) => { f.assignmentItem.evidenceUses[0].endpoint = 'END'; },
    (f) => { f.evidence.find((entry) => entry.id === f.start.id).groupAssignmentUse = null; },
    (f) => { f.evidence.find((entry) => entry.id === f.start.id).assignmentUse = { itemId: randomUUID(), endpoint: 'START' }; },
    (f) => { f.assignmentItem.snapshot = {}; }
  ]) { const f = groupAssignmentCorrectionFixture(); change(f); invalid(() => plan(f)); }
});

test('actual immutable assignment must retain its whole proposal, null actors and capture, not just dates', () => {
  for (const extra of [{ notes: 'Forged' }, { personName: 'Forged Recipient' }, { createdById: randomUUID() },
    { personId: randomUUID() }, { createdAt: new Date('2000-01-01') }, { expectedReturnAt: new Date('2003-01-01') },
    { importHistory: { id: randomUUID() } }, { importedHistory: false }, { ticketReference: 'FORGED' }, { endedAt: null }]) {
    const f = groupAssignmentCorrectionFixture(); Object.assign(f.assignmentItem.assignment, extra); invalid(() => plan(f));
  }
});

test('root and assignment audits must belong to the actual origin importer', () => {
  for (const change of [(f) => { f.audits.pop(); }, (f) => { f.audits.shift(); }, (f) => { f.audits[0].userId = randomUUID(); }]) {
    const f = groupAssignmentCorrectionFixture(); change(f); invalid(() => plan(f));
  }
});

test('correction hashes bind explanation, supporting proof and full current metadata independently of source preview', () => {
  const f = groupAssignmentCorrectionFixture(); const first = plan(f);
  f.input.reason = 'Another reason'; assert.notEqual(plan(f).correctionPlanId, first.correctionPlanId); f.input.reason = first.reason;
  f.input.supportingReference = 'Another signed document'; assert.notEqual(plan(f).correctionPlanId, first.correctionPlanId);
  f.input.supportingReference = first.supportingReference; f.currentState.asset.location = 'Changed with preserved timestamp';
  assert.notEqual(plan(f).currentContextDigest, first.currentContextDigest); assert.notEqual(plan(f).correctionPlanId, first.correctionPlanId);
});

test('current identity or product changes block rectification without rewriting or declaring the old receipt invalid', () => {
  const f = groupAssignmentCorrectionFixture(); f.context.asset = { ...f.asset, serialNumber: 'Changed-current-identity' };
  f.currentState.asset = { ...f.currentState.asset, serialNumber: f.context.asset.serialNumber };
  assert.ok(plan(f).blockers.some((entry) => entry.code === 'GROUP_ASSET_IDENTITY_CHANGED'));
  f.context.asset = { ...f.asset, product: { ...f.asset.product, trackingMode: 'QUANTITY' } };
  assert.ok(plan(f).blockers.some((entry) => entry.code === 'PRODUCT_NOT_ASSET'));
});

test('a complete V25 receipt never substitutes for validation of its immutable V21 and V23 parents', () => {
  const identity = groupAssignmentCorrectionFixture(); identity.context.application.items[0].rows.pop();
  assert.throws(() => plan(identity), (error) => error.statusCode === 409 && error.code.includes('GROUP'));
  const history = groupAssignmentCorrectionFixture(); history.context.receipts[0].links[0].projection = {};
  assert.throws(() => plan(history), (error) => error.code === 'INVALID_GROUP_HISTORY_APPLICATION');
});
