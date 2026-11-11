import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { assetId, batchId, receiptId } from './fixtures/import-pilot.mjs';
import { historyFixture } from './fixtures/import-history.mjs';
import { assetEvidenceFixture } from './fixtures/asset-evidence.mjs';

function moduleUrl(path,imports={}) {
  let source=readFileSync(new URL(path,import.meta.url),'utf8');
  for (const [specifier,url] of Object.entries(imports)) source=source.replaceAll("'"+specifier+"'",JSON.stringify(url));
  return 'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
}
const errorUrl=moduleUrl('../src/lib/api.ts',{'../config/environment':'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};'});
const modelUrl=moduleUrl('../src/features/imports/history-evidence-model.ts');
const model=await import(modelUrl);
const errors=await import(errorUrl);
const api=await import(moduleUrl('../src/features/imports/history-evidence-api.ts',{'../../lib/api':errorUrl,'./import-review-api':'data:text/javascript,export const importReviewPath="/inventory/imports/batches";','./history-evidence-model':modelUrl}));
const signal=()=>new globalThis.AbortController().signal;
async function respond(value,operation,status=200) {
  const old=globalThis.fetch; const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf')?{csrfToken:'csrf-qa'}:value),{status:url.endsWith('/auth/csrf')?200:status});};
  try {return await operation(calls);} finally {globalThis.fetch=old;}
}
function fixtureIntent(fixture,records=fixture.observations.slice(0,3).map((entry)=>({recordId:entry.recordId,kind:entry.kind,assetId:null}))) {
  return model.createHistoryIntent(fixture.previewFor(),records,' Respaldo verificado ',' Acta QA ',receiptId);
}
test('historical preview uses real 25-row pages and never treats read errors as an empty result',async()=>{
  const fixture=historyFixture();
  for (const offset of [0,25]) await respond(fixture.previewFor(offset),async(calls)=>{
    const page=await api.readHistoryPreview(batchId,offset,signal()); assert.equal(page.observations.length,offset?2:25);
    assert.match(calls[0].url,new RegExp('history-preview\\?limit=25&offset='+offset+'$')); assert.equal(calls[0].options.body,undefined);
  });
  await respond({message:'private failure'},()=>assert.rejects(api.readHistoryPreview(batchId,0,signal())),503);
});
test('unknown, unconfirmed and retirement dates stay null; original and interpreted references remain separate',async()=>{
  const fixture=historyFixture(); const page=fixture.previewFor(); page.observations[0].effective.fields.receivedDate='2025-01-02'; page.observations[0].effectiveDay='2025-01-02';
  await respond(page,async()=>{
    const result=await api.readHistoryPreview(batchId,0,signal());
    assert.equal(result.observations[1].effectiveDay,null); assert.equal(result.observations[2].effectiveDay,null);
    assert.equal(result.observations[0].original.fields.receivedDate,'2025-01-01'); assert.equal(result.observations[0].effective.fields.receivedDate,'2025-01-02');
    assert.deepEqual(Object.keys(result.observations[0].effective.fields),['serialNumber','receivedDate','incomingTicket','incomingOt','purchaseOrder']);
    assert.equal(model.historyDay(null),'Fecha desconocida'); assert.equal(model.historyDay('2025-01-01'),'01-01-2025');
  });
});
test('wrong scope, owner, page, date, provenance and unsafe links are rejected',async()=>{
  const fixture=historyFixture();
  for (const mutate of [(value)=>{value.canApply=true;},(value)=>{value.affectsCurrentState=true;},(value)=>{value.batchId=assetId;},(value)=>{value.offset=25;},(value)=>{value.observations.pop();},
    (value)=>{value.observations[0].historicalActorId=assetId;},(value)=>{value.observations[0].effectiveDay='2025-02-30';},(value)=>{value.observations[1].datePrecision='DAY';},
    (value)=>{value.observations[0].original.id='0'.repeat(64);},(value)=>{value.observations[0].effective.row=100;},(value)=>{value.observations[0].linkOptions[0].basis.id='not-an-id';},
    (value)=>{value.observations[0].linkOptions.push(value.observations[0].linkOptions[0]);}]) {
    const page=fixture.previewFor(); mutate(page); await respond(page,()=>assert.rejects(api.readHistoryPreview(batchId,0,signal()),{code:'INVALID_RESPONSE'}));
  }
});
test('selection never automatically links an asset; refresh preserves unauthorized or already captured choices for explicit review',()=>{
  const fixture=historyFixture(); const selected=[{recordId:fixture.observations[0].recordId,kind:fixture.observations[0].kind,assetId}];
  const before=globalThis.structuredClone(selected); const page=fixture.previewFor(); page.observations[0].linkOptions=[];
  assert.match(model.reconcileHistorySelection(page,selected)[0].error,/no está autorizado/); assert.deepEqual(selected,before);
  assert.equal(model.reconcileHistorySelection(page,[{...selected[0],assetId:null}])[0].error,null);
  page.observations[0].stored={id:assetId}; assert.match(model.reconcileHistorySelection(page,selected)[0].error,/capturada/);
  assert.match(model.reconcileHistorySelection(fixture.previewFor(25),selected)[0].error,/no aparece/);
});
test('capture intent contains only strict identifiers, versions, explicit null and evidence; drafts cannot mutate it',()=>{
  const fixture=historyFixture(); const records=fixture.observations.slice(0,1).map((entry)=>({recordId:entry.recordId,kind:entry.kind,assetId:null}));
  const intent=fixtureIntent(fixture,records); records[0].assetId=assetId;
  assert.equal(intent.records[0].assetId,null); assert.equal(intent.note,'Respaldo verificado'); assert.equal(intent.evidenceReference,'Acta QA');
  assert.deepEqual(Object.keys(intent),['expectedVersion','expectedSourceRevision','requestId','historyPreviewId','confirmation','note','evidenceReference','records']);
  assert.equal(intent.confirmation,'STORE_HISTORICAL_EVIDENCE_ONLY'); assert.deepEqual(Object.keys(intent.records[0]),['recordId','kind','assetId']);
});
test('capture validates persisted receipt ownership and uses CSRF; recovery repeats identical body and UUID',async()=>{
  const fixture=historyFixture(); const intent=fixtureIntent(fixture); const receipt=fixture.receiptFor(intent);
  for (const reused of [false,true]) await respond({...fixture.scope,persisted:true,reused,capture:receipt},async(calls)=>{
    const result=await api.saveHistoryCapture(batchId,intent); assert.equal(result.id,receiptId);
    assert.equal(calls[1].options.method,'POST'); assert.equal(new globalThis.Headers(calls[1].options.headers).get('X-CSRF-Token'),'csrf-qa');
    assert.equal(calls[1].options.body,JSON.stringify(intent)); assert.ok(calls[1].options.signal instanceof globalThis.AbortSignal);
  });
});
test('mismatched or duplicated receipt items, selection, versions and intent are not acknowledged as success',async()=>{
  const fixture=historyFixture(); const intent=fixtureIntent(fixture);
  for (const mutate of [(value)=>{value.requestId=assetId;},(value)=>{value.batchVersion++;},(value)=>{value.sourceRevision++;},(value)=>{value.note='other';},
    (value)=>{value.items[0].assetId=assetId;},(value)=>{value.items[0].snapshot.original.fields.serialNumber='changed';},(value)=>{value.items[1]=value.items[0];},
    (value)=>{value.selection[0].historicalActorId=assetId;}]) {
    const receipt=globalThis.structuredClone(fixture.receiptFor(intent)); mutate(receipt);
    await respond({...fixture.scope,persisted:true,reused:false,capture:receipt},()=>assert.rejects(api.saveHistoryCapture(batchId,intent),{code:'INVALID_RESPONSE'}));
  }
});
test('original receipts do not require object property order to match PostgreSQL JSON ordering',async()=>{
  const fixture=historyFixture(); const receipt=fixture.receiptFor(fixtureIntent(fixture));
  receipt.items[0].snapshot=Object.fromEntries(Object.entries(receipt.items[0].snapshot).reverse());
  await respond({...fixture.scope,persisted:true,capture:receipt},async()=>assert.equal((await api.readHistoryCapture(batchId,receiptId,signal())).items.length,3));
});
test('receipt list metadata is intentionally lighter than the receipt detail and remains batch scoped',async()=>{
  const fixture=historyFixture(); const receipt=fixture.receiptFor(fixtureIntent(fixture));
  const page={...fixture.scope,captures:[fixture.metadata(receipt)],limit:25,offset:0,total:1,hasMore:false};
  await respond(page,async()=>assert.equal((await api.readHistoryCaptures(batchId,0,signal())).items.length,1));
  await respond({...fixture.scope,persisted:true,capture:receipt},()=>assert.rejects(api.readHistoryCapture(batchId,assetId,signal()),{code:'INVALID_RESPONSE'}));
});
test('uncertain/busy/conflicting captures keep their intent; known revalidation conflicts do not',()=>{
  for (const code of ['NETWORK_ERROR','INVALID_RESPONSE','HISTORY_CAPTURE_BUSY','HISTORY_CAPTURE_CONFLICT']) assert.equal(api.historyNeedsRecovery(new errors.ApiRequestError('private',409,code)),true);
  assert.equal(api.historyNeedsRecovery(new Error('timeout')),true); assert.equal(api.historyNeedsRecovery(new errors.ApiRequestError('private',503)),true);
  for (const code of ['HISTORY_PREVIEW_CHANGED','HISTORY_ASSET_LINK_UNCONFIRMED','HISTORY_EVIDENCE_ALREADY_CAPTURED','SOURCE_REVISION_CONFLICT','REVIEW_VERSION_CONFLICT']) assert.equal(api.historyNeedsRecovery(new errors.ApiRequestError('private',409,code)),false);
});
test('historical errors are localized and never render backend detail',()=>{
  for (const code of ['INVALID_HISTORICAL_TARGET','HISTORY_PREVIEW_CHANGED','HISTORY_ASSET_LINK_UNCONFIRMED','HISTORY_EVIDENCE_ALREADY_CAPTURED','HISTORY_CAPTURE_CONFLICT','HISTORY_CAPTURE_BUSY','HISTORY_SOURCE_LIMIT','HISTORY_LIST_CHANGED']) {
    const message=errors.getApiErrorMessage(new errors.ApiRequestError('secret database detail',409,code),'Fallback'); assert.notEqual(message,'Fallback'); assert.doesNotMatch(message,/secret/);
  }
});
test('asset evidence uses read-only 25-row pages, including empty and out-of-range live pages',async()=>{
  const fixture=assetEvidenceFixture();
  for (const offset of [0,25,50]) await respond(fixture.pageFor(offset),async(calls)=>{
    const result=await api.readAssetImportedEvidence(assetId,offset,signal());
    assert.equal(result.evidence.length,offset===0?25:offset===25?2:0);
    assert.match(calls[0].url,new RegExp('/assets/'+assetId+'/imported-evidence\\?limit=25&offset='+offset+'$'));
    assert.equal(calls.length,1); assert.equal(calls[0].options.body,undefined); assert.equal(calls[0].options.method,undefined);
    assert.ok(calls[0].options.signal instanceof globalThis.AbortSignal);
  });
  await respond(fixture.pageFor(0,[]),async()=>assert.equal((await api.readAssetImportedEvidence(assetId,0,signal())).total,0));
});
test('asset current interpretation distinguishes immutable capture date, origin revision, later link and unknown dates',async()=>{
  const fixture=assetEvidenceFixture();
  await respond(fixture.pageFor(),async()=>{
    const {evidence}=await api.readAssetImportedEvidence(assetId,0,signal());
    assert.equal(evidence[0].effectiveDay,'2025-01-02'); assert.equal(evidence[0].capturedEffectiveDay,'2025-01-01');
    assert.equal(evidence[0].capturedAssetId,null); assert.equal(evidence[0].assetId,assetId);
    assert.equal(evidence[0].capturedSourceRevision,0); assert.equal(evidence[0].effectiveSourceRevision,1);
    assert.equal(evidence[0].snapshot.original.fields.receivedDate,'2025-01-01'); assert.equal(evidence[0].snapshot.effective.fields.receivedDate,'2025-01-02');
    assert.equal(evidence[0].snapshot.original.originalCells.B.value,'2025-01-01'); assert.equal(evidence[0].snapshot.effective.originalCells.B.value,'2025-01-02');
    assert.equal(evidence[1].effectiveDay,null); assert.equal(evidence[1].capturedEffectiveDay,null);
    assert.equal(evidence[2].kind,'RETIREMENT_OBSERVATION'); assert.equal(evidence[2].effectiveDay,null);
  });
  const page=fixture.pageFor(); page.evidence[0].capturedAssetId=receiptId;
  await respond(page,async()=>assert.equal((await api.readAssetImportedEvidence(assetId,0,signal())).evidence[0].capturedAssetId,receiptId));
});
test('asset current evidence rejects wrong owner, scope, malformed V12 projection and inconsistent provenance',async()=>{
  const fixture=assetEvidenceFixture();
  const mutations=[(value)=>{value.canApply=true;},(value)=>{value.affectsCurrentState=true;},(value)=>{value.offset=25;},(value)=>{value.evidence.pop();},
    (value)=>{value.evidence[0].assetId=receiptId;},(value)=>{value.evidence[0].snapshot.assetId=receiptId;},
    (value)=>{delete value.evidence[0].evidenceVersion;},(value)=>{value.evidence[0].evidenceVersion=1001;},
    (value)=>{value.evidence[0].amendmentId=null;},(value)=>{value.evidence[0].amendedAt=null;},
    (value)=>{value.evidence[1].amendmentId=receiptId;},(value)=>{value.evidence[1].capturedAssetId=null;},
    (value)=>{value.evidence[1].effectiveSourceRevision=1;},(value)=>{value.evidence[0].capturedSourceRevision=2;},
    (value)=>{value.evidence[0].effectiveSourceRevision=-1;},(value)=>{value.evidence[0].captureId=assetId;},
    (value)=>{value.evidence[0].sourceHash='c'.repeat(64);},(value)=>{value.evidence[0].snapshot.recordId='f'.repeat(64);},
    (value)=>{value.evidence[0].effectiveDay='2025-02-30';},(value)=>{value.evidence[0].capturedEffectiveDay='2025-02-30';},
    (value)=>{value.evidence[0].snapshot.historicalActorId=assetId;},(value)=>{value.evidence[1]=value.evidence[0];}];
  for (const mutate of mutations) {
    const page=fixture.pageFor(); mutate(page);
    await respond(page,()=>assert.rejects(api.readAssetImportedEvidence(assetId,0,signal()),{code:'INVALID_RESPONSE'}));
  }
});
test('asset evidence errors are not confirmed empty documents and aborted reads remain cancelled',async()=>{
  await respond({message:'private'},()=>assert.rejects(api.readAssetImportedEvidence(assetId,0,signal()),{status:503}),503);
  const controller=new globalThis.AbortController(); controller.abort(); const previous=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{void url; options.signal.throwIfAborted();};
  try {await assert.rejects(api.readAssetImportedEvidence(assetId,0,controller.signal),{name:'AbortError'});} finally {globalThis.fetch=previous;}
});
