import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText + '\n//# sourceURL=' + path).toString('base64');
}
const errorUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};' });
const modelUrl = moduleUrl('../src/features/imports/workbook-intake-model.ts', { '../../lib/api': errorUrl });
const reviewUrl = moduleUrl('../src/features/imports/import-review-api.ts', { '../../lib/api': errorUrl });
const historyModelUrl = moduleUrl('../src/features/imports/history-evidence-model.ts');
const historyUrl = moduleUrl('../src/features/imports/history-evidence-api.ts', { '../../lib/api': errorUrl, './import-review-api': reviewUrl, './history-evidence-model': historyModelUrl });
const api = await import(moduleUrl('../src/features/imports/workbook-intake-api.ts', { '../../lib/api': errorUrl, './import-review-api': reviewUrl, './closed-assignment-model': moduleUrl('../src/features/imports/closed-assignment-model.ts'), './history-evidence-api': historyUrl, './workbook-intake-model': modelUrl }));
const model = await import(modelUrl);
const { ApiRequestError } = await import(errorUrl);
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/workbook-intake.json', import.meta.url), 'utf8'));
function receipt(preview, reused = false) {
  return { reused, batch: {
    id: '10000000-0000-4000-8000-000000000001', createdById: '10000000-0000-4000-8000-000000000099', version: reused ? 9 : 1,
    sourceFileName: preview.source.fileName, sourceHash: preview.source.sha256, previewId: preview.previewId,
    payloadDigest: preview.payloadDigest, databaseSnapshotDigest: preview.databaseSnapshotDigest, rulesVersion: preview.rulesVersion, asOf: preview.asOf,
    targetCount: preview.candidates.length + preview.records.filter((row) => !['ASSET_OBSERVATION','RETIREMENT_HISTORY'].includes(row.kind)).length,
    mode: 'REVIEW', persisted: true, canApply: false, createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T13:00:00Z'
  } };
}

test('extractor input preserves source, hidden data, raw cells and formulas without evaluation or truncation', () => {
  const { workbook } = fixture();
  workbook.sheets[0].hidden = true; workbook.sheets[0].rows[0].hidden = true;
  workbook.sheets[0].rows[0].cells.ZZ = { type: 'formula', value: '=SUM(A1:A9)', cachedValue: null, rawValue: '0001', numberFormat: '0.00', formulaAttributes: { t: 'shared', si: '0' } };
  const parsed = model.parseWorkbookJSON('\uFEFF' + JSON.stringify(workbook));
  assert.deepEqual(parsed, workbook); assert.equal(Object.isFrozen(parsed.sheets[0].rows[0].cells.ZZ), true);
  assert.throws(() => { parsed.source.fileName = 'alterado.xlsx'; }, TypeError);
});
test('malformed, partial, duplicate, oversized or non-extractor input is rejected before any request', () => {
  assert.throws(() => model.parseWorkbookJSON('{'), { code: 'INVALID_WORKBOOK_INPUT' });
  assert.throws(() => model.parseWorkbookJSON(' '.repeat(model.workbookBodyLimit + 1)), { code: 'INVALID_WORKBOOK_INPUT' });
  for (const mutate of [
    (v) => { v.extra = true; }, (v) => { v.formatVersion = 2; }, (v) => { v.source.fileName = '../inventario.xlsx'; },
    (v) => { v.source.sha256 = 'A'.repeat(64); }, (v) => { v.sheets.push(v.sheets[0]); },
    (v) => { v.sheets[0].rows.push(v.sheets[0].rows[0]); }, (v) => { v.sheets[0].rows[0].row = 1048577; },
    (v) => { v.sheets[0].rows[0].cells.A = {type:'number',value:Infinity}; },
    (v) => { v.sheets[0].rows[0].cells.A = {type:'formula',value:'SUM(A1)'}; },
    (v) => { v.sheets[0].rows[0].cells.A = {type:'text',value:'x'.repeat(8193)}; }
  ]) { const value = fixture().workbook; mutate(value); assert.throws(() => model.validateWorkbookInput(value), {code:'INVALID_WORKBOOK_INPUT'}); }
});
test('database preview binds the complete extraction and rejects missing rows, altered source, unsafe flags or inconsistent counters', () => {
  const { workbook, preview } = fixture();
  assert.equal(api.validateDatabasePreview(preview, workbook).previewId, preview.previewId);
  for (const mutate of [
    (v) => { v.comparisonMode = 'NONE'; }, (v) => { v.canApply = true; }, (v) => { v.source.sha256 = 'b'.repeat(64); },
    (v) => { v.records.pop(); }, (v) => { v.records[0].originalCells.A = { type:'text',value:'alterado' }; },
    (v) => { v.summary.recordCount++; }, (v) => { v.summary.blockingIssueCount++; },
    (v) => { v.sheets[0].hidden = !v.sheets[0].hidden; }, (v) => { v.asOf = '2026-02-30'; },
    (v) => { v.candidates[0].recordIds.push('a'.repeat(64)); }
  ]) { const value = globalThis.structuredClone(preview); mutate(value); assert.throws(() => api.validateDatabasePreview(value, workbook), {code:'INVALID_RESPONSE'}); }
});
test('batch intent is detached and frozen; it contains only workbook and reviewed previewId', () => {
  const {workbook,preview} = fixture(); const intent = model.captureBatchIntake(workbook,preview);
  assert.deepEqual(Object.keys(intent),['workbook','previewId']); assert.equal(Object.isFrozen(intent.workbook.sheets[0].rows),true);
  workbook.sheets[0].rows.length = 0; assert.notEqual(intent.workbook.sheets[0].rows.length,0);
  assert.throws(() => model.captureBatchIntake(intent.workbook,{...preview,source:{...preview.source,fileName:'otro.xlsx'}}),{code:'INVALID_WORKBOOK_INPUT'});
});
test('a complete extraction fitting the preview limit is not silently shortened when its save wrapper exceeds 16 MiB',()=>{
  const {workbook,preview}=fixture();
  workbook.sheets=[{name:'QA',rows:Array.from({length:32},(_,index)=>({row:index+1,cells:Object.fromEntries(Array.from({length:64},(_,column)=>['A'+String.fromCharCode(65+Math.floor(column/26))+String.fromCharCode(65+column%26),{type:'text',value:'x'.repeat(8192)}]))}))}];
  let excess=JSON.stringify(workbook).length-(model.workbookBodyLimit-1);
  for(const row of workbook.sheets)for(const cells of row.rows)for(const cell of Object.values(cells.cells)){
    const removed=Math.min(excess,cell.value.length);cell.value=cell.value.slice(removed);excess-=removed;
  }
  const raw=JSON.stringify(workbook);assert.equal(raw.length,model.workbookBodyLimit-1);
  const parsed=model.parseWorkbookJSON(raw);assert.equal(parsed.sheets[0].rows.length,32);
  assert.throws(()=>model.captureBatchIntake(parsed,preview),{code:'INVALID_WORKBOOK_INPUT'});
  assert.equal(JSON.stringify(parsed),raw);
});
test('preview and creation are explicit CSRF requests; reuse accepts the original creator and later administrative version', async () => {
  const { workbook,preview } = fixture(); const previous = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url,options) => { calls.push({url,options}); options.signal.throwIfAborted(); return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? {csrfToken:'qa'} : url.endsWith('/preview') ? preview : receipt(preview,true))); };
  try {
    const result = await api.previewWorkbook(workbook,new globalThis.AbortController().signal);
    const saved = await api.createWorkbookBatch(model.captureBatchIntake(workbook,result),result);
    assert.equal(saved.reused,true); assert.equal(saved.batch.version,9);
    assert.deepEqual(calls.map((call) => call.url), ['https://fixture.invalid/auth/csrf','https://fixture.invalid/inventory/imports/preview','https://fixture.invalid/auth/csrf','https://fixture.invalid/inventory/imports/batches']);
    assert.deepEqual(JSON.parse(calls[1].options.body),workbook);
    assert.deepEqual(Object.keys(JSON.parse(calls[3].options.body)),['workbook','previewId']);
    for (const call of [calls[1],calls[3]]) { assert.equal(call.options.method,'POST'); assert.equal(new globalThis.Headers(call.options.headers).get('X-CSRF-Token'),'qa'); }
  } finally { globalThis.fetch = previous; }
});
test('source/body binding and invalid preview fail before CSRF; aborted reads cannot start preview POST', async () => {
  const {workbook,preview} = fixture(); const previous = globalThis.fetch; const calls=[];
  globalThis.fetch = async (url, options) => { calls.push(url); options.signal.throwIfAborted(); return new globalThis.Response(JSON.stringify({csrfToken:'qa'})); };
  try {
    await assert.rejects(api.createWorkbookBatch({...model.captureBatchIntake(workbook,preview),previewId:'f'.repeat(64)},preview),{code:'INVALID_WORKBOOK_INPUT'});
    assert.equal(calls.length,0);
    const controller = new globalThis.AbortController(); controller.abort(); await assert.rejects(api.previewWorkbook(workbook,controller.signal),{name:'AbortError'});
    assert.equal(calls.some((url) => url.endsWith('/preview')),false);
  } finally { globalThis.fetch = previous; }
});
test('incompatible receipts remain unknown outcomes; known stale conflicts require a fresh preview', async () => {
  const {workbook,preview} = fixture(); const previous=globalThis.fetch;
  globalThis.fetch=async (url) => { const value=receipt(preview); value.batch.sourceHash='b'.repeat(64); return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? {csrfToken:'qa'} : value)); };
  try { await assert.rejects(api.createWorkbookBatch(model.captureBatchIntake(workbook,preview),preview),{code:'INVALID_RESPONSE'}); }
  finally {globalThis.fetch=previous;}
  assert.equal(api.batchIntakeNeedsRecovery(new ApiRequestError('private',409,'STALE_PREVIEW')),false);
  assert.equal(api.batchIntakeNeedsRecovery(new ApiRequestError('private',500)),true);
  assert.equal(api.batchIntakeNeedsRecovery(new ApiRequestError('private',200,'INVALID_RESPONSE')),true);
});
