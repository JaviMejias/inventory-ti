import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { batchId, candidateId } from './fixtures/import-pilot.mjs';
import { sourceFixture } from './fixtures/import-source.mjs';
function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier,url] of Object.entries(imports)) source=source.replaceAll("'"+specifier+"'",JSON.stringify(url));
  return 'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
}
const modelUrl=moduleUrl('../src/features/imports/source-review-model.ts');
const model=await import(modelUrl);
const apiUrl=moduleUrl('../src/lib/api.ts',{'../config/environment':'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};'});
const reviewUrl=moduleUrl('../src/features/imports/import-review-api.ts',{'../../lib/api':apiUrl});
const api=await import(moduleUrl('../src/features/imports/source-review-api.ts',{'../../lib/api':apiUrl,'./import-review-api':reviewUrl,'./source-review-model':modelUrl}));
const reviewApi=await import(reviewUrl);
const reviewModel=await import(moduleUrl('../src/features/imports/import-review-model.ts'));
test('source cells preserve an explicitly null formula cache without accepting structured cache values',()=>{
  const cell={type:'formula',value:'=A1',cachedValue:null,rawValue:'=A1',numberFormat:'0000',formulaAttributes:{t:'shared'}};
  assert.equal(api.validSourceCell(cell),true);assert.equal(cell.cachedValue,null);
  assert.equal(api.validSourceCell({...cell,cachedValue:{private:'invalid'}}),false);
});
async function respond(values, operation) {
  const original=globalThis.fetch; const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return new globalThis.Response(JSON.stringify(values.shift()),{status:200});};
  try {return await operation(calls);} finally {globalThis.fetch=original;}
}
function intentFor(fixture, changes=[{recordId:fixture.preview.records[0].id,field:'model',action:'REPLACE',value:'Modelo verificado'}]) {
  return model.captureSourceIntent(fixture.resolved,' Verificación física ',' Ticket QA ','00000000-0000-4000-8000-000000000008',changes);
}
test('descriptive fields use only the physical preview mapping, including missing cells',()=>{
  const fixture=sourceFixture(), record=fixture.preview.records[0];
  assert.deepEqual(model.descriptiveFields(record),['equipmentType','brand','model','receivedDate']);
  assert.deepEqual(model.descriptiveFields({...record,kind:'CONSUMABLE_REVIEW'}),[]);
  assert.deepEqual(model.descriptiveFields({...record,fields:{serialNumber:'QA'}}),[]);
});
test('verified historical dates reject rollover, future, placeholders and out-of-range years',()=>{
  const record=sourceFixture().preview.records[0];
  for(const value of ['2025-02-29','2026-02-30','2026-10-06','1899-12-31','N/A','']) assert.ok(model.validateSourceChange(record,'receivedDate','REPLACE',value,'2026-10-05').value);
  assert.deepEqual(model.validateSourceChange(record,'receivedDate','REPLACE','1900-01-01','2026-10-05'),{});
  assert.deepEqual(model.validateSourceChange(record,'receivedDate','RESTORE','','2026-10-05'),{});
  assert.ok(model.validateSourceChange(record,'brand','REPLACE','x'.repeat(101),'2026-10-05').value);
});
test('identity requires whole-candidate human verification, explicit text/null and bounded scope',()=>{
  const target=reviewModel.buildReviewTargets(sourceFixture().preview)[0];
  assert.deepEqual(model.validateIdentityDraft(target,'VERIFY','000012',null,true),{});
  assert.ok(model.validateIdentityDraft(target,'VERIFY','',null,true).serialNumber);
  assert.ok(model.validateIdentityDraft(target,'VERIFY',null,null,true).serialNumber);
  assert.ok(model.validateIdentityDraft(target,'VERIFY','000012',null,false).confirmation);
  assert.ok(model.validateIdentityDraft({...target,records:Array(13).fill(target.records[0])},'VERIFY','000012',null,true).scope);
  assert.deepEqual(model.validateIdentityDraft(target,'RESTORE',null,null,true),{});
});
test('captured source intent preserves UUID, versions, evidence and exact immutable changes',()=>{
  const fixture=sourceFixture(), changes=[{recordId:fixture.preview.records[0].id,field:'brand',action:'REPLACE',value:'QA'}];
  const intent=intentFor(fixture,changes); changes[0].value='changed';
  assert.equal(intent.changes[0].value,'QA'); assert.equal(intent.expectedRevision,0); assert.equal(intent.expectedBatchVersion,2);
  assert.equal(intent.evidenceReference,'Ticket QA'); assert.equal(intent.note,'Verificación física');
  const restore=intentFor(fixture,[{recordId:changes[0].recordId,field:'brand',action:'RESTORE'}]);
  assert.equal(Object.hasOwn(restore.changes[0],'value'),false);
});
test('RESTORE requires redecision even after all active identity corrections disappear',()=>{
  const fixture=sourceFixture();
  fixture.resolved.sourceContext.identityRevisions=[{candidateId,revision:2}];
  assert.equal(model.requiresIdentityRedecision(fixture.resolved,candidateId,1),true);
  assert.equal(model.requiresIdentityRedecision(fixture.resolved,candidateId,2),false);
  assert.equal(model.requiresIdentityRedecision(fixture.resolved,'other',0),false);
});
test('resolved preview keeps original evidence independent and validates corrections/revision provenance',async()=>{
  const fixture=sourceFixture(), intent=intentFor(fixture), event=fixture.eventFor(intent); fixture.commit(event);
  await respond([fixture.resolved],async()=>{const result=await api.readResolvedReviewSource(batchId);assert.equal(result.sourceContext.revision,1);assert.equal(result.preview.candidates[0].id,candidateId);});
  assert.equal(fixture.preview.records[0].fields.model,'Modelo incompleto');
  for(const mutation of [
    (value)=>{value.batchId='other';},(value)=>{value.sourceContext.corrections[0].revision=2;},
    (value)=>{value.sourceContext.corrections[0].afterCell.numberFormat={unexpected:true};},
    (value)=>{value.sourceContext.identityRevisions=[{candidateId,revision:3}];}
  ]) {const invalid=globalThis.structuredClone(fixture.resolved);mutation(invalid);await respond([invalid],()=>assert.rejects(api.readResolvedReviewSource(batchId),{code:'INVALID_RESPONSE'}));}
});
test('real source pages verify owner, descending order, offset and progress independently of head',async()=>{
  const fixture=sourceFixture(), event=fixture.eventFor(intentFor(fixture));
  const page={events:[event],revision:27,total:27,limit:25,offset:25,hasMore:true,canApply:false};
  await respond([page],async()=>assert.equal((await api.readSourceEvents(batchId,25,new globalThis.AbortController().signal)).revision,27));
  for(const invalid of [{...page,offset:0},{...page,events:[]},{...page,events:[{...event,batchId:'other'}]},{...page,events:[event,event]}]) await respond([invalid],()=>assert.rejects(api.readSourceEvents(batchId,25,new globalThis.AbortController().signal),{code:'INVALID_RESPONSE'}));
});
test('source save uses CSRF and exact intention on recovery, validating the persisted event',async()=>{
  const fixture=sourceFixture(), intent=intentFor(fixture), event=fixture.eventFor(intent);
  await respond([{csrfToken:'qa'}, {event,reused:false,canApply:false},{csrfToken:'qa'},{event,reused:true,canApply:false}],async(calls)=>{
    await api.saveSourceRevision(batchId,intent);await api.saveSourceRevision(batchId,intent);
    assert.equal(calls[1].options.body,calls[3].options.body);assert.match(calls[1].url,/source-revisions$/);
    assert.equal(calls[1].options.headers.get('X-CSRF-Token'),'qa');
    assert.ok(calls[1].options.signal instanceof globalThis.AbortSignal);
    assert.equal(calls[0].options.signal,calls[1].options.signal);
  });
  for(const invalid of [{...event,requestId:'other'},{...event,revision:3},{...event,changes:[{...event.changes[0],afterCell:{type:'text',value:'wrong'}}]}]) await respond([{csrfToken:'qa'},{event:invalid,reused:false,canApply:false}],()=>assert.rejects(api.saveSourceRevision(batchId,intent),{code:'INVALID_RESPONSE'}));
});
test('identity verification is exclusively whole candidate with text and explicit nullable properties',async()=>{
  const fixture=sourceFixture(); const {changes:ignored,...base}=intentFor(fixture);
  const intent={...base,candidateId,action:'VERIFY',confirmation:'VERIFIED_PHYSICAL_IDENTITY',serialNumber:'000012',assetTag:null};
  const event=fixture.eventFor(intent);
  await respond([{csrfToken:'qa'},{event,reused:false,canApply:false}],async(calls)=>{await api.saveSourceRevision(batchId,intent);assert.match(calls[1].url,/identity-revisions$/);assert.deepEqual(JSON.parse(calls[1].options.body),intent);});
  assert.equal(event.changes[0].afterCell.type,'text');assert.equal(event.changes[0].afterCell.value,'000012');assert.ok(ignored);
});
test('source-aware decision proves the exact source revision while retaining original candidate ID',async()=>{
  const fixture=sourceFixture(); const intent={expectedVersion:2,expectedSourceRevision:4,requestId:'stable',targetType:'CANDIDATE',targetId:candidateId,action:'PROPOSE_NEW',note:'Identidad verificada'};
  const response={batch:{...fixture.batch,version:3},decision:{...fixture.decision,...intent,batchVersion:3,sourceRevision:4},reused:false};
  await respond([{csrfToken:'qa'},response],()=>reviewApi.saveReviewDecision(batchId,intent));
  await respond([{csrfToken:'qa'},{...response,decision:{...response.decision,sourceRevision:3}}],()=>assert.rejects(reviewApi.saveReviewDecision(batchId,intent),{code:'INVALID_RESPONSE'}));
});
test('whole identity restoration omits replacement properties and preserves literal original cell metadata',async()=>{
  const fixture=sourceFixture(); const {changes:ignored,...base}=intentFor(fixture);
  const verify={...base,candidateId,action:'VERIFY',confirmation:'VERIFIED_PHYSICAL_IDENTITY',serialNumber:'000012',assetTag:null};
  fixture.commit(fixture.eventFor(verify));
  const restore={...base,expectedRevision:1,requestId:'restore-qa',candidateId,action:'RESTORE',confirmation:'RESTORE_ORIGINAL_IDENTITY'};
  const event=fixture.eventFor(restore);
  await respond([{csrfToken:'qa'},{event,reused:false,canApply:false}],async(calls)=>{
    await api.saveSourceRevision(batchId,restore);
    const body=JSON.parse(calls[1].options.body);
    assert.equal(Object.hasOwn(body,'serialNumber'),false);assert.equal(Object.hasOwn(body,'assetTag'),false);assert.ok(ignored);
    assert.deepEqual(event.changes[0].afterCell,{type:'number',value:12,numberFormat:'000000',rawValue:'12'});
  });
});
test('review reason and evidence are explicit and bounded; server identity conflicts remain safely localized',async()=>{
  assert.deepEqual(model.validateRevisionBase('Acta verificada','Ticket QA'),{});
  assert.ok(model.validateRevisionBase('','QA').note);
  assert.ok(model.validateRevisionBase('QA','').evidenceReference);
  assert.ok(model.validateRevisionBase('QA','x'.repeat(501)).evidenceReference);
  const library=await import(apiUrl);
  for(const code of ['IDENTITY_CANNOT_DROP_SOURCE_VALUE','IDENTITY_GROUP_CHANGE_REQUIRES_REVIEW','IDENTITY_CROSS_CANDIDATE_CONFLICT','SOURCE_TARGET_ALREADY_APPLIED','INVALID_SOURCE_REVISION']) {
    const message=library.getApiErrorMessage(new library.ApiRequestError('PRIVATE_CELL_VALUE',409,code),'Fallback');
    assert.notEqual(message,'Fallback');assert.equal(message.includes('PRIVATE_CELL_VALUE'),false);
  }
});
