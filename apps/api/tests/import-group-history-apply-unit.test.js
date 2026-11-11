import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { groupHistoryApplyDigest, groupHistoryApplySchema, groupHistoryReceiptParamsSchema } from '../src/imports/identity-group-history-apply-schemas.js';
import { buildGroupHistoryProjection } from '../src/imports/identity-group-history-apply-service.js';
import { buildGroupHistoryPlan } from '../src/imports/identity-group-history-plan.js';
import { groupHistoryFixture } from './fixtures/group-history-plan.js';

function planned(f) {
  const first = buildGroupHistoryPlan(f.application, f.item.id, f.asset, f.evidence, f.revisions, f.input, '2026-10-20');
  const input = { ...f.input, operations: f.input.operations.map((operation) => ({ ...operation,
    acknowledgedWarnings: first.operations.find((entry) => entry.evidenceId === operation.evidenceId).warnings.map((warning) => warning.id) })) };
  const plan = buildGroupHistoryPlan(f.application, f.item.id, f.asset, f.evidence, f.revisions, input, '2026-10-20');
  return { input, plan, apply: { requestId: randomUUID(), historyLinkPlanId: plan.historyLinkPlanId, confirmation: 'SAVE_GROUP_HISTORY_LINKS_ONLY', plan: input } };
}

test('group history confirmation DTO requires a new explicit intent and forbids client projection, target and operational fields', () => {
  const f = groupHistoryFixture(); const { apply } = planned(f); assert.equal(groupHistoryApplySchema.safeParse(apply).success, true);
  for (const change of [{ confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY' }, { confirmation: undefined }, { requestId: 'bad' }, { historyLinkPlanId: 'bad' },
    { force: true }, { assetId: f.asset.id }, { confirmedAt: '2001-01-01' }, { plan: { ...apply.plan, projection: {} } }]) {
    assert.equal(groupHistoryApplySchema.safeParse({ ...apply, ...change }).success, false);
  }
  const params = { id: randomUUID(), reviewId: randomUUID(), applicationId: f.application.id, itemId: f.item.id, historyApplicationId: randomUUID() };
  assert.deepEqual(groupHistoryReceiptParamsSchema.parse(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value.toUpperCase()]))), params);
});

test('group history request digest canonicalizes selection and acknowledgements but binds actor-independent intent fields', () => {
  const f = groupHistoryFixture(); f.input.operations = f.evidence.map((entry) => ({ ...f.input.operations[0], evidenceId: entry.id }));
  const { apply } = planned(f); const digest = groupHistoryApplyDigest(groupHistoryApplySchema.parse(apply));
  assert.equal(groupHistoryApplyDigest(groupHistoryApplySchema.parse({ ...apply, plan: { ...apply.plan, operations: [...apply.plan.operations].reverse() } })), digest);
  for (const change of [{ requestId: randomUUID() }, { historyLinkPlanId: 'f'.repeat(64) },
    { plan: { ...apply.plan, operations: [{ ...apply.plan.operations[0], note: 'Different intent' }] } }]) {
    assert.notEqual(groupHistoryApplyDigest(groupHistoryApplySchema.parse({ ...apply, ...change })), digest);
  }
});

test('group history projection changes only explicit target and effective identity while preserving original data, dates and unknown actors', () => {
  const f = groupHistoryFixture(); const { plan } = planned(f); const operation = plan.operations[0]; const before = JSON.stringify(operation);
  const projection = buildGroupHistoryProjection(operation, f.item.id);
  assert.equal(projection.assetId, f.asset.id); assert.equal(projection.effective.serialKey, f.asset.serialNumber);
  assert.deepEqual(projection.linkBasis, { type: 'APPLIED_IDENTITY_GROUP', id: f.item.id });
  assert.deepEqual(projection.original, operation.currentSnapshot.original);
  assert.equal(projection.effectiveDay, operation.effectiveDay); assert.equal(projection.historicalActorId, null); assert.equal(projection.affectsCurrentState, false);
  assert.deepEqual({ ...projection.effective.fields, serialNumber: null, assetTag: null }, { ...operation.currentSnapshot.effective.fields, serialNumber: null, assetTag: null });
  assert.equal(JSON.stringify(operation), before);
});

test('group history projection retains unknown day and precision rather than using confirmation day', () => {
  const f = groupHistoryFixture(); const entry = f.evidence[0]; entry.effectiveDay = null; entry.snapshot.effectiveDay = null; entry.snapshot.datePrecision = 'UNKNOWN';
  const projection = buildGroupHistoryProjection(planned(f).plan.operations[0], f.item.id);
  assert.equal(projection.effectiveDay, null); assert.equal(projection.datePrecision, 'UNKNOWN'); assert.equal(projection.historicalActorId, null);
});

test('group history plan exposes prior immutable link and blocks repeat application without treating it as a legacy amendment', () => {
  const f = groupHistoryFixture(); const before = planned(f).plan;
  const link = { id: randomUUID(), historyApplicationId: randomUUID(), assetId: f.asset.id, version: 1 };
  f.evidence[0].groupHistoryLink = link; const { plan } = planned(f);
  assert.equal(plan.planValidationComplete, false); assert.ok(plan.operations[0].blockers.includes('GROUP_HISTORY_LINK_ALREADY_SAVED'));
  assert.deepEqual(plan.operations[0].savedGroupLink, link); assert.equal(plan.operations[0].currentAssetId, null);
  assert.equal(plan.operations[0].evidenceVersion, 0); assert.notEqual(plan.historyLinkPlanId, before.historyLinkPlanId);
});
