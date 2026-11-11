import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { buildPilotPlan } from '../src/imports/plan.js';
import { pilotPlanSchema } from '../src/imports/plan-schemas.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { receptionRow, textCell, workbook, mergeWorkbooks } from './fixtures/workbook-preview.js';

function fixture(extra = {}) {
  const product = { id: randomUUID(), name: 'Pilot notebook', trackingMode: 'ASSET', isActive: true,
    equipmentType: 'Notebook', brand: 'HP', model: 'Model G9', updatedAt: new Date('2026-01-01') };
  const preview = buildWorkbookPreview(workbook('Recepción', [receptionRow(4, 'PILOT-001', { K: textCell('Disponible'), ...extra })]), [], '2026-10-05', 'DATABASE');
  const candidate = preview.candidates[0];
  const batch = { id: randomUUID(), version: 2, targetCount: 1, previewId: preview.previewId,
    rulesVersion: preview.rulesVersion, databaseSnapshotDigest: preview.databaseSnapshotDigest, asOf: preview.asOf };
  const decision = { id: randomUUID(), targetType: 'CANDIDATE', targetId: candidate.id, action: 'PROPOSE_NEW', linkedAssetId: null, batchVersion: 2 };
  const input = pilotPlanSchema.parse({ expectedVersion: 2, operations: [{ type: 'CREATE_ASSET', candidateId: candidate.id,
    confirmation: 'AVAILABLE_UNASSIGNED', note: 'Confirmed physical unassigned asset', values: { productId: product.id, serialNumber: 'PILOT-001', location: 'Storage' } }] });
  const plan = (overrides = {}) => buildPilotPlan(overrides.batch ?? batch, overrides.preview ?? preview, overrides.decisions ?? [decision],
    overrides.products ?? [product], overrides.assets ?? [], overrides.input ?? input);
  return { product, preview, candidate, batch, decision, input, plan };
}

test('pilot DTO is explicit, bounded and cannot alter identity/state through metadata', () => {
  const { input, candidate } = fixture();
  assert.equal(pilotPlanSchema.safeParse(input).success, true);
  const update = { type: 'UPDATE_METADATA', candidateId: candidate.id, assetId: randomUUID(), note: 'Validated location', values: { location: null } };
  assert.equal(pilotPlanSchema.safeParse({ expectedVersion: 2, operations: [update] }).success, true);
  for (const invalid of [
    { ...input, expectedVersion: '2' }, { ...input, force: true }, { ...input, operations: [] },
    { ...input, operations: Array(26).fill(input.operations[0]) }, { ...input, operations: Array(2).fill(input.operations[0]) },
    { ...input, operations: [{ ...input.operations[0], confirmation: 'ASSIGNED' }] },
    { ...input, operations: [{ ...input.operations[0], values: { ...input.operations[0].values, status: 'AVAILABLE' } }] },
    { ...input, operations: [{ ...update, values: { serialNumber: 'Changed' } }] },
    { ...input, operations: [{ ...update, values: {} }] }, { ...input, operations: [{ ...update, values: { ipAddress: 'bad' } }] },
    { ...input, operations: [{ ...update, acknowledgedWarnings: ['a'.repeat(64), 'a'.repeat(64)] }] }
  ]) assert.equal(pilotPlanSchema.safeParse(invalid).success, false);
});

test('clean pilot produces exact field changes and stable fingerprint, never authorization', () => {
  const { plan, input, product } = fixture();
  const result = plan();
  assert.equal(result.planValidationComplete, true);
  assert.equal(result.canApply, false);
  assert.equal(result.persisted, false);
  assert.equal(result.omittedTargetCount, 0);
  assert.deepEqual(result.operations[0].source.map(({ sheet, row }) => ({ sheet, row })), [{ sheet: 'Recepción', row: 4 }]);
  assert.deepEqual(result.operations[0].changes, [{ field: 'serialNumber', before: null, after: 'PILOT-001' }, { field: 'location', before: null, after: 'Storage' }]);
  assert.equal(result.operations[0].resultingStatus, 'AVAILABLE');
  assert.equal(plan().planId, result.planId);
  assert.notEqual(plan({ input: { ...input, operations: [{ ...input.operations[0], note: 'Another reason' }] } }).planId, result.planId);
  assert.notEqual(plan({ products: [{ ...product, updatedAt: new Date('2026-02-01') }] }).planId, result.planId);
});

test('identity intentions, inventory freshness and review version are mandatory', () => {
  const { plan, batch, decision } = fixture();
  for (const action of ['HOLD', 'EXCLUDE', 'LINK_EXISTING']) assert.ok(plan({ decisions: [{ ...decision, action }] }).operations[0].blockers.some((entry) => entry.code === 'NEW_ASSET_REVIEW_REQUIRED'));
  assert.equal(plan({ decisions: [] }).planValidationComplete, false);
  for (const changed of [{ rulesVersion: 'old' }, { databaseSnapshotDigest: 'f'.repeat(64) }]) {
    assert.ok(plan({ batch: { ...batch, ...changed } }).operations[0].blockers.some((entry) => entry.code === 'BATCH_SNAPSHOT_STALE'));
  }
  assert.equal(plan({ batch: { ...batch, asOf: '2026-10-04' } }).planValidationComplete, true);
  assert.throws(() => plan({ batch: { ...batch, version: 3 } }), (error) => error.code === 'REVIEW_VERSION_CONFLICT');
});

test('warnings require exact acknowledgements and blocking evidence cannot be waived', () => {
  const { plan, input } = fixture({ E: textCell('') });
  const first = plan();
  assert.equal(first.planValidationComplete, false);
  const warningIds = first.operations[0].warnings.map((entry) => entry.id);
  assert.equal(warningIds.length, 1);
  assert.equal(plan({ input: { ...input, operations: [{ ...input.operations[0], acknowledgedWarnings: warningIds }] } }).planValidationComplete, true);
  assert.ok(plan({ input: { ...input, operations: [{ ...input.operations[0], acknowledgedWarnings: ['f'.repeat(64)] }] } }).operations[0].blockers.some((entry) => entry.code === 'UNKNOWN_WARNING_ACKNOWLEDGEMENT'));
  const damaged = fixture({ A: textCell('2055-01-01') });
  assert.ok(damaged.plan().operations[0].blockers.some((entry) => entry.code === 'FUTURE_SOURCE_DATE'));
});

test('selected products must be active ASSET and consistent with source model', () => {
  const { plan, product } = fixture();
  for (const [change, code] of [
    [{ isActive: false }, 'PRODUCT_INACTIVE'], [{ trackingMode: 'QUANTITY' }, 'PRODUCT_NOT_ASSET'],
    [{ model: 'Model G10' }, 'SELECTED_PRODUCT_MODEL_CONFLICT'], [{ brand: 'Dell' }, 'SELECTED_PRODUCT_BRAND_CONFLICT']
  ]) assert.ok(plan({ products: [{ ...product, ...change }] }).operations[0].blockers.some((entry) => entry.code === code));
  assert.ok(plan({ products: [] }).operations[0].blockers.some((entry) => entry.code === 'PRODUCT_NOT_FOUND'));
});

test('new asset identity must retain all usable source identifiers', () => {
  const { plan, input } = fixture({ G: textCell('TAG-001') });
  assert.ok(plan().operations[0].blockers.some((entry) => entry.code === 'SOURCE_IDENTITY_MISMATCH'));
  const matching = { ...input, operations: [{ ...input.operations[0], values: { ...input.operations[0].values, assetTag: 'tag-001' } }] };
  assert.equal(plan({ input: matching }).planValidationComplete, true);
  for (const values of [{ serialNumber: 'OTHER', assetTag: 'TAG-001' }, { serialNumber: 'N/A', assetTag: null }]) {
    assert.ok(plan({ input: { ...input, operations: [{ ...input.operations[0], values: { productId: input.operations[0].values.productId, ...values } }] } }).operations[0].blockers.some((entry) => entry.code === 'SOURCE_IDENTITY_MISMATCH'));
  }
  const serialOnly = fixture();
  const placeholder = { ...serialOnly.input, operations: [{ ...serialOnly.input.operations[0], values: { ...serialOnly.input.operations[0].values, assetTag: 'N/A' } }] };
  assert.ok(serialOnly.plan({ input: placeholder }).operations[0].blockers.some((entry) => entry.code === 'IDENTITY_PLACEHOLDER_NOT_ALLOWED'));
});

test('assignments, outgoing history, unavailable states and retirements cannot become AVAILABLE', () => {
  for (const extra of [{ K: textCell('No Disponible') }, { M: textCell('2026-01-02') }, { N: textCell('TK-OUT') }, { P: textCell('Sent to office') }]) {
    assert.equal(fixture(extra).plan().planValidationComplete, false);
  }
  const { plan, preview } = fixture();
  const historical = JSON.parse(JSON.stringify(preview));
  historical.records[0].kind = 'RETIREMENT_HISTORY';
  historical.records[0].statusEvidence = 'DECOMMISSIONED';
  assert.ok(plan({ preview: historical }).operations[0].blockers.some((entry) => entry.code === 'RETIREMENT_REQUIRES_SEPARATE_WORKFLOW'));
});

test('metadata plan uses the selected existing identity, preserves status and shows null clearing', () => {
  const { product, batch, input } = fixture();
  const asset = { id: randomUUID(), productId: product.id, serialNumber: 'PILOT-001', assetTag: null, status: 'ASSIGNED', isActive: true,
    updatedAt: new Date('2026-01-01'), technicalCondition: null, usagePurpose: null, location: 'Old storage', sector: null,
    ipAddress: null, hostname: null, loanCode: null, notes: null };
  const preview = buildWorkbookPreview(workbook('Recepción', [receptionRow(4, asset.serialNumber, { K: textCell('Disponible') })]), [{ ...asset, product }], '2026-10-05', 'DATABASE');
  const candidate = preview.candidates[0];
  const updatedBatch = { ...batch, previewId: preview.previewId, databaseSnapshotDigest: preview.databaseSnapshotDigest };
  const decision = { id: randomUUID(), targetType: 'CANDIDATE', targetId: candidate.id, action: 'LINK_EXISTING', linkedAssetId: asset.id, batchVersion: 2 };
  const operation = { type: 'UPDATE_METADATA', candidateId: candidate.id, assetId: asset.id, note: 'Clear incorrect location', values: { location: null } };
  const run = (assets = [asset], decisions = [decision], values = operation.values) => buildPilotPlan(updatedBatch, preview, decisions, [product], assets,
    pilotPlanSchema.parse({ ...input, operations: [{ ...operation, values }] }));
  assert.equal(run().planValidationComplete, true);
  assert.equal(run().operations[0].resultingStatus, 'ASSIGNED');
  assert.deepEqual(run().operations[0].changes, [{ field: 'location', before: 'Old storage', after: null }]);
  assert.ok(run([], [decision]).operations[0].blockers.some((entry) => entry.code === 'ASSET_NOT_FOUND'));
  assert.ok(run([asset], [{ ...decision, action: 'EXCLUDE' }]).operations[0].blockers.some((entry) => entry.code === 'EXISTING_ASSET_REVIEW_REQUIRED'));
  assert.ok(run([{ ...asset, isActive: false }]).operations[0].blockers.some((entry) => entry.code === 'ASSET_DECOMMISSIONED'));
  assert.ok(run([asset], [decision], { location: 'Old storage' }).operations[0].blockers.some((entry) => entry.code === 'NO_METADATA_CHANGE'));
});

test('partial pilot leaves unrelated tintas pending without importing them or hiding omission', () => {
  const { product, input, batch } = fixture();
  const source = mergeWorkbooks(workbook('Recepción', [receptionRow(4, 'PILOT-001', { K: textCell('Disponible') })]),
    workbook('Tintas', [{ row: 4, cells: { C: textCell('PRINTER-001'), D: textCell('Cyan') } }]));
  const preview = buildWorkbookPreview(source, [], '2026-10-05', 'DATABASE');
  const candidate = preview.candidates[0];
  const result = buildPilotPlan({ ...batch, targetCount: 2, previewId: preview.previewId }, preview,
    [{ id: randomUUID(), targetType: 'CANDIDATE', targetId: candidate.id, action: 'PROPOSE_NEW', linkedAssetId: null, batchVersion: 2 }], [product], [], input);
  assert.equal(result.planValidationComplete, true);
  assert.equal(result.omittedTargetCount, 1);
  assert.equal(result.operations.length, 1);
  assert.throws(() => buildPilotPlan(batch, preview, [], [product], [], { ...input, operations: [{ ...input.operations[0], candidateId: preview.records.find((entry) => entry.kind === 'CONSUMABLE_REVIEW').id }] }), (error) => error.code === 'INVALID_REVIEW_TARGET');
});
