import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { groupRetirementApplySchema, groupRetirementRequestDigest } from '../src/imports/group-retirement-apply-schemas.js';
import { buildGroupRetirementPlan } from '../src/imports/group-retirement-plan.js';
import { groupRetirementPlanFixture } from './fixtures/group-retirement-plan.js';

function fixture() { const f = groupRetirementPlanFixture(); return { ...f, input: groupRetirementApplySchema.parse({ requestId: randomUUID(), planId: 'a'.repeat(64),
  confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT', plan: f.input }) }; }
test('group retirement apply DTO requires its own confirmation and strict reviewed plan, never free effects or snapshots', () => {
  const f = fixture(); assert.equal(groupRetirementApplySchema.safeParse(f.input).success, true);
  for (const change of [{ confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT' }, { confirmation: 'VERIFIED_HISTORICAL_RETIREMENT' }, { assetId: f.asset.id },
    { sourceHash: 'a'.repeat(64) }, { appliedById: randomUUID() }, { force: true }, { result: {} }, { requestId: 'invalid' }, { planId: 'invalid' }]) {
    assert.equal(groupRetirementApplySchema.safeParse({ ...f.input, ...change }).success, false);
  }
});
test('group retirement intent digest normalizes both warning lists while binding versions, proof, timestamp and request identity', () => {
  const { input } = fixture(); input.plan.acknowledgedGroupWarnings = ['b'.repeat(64),'c'.repeat(64)]; input.plan.plan.acknowledgedWarnings = ['d'.repeat(64),'e'.repeat(64)];
  const digest = groupRetirementRequestDigest(input);
  const reversed = { ...input, plan: { ...input.plan, acknowledgedGroupWarnings: [...input.plan.acknowledgedGroupWarnings].reverse(), plan: { ...input.plan.plan,
    acknowledgedWarnings: [...input.plan.plan.acknowledgedWarnings].reverse() } } };
  assert.equal(groupRetirementRequestDigest(reversed), digest);
  for (const change of [{ requestId: randomUUID() }, { planId: 'f'.repeat(64) }, { plan: { ...input.plan, expectedEvidenceVersion: 1 } },
    { plan: { ...input.plan, plan: { ...input.plan.plan, dateEvidenceReference: 'Another temporal proof' } } },
    { plan: { ...input.plan, plan: { ...input.plan.plan, confirmedAt: '2006-01-01T00:00:00Z' } } }]) assert.notEqual(groupRetirementRequestDigest({ ...input, ...change }), digest);
});
test('group retirement review remains read-only even when an explicit separate application contract exists', () => {
  const f = groupRetirementPlanFixture(); const first = buildGroupRetirementPlan(f.projection,f.decisions,f.asset,f.evidence,f.assignments,f.revisions,f.consumedRows,f.input,f.now);
  f.input.acknowledgedGroupWarnings = first.groupWarnings.map((entry) => entry.id); f.input.plan.acknowledgedWarnings = first.warnings.map((entry) => entry.id);
  const plan = buildGroupRetirementPlan(f.projection,f.decisions,f.asset,f.evidence,f.assignments,f.revisions,f.consumedRows,f.input,f.now);
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.retirementApplicationImplemented, false); assert.equal(plan.persisted, false); assert.equal(plan.affectsCurrentState, false);
});
