import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new globalThis.URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll(`'${specifier}'`, JSON.stringify(url));
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
}

const dateUrl = moduleUrl('../src/lib/date-range.ts');
const { inventoryDate, inventoryDateRange, currentMonthStart, previousMonthDates, shiftDate } = await import(dateUrl);
const { buildSummary } = await import(moduleUrl('../src/features/home/dashboard-model.ts', { '../../lib/date-range': dateUrl }));
const apiSource = readFileSync(new globalThis.URL('../src/lib/api.ts', import.meta.url), 'utf8').replace("import { environment } from '../config/environment';", "const environment = { apiUrl: 'http://inventory.test' };");
const apiUrl = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(apiSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
const { fetchAllPages, mergeRecords } = await import(moduleUrl('../src/lib/pagination.ts', { './api': apiUrl }));

test('Chile calendar dates do not advance after 21:00 or skip the first day of the month', () => {
  const now = new Date('2026-09-30T22:00:00-03:00');
  assert.equal(inventoryDate(now), '2026-09-30');
  assert.equal(currentMonthStart(now), '2026-09-01');
  assert.deepEqual(previousMonthDates(now), { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
});

test('Chile range includes late local movements and excludes the next local day', () => {
  const range = inventoryDateRange('2026-09-01', '2026-09-30');
  const late = new Date('2026-09-30T22:00:00-03:00');
  assert.ok(late >= new Date(range.from) && late <= new Date(range.to));
  assert.equal(range.from, '2026-09-01T04:00:00.000Z');
  assert.equal(range.to, '2026-10-01T02:59:59.999Z');
  assert.deepEqual(inventoryDateRange(), { from: undefined, to: undefined });
});

test('date boundaries handle the Chile DST transition that skips midnight', () => {
  const range = inventoryDateRange('2026-09-06', '2026-09-06');
  assert.equal(inventoryDate(new Date(range.from)), '2026-09-06');
  assert.equal(inventoryDate(new Date(Date.parse(range.from) - 1)), '2026-09-05');
  assert.equal(Date.parse(range.to) - Date.parse(range.from) + 1, 23 * 3600000);
});

const data = {
  products: [], stock: [], assets: [],
  movements: [
    { effectiveAt: '2026-08-01T15:00:00Z', movementType: 'ENTRY', quantity: 20 },
    { effectiveAt: '2026-09-01T15:00:00Z', movementType: 'ENTRY', quantity: 5 },
    { effectiveAt: '2026-10-01T15:00:00Z', movementType: 'EXIT', quantity: -7 }
  ]
};

test('a period longer than 31 days retains every movement in totals and trend', () => {
  const summary = buildSummary(data, '2026-08-01', '2026-10-03');
  assert.deepEqual(summary.movementTotals, { entradas: 25, salidas: 7, ajustes: 0 });
  assert.ok(summary.movementTrend.length <= 31);
  assert.equal(summary.movementTrend.reduce((sum, item) => sum + item.entradas, 0), 25);
  assert.equal(summary.movementTrend.reduce((sum, item) => sum + item.salidas, 0), 7);
});

test('annual periods use monthly buckets without losing older movements', () => {
  const summary = buildSummary(data, '2026-01-01', '2026-12-31');
  assert.equal(summary.movementTrend.length, 12);
  assert.deepEqual(summary.movementTotals, { entradas: 25, salidas: 7, ajustes: 0 });
});

test('trend buckets use local movement days rather than their UTC dates', () => {
  const summary = buildSummary({ ...data, movements: [{ movementType: 'RETURN', quantity: 3, effectiveAt: '2026-10-01T01:00:00Z' }] }, '2026-09-30', '2026-09-30');
  assert.equal(summary.movementTotals.entradas, 3);
  assert.equal(summary.movementTrend[0].entradas, 3);
});

test('all product pages are fetched without discarding active filters', async (context) => {
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url) => {
    const query = new globalThis.URL(url).searchParams;
    calls.push(Number(query.get('offset')));
    assert.equal(query.get('active'), 'true');
    const offset = Number(query.get('offset'));
    return new globalThis.Response(JSON.stringify({ products: Array.from({ length: offset === 0 ? 100 : 20 }, (_, index) => ({ id: String(offset + index) })), hasMore: offset === 0 }));
  });
  const products = await fetchAllPages('/products?active=true', (page) => page.products);
  assert.equal(products.length, 120);
  assert.deepEqual(calls, [0, 100]);
});

test('pending corrections beyond the first page are included', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new globalThis.URL(url).searchParams.get('status'), 'PENDING');
    const offset = Number(new globalThis.URL(url).searchParams.get('offset'));
    return new globalThis.Response(JSON.stringify({ corrections: Array.from({ length: offset === 0 ? 100 : 25 }, (_, index) => ({ id: String(offset + index) })), hasMore: offset === 0 }));
  });
  assert.equal((await fetchAllPages('/corrections?status=PENDING', (page) => page.corrections)).length, 125);
});

test('pagination stops on inconsistent empty pages instead of looping', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new globalThis.Response(JSON.stringify({ products: [], hasMore: true })));
  await assert.rejects(fetchAllPages('/products', (page) => page.products), (error) => error.code === 'INVALID_RESPONSE');
});

test('a failure in a later page does not return an incomplete successful dataset', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url) => new globalThis.URL(url).searchParams.get('offset') === '0'
    ? new globalThis.Response(JSON.stringify({ products: [{ id: 'first' }], hasMore: true }))
    : new globalThis.Response(JSON.stringify({ code: 'SERVER_ERROR' }), { status: 500 }));
  await assert.rejects(fetchAllPages('/products', (page) => page.products), (error) => error.status === 500);
});

test('injected correction rows are reconciled with later server pages', () => {
  const current = [{ id: '30', reason: 'old' }, ...Array.from({ length: 25 }, (_, index) => ({ id: String(index + 1) }))];
  const page = Array.from({ length: 15 }, (_, index) => ({ id: String(index + 26), reason: 'updated' }));
  const merged = mergeRecords(current, page);
  assert.equal(merged.length, 40);
  assert.ok(merged.some((item) => item.id === '26'));
  assert.equal(merged.filter((item) => item.id === '30').length, 1);
  assert.equal(merged.find((item) => item.id === '30').reason, 'updated');
});
