import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { retirementDocumentApplySchema, retirementDocumentPlanSchema, retirementDocumentRequestDigest } from '../src/imports/retirement-document-schemas.js';

const plan = () => ({ evidenceId: randomUUID(), note: 'Reviewed existing retirement', evidenceReference: 'Archived source', acknowledgedWarnings: [] });
test('retirement document DTO never accepts dates, terminal changes, approval bypasses or foreign confirmations', () => {
  const input = plan(); assert.equal(retirementDocumentPlanSchema.safeParse(input).success, true);
  for (const change of [{ confirmedAt: null }, { decommissionedAt: '2005-01-01' }, { force: true }, { assetId: randomUUID() }, { dateEvidenceReference: 'Certificate' },
    { note: ' ' }, { acknowledgedWarnings: ['a'.repeat(64), 'a'.repeat(64)] }]) assert.equal(retirementDocumentPlanSchema.safeParse({ ...input, ...change }).success, false);
  const confirmation = { requestId: randomUUID(), planId: 'a'.repeat(64), confirmation: 'RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY', plan: input };
  assert.equal(retirementDocumentApplySchema.safeParse(confirmation).success, true);
  for (const change of [{ confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT' }, { result: {} }, { recordedById: randomUUID() }]) {
    assert.equal(retirementDocumentApplySchema.safeParse({ ...confirmation, ...change }).success, false);
  }
});
test('retirement document intent binds documentary proof, plan and request while normalizing warning order and UUIDs', () => {
  const input = retirementDocumentApplySchema.parse({ requestId: randomUUID().toUpperCase(), planId: 'a'.repeat(64),
    confirmation: 'RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY', plan: { ...plan(), acknowledgedWarnings: ['b'.repeat(64), 'c'.repeat(64)] } });
  assert.equal(input.requestId, input.requestId.toLowerCase()); const digest = retirementDocumentRequestDigest(input);
  assert.equal(retirementDocumentRequestDigest({ ...input, plan: { ...input.plan, acknowledgedWarnings: [...input.plan.acknowledgedWarnings].reverse() } }), digest);
  for (const change of [{ requestId: randomUUID() }, { planId: 'd'.repeat(64) }, { plan: { ...input.plan, note: 'Another review' } },
    { plan: { ...input.plan, evidenceReference: 'Another document' } }]) assert.notEqual(retirementDocumentRequestDigest({ ...input, ...change }), digest);
});
