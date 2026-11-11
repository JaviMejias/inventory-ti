import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { identityGroupProjectionFixture } from './fixtures/identity-group-projection.mjs';

class ApiError extends Error {constructor(message,status,code){super(message);this.status=status;this.code=code;}}
function harness(responder){
  const calls=[];const modules={};const loaded=new Map();
  modules['../../lib/api']={ApiRequestError:ApiError,apiRequest:async(path,options)=>{calls.push({path,options});options.signal.throwIfAborted();return responder(path,options);}};
  modules['./closed-assignment-model']={validHistoricalInstant:value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value.slice(0,10)};
  modules['./history-evidence-api']={sameSnapshot:(a,b)=>{const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));}};
  modules['./import-review-api']={importReviewPath:'/inventory/imports/batches'};
  modules['./source-review-api']={validSourceCell:value=>value===null||value&&typeof value==='object'&&typeof value.type==='string'&&'value'in value};
  function load(name){if(modules[name])return modules[name];if(loaded.has(name))return loaded.get(name);const exports={};loaded.set(name,exports);
    const source=readFileSync(new URL('../src/features/imports/'+name.slice(2)+'.ts',import.meta.url),'utf8');
    runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:load,globalThis,Date,Object,Map,Set,JSON});return exports;}
  return{api:load('./identity-group-projection-api'),calls};
}
for(const name of ['split','merge','repartition','numeric','scale'])test(name+' projection preserves complete original membership, stable group keys and current conflicts without write authority',()=>{
  const f=identityGroupProjectionFixture(name);const h=harness();
  for(const projection of [f.projection,f.changed,f.consumed]){
    const parsed=h.api.validateIdentityGroupProjection(projection,f.review);
    assert.equal(parsed.canApply,false);assert.equal(parsed.persisted,false);assert.equal(parsed.reviewPersisted,true);
    assert.equal(parsed.groups.length,f.review.plan.request.groups.length);assert.ok(Object.isFrozen(parsed.groups[0].observations));
    assert.equal(parsed.summary.observationCount,f.review.rows.length);assert.equal(parsed.projectionValidationComplete,parsed.blockers.length===0);
  }
  assert.deepEqual(f.projection.groups.map(g=>g.groupKey),f.changed.groups.map(g=>g.groupKey));
  assert.notEqual(f.projection.projectionId,f.changed.projectionId);assert.equal(f.changed.freshness.reviewSnapshotCurrent,false);
  assert.equal(f.changed.groups.some(g=>g.evidence.some(e=>e.capturedAssetId!==null&&e.currentAssetId===null)),true);
  assert.ok(f.consumed.blockers.some(row=>row.code==='SOURCE_OBSERVATION_ALREADY_APPLIED'));
});
test('a changed historical snapshot can still have a complete read-only projection; freshness never implies application authority',()=>{
  const f=identityGroupProjectionFixture();const value=globalThis.structuredClone(f.projection);
  value.asOf='2026-10-27';value.freshness.asOfChanged=true;value.freshness.reviewSnapshotCurrent=false;value.currentScenarioPlanId='f'.repeat(64);
  const parsed=harness().api.validateIdentityGroupProjection(value,f.review);assert.equal(parsed.projectionValidationComplete,true);assert.equal(parsed.canApply,false);
});
test('crossed owners, missing/duplicated membership, relinked evidence, forged flags and inconsistent counters fail visibly',()=>{
  const f=identityGroupProjectionFixture();const h=harness();
  const mutations=[v=>v.batchId=f.review.id,v=>v.reviewId=f.review.batchId,v=>v.sourceHash='b'.repeat(64),v=>v.reviewedPlanId='d'.repeat(64),
    v=>v.canApply=true,v=>v.persisted=true,v=>v.groupedPilotImplemented=true,v=>v.requiresNewDecisions=false,v=>v.projectionValidationComplete=true,
    v=>v.groups.pop(),v=>v.groups[1].groupKey=v.groups[0].groupKey,v=>v.groups[0].recordIds.push('f'.repeat(64)),v=>v.groups[0].observations.pop(),
    v=>v.groups[0].observations[0].originalCandidateId='f'.repeat(64),v=>v.groups[0].observations[0].reviewedIdentityCells.serialNumber.value='wrong',
    v=>v.groups[0].observations[0].currentIdentityCells.serialNumber.value='wrong',v=>v.groups[0].observations[0].originalIdentityCells.serialNumber.value='wrong',
    v=>v.groups[0].observations[0].groupKey='f'.repeat(64),v=>v.groups[0].evidence[0].linkedToGroup=true,v=>v.groups[0].evidence[0].currentAssetId=f.review.id,
    v=>v.groups[0].requiresNewDecision=false,v=>v.groups[0].originalDecisions=[],v=>v.impacts.evidence.push(v.impacts.evidence[0]),
    v=>v.freshness.batchVersionChanged=false,v=>v.summary.blockingCount++,v=>v.summary.observationCount++,v=>v.groups[0].candidates[0].hasMoreExistingAssets=false];
  for(const mutate of mutations){const value=globalThis.structuredClone(f.changed);mutate(value);assert.throws(()=>h.api.validateIdentityGroupProjection(value,f.review),e=>e.code==='INVALID_RESPONSE',String(mutate));}
});
test('numeric original cells and explicit null links survive; limited inventory matches are truthful',()=>{
  const f=identityGroupProjectionFixture('numeric');const parsed=harness().api.validateIdentityGroupProjection(f.changed,f.review);
  assert.equal(parsed.groups[0].observations[0].originalIdentityCells.serialNumber.type,'number');
  assert.equal(parsed.groups[0].evidence[0].currentAssetId,null);assert.notEqual(parsed.groups[0].evidence[0].capturedAssetId,null);
  const matches=parsed.groups[0].candidates[0];assert.equal(matches.existingAssets.length,10);assert.equal(matches.existingAssetCount,11);assert.equal(matches.hasMoreExistingAssets,true);
});
test('GET uses only the canonical V18 route, one deadline and cancellation, with no CSRF or data-bearing query',async()=>{
  const f=identityGroupProjectionFixture();const h=harness(()=>f.projection);const controller=new globalThis.AbortController();
  const result=await h.api.readIdentityGroupProjection(f.review,controller.signal);assert.equal(result.projectionId,f.projection.projectionId);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].path,'/inventory/imports/batches/'+f.review.batchId+'/identity-group-reviews/'+f.review.id+'/effective-preview');
  assert.deepEqual(Object.keys(h.calls[0].options),['signal']);controller.abort();assert.equal(h.calls[0].options.signal.aborted,true);
  const aborted=new globalThis.AbortController();aborted.abort();await assert.rejects(h.api.readIdentityGroupProjection(f.review,aborted.signal),{name:'AbortError'});
});
test('canceled or malformed review cannot start a read and API failures never turn into empty success',async()=>{
  const f=identityGroupProjectionFixture();const error=new ApiError('PRIVATE',409,'IDENTITY_GROUP_ALREADY_RELEASED');const h=harness(()=>{throw error;});
  for(const review of [{...f.review,release:{id:f.review.id}},{...f.review,id:'bad'}])await assert.rejects(h.api.readIdentityGroupProjection(review,new globalThis.AbortController().signal),e=>e.code==='VALIDATION_ERROR');
  assert.equal(h.calls.length,0);await assert.rejects(h.api.readIdentityGroupProjection(f.review,new globalThis.AbortController().signal),e=>e===error);
});
