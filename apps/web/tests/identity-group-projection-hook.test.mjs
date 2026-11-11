import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { identityGroupProjectionFixture } from './fixtures/identity-group-projection.mjs';

function harness(read){
  const fixture=identityGroupProjectionFixture();const slots=[];const effects=[];const calls=[];const errors=[];let cursor=0;
  const report=error=>{errors.push(error);return'Error localizado';};
  const same=(a,b)=>a&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
  const modules={
    react:{useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
      useRef:initial=>{const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
      useCallback:(callback,deps)=>{const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={deps,callback};return slots[i].callback;},
      useEffect:(callback,deps=[])=>{const i=cursor++;if(!same(slots[i]?.deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:callback()};});}},
    '../../ui':{useRequestError:()=>report},
    './identity-group-projection-api':{readIdentityGroupProjection:async(review,signal)=>{calls.push({review,signal});return read?read(fixture,signal):fixture.projection;}}
  };
  const exports={};const source=readFileSync(new URL('../src/features/imports/useIdentityGroupProjection.ts',import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>{assert.ok(name in modules,name);return modules[name];},globalThis});
  return{fixture,calls,errors,render:(open=true)=>{cursor=0;const value=exports.useIdentityGroupProjection(fixture.review,open);while(effects.length)effects.shift()();return value;},unmount:()=>slots.forEach(slot=>slot?.cleanup?.())};
}
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
test('entering the consultation starts one read; duplicate refresh is synchronously blocked',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});const h=harness(async f=>{await held;return f.projection;});
  const old=h.render();await old.refresh();assert.equal(h.calls.length,1);assert.equal(h.render().reading,true);
  release();await settle();assert.equal(h.render().fresh,true);assert.equal(h.render().reading,false);assert.ok(h.render().data);
});
test('failed refresh keeps previous projection unconfirmed with one Spanish error and an explicit retry',async()=>{
  let count=0;const h=harness(async f=>{if(count++===1)throw Error('PRIVATE');return count>2?f.changed:f.projection;});
  h.render();await settle();const first=h.render().data;await h.render().refresh();const failed=h.render();
  assert.equal(failed.data,first);assert.equal(failed.fresh,false);assert.equal(failed.error,'Error localizado');assert.equal(h.errors.length,1);
  await failed.refresh();assert.equal(h.render().fresh,true);assert.equal(h.render().data.projectionId,h.fixture.changed.projectionId);assert.equal(h.calls.length,3);
});
test('closing aborts a read; late responses and old refresh callbacks cannot reopen it',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});const h=harness(async f=>{await held;return f.projection;});
  const old=h.render();h.render(false);assert.equal(h.calls[0].signal.aborted,true);release();await settle();await old.refresh();
  assert.equal(h.render(false).data,null);assert.equal(h.render(false).fresh,false);assert.equal(h.render(false).reading,false);assert.equal(h.calls.length,1);
});
test('unmount prevents late error/result feedback and detached reads',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});const h=harness(async()=>{await held;throw Error('PRIVATE');});
  const old=h.render();h.unmount();release();await settle();await old.refresh();assert.equal(h.errors.length,0);assert.equal(h.calls.length,1);assert.equal(h.calls[0].signal.aborted,true);
});
test('a closed consultation never reads; reopening makes a new cancelable request',async()=>{
  const h=harness();h.render(false);assert.equal(h.calls.length,0);h.render(true);await settle();assert.equal(h.calls.length,1);assert.equal(h.render().fresh,true);
  h.render(false);h.render(true);await settle();assert.equal(h.calls.length,2);assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.render().fresh,true);
});
