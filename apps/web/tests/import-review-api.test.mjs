import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const environment = 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};';
const apiUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': environment });
const { ApiRequestError, getApiErrorMessage } = await import(apiUrl);
const { readReviewPage, readBatch, readSnapshot, saveReviewDecision } = await import(moduleUrl('../src/features/imports/import-review-api.ts', { '../../lib/api': apiUrl }));
const id = '00000000-0000-4000-8000-000000000001';
const batch = { id, sourceFileName: 'Anónimo.xlsx', createdAt: '2026-10-05T12:00:00Z', asOf: '2026-10-05', previewId: 'a'.repeat(64), version: 1, targetCount: 0, mode: 'REVIEW', persisted: true, canApply: false };
const controller = new globalThis.AbortController();

async function withResponses(responses, operation) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new globalThis.Response(JSON.stringify(responses.shift()), {status:200}); };
  try { return await operation(calls); } finally { globalThis.fetch = original; }
}
test('a malformed, empty-progress or operational response never becomes a review page', async () => {
  for (const response of [{}, {batches:[],total:1,hasMore:true}, {batches:[{...batch,canApply:true}],total:1,hasMore:false}]) {
    await withResponses([response], () => assert.rejects(readReviewPage('/inventory/imports/batches', 'batches', controller.signal), (error) => error.code === 'INVALID_RESPONSE'));
  }
});
test('a latest decision page cannot silently display history or another target', async () => {
  const decision = { id:'decision', batchId:id, requestId:'request', targetId:'other', targetType:'CANDIDATE', action:'HOLD', note:'Revisar', reviewedById:'jefe', createdAt:'2026-10-05T12:00:00Z', batchVersion:1 };
  for (const response of [{decisions:[],mode:'history',total:0,hasMore:false}, {decisions:[decision],mode:'latest',total:1,hasMore:false}, {decisions:[{...decision,targetId:'expected',batchId:'another-batch'}],mode:'latest',total:1,hasMore:false}]) {
    await withResponses([response], () => assert.rejects(readReviewPage('/inventory/imports/batches/'+id+'/decisions?mode=latest&targetType=CANDIDATE&targetId=expected', 'decisions', controller.signal), (error) => error.code === 'INVALID_RESPONSE'));
  }
});
test('batch ownership and the persisted snapshot wrapper are checked before rendering', async () => {
  await withResponses([{ batch:{...batch,id:'different'},reviewSummary:{} }], () => assert.rejects(readBatch(id), (error) => error.code === 'INVALID_RESPONSE'));
  await withResponses([{ batchId:id,persisted:false,canApply:false,snapshot:{} }], () => assert.rejects(readSnapshot(id), (error) => error.code === 'INVALID_RESPONSE'));
});
test('saving a decision sends CSRF, the exact captured intent and no operational mutation', async () => {
  const intent = {requestId:'request',expectedVersion:1,targetType:'RECORD',targetId:'target',action:'HOLD',note:'Motivo explícito'};
  const decision = {...intent,id:'decision',batchId:id,batchVersion:2,linkedAssetId:null,reviewedById:'jefe',createdAt:'2026-10-05T12:00:00Z'};
  await withResponses([{csrfToken:'fixture-token'}, {batch:{...batch,version:2},decision,reused:false}], async (calls) => {
    await saveReviewDecision(id, intent);
    assert.equal(calls.length,2);
    assert.ok(calls[1].url.endsWith('/decisions'));
    assert.equal(calls[1].options.headers.get('X-CSRF-Token'),'fixture-token');
    assert.equal(calls[1].options.body, JSON.stringify(intent));
    assert.equal(calls[1].options.credentials,'include');
  });
});
test('review errors give Spanish recovery without exposing cells or server internals', () => {
  for (const code of ['IMPORT_REVIEW_NOT_READY','REVIEW_VERSION_CONFLICT','BATCH_SNAPSHOT_STALE','ASSET_NOT_SUGGESTED','IDEMPOTENCY_KEY_REUSED','INVALID_REVIEW_SNAPSHOT']) {
    const message = getApiErrorMessage(new ApiRequestError('private-cell-content',409,code),'fallback');
    assert.notEqual(message,'fallback');
    assert.equal(message.includes('private-cell-content'),false);
  }
});
