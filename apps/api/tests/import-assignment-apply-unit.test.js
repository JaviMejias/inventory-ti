import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { closedAssignmentApplySchema, closedAssignmentRequestDigest } from '../src/imports/assignment-apply-schemas.js';
import { assignmentHistoryEvents } from '../src/routes/assignment-history.js';

function input() {
  return closedAssignmentApplySchema.parse({ requestId: randomUUID(), planId: 'a'.repeat(64), confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: {
    periods: [{ periodId: randomUUID(), confirmation: 'VERIFIED_CLOSED_ASSIGNMENT', start: { evidenceId: randomUUID() }, end: { evidenceId: randomUUID() },
      recipient: { type: 'OFFICE', name: 'Central office' }, assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW',
      note: 'Closed historical period', evidenceReference: 'Delivery and return records' }]
  } });
}

test('historical application DTO requires plan fingerprint, retry key and a separate explicit application confirmation', () => {
  const valid = input();
  for (const invalid of [{ ...valid, confirmation: 'VERIFIED_CLOSED_ASSIGNMENT' }, { ...valid, planId: 'wrong' }, { ...valid, requestId: null },
    { ...valid, force: true }, { ...valid, createdById: randomUUID() }, { ...valid, plan: { ...valid.plan, canApply: true } }]) {
    assert.equal(closedAssignmentApplySchema.safeParse(invalid).success, false);
  }
  assert.equal(closedAssignmentApplySchema.parse({ ...valid, requestId: valid.requestId.toUpperCase() }).requestId, valid.requestId);
});

test('historical retry fingerprint ignores selection and acknowledgement order, but binds proof and plan identity', () => {
  const valid = input(); const period = valid.plan.periods[0];
  valid.plan.periods.push({ ...period, periodId: randomUUID(), start: { evidenceId: randomUUID(), confirmedAt: null, dateEvidenceReference: null },
    end: { evidenceId: randomUUID(), confirmedAt: null, dateEvidenceReference: null }, acknowledgedWarnings: ['b'.repeat(64), 'c'.repeat(64)] });
  const digest = closedAssignmentRequestDigest(valid);
  assert.equal(closedAssignmentRequestDigest({ ...valid, plan: { periods: valid.plan.periods.toReversed().map((entry) => ({ ...entry, acknowledgedWarnings: entry.acknowledgedWarnings.toReversed() })) } }), digest);
  assert.notEqual(closedAssignmentRequestDigest({ ...valid, planId: 'd'.repeat(64) }), digest);
  assert.notEqual(closedAssignmentRequestDigest({ ...valid, plan: { periods: [{ ...period, evidenceReference: 'Different documents' }] } }), digest);
});

test('imported history exposes the capturer separately and leaves both historical event actors unknown', () => {
  const applicationId = randomUUID(); const appliedById = randomUUID(); const capturedAt = new Date('2026-10-05');
  const assignment = { id: randomUUID(), importedHistory: true, personName: null, recipientType: 'OFFICE', officeName: 'Central office', assignmentType: 'LOAN',
    expectedReturnAt: null, startedAt: new Date('2001-01-01'), endedAt: new Date('2002-01-01'), createdAt: capturedAt, returnRecordedAt: capturedAt,
    createdBy: null, endedBy: null, importHistory: { applicationId, application: { appliedById, appliedAt: capturedAt } } };
  const events = assignmentHistoryEvents(assignment);
  assert.equal(events.length, 2);
  assert.equal(events.every((entry) => entry.actor === null && entry.source === 'IMPORTED_HISTORY' && entry.recordedById === appliedById && entry.importApplicationId === applicationId), true);
  assert.equal(events.every((entry) => entry.recordedAt === capturedAt), true);
  const operational = assignmentHistoryEvents({ ...assignment, importedHistory: false, createdBy: { displayName: 'Delivery operator' }, endedBy: { displayName: 'Return operator' } });
  assert.equal(operational[0].actor, 'Delivery operator'); assert.equal(operational[1].actor, 'Return operator');
  assert.equal('recordedById' in operational[0], false);
});
