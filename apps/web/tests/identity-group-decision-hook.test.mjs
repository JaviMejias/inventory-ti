import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decisionDraft, decisionUuid, groupDecisionFixture } from './fixtures/identity-group-decision.mjs';

function hooks(extra={}) {
  const slots=[],effects=[],errors=[],toasts=[];let cursor=0,sequence=8000;
  const same=(a,b)=>a&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));const report=error=>{errors.push(error);return'Error en español';};
  const modules={react:{useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef:initial=>{const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useCallback:(callback,deps)=>{const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={deps,callback};return slots[i].callback;},useEffect:(callback,deps=[])=>{const i=cursor++;if(!same(slots[i]?.deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:callback()};});}},'../../ui':{useRequestError:()=>report,useToast:()=>({showToast:value=>toasts.push(value)})},...extra};
  function load(name){const exports={};runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/imports/'+name+'.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>{assert.ok(name in modules,name);return modules[name];},globalThis:{...globalThis,AbortController:globalThis.AbortController,structuredClone:globalThis.structuredClone,crypto:{randomUUID:()=>decisionUuid(++sequence)}}});return exports;}
  return{load,errors,toasts,render:fn=>{cursor=0;const result=fn();while(effects.length)effects.shift()();return result;},unmount:()=>slots.forEach(slot=>slot?.cleanup?.())};
}
function mutation(write){const f=groupDecisionFixture(),calls=[];const h=hooks({
  './identity-group-decision-api':{captureGroupDecisionIntent:value=>globalThis.structuredClone(value),groupDecisionNeedsRecovery:error=>error.unknown===true,writeGroupDecision:async intent=>{calls.push(globalThis.structuredClone(intent));return write(intent,f,calls.length);}},
  './identity-group-decision-model':{groupDecisionInput:(context,groupKey,draft,requestId)=>({...f.input,requestId,groupKey,note:draft.note,expectedDecisionVersion:context.latest.decisionVersion})}
});const component=h.load('useGroupDecisionMutation').useGroupDecisionMutation;return{...h,f,calls,render:()=>h.render(()=>component(f.review,f.review.reviewedById))};}
const save=(h,value=h.render())=>value.save(h.f.context,h.f.input.groupKey,decisionDraft(h.f));
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
test('decision save is explicit and single-flight; a successful receipt blocks obsolete callbacks',async()=>{
  let release;const held=new Promise(resolve=>release=resolve);const h=mutation(async(_intent,f)=>{await held;return f.receipt;});const old=h.render();assert.equal(h.calls.length,0);const pending=save(h,old);await save(h,old);assert.equal(h.calls.length,1);assert.equal(old.submitting(),true);assert.equal(h.render().busy,true);
  release();await pending;await save(h,old);assert.equal(h.calls.length,1);assert.ok(h.render().saved);assert.equal(h.toasts.length,1);
});
test('lost response retains original actor, key, evidence, versions and body even after draft/context mutation',async()=>{
  const h=mutation(async(_intent,f,n)=>{if(n===1)throw{unknown:true};return{...f.receipt,reused:true};});await save(h);const key=h.render().requestId;assert.equal(h.render().uncertain,true);h.f.context.latest.decisionVersion=19;h.f.input.note='External change';h.render().reviewed();await h.render().save();
  assert.deepEqual(h.calls[0],h.calls[1]);assert.equal(h.calls[1].input.requestId,key);assert.equal(h.calls[1].actorId,h.f.review.reviewedById);assert.equal(h.toasts.length,1);assert.equal(h.render().uncertain,false);
});
test('known conflicts invalidate old callbacks until a freshly reviewed context, then use a new key',async()=>{
  const h=mutation(async(_intent,f,n)=>{if(n===1)throw{unknown:false};return f.receipt;});const old=h.render();await save(h,old);await save(h,old);assert.equal(h.calls.length,1);assert.equal(h.render().needsContext,true);h.f.context.latest.decisionVersion=7;h.render().reviewed();await save(h);
  assert.equal(h.calls.length,2);assert.notEqual(h.calls[0].input.requestId,h.calls[1].input.requestId);assert.equal(h.calls[1].input.expectedDecisionVersion,7);
});
test('unmount cannot publish a late receipt/toast or perform another detached mutation',async()=>{
  let release;const held=new Promise(resolve=>release=resolve);const h=mutation(async(_intent,f)=>{await held;return f.receipt;});const old=h.render();const pending=save(h,old);h.unmount();release();assert.equal(await pending,undefined);await save(h,old);assert.equal(h.calls.length,1);assert.equal(h.toasts.length,0);assert.equal(h.errors.length,0);
});
function context(read){const f=groupDecisionFixture(),calls=[];const h=hooks({'./identity-group-decision-api':{readGroupDecisionContext:async(review,signal,initial)=>{calls.push({review,signal,initial});return read(f,signal,calls.length);}}});const component=h.load('useGroupDecisionContext').useGroupDecisionContext;return{...h,f,calls,render:(open=true)=>h.render(()=>component(f.review,f.projection,open))};}
test('context entry checks latest version against the supplied V18 snapshot; explicit refresh reads a new projection and cannot duplicate',async()=>{
  let release;const held=new Promise(resolve=>release=resolve);const h=context(async(f,_s,n)=>{if(n===1)await held;return f.context;});const old=h.render();await old.refresh();assert.equal(h.calls.length,1);assert.equal(h.calls[0].initial,h.f.projection);release();await settle();assert.equal(h.render().fresh,true);await h.render().refresh();assert.equal(h.calls.length,2);assert.equal(h.calls[1].initial,undefined);
});
test('failed context refresh preserves data but removes authority until an explicit successful retry',async()=>{
  const h=context(async(f,_s,n)=>{if(n===2)throw Error('PRIVATE');return f.context;});h.render();await settle();const first=h.render().data;await h.render().refresh();assert.equal(h.render().data,first);assert.equal(h.render().fresh,false);assert.equal(h.render().error,'Error en español');assert.equal(h.errors.length,1);await h.render().refresh();assert.equal(h.render().fresh,true);
});
test('closed contexts do not read; closing aborts and blocks obsolete callbacks or late results',async()=>{
  let release;const held=new Promise(resolve=>release=resolve);const h=context(async f=>{await held;return f.context;});h.render(false);assert.equal(h.calls.length,0);const old=h.render(true);h.render(false);assert.equal(h.calls[0].signal.aborted,true);release();await settle();await old.refresh();assert.equal(h.calls.length,1);assert.equal(h.render(false).data,null);assert.equal(h.render(false).fresh,false);
});
test('unmounted context never reports a late failure and cannot start another request',async()=>{
  let release;const held=new Promise(resolve=>release=resolve);const h=context(async()=>{await held;throw Error('PRIVATE');});const old=h.render();h.unmount();release();await settle();await old.refresh();assert.equal(h.errors.length,0);assert.equal(h.calls.length,1);assert.equal(h.calls[0].signal.aborted,true);
});
