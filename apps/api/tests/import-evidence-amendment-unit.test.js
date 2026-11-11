import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { evidenceAmendmentPlanSchema, evidenceAmendmentSchema } from '../src/imports/evidence-amendment-schemas.js';
import { currentHistoricalEvidence } from '../src/imports/evidence-current.js';

test('evidence amendment DTO requires explicit link choice, bounded versions, proof and a separate confirmation', () => {
  const input = { requestId: randomUUID(), amendmentPlanId: 'a'.repeat(64), expectedEvidenceVersion: 0, expectedBatchVersion: 1, expectedSourceRevision: 0,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: null, note: 'Source interpretation rechecked', evidenceReference: 'Physical label and source' };
  assert.equal(evidenceAmendmentSchema.safeParse(input).success, true);
  for (const change of [{ assetId: undefined }, { expectedEvidenceVersion: 1000 }, { expectedEvidenceVersion: -1 }, { expectedSourceRevision: 1001 },
    { confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY' }, { snapshot: {} }, { historicalActorId: randomUUID() }, { effectiveDay: '2001-01-01' }, { force: true }, { note: ' ' }]) {
    assert.equal(evidenceAmendmentSchema.safeParse({ ...input, ...change }).success, false);
  }
  const id = randomUUID(); assert.equal(evidenceAmendmentPlanSchema.parse({ assetId: id.toUpperCase() }).assetId, id);
  assert.equal(evidenceAmendmentPlanSchema.safeParse({}).success, false);
});

test('current evidence projection preserves its immutable capture and explicit null amendments instead of falling back to old links', () => {
  const original = { id: randomUUID(), assetId: randomUUID(), effectiveDay: '2001-01-01', snapshot: { original: 'retained' }, capture: { sourceRevision: 0 },
    amendments: [{ id: randomUUID(), version: 1, sourceRevision: 2, assetId: null, effectiveDay: null, snapshot: { current: 'rechecked' }, amendedAt: new Date() }] };
  const before = JSON.stringify(original); const current = currentHistoricalEvidence(original);
  assert.equal(current.id, original.id); assert.equal(current.assetId, null); assert.equal(current.effectiveDay, null);
  assert.equal(current.capture.sourceRevision, 0); assert.equal(current.effectiveSourceRevision, 2); assert.equal(current.evidenceVersion, 1);
  assert.equal(current.amendmentId, original.amendments[0].id); assert.deepEqual(current.snapshot, { current: 'rechecked' });
  assert.equal(current.capturedAssetId, original.assetId); assert.equal(JSON.stringify(original), before); assert.equal('amendments' in current, false);
});

test('unamended evidence remains version zero with its original snapshot, source revision and capture identity', () => {
  const original = { id: randomUUID(), assetId: null, effectiveDay: null, snapshot: { unchanged: true }, capture: { sourceRevision: 3 }, amendments: [] };
  const current = currentHistoricalEvidence(original);
  assert.equal(current.evidenceVersion, 0); assert.equal(current.amendmentId, null); assert.equal(current.amendedAt, null);
  assert.equal(current.effectiveSourceRevision, 3); assert.deepEqual(current.snapshot, original.snapshot); assert.equal(current.id, original.id);
});
