import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { buildWorkbookPreview } from '../src/imports/preview.js';
import { sourceRevisionSchema } from '../src/imports/source-schemas.js';
import { prepareSourceChanges, resolveWorkbook, sourceRequestDigest } from '../src/imports/source.js';
import { receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

function fixture() {
  const original = workbook('Recepción', [receptionRow(4, 'SOURCE-001', { A: textCell('2055-01-01'), K: textCell('Disponible') })]);
  const record = buildWorkbookPreview(original).records[0];
  const input = sourceRevisionSchema.parse({ expectedRevision: 0, expectedBatchVersion: 2, requestId: randomUUID(), note: 'Checked source evidence',
    evidenceReference: 'Receiving document R-001', changes: [{ recordId: record.id, field: 'receivedDate', action: 'REPLACE', value: '2001-01-01' }] });
  return { original, record, input };
}

test('source correction DTO only admits verified catalog/reception fields, not force or identity/state edits', () => {
  const { input } = fixture();
  assert.equal(sourceRevisionSchema.safeParse(input).success, true);
  for (const field of ['serialNumber', 'assetTag', 'availability', 'usedDate', 'recipientText', 'notes']) {
    assert.equal(sourceRevisionSchema.safeParse({ ...input, changes: [{ ...input.changes[0], field }] }).success, false);
  }
  for (const value of [null, '', 'N/A', '2026-02-30', '01/02/26', '1899-12-31']) {
    assert.equal(sourceRevisionSchema.safeParse({ ...input, changes: [{ ...input.changes[0], value }] }).success, false);
  }
  for (const invalid of [{ ...input, force: true }, { ...input, expectedRevision: '0' }, { ...input, expectedRevision: 1000 },
    { ...input, note: ' ' }, { ...input, evidenceReference: ' ' }, { ...input, changes: [] },
    { ...input, changes: [input.changes[0], input.changes[0]] }, { ...input, changes: [{ recordId: input.changes[0].recordId, field: 'model', action: 'RESTORE', value: 'Ignored?' }] }]) {
    assert.equal(sourceRevisionSchema.safeParse(invalid).success, false);
  }
});

test('reception correction removes only its actual date blocker and preserves original evidence', () => {
  const { original, input } = fixture();
  const originalCopy = JSON.stringify(original);
  const changes = prepareSourceChanges(original, original, input, '2026-10-05');
  const event = { id: randomUUID(), revision: 1, reviewedById: randomUUID(), note: input.note, evidenceReference: input.evidenceReference, changes };
  const resolved = resolveWorkbook(original, [event]);
  const preview = buildWorkbookPreview(resolved.workbook, [], '2026-10-05');
  assert.equal(preview.issues.some((issue) => issue.code === 'FUTURE_SOURCE_DATE'), false);
  assert.equal(JSON.stringify(original), originalCopy);
  assert.deepEqual(changes[0].originalCell, textCell('2055-01-01'));
  assert.equal(resolved.sourceContext.corrections[0].reviewedById, event.reviewedById);
  const restoreInput = { ...input, changes: [{ recordId: input.changes[0].recordId, field: 'receivedDate', action: 'RESTORE' }] };
  const restored = resolveWorkbook(original, [event, { ...event, id: randomUUID(), revision: 2, changes: prepareSourceChanges(original, resolved.workbook, restoreInput) }]);
  assert.deepEqual(restored.workbook, original);
  assert.equal(restored.sourceContext.revision, 2);
  assert.equal(restored.sourceContext.corrections.length, 0);
});

test('correction target, future dates, unchanged values and invalid stored history are rejected', () => {
  const { original, input } = fixture();
  assert.throws(() => prepareSourceChanges(original, original, { ...input, changes: [{ ...input.changes[0], recordId: 'f'.repeat(64) }] }), (error) => error.code === 'INVALID_SOURCE_TARGET');
  assert.throws(() => prepareSourceChanges(original, original, { ...input, changes: [{ ...input.changes[0], value: '2055-01-01' }] }), (error) => error.code === 'FUTURE_SOURCE_CORRECTION');
  assert.throws(() => prepareSourceChanges(original, original, { ...input, changes: [{ ...input.changes[0], action: 'RESTORE' }] }), (error) => error.code === 'SOURCE_FIELD_UNCHANGED');
  assert.throws(() => resolveWorkbook(original, [{ revision: 2, changes: [] }]), (error) => error.code === 'INVALID_SOURCE_REVISION');
});

test('normalized request fingerprint is independent of correction order but binds rationale', () => {
  const { input } = fixture();
  const changes = [...input.changes, { recordId: input.changes[0].recordId, field: 'model', action: 'REPLACE', value: 'G10' }];
  const first = sourceRequestDigest({ ...input, changes });
  assert.equal(sourceRequestDigest({ ...input, changes: changes.toReversed() }), first);
  assert.notEqual(sourceRequestDigest({ ...input, changes, note: 'Different review' }), first);
});
