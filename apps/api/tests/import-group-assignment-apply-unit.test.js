import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { groupAssignmentApplicationParamsSchema, groupClosedAssignmentApplyDigest, groupClosedAssignmentApplySchema } from '../src/imports/group-assignment-apply-schemas.js';
import { buildGroupClosedAssignmentPlan } from '../src/imports/group-assignment-plan.js';
import { assignmentHistoryEvents } from '../src/routes/assignment-history.js';
import { groupAssignmentPlanFixture } from './fixtures/group-assignment-plan.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function application(f) {
  const plan = buildGroupClosedAssignmentPlan(f.application, f.item.id, f.asset, f.receipts, f.evidence, f.assignments, f.revisions, f.input, f.now);
  return { requestId: randomUUID(), planId: plan.planId, confirmation: 'APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY', plan: f.input };
}

test('group historical application DTO requires its own explicit confirmation and forbids free operational targets and snapshots', () => {
  const f = groupAssignmentPlanFixture(); const input = application(f);
  assert.equal(groupClosedAssignmentApplySchema.safeParse(input).success, true);
  for (const change of [{ confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY' }, { confirmation: 'SAVE_GROUP_HISTORY_LINKS_ONLY' },
    { requestId: 'bad' }, { planId: 'bad' }, { assetId: f.asset.id }, { snapshots: {} }, { force: true }, { appliedAt: '2001-01-01' }]) {
    assert.equal(groupClosedAssignmentApplySchema.safeParse({ ...input, ...change }).success, false);
  }
  const params = { id: f.application.batchId, reviewId: f.application.reviewId, applicationId: f.application.id, itemId: f.item.id, groupApplicationId: randomUUID() };
  assert.deepEqual(groupAssignmentApplicationParamsSchema.parse(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value.toUpperCase()]))), params);
});

test('group historical application request digest normalizes selection and period order but binds evidence, date proof and actor-independent intent', () => {
  const f = groupAssignmentPlanFixture(); const input = groupClosedAssignmentApplySchema.parse(application(f));
  const second = { ...input.plan.plan.periods[0], periodId: randomUUID(), start: { ...input.plan.plan.periods[0].start, evidenceId: randomUUID() },
    end: { ...input.plan.plan.periods[0].end, evidenceId: randomUUID() } };
  input.plan.plan.periods.push(second);
  input.plan.links.push(...[second.start.evidenceId, second.end.evidenceId].map((evidenceId) => ({ evidenceId, linkId: randomUUID(), expectedLinkVersion: 1, expectedEvidenceVersion: 0 })));
  input.plan.plan.periods[0].acknowledgedWarnings = ['f'.repeat(64), 'e'.repeat(64)];
  const digest = groupClosedAssignmentApplyDigest(input);
  const reversed = clone(input); reversed.plan.links.reverse(); reversed.plan.plan.periods.reverse();
  reversed.plan.plan.periods.forEach((period) => { period.acknowledgedWarnings.reverse(); });
  assert.equal(groupClosedAssignmentApplyDigest(reversed), digest);
  for (const change of [
    (value) => { value.requestId = randomUUID(); }, (value) => { value.planId = 'd'.repeat(64); },
    (value) => { value.plan.links[0].expectedEvidenceVersion++; },
    (value) => { value.plan.plan.periods[0].note = 'Another intent'; },
    (value) => { value.plan.plan.periods[0].start.dateEvidenceReference = 'Another date proof'; }
  ]) { const copy = clone(input); change(copy); assert.notEqual(groupClosedAssignmentApplyDigest(copy), digest); }
});

test('grouped historical periods appear as separate imported provenance without assigning the importer as historical actor', () => {
  const appliedById = randomUUID(); const applicationId = randomUUID(); const itemId = randomUUID();
  const history = { id: randomUUID(), assetId: randomUUID(), personId: null, recipientType: 'OFFICE', officeName: 'Historical office', personName: null,
    assignmentType: 'STANDARD', expectedReturnAt: null, importedHistory: true, createdById: null, endedById: null, createdBy: null, endedBy: null,
    startedAt: new Date('2001-01-01'), endedAt: new Date('2002-01-01'), createdAt: new Date('2026-10-20'), returnRecordedAt: new Date('2026-10-20'), returnStatus: 'AVAILABLE',
    ticketReference: 'OUT', otReference: null, notes: 'Verified period', returnTicketReference: 'IN', returnOtReference: null, returnNotes: 'Signed return',
    importHistory: null, groupImportHistory: { applicationId, application: { itemId, appliedById, appliedAt: new Date('2026-10-20') } } };
  const events = assignmentHistoryEvents(history);
  assert.equal(events.length, 2); assert.equal(events.every((event) => event.actor === null && event.source === 'IMPORTED_HISTORY' && event.importScope === 'GROUP_CLOSED_ASSIGNMENT_HISTORY'), true);
  assert.equal(events.every((event) => event.recordedById === appliedById && event.importApplicationId === applicationId && event.importGroupItemId === itemId), true);
  assert.equal(events[0].effectiveAt, history.startedAt); assert.equal(events[1].effectiveAt, history.endedAt);
  assert.equal(events[0].recordedAt, history.createdAt); assert.equal(events[1].recordedAt, history.returnRecordedAt);
  const legacy = assignmentHistoryEvents({ ...history, groupImportHistory: null, importHistory: { applicationId, application: { appliedById, appliedAt: new Date('2026-10-20') } } });
  assert.equal(legacy.every((event) => event.source === 'IMPORTED_HISTORY'), true); assert.equal('importGroupItemId' in legacy[0], false);
});

test('grouped endpoint consumption blocks fresh planning and is distinguished from immutable historical membership', () => {
  const f = groupAssignmentPlanFixture(); f.evidence.find((entry) => entry.id === f.start.id).groupAssignmentUse = { itemId: randomUUID(), endpoint: 'START' };
  const plan = buildGroupClosedAssignmentPlan(f.application, f.item.id, f.asset, f.receipts, f.evidence, f.assignments, f.revisions, f.input, f.now);
  assert.equal(plan.planValidationComplete, false); assert.ok(plan.periods[0].blockers.some((blocker) => blocker.code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED'));
  assert.equal(plan.historyLinks.find((link) => link.evidenceId === f.start.id).groupAssignmentUse.endpoint, 'START');
  assert.equal(plan.operationalHistoryApplied, false); assert.equal(plan.canApply, false);
});
