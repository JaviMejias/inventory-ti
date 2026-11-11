import assert from 'node:assert/strict';
import { deserialize, serialize } from 'node:v8';
import { test } from 'node:test';

import { sheetDictionary } from '../src/imports/dictionary.js';
import { buildWorkbookPreview, identifierKey, previewDate } from '../src/imports/preview.js';
import { readPreviewAssets } from '../src/imports/routes.js';
import { workbookPreviewSchema } from '../src/imports/schemas.js';
import { dateCell, mergeWorkbooks, numberCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const asOf = '2026-10-05';
const preview = (input, assets = [], mode = 'SOURCE_ONLY') => buildWorkbookPreview(input, assets, asOf, mode);
const hasIssue = (result, code) => result.issues.some((issue) => issue.code === code);
const asset = (overrides = {}) => ({ id: 'asset-1', productId: 'product-1', serialNumber: 'SER-1', assetTag: '123', status: 'AVAILABLE', isActive: true, updatedAt: '2026-01-01T00:00:00Z', product: { name: 'Fixture product' }, ...overrides });

test('all 17 contextual mappings identify the correct column and header row', () => {
  const expected = [
    ['Baja 2026', 1, 'E', 'RETIREMENT_HISTORY'], ['Baja 2025', 1, 'F', 'RETIREMENT_HISTORY'],
    ['NB Prestamo', 2, 'F', 'ASSET_OBSERVATION'], ['FORTIGATE', 1, 'D', 'ASSET_OBSERVATION'],
    ['Control Desvinculados', 4, 'D', 'ASSET_OBSERVATION'], ['Baja 2024', 3, 'D', 'RETIREMENT_HISTORY'],
    ['Bodega 2', 3, 'F', 'ASSET_OBSERVATION'], ['Bodega 1', 3, 'F', 'ASSET_OBSERVATION'],
    ['Recepción', 3, 'F', 'ASSET_OBSERVATION'], ['Tintas', 3, 'C', 'CONSUMABLE_REVIEW'],
    ['Desvinculados', 4, 'D', 'ASSET_OBSERVATION'], ['Caja Negra', 4, 'D', 'ASSET_OBSERVATION'],
    ['KIT CONTINGENCIA', 1, 'F', 'ASSET_OBSERVATION'], ['CE', 3, 'F', 'ASSET_OBSERVATION'],
    ['Transitorio', 2, 'F', 'ASSET_OBSERVATION'], ['Disponible', 2, null, 'MANUAL_SUMMARY'],
    ['Inventario MDA 2', 5, 'G', 'ASSET_OBSERVATION']
  ];
  assert.equal(Object.keys(sheetDictionary).length, 17);
  const input = mergeWorkbooks(...expected.map(([name, headerRow, column]) => workbook(name, [{ row: headerRow + 1, cells: column ? { [column]: textCell('Fixture-' + name) } : { B: textCell('Notebook'), C: numberCell(11) } }])));
  const result = preview(input);
  assert.equal(result.sheets.length, 17);
  assert.equal(result.summary.recordCount, 17);
  assert.equal(result.summary.candidateCount, 15);
  assert.equal(result.summary.consumableReviewCount, 1);
  assert.equal(result.summary.manualSummaryCount, 1);
  assert.equal(hasIssue(result, 'HEADER_MISMATCH'), false);
  assert.equal(hasIssue(result, 'MISSING_SHEET'), false);
  for (const [name, headerRow, column, kind] of expected) {
    const record = result.records.find((entry) => entry.sheet === name);
    assert.equal(record.row, headerRow + 1);
    assert.equal(record.kind, kind);
    if (column && name !== 'Tintas') assert.equal(record.fields.serialNumber, 'Fixture-' + name);
    if (name === 'Tintas') assert.equal(record.fields.printerSerial, 'Fixture-Tintas');
  }
});

test('Estado remains condition in reception and purpose in CE; no-disponible is not assigned', () => {
  const input = mergeWorkbooks(
    workbook('Recepción', [receptionRow(4, 'SER-1', { J: textCell('Bueno'), K: textCell('No Disponible') })]),
    workbook('CE', [receptionRow(4, 'SER-1', { J: textCell('Disponible'), K: textCell('Alta') })])
  );
  const result = preview(input);
  const reception = result.records.find((row) => row.sheet === 'Recepción');
  const ce = result.records.find((row) => row.sheet === 'CE');
  assert.equal(reception.fields.technicalCondition, 'Bueno');
  assert.equal(reception.fields.availability, 'No Disponible');
  assert.equal(reception.statusEvidence, null);
  assert.equal(ce.fields.usagePurpose, 'Alta');
  assert.equal(ce.statusEvidence, 'AVAILABLE');
  assert.equal(result.candidates[0].proposedStatus, null);
});

test('filters, hidden rows and sparse row positions never exclude source records', () => {
  const row = { ...receptionRow(1687, 'SER-LAST'), hidden: true };
  const input = workbook('Recepción', [row], { hidden: true, filterRange: 'A3:P100' });
  const result = preview(input);
  assert.equal(result.records[0].hidden, true);
  assert.equal(result.records[0].row, 1687);
  assert.equal(result.sheets[0].filterRange, 'A3:P100');
  assert.equal(result.summary.populatedRows, result.summary.recordCount + result.summary.excludedCount);
});

test('repeated headers are excluded with original cells and changed headers block mapping', () => {
  const input = workbook('Baja 2024', [{ row: 4, cells: { D: textCell('SER-1') } }]);
  input.sheets[0].rows.push({ ...input.sheets[0].rows[0], row: 64 });
  const result = preview(input);
  assert.equal(result.records.length, 1);
  assert.equal(result.excluded.find((row) => row.row === 64).reason, 'REPEATED_HEADER');
  input.sheets[0].rows[0].cells.D = textCell('Changed header');
  const invalid = preview(input);
  assert.equal(hasIssue(invalid, 'HEADER_MISMATCH'), true);
  assert.equal(invalid.candidates.length, 0);
  assert.equal(invalid.records[0].kind, 'UNMAPPED');
  assert.deepEqual(invalid.records[0].originalCells, input.sheets[0].rows[1].cells);
});

test('identifier normalization preserves punctuation and accents and does not invent numeric serials', () => {
  assert.equal(identifierKey(' 5cd\u00a03495/739 '), '5CD 3495/739');
  assert.equal(identifierKey(' n/a '), null);
  assert.notEqual(identifierKey('SÉRIE'), identifierKey('SERIE'));
  const input = workbook('Recepción', [receptionRow(4, 'unused', { F: numberCell(1603400000000) }), receptionRow(5, 'unused', { F: textCell('N/A'), G: numberCell(123) })]);
  const result = preview(input);
  assert.equal(hasIssue(result, 'NUMERIC_SERIAL_REQUIRES_REVIEW'), true);
  assert.equal(result.records[0].serialKey, null);
  assert.equal(result.records[1].tagKey, '123');
  assert.equal(hasIssue(result, 'MISSING_ASSET_IDENTITY'), true);
});

test('same serial across sheets forms one review candidate but G9/G10 cannot silently win', () => {
  const input = mergeWorkbooks(workbook('Bodega 2', [receptionRow(5, 'SER-1', { G: numberCell(123) })]), workbook('Bodega 1', [receptionRow(433, ' ser-1\u00a0', { E: textCell('Model G10') })]));
  const result = preview(input);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].recordIds.length, 2);
  assert.equal(hasIssue(result, 'PRODUCT_MODEL_CONFLICT'), true);
  assert.equal(result.canApply, false);
});

test('typed dates/booleans cannot identify assets and stand-alone notes are not asset candidates', () => {
  const input = workbook('Recepción', [receptionRow(4, 'unused', { F: dateCell('2026-01-01T00:00:00'), G: { type: 'boolean', value: true } }), { row: 5, cells: { L: textCell('Equipment review note') } }]);
  const result = preview(input);
  assert.equal(hasIssue(result, 'IDENTIFIER_TYPE_REQUIRES_REVIEW'), true);
  assert.equal(result.records[0].serialKey, null);
  assert.equal(result.records[0].tagKey, null);
  assert.equal(result.records[1].kind, 'SOURCE_NOTE');
  assert.equal(result.summary.sourceNoteCount, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].proposal, 'REVIEW_IDENTITY');
});

test('tag-only observations join a single serial, but tags with several serials cannot bridge assets', () => {
  const input = workbook('Recepción', [receptionRow(4, 'SER-1', { G: numberCell(123) }), receptionRow(5, 'N/A', { G: numberCell(123) })]);
  assert.equal(preview(input).candidates.length, 1);
  input.sheets[0].rows.push(receptionRow(6, 'SER-2', { G: numberCell(123) }));
  const result = preview(input);
  assert.equal(result.candidates.length, 3);
  assert.equal(hasIssue(result, 'TAG_HAS_MULTIPLE_SERIALS'), true);
});

test('zero-padded numeric asset tags cannot silently match unpadded identifiers', () => {
  const input = workbook('Recepción', [receptionRow(4, 'N/A', { G: { type: 'number', value: 123, numberFormat: '00000', rawValue: '123' } })]);
  const result = preview(input, [asset()], 'DATABASE');
  assert.equal(hasIssue(result, 'NUMERIC_TAG_FORMAT_REQUIRES_REVIEW'), true);
  assert.equal(result.records[0].tagKey, null);
  assert.equal(result.candidates[0].existingAssets.length, 0);
  assert.equal(result.candidates[0].proposal, 'REVIEW_IDENTITY');
  assert.equal(result.records[0].originalCells.G.numberFormat, '00000');
});

test('tintas printer identifiers and manual totals never enter physical asset candidates', () => {
  const input = mergeWorkbooks(workbook('Recepción', [receptionRow(4, 'SER-1')]), workbook('Tintas', [{ row: 4, cells: { C: textCell('SER-1'), D: textCell('Black') } }, { row: 5, cells: { C: textCell('SER-1'), D: textCell('Cyan') } }]), workbook('Disponible', [{ row: 3, cells: { B: textCell('Notebook'), C: numberCell(11) } }]));
  const result = preview(input);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].recordIds.length, 1);
  assert.equal(result.summary.consumableReviewCount, 2);
  assert.equal(result.summary.manualSummaryCount, 1);
  assert.equal(hasIssue(result, 'CONSUMABLE_UNIT_UNCONFIRMED'), true);
});

test('formula values are not executed or trusted and dates are never repaired', () => {
  const input = workbook('Recepción', [receptionRow(4, 'SER-1', {
    A: dateCell('2205-01-01T00:00:00'), M: textCell('01/02/24'), I: { type: 'formula', value: '=Other!I20', cachedValue: 'Bodega 2' }
  })]);
  const result = preview(input);
  assert.equal(hasIssue(result, 'FUTURE_SOURCE_DATE'), true);
  assert.equal(hasIssue(result, 'DATE_REQUIRES_REVIEW'), true);
  assert.equal(hasIssue(result, 'FORMULA_REQUIRES_REVIEW'), true);
  assert.equal(result.records[0].fields.location, null);
  assert.equal(result.records[0].originalCells.I.cachedValue, 'Bodega 2');
  assert.equal(result.records[0].fields.receivedDate, '2205-01-01T00:00:00');
});

test('network conflicts, displaced columns and available/assigned contradictions are visible', () => {
  const input = mergeWorkbooks(
    workbook('FORTIGATE', [{ row: 124, cells: { A: textCell('10.72.40'), B: textCell('10.72.115.254'), D: textCell('SER-FW') } }]),
    workbook('Transitorio', [receptionRow(14, 'SER-T', { I: textCell('Bodega 2'), Q: textCell('Unexpected') })]),
    workbook('Bodega 2', [receptionRow(1209, 'SER-1', { J: textCell('Disponible'), P: textCell('Asignado a oficina') })])
  );
  const result = preview(input);
  for (const code of ['NETWORK_PREFIX_IP_CONFLICT', 'POSSIBLE_SHIFTED_STATE_COLUMN', 'UNMAPPED_COLUMN', 'AVAILABILITY_ASSIGNMENT_CONFLICT']) assert.equal(hasIssue(result, code), true, code);
});

test('database identity matching spans products, detects ambiguity and terminal state conflicts', () => {
  const input = workbook('Recepción', [receptionRow(4, 'SER-1', { G: numberCell(123), K: textCell('Disponible') })]);
  assert.equal(preview(input).candidates[0].proposal, 'REVIEW_SOURCE_ONLY');
  const matched = preview(input, [asset()], 'DATABASE');
  assert.equal(matched.candidates[0].proposal, 'REVIEW_EXISTING');
  const ambiguous = preview(input, [asset(), asset({ id: 'asset-2', productId: 'product-2', assetTag: null })], 'DATABASE');
  assert.equal(hasIssue(ambiguous, 'AMBIGUOUS_EXISTING_ASSET'), true);
  assert.equal(ambiguous.candidates[0].proposal, 'REVIEW_MATCH');
  const conflicting = preview(input, [asset({ serialNumber: 'DIFFERENT', status: 'DECOMMISSIONED', isActive: false })], 'DATABASE');
  assert.equal(hasIssue(conflicting, 'EXISTING_SERIAL_CONFLICT'), true);
  assert.equal(hasIssue(conflicting, 'EXISTING_TERMINAL_STATE_CONFLICT'), true);
});

test('preview IDs bind source contents, rules, as-of and database snapshot without mutations', () => {
  const input = workbook('Recepción', [receptionRow(4, 'SER-1')]);
  const original = deserialize(serialize(input));
  const first = preview(input, [asset()], 'DATABASE');
  assert.deepEqual(input, original);
  assert.deepEqual(first, preview(input, [asset()], 'DATABASE'));
  assert.equal(first.persisted, false);
  assert.notEqual(first.previewId, preview(input, [asset({ updatedAt: '2026-01-02T00:00:00Z' })], 'DATABASE').previewId);
  input.sheets[0].rows[1].cells.E.value = 'Changed model';
  assert.notEqual(first.previewId, preview(input, [asset()], 'DATABASE').previewId);
  assert.equal(previewDate(new Date('2026-10-05T01:00:00Z')), '2026-10-04');
});

test('strict envelope rejects paths, extra instructions, mismatched cell types and duplicate positions', () => {
  const valid = workbook();
  for (const invalid of [
    { ...valid, instructions: 'Do something' },
    { ...valid, source: { ...valid.source, fileName: '../source.xlsx' } },
    { ...valid, sheets: [...valid.sheets, ...valid.sheets] },
    { ...valid, sheets: [{ ...valid.sheets[0], rows: [...valid.sheets[0].rows, ...valid.sheets[0].rows] }] },
    { ...valid, sheets: [{ ...valid.sheets[0], rows: [{ row: 4, cells: { F: { type: 'number', value: '123' } } }] }] }
  ]) assert.equal(workbookPreviewSchema.safeParse(invalid).success, false);
  const unknown = { ...valid, sheets: [{ ...valid.sheets[0], name: 'constructor' }] };
  const result = preview(workbookPreviewSchema.parse(unknown));
  assert.equal(hasIssue(result, 'UNKNOWN_SHEET'), true);
  assert.equal(result.candidates.length, 0);
});

test('database reader uses only legacy columns, performs no writes and refuses truncation', async () => {
  let query;
  const fake = { asset: { findMany: async (input) => { query = input; return [asset()]; } } };
  assert.equal((await readPreviewAssets(fake)).length, 1);
  assert.equal(query.take, 25001);
  assert.deepEqual(query.select.product, { select: { name: true } });
  assert.equal(query.select.location, undefined);
  await assert.rejects(readPreviewAssets({ asset: { findMany: async () => Array(25001).fill(asset()) } }), (error) => error.code === 'PREVIEW_DATABASE_LIMIT');
});
