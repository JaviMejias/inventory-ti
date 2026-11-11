import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { buildGroupAssignmentCorrectionPlan } from '../src/imports/group-assignment-correction-plan.js';
import { groupAssignmentCorrectionPlanSchema } from '../src/imports/group-assignment-correction-schemas.js';
import { groupCorrectionApplySchema, groupCorrectionRequestDigest } from '../src/imports/group-correction-apply-schemas.js';
import { validateGroupCorrectionChain } from '../src/imports/group-correction-chain.js';
import { groupAssignmentCorrectionFixture } from './fixtures/group-assignment-correction.js';

function fixture() {
  const f = groupAssignmentCorrectionFixture(); const input = groupAssignmentCorrectionPlanSchema.parse(f.input);
  const plan = buildGroupAssignmentCorrectionPlan(f.context, f.receipt, f.assignmentItem.id, f.audits, f.currentState, input, f.now);
  const request = groupCorrectionApplySchema.parse({ requestId: randomUUID(), correctionPlanId: plan.correctionPlanId, confirmation: 'APPLY_GROUP_ASSIGNMENT_CORRECTION', plan: input });
  const event = { id: randomUUID(), itemId: f.assignmentItem.id, version: 1, previousId: null, requestId: request.requestId,
    requestDigest: groupCorrectionRequestDigest(request), correctionPlanId: plan.correctionPlanId, rulesVersion: 'mda-group-assignment-correction-application-1',
    plan, reason: input.reason, supportingReference: input.supportingReference, correctedById: randomUUID(), correctedAt: f.now, createdTransactionId: '999', assetSnapshot: {}, custodySnapshot: [] };
  return { ...f, input, plan, request, event };
}

test('correction apply DTO requires distinct write confirmation, stable key and strict plan intent', () => {
  const f = fixture();
  for (const extra of [{ confirmation: 'VERIFIED_CLOSED_ASSIGNMENT' }, { assetId: randomUUID() }, { requestId: 'bad' }, { correctionPlanId: 'bad' }, { correctedAt: new Date() }]) {
    assert.equal(groupCorrectionApplySchema.safeParse({ ...f.request, ...extra }).success, false);
  }
  assert.equal(groupAssignmentCorrectionPlanSchema.parse(f.input).expectedCorrectionVersion, 0);
  assert.equal(groupCorrectionApplySchema.parse({ ...f.request, requestId: f.request.requestId.toUpperCase() }).requestId, f.request.requestId);
});

test('correction intent digest normalizes warnings but binds every date, version, reason and proof', () => {
  const f = fixture(); const input = { ...f.request, plan: { ...f.input, correction: { ...f.input.correction, acknowledgedWarnings: ['b'.repeat(64), 'a'.repeat(64)] } } };
  const reversed = { ...input, plan: { ...input.plan, correction: { ...input.plan.correction, acknowledgedWarnings: [...input.plan.correction.acknowledgedWarnings].reverse() } } };
  assert.equal(groupCorrectionRequestDigest(input), groupCorrectionRequestDigest(reversed));
  for (const extra of [{ expectedCorrectionVersion: 1 }, { reason: 'Another intent' }, { supportingReference: 'Other document' }]) assert.notEqual(groupCorrectionRequestDigest({ ...input, plan: { ...input.plan, ...extra } }), groupCorrectionRequestDigest(input));
});

test('immutable correction chain validates sequential origin and rejects rewritten, missing or reparented receipts', () => {
  const f = fixture(); const validate = (events) => validateGroupCorrectionChain(events, f.assignmentItem.id, f.receipt.planId, f.plan.originReceiptDigest, f.now, f.plan.before);
  assert.equal(validate([f.event]), f.event);
  for (const extra of [{ version: 2 }, { previousId: randomUUID() }, { itemId: randomUUID() }, { requestDigest: 'e'.repeat(64) },
    { plan: { ...f.plan, before: {} } }, { correctedAt: new Date('2030-01-01') }]) assert.throws(() => validate([{ ...f.event, ...extra }]), (error) => error.code === 'INVALID_GROUP_CORRECTION_CHAIN');
});

test('versioned planning compares against latest effective facts without changing original capture or endpoints', () => {
  const f = fixture(); const input = { ...f.input, expectedCorrectionVersion: 1, correction: { ...f.input.correction, note: 'Next correction' } };
  const next = buildGroupAssignmentCorrectionPlan(f.context, f.receipt, f.assignmentItem.id, f.audits, f.currentState, input, f.now, [f.event]);
  assert.equal(next.currentCorrectionVersion, 1); assert.equal(next.currentCorrectionId, f.event.id); assert.equal(next.before.note, f.input.correction.note);
  assert.equal(next.originalAssignment.notes, f.assignmentItem.assignment.notes); assert.equal(next.originalAssignment.createdById, null);
  assert.throws(() => buildGroupAssignmentCorrectionPlan(f.context, f.receipt, f.assignmentItem.id, f.audits, f.currentState, f.input, f.now, [f.event]), (error) => error.code === 'GROUP_CORRECTION_VERSION_CONFLICT');
});
