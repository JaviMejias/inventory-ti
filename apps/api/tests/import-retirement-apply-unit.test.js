import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { historicalRetirementApplySchema, retirementRequestDigest } from '../src/imports/retirement-apply-schemas.js';
import { retirementHistoryEvents } from '../src/routes/retirement-history.js';

function input() {
  return { requestId: randomUUID(), planId: 'a'.repeat(64), confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT', plan: {
    evidenceId: randomUUID(), confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: '2005-01-01T09:00:00-03:00', dateEvidenceReference: 'Signed timestamp',
    note: 'Verified historical retirement', evidenceReference: 'Disposal proof', acknowledgedWarnings: ['b'.repeat(64), 'c'.repeat(64)] } };
}
test('retirement application DTO requires independent confirmation, plan identity and retry key', () => {
  const request = input();
  for (const change of [{ confirmation: 'VERIFIED_HISTORICAL_RETIREMENT' }, { requestId: null }, { planId: randomUUID() },
    { force: true }, { historicalActorId: randomUUID() }, { plan: { ...request.plan, status: 'AVAILABLE' } }]) {
    assert.equal(historicalRetirementApplySchema.safeParse({ ...request, ...change }).success, false);
  }
  assert.equal(historicalRetirementApplySchema.parse({ ...request, requestId: request.requestId.toUpperCase() }).requestId, request.requestId);
});
test('retirement request digest ignores acknowledgement order but binds proof, proposed date and plan identity', () => {
  const request = historicalRetirementApplySchema.parse(input()); const baseline = retirementRequestDigest(request);
  assert.equal(retirementRequestDigest({ ...request, plan: { ...request.plan, acknowledgedWarnings: [...request.plan.acknowledgedWarnings].reverse() } }), baseline);
  for (const change of [{ planId: 'd'.repeat(64) }, { plan: { ...request.plan, evidenceReference: 'Other proof' } },
    { plan: { ...request.plan, confirmedAt: '2006-01-01T00:00:00Z' } }]) assert.notEqual(retirementRequestDigest({ ...request, ...change }), baseline);
});
test('retirement history shows unknown event actor and separates effective date from import date and operator', () => {
  assert.deepEqual(retirementHistoryEvents(null), []);
  const application = { id: randomUUID(), evidenceId: randomUUID(), evidenceVersion: 1, amendmentId: randomUUID(), sourceRevision: 1,
    decommissionedAt: new Date('2005-01-01'), appliedById: randomUUID(), appliedAt: new Date('2026-10-05') };
  const [event] = retirementHistoryEvents(application);
  assert.equal(event.actor, null); assert.equal(event.recordedById, application.appliedById); assert.equal(event.effectiveAt, application.decommissionedAt);
  assert.equal(event.recordedAt, application.appliedAt); assert.equal(event.source, 'IMPORTED_HISTORY');
});
