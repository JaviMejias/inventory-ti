import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { groupRetirementDocumentApplySchema, groupRetirementDocumentPlanSchema, groupRetirementDocumentRequestDigest } from '../src/imports/group-retirement-document-schemas.js';

const plan = () => ({ expectedBatchVersion: 1, expectedSourceRevision: 0, expectedDecisionVersion: 1, expectedEvidenceVersion: 0,
  projectionId: 'a'.repeat(64), groupKey: 'b'.repeat(64), decisionId: randomUUID(), acknowledgedGroupWarnings: [],
  document: { evidenceId: randomUUID(), note: 'Documentary review', evidenceReference: 'Original archive', acknowledgedWarnings: [] } });
test('group documentary DTO requires its own confirmation and exact current administrative context without dates or operational effects', () => {
  const input = plan(); assert.equal(groupRetirementDocumentPlanSchema.safeParse(input).success, true);
  for (const change of [{ force: true }, { confirmedAt: null }, { assetId: randomUUID() }, { expectedDecisionVersion: 0 }, { acknowledgedGroupWarnings: ['a'.repeat(64), 'a'.repeat(64)] }]) {
    assert.equal(groupRetirementDocumentPlanSchema.safeParse({ ...input, ...change }).success, false);
  }
  for (const change of [{ note: ' ' }, { confirmedAt: null }, { dateEvidenceReference: 'Signed date' }, { confirmation: 'VERIFIED_HISTORICAL_RETIREMENT' }, { acknowledgedWarnings: ['b'.repeat(64), 'b'.repeat(64)] }]) {
    assert.equal(groupRetirementDocumentPlanSchema.safeParse({ ...input, document: { ...input.document, ...change } }).success, false);
  }
  const apply = { requestId: randomUUID(), planId: 'c'.repeat(64), confirmation: 'RECONCILE_GROUP_RETIREMENT_DOCUMENT_ONLY', plan: input };
  assert.equal(groupRetirementDocumentApplySchema.safeParse(apply).success, true);
  for (const change of [{ confirmation: 'RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY' }, { confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT' }, { recordedById: randomUUID() }]) {
    assert.equal(groupRetirementDocumentApplySchema.safeParse({ ...apply, ...change }).success, false);
  }
});
test('group documentary request digest normalizes both warning lists but binds identity, version, actor-independent intention and proof', () => {
  const input = groupRetirementDocumentApplySchema.parse({ requestId: randomUUID().toUpperCase(), planId: 'c'.repeat(64),
    confirmation: 'RECONCILE_GROUP_RETIREMENT_DOCUMENT_ONLY', plan: { ...plan(), acknowledgedGroupWarnings: ['d'.repeat(64), 'e'.repeat(64)],
      document: { ...plan().document, acknowledgedWarnings: ['f'.repeat(64), 'a'.repeat(64)] } } });
  assert.equal(input.requestId, input.requestId.toLowerCase()); const digest = groupRetirementDocumentRequestDigest(input);
  assert.equal(groupRetirementDocumentRequestDigest({ ...input, plan: { ...input.plan, acknowledgedGroupWarnings: [...input.plan.acknowledgedGroupWarnings].reverse(),
    document: { ...input.plan.document, acknowledgedWarnings: [...input.plan.document.acknowledgedWarnings].reverse() } } }), digest);
  for (const change of [{ requestId: randomUUID() }, { planId: 'b'.repeat(64) }, { plan: { ...input.plan, expectedDecisionVersion: 2 } },
    { plan: { ...input.plan, document: { ...input.plan.document, evidenceReference: 'Other certificate' } } }]) {
    assert.notEqual(groupRetirementDocumentRequestDigest({ ...input, ...change }), digest);
  }
});
