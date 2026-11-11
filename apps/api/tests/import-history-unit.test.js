import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { historyCaptureSchema } from '../src/imports/history-schemas.js';
import { buildHistoricalObservations, historicalLinkBasis, historyRequestDigest } from '../src/imports/history.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { dateCell, mergeWorkbooks, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

function observations(source, assets = [], sourceContext = { revision: 0, corrections: [] }) {
  const preview = buildWorkbookPreview(source, assets, '2026-10-05', 'DATABASE');
  return buildHistoricalObservations(buildWorkbookPreview(source, [], '2026-10-05'), preview, sourceContext);
}
function request() {
  return historyCaptureSchema.parse({ expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), historyPreviewId: 'a'.repeat(64),
    confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Historical source reviewed', evidenceReference: 'Workbook and receiving document',
    records: [{ recordId: 'b'.repeat(64), kind: 'RECEIPT_OBSERVATION' }] });
}

test('historical capture DTO rejects invented events, dates, actors, state effects and unbounded selections', () => {
  const input = request();
  for (const change of [{ confirmation: 'APPLY_INVENTORY' }, { effectiveDay: '2001-01-01' }, { performedById: randomUUID() }, { expectedVersion: '1' },
    { records: [] }, { records: [input.records[0], input.records[0]] }, { records: Array(26).fill(input.records[0]) },
    { records: [{ ...input.records[0], kind: 'ASSET_RETURNED' }] }, { records: [{ ...input.records[0], status: 'DECOMMISSIONED' }] }]) {
    assert.equal(historyCaptureSchema.safeParse({ ...input, ...change }).success, false);
  }
  assert.equal(input.records[0].assetId, null);
});

test('receipt and usage observations preserve distinct source dates and references without assigning anyone', () => {
  const results = observations(workbook('Recepción', [receptionRow(4, 'HISTORY-001', { A: dateCell('2001-01-01T08:35:00'), B: textCell('OT-IN'), H: textCell('TICKET-IN'),
    M: dateCell('2002-01-01'), N: textCell('TICKET-OUT'), O: textCell('OT-OUT'), P: textCell('Sent to an office') })]));
  assert.equal(results.length, 2);
  const receipt = results.find((entry) => entry.kind === 'RECEIPT_OBSERVATION');
  const usage = results.find((entry) => entry.kind === 'USAGE_OBSERVATION');
  assert.equal(receipt.effectiveDay, '2001-01-01'); assert.equal(receipt.datePrecision, 'DAY');
  assert.equal(receipt.sourceDateText, '2001-01-01T08:35:00');
  assert.equal(usage.effectiveDay, '2002-01-01'); assert.equal(usage.dateField, 'usedDate');
  assert.equal(usage.effective.fields.incomingTicket, 'TICKET-IN');
  assert.equal(usage.effective.fields.outgoingTicket, 'TICKET-OUT');
  assert.equal(usage.historicalActorId, null); assert.equal(usage.affectsCurrentState, false);
});

test('retirement sheet Fecha never becomes an invented retirement date', () => {
  const results = observations(workbook('Baja 2026', [{ row: 2, cells: { A: dateCell('2001-01-01'), B: textCell('Notebook'), E: textCell('RETIRED-001') } }]));
  assert.equal(results.find((entry) => entry.kind === 'RECEIPT_OBSERVATION').effectiveDay, '2001-01-01');
  const retirement = results.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION');
  assert.equal(retirement.effectiveDay, null); assert.equal(retirement.dateField, null);
  assert.equal(retirement.dateUncertainty, 'RETIREMENT_DATE_NOT_MAPPED');
});

test('malformed, future and formula dates remain unknown with original evidence and issues intact', () => {
  for (const cell of [textCell('31/02/2001'), textCell('2055-01-01'), { type: 'formula', value: '=TODAY()', cachedValue: '2001-01-01' }]) {
    const receipt = observations(workbook('Recepción', [receptionRow(4, 'UNCERTAIN-001', { A: cell })]))[0];
    assert.equal(receipt.effectiveDay, null); assert.equal(receipt.datePrecision, 'UNKNOWN');
    assert.equal(receipt.dateUncertainty, 'DATE_UNCONFIRMED');
    assert.deepEqual(receipt.original.originalCells.A, cell); assert.ok(receipt.issues.some((issue) => issue.severity === 'BLOCKING'));
  }
});

test('loan context keeps recipient and reported agent as source text, not accounts or active assignments', () => {
  const results = observations(workbook('NB Prestamo', [{ row: 3, cells: { F: textCell('LOAN-001'), H: dateCell('2001-01-01'), J: textCell('Reported recipient'), K: textCell('Reported agent') } }]));
  const loan = results.find((entry) => entry.kind === 'LOAN_OBSERVATION');
  assert.equal(loan.effectiveDay, '2001-01-01'); assert.equal(loan.historicalActorId, null);
  assert.equal(loan.effective.fields.recipientText, 'Reported recipient'); assert.equal(loan.effective.fields.agentText, 'Reported agent');
  assert.equal(observations(workbook('NB Prestamo', [{ row: 3, cells: { F: textCell('LOAN-002') } }]))[0].effectiveDay, null);
});

test('Tintas, summaries, notes and unknown sheets cannot become physical historical observations', () => {
  const source = mergeWorkbooks(workbook('Tintas', [{ row: 4, cells: { A: dateCell('2001-01-01'), C: textCell('PRINTER-001') } }]),
    workbook('Disponible', [{ row: 3, cells: { B: textCell('Notebook'), C: { type: 'number', value: 10 } } }]),
    workbook('Recepción', [{ row: 4, cells: { P: textCell('Historical note without a physical row') } }]));
  source.sheets.push({ name: 'Unknown historical worksheet', rows: [{ row: 2, cells: { A: dateCell('2001-01-01'), B: textCell('DEVICE-001') } }] });
  assert.deepEqual(observations(source), []);
});

test('history requests bind normalized selection, versions and rationale, not selection order', () => {
  const input = request();
  input.records.push({ ...input.records[0], recordId: 'c'.repeat(64) });
  assert.equal(historyRequestDigest(input), historyRequestDigest({ ...input, records: input.records.toReversed() }));
  for (const change of [{ expectedSourceRevision: 1 }, { note: 'Different note' }, { evidenceReference: 'Other proof' },
    { records: [{ ...input.records[0], assetId: randomUUID() }] }]) assert.notEqual(historyRequestDigest(input), historyRequestDigest({ ...input, ...change }));
});

test('historical asset linkage requires current identity approval, or the exact immutable pilot receipt', () => {
  const id = randomUUID(); const productId = randomUUID();
  const asset = { id, productId, serialNumber: 'LINK-001', assetTag: null, status: 'AVAILABLE', isActive: true, updatedAt: new Date(), product: { name: 'History asset' } };
  const source = workbook('Recepción', [receptionRow(4, 'LINK-001', { A: dateCell('2001-01-01') })]);
  const observation = observations(source, [asset])[0];
  const decision = { id: randomUUID(), targetType: 'CANDIDATE', targetId: observation.candidateId, action: 'LINK_EXISTING', linkedAssetId: id, sourceRevision: 0 };
  const context = { revision: 0, corrections: [] };
  assert.equal(historicalLinkBasis(observation, null, [], [], context), null);
  assert.equal(historicalLinkBasis(observation, id, [], [], context), undefined);
  assert.equal(historicalLinkBasis(observation, id, [decision], [], context).type, 'REVIEW_DECISION');
  assert.equal(historicalLinkBasis(observation, id, [decision], [], { ...context, identityRevisions: [{ candidateId: observation.candidateId, revision: 1 }] }), undefined);
  const applied = { id: randomUUID(), candidateId: observation.candidateId, assetId: id };
  assert.deepEqual(historicalLinkBasis(observation, id, [], [applied], context), { type: 'PILOT_RECEIPT', id: applied.id });
  assert.equal(historicalLinkBasis(observation, randomUUID(), [decision], [applied], context), undefined);
});

test('an unsafe identity in another observation of the same candidate prevents a reviewed history link', () => {
  const assetId = randomUUID();
  const source = workbook('Recepción', [receptionRow(4, 'MULTI-001', { A: dateCell('2001-01-01') }),
    receptionRow(5, 'MULTI-001', { G: { type: 'formula', value: '=123' } })]);
  const asset = { id: assetId, productId: randomUUID(), serialNumber: 'MULTI-001', assetTag: null, status: 'AVAILABLE', isActive: true, updatedAt: new Date(), product: { name: 'History asset' } };
  const observation = observations(source, [asset])[0];
  const decision = { id: randomUUID(), targetType: 'CANDIDATE', targetId: observation.candidateId, action: 'LINK_EXISTING', linkedAssetId: assetId, sourceRevision: 0 };
  assert.equal(observation.identityLinkBlocked, true);
  assert.equal(historicalLinkBasis(observation, assetId, [decision], [], { revision: 0, corrections: [] }), undefined);
});
