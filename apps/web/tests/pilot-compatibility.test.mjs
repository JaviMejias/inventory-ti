import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { assetId, batchId, pilotFixture } from './fixtures/import-pilot.mjs';
import { legacyPilotFixture } from './fixtures/legacy-pilot.mjs';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const metadataUrl = moduleUrl('../src/features/home/inventory-metadata.ts');
const modelUrl = moduleUrl('../src/features/imports/pilot-model.ts', { '../home/inventory-metadata': metadataUrl });
const model = await import(modelUrl);
const errorUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};' });
const reviewUrl = moduleUrl('../src/features/imports/import-review-api.ts', { '../../lib/api': errorUrl });
const historyModelUrl = moduleUrl('../src/features/imports/history-evidence-model.ts');
const historyUrl = moduleUrl('../src/features/imports/history-evidence-api.ts', { '../../lib/api': errorUrl, './import-review-api': reviewUrl, './history-evidence-model': historyModelUrl });
const sourceUrl = moduleUrl('../src/features/imports/source-review-api.ts', { '../../lib/api': errorUrl, './import-review-api': reviewUrl, './source-review-model': moduleUrl('../src/features/imports/source-review-model.ts') });
const pilotUrl = moduleUrl('../src/features/imports/pilot-api.ts', { '../../lib/api': errorUrl, '../../lib/pagination': moduleUrl('../src/lib/pagination.ts', { './api': errorUrl }), './import-review-api': reviewUrl, './source-review-api': sourceUrl });
const pilot = await import(pilotUrl);
const receipts = await import(moduleUrl('../src/features/imports/pilot-receipt-api.ts', { '../../lib/api': errorUrl, './history-evidence-api': historyUrl, './pilot-api': pilotUrl }));
const signal = () => new globalThis.AbortController().signal;
async function withFetch(response, action) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); options.signal?.throwIfAborted();
    return new globalThis.Response(JSON.stringify(typeof response === 'function' ? response(url, options) : response));
  };
  try { return await action(calls); } finally { globalThis.fetch = original; }
}
function contextResponse(fixture, products) {
  return (url) => url.includes('/resolved-preview') ? fixture.resolved : url.includes('/decisions?') ? { decisions: [], mode: 'latest', total: 0, hasMore: false } : { products, hasMore: false };
}

test('catalog active DTOs remain selectable across every product page without changing the internal plan product contract', async () => {
  const fixture = pilotFixture(); const metadata = { ...fixture.product }; delete metadata.isActive;
  const publicProduct = { ...metadata, active: true };
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...publicProduct, id: index ? 'product-' + index : publicProduct.id }));
  const nextPage = [{ ...publicProduct, id: 'next-active' }, { ...publicProduct, id: 'inactive', active: false }, { ...publicProduct, id: 'quantity', trackingMode: 'QUANTITY' }];
  await withFetch((url) => url.includes('/products?') ? { products: new URL(url).searchParams.get('offset') === '0' ? firstPage : nextPage, hasMore: new URL(url).searchParams.get('offset') === '0' } : contextResponse(fixture, [])(url), async (calls) => {
    const context = await pilot.readPilotContext(batchId, signal());
    assert.equal(context.products.length, 101);
    assert.equal(context.products[0].id, publicProduct.id); assert.equal(context.products.at(-1).id, 'next-active');
    assert.equal(context.products.every((product) => product.isActive === true && !Object.hasOwn(product, 'active')), true);
    assert.deepEqual(model.validatePilotOperation(fixture.request.operations[0], true, context.products), {});
    assert.deepEqual(calls.filter((call) => call.url.includes('/products?')).map((call) => new URL(call.url).searchParams.get('offset')), ['0', '100']);
    assert.equal(calls.every((call) => !call.options.method || call.options.method === 'GET'), true);
  });
});

test('missing or malformed active values fail visibly instead of silently discarding the catalog', async () => {
  const fixture = pilotFixture();
  for (const active of [undefined, 'true', 1, null]) {
    const product = { ...fixture.product, active };
    await withFetch(contextResponse(fixture, [product]), () => assert.rejects(pilot.readPilotContext(batchId, signal()), { code: 'INVALID_RESPONSE' }));
  }
});

test('explicit mda-pilot-1 receipts with 1 through 25 operations remain immutable and do not acquire V7 fields', () => {
  for (const count of [1, 2, 25]) {
    const fixture = legacyPilotFixture(count); const original = globalThis.structuredClone(fixture.response);
    const receipt = receipts.validateLegacyPilotReceipt(fixture.response, fixture.batchId, fixture.receiptId);
    assert.deepEqual(receipt, original.application); assert.deepEqual(fixture.response, original);
    assert.equal(model.isLegacyPilotReceipt(receipt), true); assert.equal(Object.hasOwn(receipt.plan, 'sourceRevision'), false);
    assert.equal(receipt.plan.operations.some((operation) => Object.hasOwn(operation, 'sourceCorrections') || Object.hasOwn(operation, 'identityRevision')), false);
    assert.equal(Object.isFrozen(receipt.plan.operations[0].values), true);
    assert.throws(() => { receipt.items[0].result.status = 'DECOMMISSIONED'; }, TypeError);
  }
});

test('legacy validation binds every item to the original receipt, plan, source, decision, operation and resulting asset', () => {
  for (const mutate of [
    (value) => { value.application.id = assetId; }, (value) => { value.application.batchId = assetId; },
    (value) => { value.application.plan.batchVersion++; }, (value) => { value.application.plan.planId = 'f'.repeat(64); },
    (value) => { value.application.items[1].applicationId = assetId; }, (value) => { value.application.items[1].sourceHash = 'f'.repeat(64); },
    (value) => { value.application.items[1].decisionId = assetId; }, (value) => { value.application.items[1].operation.note = 'Altered snapshot'; },
    (value) => { value.application.items[1].result.id = assetId; }, (value) => { value.application.items[1].result.productId = assetId; },
    (value) => { value.application.items[1].result.serialNumber = 'Altered identity'; }, (value) => { value.application.items[1].result.status = 'AVAILABLE'; },
    (value) => { value.application.items[1].result.notes = 'Altered result'; }, (value) => { value.application.items[1].result.product.id = assetId; },
    (value) => { value.application.items[1] = globalThis.structuredClone(value.application.items[0]); },
    (value) => { value.application.items.pop(); }, (value) => { value.application.plan.summary.validCount = 1; },
    (value) => { value.application.plan.operations[1].valid = false; }, (value) => { value.application.plan.freshness.stale = true; }
  ]) {
    const fixture = legacyPilotFixture(); mutate(fixture.response);
    assert.throws(() => receipts.validateLegacyPilotReceipt(fixture.response, fixture.batchId, fixture.receiptId), { code: 'INVALID_RESPONSE' });
  }
});

test('legacy validation rejects unknown versions, disguised V7 snapshots and malformed historic metadata', () => {
  for (const mutate of [
    (value) => { delete value.application.plan.planRulesVersion; }, (value) => { value.application.plan.planRulesVersion = 'mda-pilot-99'; },
    (value) => { value.application.plan.planRulesVersion = 'mda-pilot-3'; }, (value) => { value.application.plan.sourceRevision = 0; },
    (value) => { value.application.plan.operations[0].sourceCorrections = []; }, (value) => { value.application.plan.operations[0].identityRevision = 0; },
    (value) => { value.application.plan.operations[0].decisionSourceRevision = 0; },
    (value) => { value.application.createdAt = 'not-a-date'; }, (value) => { value.application.appliedById = 'missing-actor'; },
    (value) => { value.application.plan.operations[0].acknowledgedWarnings = []; },
    (value) => { value.application.plan.operations[0].source[0].recordId = 'unknown'; },
    (value) => { value.application.plan.operations[0].changes[0].after = 'Altered change'; }
  ]) {
    const fixture = legacyPilotFixture(); mutate(fixture.response);
    assert.throws(() => receipts.validateLegacyPilotReceipt(fixture.response, fixture.batchId, fixture.receiptId), { code: 'INVALID_RESPONSE' });
  }
  for (const count of [0, 26]) {
    const fixture = legacyPilotFixture(count);
    assert.throws(() => receipts.validateLegacyPilotReceipt(fixture.response, fixture.batchId, fixture.receiptId), { code: 'INVALID_RESPONSE' });
  }
});

test('legacy GET consults exactly the receipt parents, keeps original actor/time and accepts independent item order without writes', async () => {
  const fixture = legacyPilotFixture(); fixture.receipt.items.reverse();
  await withFetch(fixture.response, async (calls) => {
    const receipt = await receipts.readPilotApplication(fixture.batchId, fixture.receiptId, signal());
    assert.equal(receipt.appliedById, fixture.receipt.appliedById); assert.equal(receipt.createdAt, fixture.receipt.createdAt);
    assert.deepEqual(receipt.items, fixture.receipt.items);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://fixture.invalid/inventory/imports/batches/' + fixture.batchId + '/applications/' + fixture.receiptId);
    assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
  });
});

test('current receipts retain strict validation and missing V7 fields cannot fall back to legacy', async () => {
  const fixture = pilotFixture();
  const receipt = fixture.receiptFor(model.captureApplyIntent({ request: fixture.request, plan: fixture.planFor() }, '00000000-0000-4000-8000-000000000099'));
  receipt.plan.planRulesVersion = 'mda-pilot-3';
  await withFetch({ mode: 'APPLIED', persisted: true, application: receipt }, async () => {
    const result = await receipts.readPilotApplication(batchId, receipt.id, signal());
    assert.equal(model.isLegacyPilotReceipt(result), false); assert.deepEqual(result, receipt);
  });
  for (const mutate of [
    (value) => { delete value.plan.sourceRevision; }, (value) => { delete value.plan.operations[0].sourceCorrections; },
    (value) => { value.plan.planRulesVersion = 'mda-pilot-99'; }, (value) => { value.plan.planRulesVersion = 'mda-pilot-1'; }
  ]) {
    const altered = globalThis.structuredClone(receipt); mutate(altered);
    await withFetch({ mode: 'APPLIED', persisted: true, application: altered }, () => assert.rejects(receipts.readPilotApplication(batchId, altered.id, signal()), { code: 'INVALID_RESPONSE' }));
  }
});

test('legacy plans cannot produce current write intents even if somebody adds synthetic V7 defaults', async () => {
  const fixture = legacyPilotFixture(1);
  const plan = { ...fixture.receipt.plan, sourceRevision: 0, operations: fixture.receipt.plan.operations.map((operation) => ({ ...operation, sourceCorrections: [] })) };
  const request = { expectedVersion: plan.batchVersion, expectedSourceRevision: 0, operations: plan.operations };
  assert.equal(model.canConfirmPilot({ plan, request }, true), false);
  assert.throws(() => model.captureApplyIntent({ plan, request }, 'request'), /current pilot plan/);
  await withFetch((url) => url.endsWith('/auth/csrf') ? { csrfToken: 'token' } : plan,
    () => assert.rejects(pilot.generatePilotPlan(fixture.batchId, request), { code: 'INVALID_RESPONSE' }));
});

test('invalid parents fail before GET and aborted receipt reads do not become empty or successful receipts', async () => {
  const fixture = legacyPilotFixture();
  await withFetch(fixture.response, async (calls) => {
    await assert.rejects(receipts.readPilotApplication('invalid', fixture.receiptId, signal()), { code: 'VALIDATION_ERROR' });
    assert.equal(calls.length, 0);
    const controller = new globalThis.AbortController(); controller.abort();
    await assert.rejects(receipts.readPilotApplication(fixture.batchId, fixture.receiptId, controller.signal), { name: 'AbortError' });
  });
});
