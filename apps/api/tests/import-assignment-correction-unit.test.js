import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deserialize, serialize } from 'node:v8';

import { validateAssignmentApplicationProof } from '../src/imports/assignment-application-proof.js';
import { buildAssignmentCorrectionPlan } from '../src/imports/assignment-correction-plan.js';
import { assignmentCorrectionParamsSchema, assignmentCorrectionPlanSchema } from '../src/imports/assignment-correction-schemas.js';
import { buildClosedAssignmentPlan } from '../src/imports/assignment-plan.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { assignmentCorrectionFixture } from './fixtures/assignment-correction.js';

const clone = (value) => deserialize(serialize(value));
const plan = (f) => buildAssignmentCorrectionPlan(f.receipt, f.assignmentItem.id, f.audits, f.context, assignmentCorrectionPlanSchema.parse(f.input), f.now);
const invalid = (operation) => assert.throws(operation, (error) => error.code === 'INVALID_ASSIGNMENT_APPLICATION');
test('legacy correction DTO fixes original endpoints and excludes arbitrary actors, tickets, parent IDs and confirmation authority', () => {
  const f = assignmentCorrectionFixture(); assert.equal(assignmentCorrectionPlanSchema.safeParse(f.input).success, true);
  for (const change of [{ requestId: randomUUID() }, { expectedCorrectionVersion: 1001 }, { expectedOriginPlanId: 'invalid' }, { confirmation: 'APPLY' }, { reason: ' ' }, { force: true }]) {
    assert.equal(assignmentCorrectionPlanSchema.safeParse({ ...f.input, ...change }).success, false);
  }
  for (const change of [{ periodId: randomUUID() }, { assetId: randomUUID() }, { ticketReference: 'Invented' }, { createdById: randomUUID() },
    { start: { ...f.input.correction.start, evidenceId: randomUUID() } }, { acknowledgedWarnings: ['a'.repeat(64), 'a'.repeat(64)] }]) {
    assert.equal(assignmentCorrectionPlanSchema.safeParse({ ...f.input, correction: { ...f.input.correction, ...change } }).success, false);
  }
  const params = { id: f.receipt.assetId, applicationId: f.receipt.id, assignmentItemId: f.assignmentItem.id };
  assert.deepEqual(assignmentCorrectionParamsSchema.parse(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value.toUpperCase()]))), params);
});
test('legacy correction is deterministic and read-only with separate original, proposed, capture and current state', () => {
  const f = assignmentCorrectionFixture(); const before = clone(f); const result = plan(f);
  assert.equal(result.planValidationComplete, true); assert.equal(result.correctionPlanId, plan(f).correctionPlanId);
  assert.deepEqual(result.changes, [{ field: 'note', before: f.assignmentItem.assignment.notes, after: 'Corrected historical note' }]);
  for (const flag of ['persisted','canApply','affectsCurrentState','operationalHistoryApplied','evidenceRelinked','correctionApplicationImplemented']) assert.equal(result[flag], false);
  assert.equal(result.proposed.assignedById, null); assert.equal(result.proposed.returnedById, null); assert.equal(result.originalAssignment.createdById, null);
  assert.equal(result.originReceiptDigest, importPlanDigest(f.receipt)); assert.equal(result.ownership.length, 2); assert.deepEqual(f, before);
  const original = buildClosedAssignmentPlan(f.context.asset, f.context.evidence, f.context.assignments, [], f.originalInput, f.now,
    f.context.evidence.map((entry) => ({ evidenceId: entry.id, itemId: entry.assignmentUse.itemId })));
  assert.equal(original.planValidationComplete, false); assert.ok(original.periods[0].blockers.some((entry) => entry.code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED'));
});
test('legacy correction ignores equivalent instant formatting and reason-only changes but records documentary differences', () => {
  const f = assignmentCorrectionFixture(); f.input.correction.note = f.assignmentItem.assignment.notes;
  f.input.correction.start.confirmedAt = f.assignmentItem.assignment.startedAt.toISOString();
  assert.deepEqual(plan(f).changes, []); assert.ok(plan(f).blockers.some((entry) => entry.code === 'ASSIGNMENT_CORRECTION_UNCHANGED'));
  f.input.correction.start.dateEvidenceReference = 'Additional signed timestamp proof'; assert.equal(plan(f).planValidationComplete, true);
  assert.equal(plan(f).changes[0].field, 'startDateEvidenceReference');
});
test('legacy correction supports recipient, condition and intra-day instants without changing unknown source dates', () => {
  const f = assignmentCorrectionFixture({ unknownEndDate: true }); f.input.correction.recipient = { type: 'PERSON', name: 'Correct Recipient' };
  f.input.correction.returnStatus = 'IN_REPAIR'; f.input.correction.start.confirmedAt = '2001-01-01T10:00:00-03:00';
  f.input.correction.end.confirmedAt = '2002-01-02T12:00:00Z'; const result = plan(f);
  assert.equal(result.planValidationComplete, true); assert.equal(result.sources.find((entry) => entry.endpoint === 'end').effectiveDay, null);
  assert.equal(result.proposed.personName, 'Correct Recipient'); assert.equal(result.originalAssignment.returnStatus, 'UNDER_REVIEW');
});
test('legacy correction preserves exact date proof, known day, order, recipient, future and return constraints', () => {
  for (const [change, code] of [
    [(f) => { f.input.correction.start.confirmedAt = null; }, 'EXACT_DATE_REQUIRED'],
    [(f) => { f.input.correction.end.dateEvidenceReference = null; }, 'EXACT_DATE_PROOF_REQUIRED'],
    [(f) => { f.input.correction.start.confirmedAt = '2001-01-02T12:00:00Z'; }, 'SOURCE_DAY_MISMATCH'],
    [(f) => { f.input.correction.end.confirmedAt = '2099-01-01T12:00:00Z'; }, 'HISTORICAL_DATE_IN_FUTURE'],
    [(f) => { f.input.correction.end.confirmedAt = '2000-01-01T12:00:00Z'; }, 'HISTORICAL_PERIOD_ORDER_INVALID'],
    [(f) => { f.input.correction.recipient = null; }, 'CONFIRMED_RECIPIENT_REQUIRED'],
    [(f) => { f.input.correction.returnStatus = null; }, 'CONFIRMED_RETURN_STATUS_REQUIRED']
  ]) { const f = assignmentCorrectionFixture(); change(f); assert.ok(plan(f).blockers.some((issue) => issue.code === code), code); }
});
test('legacy correction excludes only its proven assignment from overlap and respects current custody and terminal chronology', () => {
  const f = assignmentCorrectionFixture({ count: 2, unknownEndDate: true }); const sister = f.receipt.items.find((entry) => entry.id !== f.assignmentItem.id);
  f.input.correction.end.confirmedAt = new Date(sister.assignment.startedAt.getTime() + 1).toISOString();
  assert.ok(plan(f).blockers.some((entry) => entry.code === 'OPERATIONAL_ASSIGNMENT_OVERLAP' && entry.relatedId === sister.assignmentId));
  const g = assignmentCorrectionFixture(); const custody = { ...g.assignmentItem.assignment, id: randomUUID(), startedAt: new Date('2001-06-01'), endedAt: null, importedHistory: false };
  g.context.asset.status = 'ASSIGNED'; g.context.currentAsset.status = 'ASSIGNED'; g.context.custody = [custody]; g.context.assignments.push(custody);
  assert.ok(plan(g).blockers.some((entry) => entry.code === 'OPERATIONAL_ASSIGNMENT_OVERLAP' && entry.relatedId === custody.id));
  g.context.asset.status = 'DECOMMISSIONED'; g.context.asset.decommissionedAt = new Date('2001-05-01');
  assert.ok(plan(g).blockers.some((entry) => entry.code === 'HISTORICAL_PERIOD_AFTER_DECOMMISSION'));
});
test('legacy correction validates every sibling and exact complete endpoint ownership before local exemption', () => {
  const sister = (f) => f.receipt.items.find((item) => item.id !== f.assignmentItem.id);
  const mutations = [
    (f) => { f.receipt.items = f.receipt.items.filter((item) => item.id === f.assignmentItem.id); }, (f) => { sister(f).snapshot.note = 'Altered sibling'; },
    (f) => { sister(f).assignment.notes = 'Changed persisted sibling'; }, (f) => { sister(f).evidenceUses.pop(); },
    (f) => { sister(f).assignment.groupImportHistory = { id: randomUUID() }; },
    (f) => { f.context.evidence[0].assignmentUse = { itemId: randomUUID(), endpoint: 'START' }; },
    (f) => { f.context.evidence[0].groupAssignmentUse = { itemId: randomUUID() }; },
    (f) => { f.context.evidence[0].groupRetirementUse = { id: randomUUID() }; }, (f) => { f.context.evidence.pop(); }
  ];
  for (const mutate of mutations) { const f = assignmentCorrectionFixture({ count: 2 }); mutate(f); invalid(() => plan(f)); }
});
test('legacy correction rejects forged digest, request, flags, source provenance and historical actors', () => {
  for (const mutate of [
    (f) => { f.receipt.requestDigest = 'f'.repeat(64); }, (f) => { f.receipt.plan.periods[0].sources[0].snapshotDigest = 'f'.repeat(64); },
    (f) => { f.receipt.plan.canApply = true; }, (f) => { f.assignmentItem.assignment.createdById = f.receipt.appliedById; },
    (f) => { f.assignmentItem.assignment.returnRecordedAt = new Date('2000-01-01'); }, (f) => { f.receipt.appliedAt = new Date('2099-01-01'); },
    (f) => { f.context.evidence[0].capturedAt = new Date('2099-01-01'); },
    (f) => { f.context.evidence[0].recordId = 'f'.repeat(64); }
  ]) { const f = assignmentCorrectionFixture(); mutate(f); assert.throws(() => plan(f), (error) => ['INVALID_ASSIGNMENT_APPLICATION','INVALID_HISTORICAL_EVIDENCE'].includes(error.code)); }
});
test('legacy correction validates exact origin audit coverage and metadata, not just matching event names', () => {
  for (const mutate of [(f) => { f.audits.pop(); }, (f) => { f.audits.push(clone(f.audits[0])); },
    (f) => { f.audits[0].userId = randomUUID(); }, (f) => { f.audits[1].metadata.affectsCurrentState = true; },
    (f) => { f.audits[1].metadata.applicationId = randomUUID(); }]) {
    const f = assignmentCorrectionFixture(); mutate(f); invalid(() => plan(f));
  }
});
test('legacy correction retains current-state and source-context conflicts without accepting unsupported origin rules', () => {
  const f = assignmentCorrectionFixture(); const before = plan(f); f.context.currentAsset.notes = 'Changed metadata without changing updatedAt'; const changed = plan(f);
  assert.notEqual(changed.correctionPlanId, before.correctionPlanId);
  f.context.asset.serialNumber = 'OTHER'; assert.ok(plan(f).blockers.some((entry) => entry.code === 'CURRENT_ASSET_IDENTITY_CONFLICT'));
  f.context.revisions = [{ batchId: f.context.evidence[0].capture.batchId, revision: 1, changes: [{ candidateId: f.context.evidence[0].candidateId }] }];
  assert.ok(plan(f).blockers.some((entry) => entry.code === 'EVIDENCE_SOURCE_REVISED'));
  f.receipt.rulesVersion = 'mda-closed-assignment-plan-1'; assert.throws(() => plan(f), (error) => error.code === 'ASSIGNMENT_ORIGIN_RULES_UNSUPPORTED');
});
test('legacy correction refuses foreign origin, missing assignment in current history and excessive context instead of truncating', () => {
  const f = assignmentCorrectionFixture(); f.input.expectedOriginPlanId = 'f'.repeat(64); assert.throws(() => plan(f), (error) => error.code === 'ASSIGNMENT_ORIGIN_CHANGED');
  const g = assignmentCorrectionFixture(); g.context.assignments = []; assert.throws(() => plan(g), (error) => error.code === 'ASSIGNMENT_CORRECTION_CURRENT_STATE_INVALID');
  const h = assignmentCorrectionFixture(); h.context.assignments = Array(10001).fill(h.context.assignments[0]); assert.throws(() => plan(h), (error) => error.code === 'ASSIGNMENT_CORRECTION_LIMIT');
});
test('legacy origin proof supports all nonterminal statuses supported by the repository, not an invented subset', () => {
  for (const status of ['AVAILABLE','RESERVED','UNDER_REVIEW','IN_REPAIR','IN_WARRANTY','LOST']) {
    const f = assignmentCorrectionFixture({ status }); assert.equal(validateAssignmentApplicationProof(f.receipt, f.context.evidence, f.audits, f.now).plan.assetBefore.status, status);
  }
});
