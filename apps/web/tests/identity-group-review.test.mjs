import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { groupReleaseRequestId, groupReviewActorId, groupReviewId, groupReviewMetadata, groupReviewRequestId, identityGroupReviewFixture } from './fixtures/identity-group-review.mjs';

class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
function harness(responder, csrf) {
  const requests = []; const tokens = []; const modules = {}; const loaded = new Map();
  modules['../../lib/api'] = { ApiRequestError: ApiError, apiRequest: async (path, options) => { requests.push({ path, options }); return responder(path, options); }, getCsrfToken: async signal => { tokens.push(signal); if (csrf) await csrf(); return 'synthetic'; } };
  modules['./closed-assignment-model'] = { validHistoricalInstant: value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) };
  modules['./history-evidence-api'] = { sameSnapshot: (a, b) => { const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v; return JSON.stringify(canonical(a))===JSON.stringify(canonical(b)); } };
  modules['./import-review-api'] = {}; modules['./source-review-api'] = { validSourceCell: value => value===null||value&&typeof value==='object'&&typeof value.type==='string' };
  function load(name) { if (modules[name]) return modules[name]; if (loaded.has(name)) return loaded.get(name); const exports={}; loaded.set(name,exports);
    const source=readFileSync(new URL('../src/features/imports/'+name.slice(2)+'.ts',import.meta.url),'utf8');
    runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:load,globalThis:{structuredClone:globalThis.structuredClone,AbortSignal:globalThis.AbortSignal},Object,Date,Map,Set,JSON});return exports; }
  return { api: load('./identity-group-review-api'), model: load('./identity-group-review-model'), requests, tokens };
}
test('reservation freezes only the exact V16 request and planId; blocked plans and invalid ownership cannot form intents',()=>{
  const f=identityGroupReviewFixture();const h=harness();const intent=h.model.reserveIdentityGroupIntent(f.plan.batchId,groupReviewActorId,f.plan,f.original,groupReviewRequestId.toUpperCase());
  assert.equal(intent.input.requestId,groupReviewRequestId);assert.ok(Object.isFrozen(intent.input.plan.groups[0].recordIds));assert.deepEqual(globalThis.structuredClone(intent.input.plan),f.input);assert.equal(intent.input.plan.scope,undefined);
  f.plan.request.note='Mutated externally';assert.notEqual(intent.input.plan.note,f.plan.request.note);
  const blocked=identityGroupReviewFixture();blocked.plan.blockers.push({code:'QA'});blocked.plan.summary.blockingCount=1;blocked.plan.proposalValidationComplete=false;
  assert.throws(()=>h.model.reserveIdentityGroupIntent(f.plan.batchId,groupReviewActorId,blocked.plan,blocked.original,groupReviewRequestId));
  assert.throws(()=>h.model.reserveIdentityGroupIntent(f.plan.batchId,'bad',f.plan,f.original,groupReviewRequestId));
});
test('active and released receipts bind the immutable plan, every original row and administrative release without operational effects',()=>{
  const h=harness();for(const released of [false,true]){const f=identityGroupReviewFixture(released);const saved=h.api.validateIdentityGroupReview(f.receipt,f.plan.batchId,f.original,{id:groupReviewId});assert.equal(Boolean(saved.release),released);assert.ok(saved.rows.every(row=>row.isReserved===!released));assert.ok(Object.isFrozen(saved.rows[0].snapshot));}
  const f=identityGroupReviewFixture();const intent=h.model.reserveIdentityGroupIntent(f.plan.batchId,groupReviewActorId,f.plan,f.original,groupReviewRequestId);const recovered=identityGroupReviewFixture(true);recovered.receipt.reused=true;assert.ok(h.api.validateIdentityGroupReview(recovered.receipt,f.plan.batchId,f.original,{intent}).release,'Recovery must accept cancellation without re-reserving');
});
test('forged scope, parent, actor, row coverage, snapshots, current reservation state and crossed release fail visibly',()=>{
  const f=identityGroupReviewFixture();const h=harness();const intent=h.model.reserveIdentityGroupIntent(f.plan.batchId,groupReviewActorId,f.plan,f.original,groupReviewRequestId);
  const mutations=[v=>v.affectsCurrentState=true,v=>v.persisted=false,v=>v.review.batchId=groupReviewId,v=>v.review.reviewedById=groupReviewId,v=>v.review.rows.pop(),v=>v.review.rows[0].snapshot.row++,v=>v.review.rows[0].isReserved=false,v=>v.review.planId='f'.repeat(64),v=>v.review.plan.request.note='Changed',v=>v.review.internal='private',v=>v.reused='yes'];
  for(const mutate of mutations){const value=globalThis.structuredClone(f.receipt);mutate(value);assert.throws(()=>h.api.validateIdentityGroupReview(value,f.plan.batchId,f.original,{intent}),e=>e.code==='INVALID_RESPONSE');}
  const released=identityGroupReviewFixture(true);released.receipt.review.release.reviewId=groupReviewActorId;assert.throws(()=>h.api.validateIdentityGroupReview(released.receipt,f.plan.batchId,f.original));
});
test('release intent requires a reason; a confirmed release cannot rewrite the snapshot or use another actor/key',()=>{
  const f=identityGroupReviewFixture();const done=identityGroupReviewFixture(true);const h=harness();const intent=h.model.releaseIdentityGroupIntent(f.plan.batchId,groupReviewActorId,f.review,' '+done.review.release.note+' ',groupReleaseRequestId);
  assert.ok(h.api.validateIdentityGroupReview(done.receipt,f.plan.batchId,f.original,{intent}).release);assert.equal(intent.input.note,done.review.release.note);
  for(const note of ['', 'x'.repeat(2001)])assert.throws(()=>h.model.releaseIdentityGroupIntent(f.plan.batchId,groupReviewActorId,f.review,note,groupReleaseRequestId));
  assert.throws(()=>h.model.releaseIdentityGroupIntent(f.plan.batchId,groupReviewActorId,done.review,'Again',groupReleaseRequestId));
  for(const mutate of [v=>v.review.release.releasedById=groupReviewId,v=>v.review.release.note='Changed',v=>v.review.requestDigest='a'.repeat(64),v=>v.review.rows[0].groupId=groupReviewActorId]){const value=globalThis.structuredClone(done.receipt);mutate(value);assert.throws(()=>h.api.validateIdentityGroupReview(value,f.plan.batchId,f.original,{intent}));}
});
test('metadata pages25 then2 exclude plan/rows; bad limits, totals, duplicates and privacy leaks never become empty success',async()=>{
  const f=identityGroupReviewFixture();const rows=Array.from({length:27},(_,i)=>({...groupReviewMetadata(f.review),id:'00000000-0000-4000-8000-'+String(i+700).padStart(12,'0')}));let bad=false;
  const h=harness(path=>{const offset=Number(new globalThis.URL('https://synthetic.test'+path).searchParams.get('offset'));return{...f.flags,reviews:bad?[{...rows[0],plan:f.plan}]:rows.slice(offset,offset+25),total:27,limit:25,offset,hasMore:offset+25<27};});
  assert.equal((await h.api.readIdentityGroupReviews(f.plan.batchId,0,new globalThis.AbortController().signal)).items.length,25);assert.equal((await h.api.readIdentityGroupReviews(f.plan.batchId,25,new globalThis.AbortController().signal)).items.length,2);bad=true;await assert.rejects(h.api.readIdentityGroupReviews(f.plan.batchId,0,new globalThis.AbortController().signal),e=>e.code==='INVALID_RESPONSE');
});
test('explicit reserve/release use CSRF and one deadline, detach body before awaiting and never submit an apply or operational endpoint',async()=>{
  const f=identityGroupReviewFixture();let releaseCsrf;const wait=new Promise(r=>releaseCsrf=r);const h=harness(()=>f.receipt,()=>wait);const intent=h.model.reserveIdentityGroupIntent(f.plan.batchId,groupReviewActorId,f.plan,f.original,groupReviewRequestId);const mutable=globalThis.structuredClone(intent);
  const save=h.api.writeIdentityGroupReview(mutable,f.original);mutable.input.plan.note='External mutation';releaseCsrf();const saved=await save;assert.equal(saved.id,groupReviewId);assert.equal(h.requests.length,1);assert.equal(h.tokens[0],h.requests[0].options.signal);assert.equal(JSON.parse(h.requests[0].options.body).plan.note,f.input.note);assert.match(h.requests[0].path,/\/identity-group-reviews$/);
  const done=identityGroupReviewFixture(true);const r=harness(()=>done.receipt);await r.api.writeIdentityGroupReview(r.model.releaseIdentityGroupIntent(f.plan.batchId,groupReviewActorId,f.review,done.review.release.note,groupReleaseRequestId),f.original);assert.match(r.requests[0].path,/\/identity-group-reviews\/.*\/release$/);assert.deepEqual(Object.keys(JSON.parse(r.requests[0].options.body)).sort(),['confirmation','note','requestId']);
  assert.ok([...h.requests,...r.requests].every(c=>!c.path.includes('/apply')&&!c.path.includes('/assets/')));
});
test('read errors and cancellation remain errors, while uncertain write classifications preserve the same attempt',async()=>{
  const f=identityGroupReviewFixture();const fail=new ApiError('PRIVATE',503,'IMPORT_REVIEW_NOT_READY');const h=harness(()=>{throw fail;});await assert.rejects(h.api.readIdentityGroupReview(f.plan.batchId,groupReviewId,f.original,new globalThis.AbortController().signal),e=>e===fail);
  for(const error of [fail,new Error('Lost'),new ApiError('Bad',200,'INVALID_RESPONSE'),new ApiError('Busy',409,'IDENTITY_GROUP_REVIEW_BUSY')])assert.equal(h.api.identityGroupReviewNeedsRecovery(error),true);
  for(const code of ['IDENTITY_GROUP_PLAN_CHANGED','IDENTITY_GROUP_ALREADY_RELEASED','REVIEW_VERSION_CONFLICT','FORBIDDEN'])assert.equal(h.api.identityGroupReviewNeedsRecovery(new ApiError('PRIVATE',409,code)),false);
});
test('invalid mutation envelopes and extra fields fail before requesting CSRF or performing a write',async()=>{
  const f=identityGroupReviewFixture();const h=harness(()=>f.receipt);const valid=h.model.reserveIdentityGroupIntent(f.plan.batchId,groupReviewActorId,f.plan,f.original,groupReviewRequestId);
  for(const intent of [null,{...valid,kind:'apply'},{...valid,input:{...valid.input,proof:f.plan}},{kind:'release',batchId:f.plan.batchId,actorId:groupReviewActorId,input:{requestId:groupReleaseRequestId,note:'Reason',confirmation:'RELEASE_IDENTITY_GROUP_REVIEW_ONLY'},review:null}])await assert.rejects(h.api.writeIdentityGroupReview(intent,f.original),e=>e.code==='VALIDATION_ERROR');
  assert.equal(h.tokens.length,0);assert.equal(h.requests.length,0);
});
