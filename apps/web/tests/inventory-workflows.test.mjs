import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
}
const dateUrl = moduleUrl('../src/lib/date-range.ts');
const { inventoryDateTimeToUtc, inventoryDate } = await import(dateUrl);
const { validateMovement, movementPayload, assetListPath, assetMatchesScope, isOperationalAsset } = await import(moduleUrl('../src/features/home/inventory-model.ts', { '../../lib/date-range': dateUrl }));
const { assetMetadataForm, assetMetadataPayload } = await import(moduleUrl('../src/features/home/inventory-metadata.ts'));
const { buildSummary } = await import(moduleUrl('../src/features/home/dashboard-model.ts', { '../../lib/date-range': dateUrl }));
const form = { type: 'ENTRY', productId: 'product', quantity: '1', reason: '', reference: '', effectiveAt: '', effectiveTime: '' };

test('movement defaults omit effective time so the server remains authoritative', () => {
  assert.deepEqual(validateMovement(form), {});
  assert.equal('effectiveAt' in movementPayload(form), false);
  assert.equal(movementPayload({ ...form, reference: '  OT-42  ' }).reference, 'OT-42');
});

test('Chile date-time preserves the selected local day and actual seasonal offset', () => {
  assert.equal(inventoryDateTimeToUtc('2026-01-01', '09:30'), '2026-01-01T12:30:00.000Z');
  assert.equal(inventoryDateTimeToUtc('2026-07-01', '09:30'), '2026-07-01T13:30:00.000Z');
  const utc = inventoryDateTimeToUtc('2026-09-30', '23:30');
  assert.equal(utc, '2026-10-01T02:30:00.000Z');
  assert.equal(inventoryDate(new Date(utc)), '2026-09-30');
});

test('invalid, nonexistent and ambiguous local times are never silently repaired', () => {
  for (const [date, time] of [['2026-02-30', '10:00'], ['2026-01-01', '24:00'], ['2026-09-06', '00:30'], ['2026-04-04', '23:30']]) {
    assert.throws(() => inventoryDateTimeToUtc(date, time), RangeError);
  }
  assert.ok(validateMovement({ ...form, effectiveAt: '2026-01-01' }).effectiveTime);
  assert.ok(validateMovement({ ...form, effectiveTime: '10:00' }).effectiveAt);
});

test('signed adjustments require a reason; ordinary movements require positive integers', () => {
  for (const quantity of ['', '0', '-1', '1.5', '2147483648']) assert.ok(validateMovement({ ...form, quantity }).quantity);
  assert.deepEqual(validateMovement({ ...form, type: 'ADJUSTMENT', quantity: '-2147483648', reason: 'Conteo físico' }), {});
  assert.ok(validateMovement({ ...form, type: 'ADJUSTMENT', quantity: '-1' }).reason);
  assert.ok(validateMovement({ ...form, reference: 'x'.repeat(161) }).reference);
  assert.ok(validateMovement({ ...form, reason: 'x'.repeat(10001) }).reason);
});

test('archived scope uses a coherent query and never permits operational actions', () => {
  assert.equal(assetListPath('decommissioned'), '/assets?isActive=false&status=DECOMMISSIONED');
  assert.equal(assetListPath('all'), '/assets');
  const retired = { status: 'DECOMMISSIONED', isActive: false };
  assert.equal(assetMatchesScope(retired, 'decommissioned'), true);
  assert.equal(assetMatchesScope(retired, 'active'), false);
  assert.equal(isOperationalAsset(retired), false);
  assert.equal(isOperationalAsset({ status: 'AVAILABLE', isActive: false }), false);
});

test('metadata edits distinguish unchanged, explicitly cleared and supplied fields', () => {
  const original = { ipAddress: '192.168.1.20', notes: null, hostname: 'TI-01' };
  const draft = assetMetadataForm(original);
  assert.deepEqual(assetMetadataPayload(draft, original), {});
  assert.deepEqual(assetMetadataPayload({ ...draft, ipAddress: '', hostname: ' TI-02 ' }, original), { ipAddress: null, hostname: 'TI-02' });
  assert.deepEqual(assetMetadataPayload(assetMetadataForm()), {});
});

test('asset alerts use backend available counts and never total active or assigned teams', () => {
  const statusCounts = { AVAILABLE: 2, ASSIGNED: 15, RESERVED: 0, UNDER_REVIEW: 0, IN_REPAIR: 0, IN_WARRANTY: 0, LOST: 0, DECOMMISSIONED: 0 };
  const data = { products: [{ id: 'q', name: 'Cable', trackingMode: 'QUANTITY', lowStockThreshold: 10 }], stock: [{ productId: 'q', quantity: 10 }], assets: [{ status: 'AVAILABLE', isActive: true }, { status: 'DECOMMISSIONED', isActive: false }, { status: 'ASSIGNED', isActive: false }], movements: [], availability: [{ product: { id: 'a', name: 'Notebook', lowStockThreshold: 10 }, activeCount: 17, availableCount: 2, statusCounts, lowStock: true }] };
  const summary = buildSummary(data, '2026-01-01', '2026-01-31');
  assert.equal(summary.assetCount, 1);
  assert.equal(summary.lowStockCount, 2);
  assert.equal(summary.lowStockProducts.find((row) => row.id === 'a').current, 2);
  assert.equal(summary.lowStockProducts.find((row) => row.id === 'a').trackingMode, 'ASSET');
  assert.deepEqual(summary.lowStockProducts, buildSummary(data, '2025-01-01', '2025-01-31').lowStockProducts);
  assert.equal(buildSummary({ ...data, availability: undefined }, '2026-01-01', '2026-01-31').lowStockCount, 1);
});

