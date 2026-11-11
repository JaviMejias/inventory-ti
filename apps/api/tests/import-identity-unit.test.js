import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { identityRevisionSchema } from '../src/imports/identity-schemas.js';
import { buildResolvedPreview, prepareIdentityChanges, validateIdentityPreview } from '../src/imports/identity.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { resolveWorkbook } from '../src/imports/source.js';
import { numberCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

function fixture(rows = [receptionRow(4, '', { F: numberCell(123456), K: textCell('Disponible') })]) {
  const original = workbook('Recepción', rows);
  const preview = buildWorkbookPreview(original);
  const input = identityRevisionSchema.parse({ expectedRevision: 0, expectedBatchVersion: 1, requestId: randomUUID(), candidateId: preview.candidates[0].id,
    action: 'VERIFY', confirmation: 'VERIFIED_PHYSICAL_IDENTITY', serialNumber: '00123456', assetTag: preview.candidates[0].tags[0] ?? null, note: 'Verified physical label', evidenceReference: 'Label photograph R-001' });
  const changes = prepareIdentityChanges(original, original, { revision: 0, corrections: [] }, input);
  const event = { id: randomUUID(), revision: 1, reviewedById: randomUUID(), note: input.note, evidenceReference: input.evidenceReference, changes };
  return { original, preview, input, changes, event, resolved: resolveWorkbook(original, [event]) };
}

test('identity DTO requires a complete explicit pair and confirmation, not ignored blockers or numeric values', () => {
  const { input } = fixture();
  for (const change of [{ serialNumber: 123 }, { assetTag: 'N/A' }, { serialNumber: null, assetTag: null }, { confirmation: 'FORCE' },
    { ignoredIssues: [] }, { expectedRevision: '0' }, { serialNumber: 'x'.repeat(161) }, { assetTag: 'x'.repeat(101) }]) {
    assert.equal(identityRevisionSchema.safeParse({ ...input, ...change }).success, false);
  }
  const restore = { ...input, action: 'RESTORE', confirmation: 'RESTORE_ORIGINAL_IDENTITY' };
  delete restore.serialNumber; delete restore.assetTag;
  assert.equal(identityRevisionSchema.safeParse(restore).success, true);
  assert.equal(identityRevisionSchema.safeParse({ ...restore, serialNumber: 'Invented' }).success, false);
});

test('verified text preserves original candidate identity and numeric evidence without guessing it', () => {
  const { original, preview, input, resolved } = fixture();
  validateIdentityPreview(original, resolved.workbook, input);
  const current = buildResolvedPreview(original, resolved.workbook);
  assert.equal(current.candidates[0].id, preview.candidates[0].id);
  assert.notEqual(current.candidates[0].effectiveCandidateId, preview.candidates[0].id);
  assert.deepEqual(current.candidates[0].serials, ['00123456']);
  assert.equal(current.issues.some((issue) => issue.code === 'NUMERIC_SERIAL_REQUIRES_REVIEW'), false);
  assert.deepEqual(original.sheets[0].rows[1].cells.F, numberCell(123456));
  assert.equal(resolved.sourceContext.corrections[0].originalCell.type, 'number');
});

test('identity review cannot drop populated identifiers, exceed scope or merge source groups', () => {
  const { original, input } = fixture();
  assert.throws(() => prepareIdentityChanges(original, original, { revision: 0, corrections: [] }, { ...input, serialNumber: null, assetTag: 'TAG' }), (error) => error.code === 'IDENTITY_CANNOT_DROP_SOURCE_VALUE');
  const source = workbook('Recepción', [receptionRow(4, 'SERIAL-A'), receptionRow(5, 'SERIAL-B')]);
  const candidateId = buildWorkbookPreview(source).candidates[0].id;
  const requested = { ...input, candidateId, serialNumber: 'SERIAL-B' };
  const changes = prepareIdentityChanges(source, source, { revision: 0, corrections: [] }, requested);
  const proposed = resolveWorkbook(source, [{ revision: 1, changes }]).workbook;
  assert.throws(() => validateIdentityPreview(source, proposed, requested), (error) => error.code === 'IDENTITY_GROUP_CHANGE_REQUIRES_REVIEW');
  const crowded = workbook('Recepción', Array.from({ length: 13 }, (_, index) => receptionRow(index + 4, 'SHARED')));
  assert.throws(() => prepareIdentityChanges(crowded, crowded, { revision: 0, corrections: [] }, { ...input, candidateId: buildWorkbookPreview(crowded).candidates[0].id }), (error) => error.code === 'IDENTITY_REVIEW_SCOPE_LIMIT');
});

test('restoration reinstates exact raw identities and keeps the latest identity revision for reapproval', () => {
  const { original, input, event, resolved } = fixture();
  const changes = prepareIdentityChanges(original, resolved.workbook, resolved.sourceContext, { ...input, action: 'RESTORE', confirmation: 'RESTORE_ORIGINAL_IDENTITY' });
  const restored = resolveWorkbook(original, [event, { ...event, id: randomUUID(), revision: 2, changes }]);
  assert.deepEqual(restored.workbook, original);
  assert.equal(restored.sourceContext.corrections.length, 0);
  assert.deepEqual(restored.sourceContext.identityRevisions, [{ candidateId: input.candidateId, revision: 2 }]);
});

test('a later null cannot silently retain or remove an identity added by an earlier verification', () => {
  const { original, input } = fixture([receptionRow(4, '', { F: textCell(''), G: textCell('ORIGINAL-TAG') })]);
  const changes = prepareIdentityChanges(original, original, { revision: 0, corrections: [] }, input);
  const resolved = resolveWorkbook(original, [{ revision: 1, changes }]);
  assert.throws(() => prepareIdentityChanges(original, resolved.workbook, resolved.sourceContext, { ...input, serialNumber: null }), (error) => error.code === 'IDENTITY_CANNOT_DROP_SOURCE_VALUE');
});

test('a conflicting tag remains blocked when it belongs to another candidate without merging rows', () => {
  const { original, input } = fixture([receptionRow(4, 'A', { G: textCell('TAG-A') }), receptionRow(5, 'B', { G: textCell('TAG-B') })]);
  const requested = { ...input, serialNumber: 'A', assetTag: 'TAG-B' };
  const changes = prepareIdentityChanges(original, original, { revision: 0, corrections: [] }, requested);
  const proposed = resolveWorkbook(original, [{ revision: 1, changes }]).workbook;
  assert.throws(() => validateIdentityPreview(original, proposed, requested), (error) => error.code === 'IDENTITY_CROSS_CANDIDATE_CONFLICT');
});
