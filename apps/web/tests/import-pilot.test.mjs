import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { batchId, pilotFixture } from './fixtures/import-pilot.mjs';
function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
}
const metadataUrl = moduleUrl('../src/features/home/inventory-metadata.ts');
const model = await import(moduleUrl('../src/features/imports/pilot-model.ts', {'../home/inventory-metadata':metadataUrl}));
const apiUrl = moduleUrl('../src/lib/api.ts', {'../config/environment':'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};'});
const reviewUrl = moduleUrl('../src/features/imports/import-review-api.ts', {'../../lib/api':apiUrl});
const pagingUrl = moduleUrl('../src/lib/pagination.ts', {'./api':apiUrl});
const sourceModelUrl = moduleUrl('../src/features/imports/source-review-model.ts');
const sourceApiUrl = moduleUrl('../src/features/imports/source-review-api.ts', {'../../lib/api':apiUrl,'./import-review-api':reviewUrl,'./source-review-model':sourceModelUrl});
const api = await import(moduleUrl('../src/features/imports/pilot-api.ts', {'../../lib/api':apiUrl,'../../lib/pagination':pagingUrl,'./import-review-api':reviewUrl,'./source-review-api':sourceApiUrl}));
async function respond(responses, operation) {
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return new globalThis.Response(JSON.stringify(responses.shift()),{status:200});};
  try{return await operation(calls);}finally{globalThis.fetch=original;}
}
test('only latest propose/link decisions offer an operational intent',()=>{
  assert.equal(model.operationType({action:'HOLD'}),null);
  assert.equal(model.operationType({action:'EXCLUDE'}),null);
  assert.equal(model.operationType({action:'PROPOSE_NEW'}),'CREATE_ASSET');
  assert.equal(model.operationType({action:'LINK_EXISTING',linkedAssetId:'asset'}),'UPDATE_METADATA');
});
test('create needs an explicit ASSET product, physical confirmation, identity and reason',()=>{
  const fixture=pilotFixture();
  assert.deepEqual(model.validatePilotOperation(fixture.request.operations[0],true,[fixture.product]),{});
  const invalid={...fixture.request.operations[0],note:'',values:{productId:'unknown'}};
  const errors=model.validatePilotOperation(invalid,false,[fixture.product]);
  for(const field of ['note','productId','serialNumber','confirmation']) assert.ok(errors[field]);
});
test('metadata intent distinguishes omitted fields from explicit null and empty selection',()=>{
  const operation={type:'UPDATE_METADATA',assetId:'linked-asset',note:'Borrar dato verificado',values:{sector:null}};
  assert.deepEqual(model.validatePilotOperation(operation,false,[]),{});
  assert.ok(model.validatePilotOperation({...operation,values:{}},false,[]).values);
  assert.equal(Object.hasOwn(operation.values,'location'),false);
  for(const key of ['productId','serialNumber','assetTag','status','personName']) assert.ok(model.validatePilotOperation({...operation,values:{[key]:'forbidden'}},false,[]).values);
});
test('captured request and apply intent do not change when editable drafts change',()=>{
  const fixture=pilotFixture();
  const request=model.requestForPilot({source:fixture.resolved},fixture.request.operations);
  const evaluated={request,plan:fixture.planFor(request)};
  const intent=model.captureApplyIntent(evaluated,'stable-request');
  request.operations[0].note='Another edit';
  fixture.request.operations[0].values.serialNumber='CHANGED';
  assert.equal(intent.plan.operations[0].note,'Equipo verificado');
  assert.equal(intent.plan.operations[0].values.serialNumber,'QA-001');
  assert.equal(intent.confirmation,'APPLY_ASSET_PILOT');
});
test('application requires its independent gate and complete current bounded plan, not canApply',()=>{
  const fixture=pilotFixture();
  const evaluated={request:fixture.request,plan:fixture.planFor()};
  assert.equal(model.canConfirmPilot(evaluated,false),false);
  assert.equal(model.canConfirmPilot(evaluated,true),true);
  for(const plan of [{...evaluated.plan,planValidationComplete:false},{...evaluated.plan,freshness:{stale:true}},{...evaluated.plan,sourceRevision:1},{...evaluated.plan,operations:[]},{...evaluated.plan,operations:Array(26).fill(evaluated.plan.operations[0])}]) assert.equal(model.canConfirmPilot({...evaluated,plan},true),false);
});
test('planning sends source version and CSRF without calling operational CRUD',async()=>{
  const fixture=pilotFixture();
  await respond([{csrfToken:'fixture-token'},fixture.planFor()],async(calls)=>{
    await api.generatePilotPlan(batchId,fixture.request);
    assert.equal(calls[1].options.body,JSON.stringify(fixture.request));
    assert.ok(calls[1].url.endsWith('/plan'));
    assert.equal(calls[1].options.headers.get('X-CSRF-Token'),'fixture-token');
  });
});
test('a malformed or differently versioned plan cannot reach confirmation',async()=>{
  const fixture=pilotFixture();
  for(const plan of [{}, {...fixture.planFor(),sourceRevision:1}, {...fixture.planFor(),batchId:'other'}]) await respond([{csrfToken:'token'},plan],()=>assert.rejects(api.generatePilotPlan(batchId,fixture.request),error=>error.code==='INVALID_RESPONSE'));
});
test('application recovery resends exactly the captured UUID and request; only APPLIED is success',async()=>{
  const fixture=pilotFixture();
  const intent=model.captureApplyIntent({request:fixture.request,plan:fixture.planFor()},'00000000-0000-4000-8000-000000000006');
  const receipt=fixture.receiptFor(intent);
  await respond([{csrfToken:'token'},{mode:'APPLIED',persisted:true,reused:true,application:receipt}],async(calls)=>{
    assert.equal((await api.applyPilot(batchId,intent)).id,receipt.id);
    assert.equal(calls[1].options.body,JSON.stringify(intent));
    assert.ok(calls[1].url.endsWith('/apply'));
  });
  await respond([{csrfToken:'token'},{mode:'PILOT_PLAN',persisted:false,application:receipt}],()=>assert.rejects(api.applyPilot(batchId,intent),error=>error.code==='INVALID_RESPONSE'));
});
test('receipt queries validate ownership and never confuse missing proof with success',async()=>{
  const fixture=pilotFixture();
  const receipt=fixture.receiptFor(model.captureApplyIntent({request:fixture.request,plan:fixture.planFor()},'request'));
  await respond([{mode:'APPLIED',persisted:true,application:{...receipt,batchId:'another'}}],()=>assert.rejects(api.readApplication(batchId,receipt.id,new globalThis.AbortController().signal),error=>error.code==='INVALID_RESPONSE'));
});

test('historical proof must match its plan, candidate and resulting asset',async()=>{
  const fixture=pilotFixture();
  const proof=fixture.receiptFor(model.captureApplyIntent({request:fixture.request,plan:fixture.planFor()},'request'));
  const malformed=[{...proof,plan:{...proof.plan,batchId:'other'}},{...proof,plan:{...proof.plan,planId:'f'.repeat(64)}},{...proof,items:[]},{...proof,items:[{...proof.items[0],result:{id:'other',status:'AVAILABLE'}}]},{...proof,items:[{...proof.items[0],candidateId:'other'}]}];
  for(const application of malformed) await respond([{mode:'APPLIED',persisted:true,application}],()=>assert.rejects(api.readApplication(batchId,proof.id,new globalThis.AbortController().signal),error=>error.code==='INVALID_RESPONSE'));
});

test('plan guards reject missing renderable fields, acknowledgements and mismatched summaries',async()=>{
  const fixture=pilotFixture();
  const plan=fixture.planFor();
  for(const malformed of [{...plan,summary:{}},{...plan,operations:[{...plan.operations[0],acknowledgedWarnings:null}]},{...plan,operations:[{...plan.operations[0],product:{id:'id'}}]}]) await respond([{csrfToken:'token'},malformed],()=>assert.rejects(api.generatePilotPlan(batchId,fixture.request),error=>error.code==='INVALID_RESPONSE'));
});
