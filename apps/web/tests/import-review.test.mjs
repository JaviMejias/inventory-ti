import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';

const source = readFileSync(new URL('../src/features/imports/import-review-model.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { buildReviewTargets, availableReviewActions, validateReviewDraft, createReviewIntent, appendServerPage } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
const record = (id, kind, sheet = 'Recepción', row = 4) => ({ id, kind, sheet, row, hidden: false, fields: {}, originalCells: {}, statusEvidence: null });
const candidate = { id: 'candidate', serials: ['SER-1'], tags: [], recordIds: ['physical', 'retired'], proposal: 'REVIEW_NEW', existingAssets: [] };
const snapshot = {
  records: [record('physical', 'ASSET_OBSERVATION'), record('retired', 'RETIREMENT_HISTORY', 'Baja 2026'), record('ink', 'CONSUMABLE_REVIEW', 'Tintas'), record('summary', 'MANUAL_SUMMARY', 'Disponible')],
  candidates: [candidate], issues: [], excluded: [{ sheet: 'Recepción', row: 3, reason: 'HEADER_OR_TITLE' }]
};

test('physical observations share one candidate; consumables and summaries remain independent targets', () => {
  const targets = buildReviewTargets(snapshot);
  assert.equal(targets.length, 3);
  assert.deepEqual(targets.map((target) => target.type), ['CANDIDATE', 'RECORD', 'RECORD']);
  assert.equal(targets[0].records.length, 2);
  assert.equal(targets.some((target) => target.id === 'retired'), false);
  assert.equal(targets.some((target) => target.id === 'physical'), false);
});

test('candidate, sheet and row incidences are related without leaking unrelated sheets or duplicating them', () => {
  const issues = [
    { code: 'candidate', candidateId: 'candidate', sheet: null, row: null },
    { code: 'sheet', candidateId: null, sheet: 'Recepción', row: null },
    { code: 'row', candidateId: null, sheet: 'Recepción', row: 4 },
    { code: 'other-row', candidateId: null, sheet: 'Recepción', row: 9 },
    { code: 'ink', candidateId: null, sheet: 'Tintas', row: null }
  ];
  const targets = buildReviewTargets({ ...snapshot, issues });
  assert.deepEqual(targets[0].issues.map((issue) => issue.code), ['candidate', 'sheet', 'row']);
  assert.deepEqual(targets[1].issues.map((issue) => issue.code), ['ink']);
});

test('a missing identity or source-only comparison never enables proposing a new asset', () => {
  for (const proposal of ['REVIEW_IDENTITY', 'REVIEW_SOURCE_ONLY']) {
    const target = buildReviewTargets({ ...snapshot, candidates: [{ ...candidate, proposal }] })[0];
    assert.deepEqual(availableReviewActions(target, false), ['HOLD', 'EXCLUDE']);
  }
  const target = buildReviewTargets({ ...snapshot, candidates: [{ ...candidate, serials: [], tags: [] }] })[0];
  assert.deepEqual(availableReviewActions(target, false), ['HOLD', 'EXCLUDE']);
});

test('stale candidates and independent records accept only hold/exclude; matches permit suggested links only', () => {
  const targets = buildReviewTargets(snapshot);
  assert.deepEqual(availableReviewActions(targets[0], true), ['HOLD', 'EXCLUDE']);
  assert.deepEqual(availableReviewActions(targets[1], false), ['HOLD', 'EXCLUDE']);
  const existing = { ...targets[0], candidate: { ...candidate, proposal: 'REVIEW_MATCH', existingAssets: [{ id: 'suggested' }] } };
  assert.deepEqual(availableReviewActions(existing, false), ['HOLD', 'EXCLUDE', 'LINK_EXISTING']);
  assert.ok(validateReviewDraft(existing, false, 'LINK_EXISTING', 'Motivo', 'arbitrary').linkedAssetId);
  assert.deepEqual(validateReviewDraft(existing, false, 'LINK_EXISTING', 'Motivo', 'suggested'), {});
});

test('review validation requires a bounded explicit reason and a currently allowed action', () => {
  const target = buildReviewTargets(snapshot)[0];
  assert.ok(validateReviewDraft(target, false, 'HOLD', ' ', '').note);
  assert.ok(validateReviewDraft(target, false, 'HOLD', 'x'.repeat(2001), '').note);
  assert.ok(validateReviewDraft(target, true, 'PROPOSE_NEW', 'Motivo', '').action);
  assert.deepEqual(validateReviewDraft(target, false, 'PROPOSE_NEW', ' Revisado ', ''), {});
});

test('the same captured intent keeps version, UUID and values across uncertain retries; links are exclusive', () => {
  const target = buildReviewTargets(snapshot)[0];
  const intent = createReviewIntent(target, 7, 'HOLD', ' Revisar identidad ', 'do-not-send', 'request-id');
  assert.deepEqual(intent, { expectedVersion: 7, requestId: 'request-id', targetType: 'CANDIDATE', targetId: 'candidate', action: 'HOLD', note: 'Revisar identidad' });
  const request = JSON.stringify(intent);
  assert.equal(JSON.stringify(intent), request);
  assert.equal(createReviewIntent(target, 7, 'LINK_EXISTING', 'Motivo', 'suggested', 'request-id').linkedAssetId, 'suggested');
});

test('server offsets count received records independently of visible deduplicated rows', () => {
  const first = { items: [{ id: 'one' }, { id: 'two' }], total: 3, hasMore: true, nextOffset: 2 };
  const next = appendServerPage(first, [{ id: 'two', note: 'new' }, { id: 'three' }], 3, false, 2);
  assert.equal(next.items.length, 3);
  assert.equal(next.nextOffset, 4);
  assert.equal(next.items[1].note, 'new');
  assert.equal(appendServerPage(first, [{ id: 'new' }], 1, false, 0).items.length, 1);
});
