import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { groupReviewActorId, identityGroupReviewFixture } from './fixtures/identity-group-review.mjs';

function harness(write) {
  const f=identityGroupReviewFixture();const slots=[],cleanup=[],calls=[],toasts=[],errors=[];let cursor=0,sequence=900;
  const clone=value=>globalThis.structuredClone(value);const modules={
    react:{useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef:initial=>{const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useCallback:callback=>callback,useEffect:effect=>{const i=cursor++;if(!(i in slots)){slots[i]=true;cleanup.push(effect());}}},
    '../../ui':{useRequestError:()=> (error,message)=>{errors.push(error);return message;},useToast:()=>({showToast:value=>toasts.push(value)})},
    './identity-group-review-model':{
      reserveIdentityGroupIntent:(batchId,actorId,plan,_original,requestId)=>({kind:'reserve',batchId,actorId,input:{requestId,planId:plan.planId,plan:clone(plan.request)}}),
      releaseIdentityGroupIntent:(batchId,actorId,review,note,requestId)=>({kind:'release',batchId,actorId,review:clone(review),input:{requestId,note:note.trim()}})
    },
    './identity-group-review-api':{identityGroupReviewNeedsRecovery:error=>error.unknown===true,writeIdentityGroupReview:async(intent,original)=>{calls.push({intent:clone(intent),original});return write(intent,f,calls.length);}}
  };
  const source=readFileSync(new URL('../src/features/imports/useIdentityGroupReviewMutation.ts',import.meta.url),'utf8'),exports={};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>{assert.ok(name in modules,name);return modules[name];},globalThis:{crypto:{randomUUID:()=> '00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0')}}});
  return{f,calls,toasts,errors,render:()=>{cursor=0;return exports.useIdentityGroupReviewMutation(f.plan.batchId,groupReviewActorId,f.original);},unmount:()=>cleanup.forEach(fn=>fn?.())};
}
test('reservation is explicit, single-flight and cannot repeat through an obsolete callback after a validated receipt',async()=>{
  let finish;const held=new Promise(r=>finish=r);const h=harness(async(_intent,f)=>{await held;return f.review;});const stale=h.render();assert.equal(h.calls.length,0);
  const request=stale.reserve(h.f.plan);await stale.reserve(h.f.plan);assert.equal(h.calls.length,1);assert.equal(h.render().busy,true);assert.equal(stale.submitting(),true);
  finish();await request;await stale.reserve(h.f.plan);assert.equal(h.calls.length,1);assert.ok(h.render().saved);assert.equal(h.toasts.length,1);assert.match(h.toasts[0].title,/Revisión reservada/);
});
test('unknown reservation freezes actor, UUID and body for explicit recovery; a recovered canceled receipt never claims an active reservation',async()=>{
  const h=harness(async(_intent,_f,n)=>{if(n===1)throw{unknown:true};return identityGroupReviewFixture(true).review;});await h.render().reserve(h.f.plan);
  assert.equal(h.calls.length,1);assert.equal(h.render().uncertain,true);assert.ok(h.render().requestId);assert.equal(h.toasts.length,0);
  h.f.plan.request.note='External change';h.render().reviewed();await h.render().recover();assert.deepEqual(h.calls[0].intent,h.calls[1].intent);assert.equal(h.calls[0].intent.actorId,groupReviewActorId);assert.match(h.toasts[0].title,/Revisión cancelada/);assert.ok(h.render().saved.release);
});
test('known rejection blocks stale callbacks and requires an independently reviewed new scenario before a new key',async()=>{
  const h=harness(async(_intent,f,n)=>{if(n===1)throw{unknown:false};return f.review;});const stale=h.render();await stale.reserve(h.f.plan);await stale.reserve(h.f.plan);assert.equal(h.calls.length,1);assert.equal(h.render().needsReview,true);
  h.f.plan.planId='e'.repeat(64);h.render().reviewed();await h.render().reserve(h.f.plan);assert.equal(h.calls.length,2);assert.notEqual(h.calls[0].intent.input.requestId,h.calls[1].intent.input.requestId);assert.equal(h.calls[1].intent.input.planId,'e'.repeat(64));
});
test('uncertain cancellation retains its exact reason and original receipt instead of reserving again or creating another key',async()=>{
  const h=harness(async(_intent,_f,n)=>{if(n===1)throw{unknown:true};return identityGroupReviewFixture(true).review;});await h.render().release(h.f.review,' Motivo confirmado ');
  assert.equal(h.render().uncertain,true);h.f.review.plan.request.note='Changed elsewhere';await h.render().recover();assert.deepEqual(h.calls[0].intent,h.calls[1].intent);assert.equal(h.calls[1].intent.kind,'release');assert.equal(h.calls[1].intent.input.note,'Motivo confirmado');assert.equal(h.toasts.length,1);
});
test('closing or session unmount cannot publish a late write or permit another mutation from an obsolete callback',async()=>{
  let finish;const held=new Promise(r=>finish=r);const h=harness(async(_intent,f)=>{await held;return f.review;});const stale=h.render();const pending=stale.reserve(h.f.plan);h.unmount();finish();assert.equal(await pending,undefined);await stale.recover();await stale.reserve(h.f.plan);assert.equal(h.calls.length,1);assert.equal(h.toasts.length,0);assert.equal(h.errors.length,0);
});
