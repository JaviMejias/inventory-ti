import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function harness({ read, save, capture } = {}) {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/workbook-intake.json',import.meta.url),'utf8'));
  const slots=[]; let cursor=0; const cleanup=[]; const calls=[]; const toasts=[]; const errors=[];
  const modules={
    react:{useState:(initial)=>{const index=cursor++; if(!(index in slots))slots[index]=initial;return[slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
      useRef:(initial)=>{const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
      useEffect:(effect)=>{const index=cursor++;if(!(index in slots)){slots[index]=true;cleanup.push(effect());}}},
    '../../ui':{useRequestError:()=>error=>{errors.push(error);return'Error localizado';},useToast:()=>({showToast:value=>toasts.push(value)})},
    './workbook-intake-model':{captureBatchIntake:(workbook,preview)=>{if(capture)return capture(workbook,preview);return globalThis.structuredClone({workbook,previewId:preview.previewId});}},
    './workbook-intake-api':{batchIntakeNeedsRecovery:error=>error.unknown===true,
      previewWorkbook:async(workbook,signal)=>{calls.push({kind:'read',workbook,signal});return read?read(workbook,signal,fixture):globalThis.structuredClone(fixture.preview);},
      createWorkbookBatch:async(intent,preview)=>{calls.push({kind:'save',intent:globalThis.structuredClone(intent),preview:globalThis.structuredClone(preview)});return save?save(intent,preview,fixture):{batch:{id:'confirmed'},reused:false};}}
  };
  const exports={}; const source=readFileSync(new URL('../src/features/imports/useWorkbookIntake.ts',import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,globalThis,require:name=>{assert.ok(name in modules,name);return modules[name];}});
  return {fixture,calls,toasts,errors,render:()=>{cursor=0;return exports.useWorkbookIntake();},unmount:()=>cleanup.forEach(fn=>fn?.())};
}
test('opening never reads or writes; reviewed preview is required and duplicate save is blocked synchronously',async()=>{
  let finish;const held=new Promise(resolve=>{finish=resolve;});
  const h=harness({save:async()=>{await held;return{batch:{id:'saved'},reused:false};}});const initial=h.render();
  assert.equal(h.calls.length,0);await initial.save(h.fixture.workbook);assert.equal(h.calls.length,0);
  await initial.generate(h.fixture.workbook);const hook=h.render();const pending=hook.save(h.fixture.workbook);await hook.save(h.fixture.workbook);
  assert.equal(h.calls.filter(row=>row.kind==='save').length,1);assert.equal(hook.submitting(),true);
  finish();await pending;await hook.save(h.fixture.workbook);assert.equal(h.toasts.length,1);assert.ok(h.render().saved);assert.equal(hook.blocked(),true);
});
test('unknown outcomes preserve exactly the same source and preview despite later draft changes',async()=>{
  let attempt=0;const h=harness({save:async()=>{if(!attempt++)throw{unknown:true};return{batch:{id:'saved'},reused:true};}});
  await h.render().generate(h.fixture.workbook);await h.render().save(h.fixture.workbook);
  const uncertain=h.render();assert.equal(uncertain.uncertain,true);uncertain.clear();await uncertain.generate(h.fixture.workbook);
  h.fixture.workbook.source.fileName='otro.xlsx';h.fixture.preview.previewId='f'.repeat(64);
  await uncertain.save();const writes=h.calls.filter(row=>row.kind==='save');assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
  assert.equal(h.calls.filter(row=>row.kind==='read').length,1);assert.equal(h.render().uncertain,false);assert.equal(h.toasts[0].title,'Lote recuperado');
});
test('known stale result requires explicit new preview even through old callbacks',async()=>{
  let attempt=0;const h=harness({save:async()=>{if(!attempt++)throw{unknown:false};return{batch:{id:'saved'},reused:false};}});
  const old=h.render();await old.generate(h.fixture.workbook);await old.save(h.fixture.workbook);await old.save(h.fixture.workbook);
  assert.equal(h.calls.filter(row=>row.kind==='save').length,1);assert.equal(h.render().needsPreview,true);
  await h.render().generate(h.fixture.workbook);await h.render().save(h.fixture.workbook);assert.ok(h.render().saved);
});
test('cancel and clear discard late read responses without making an automatic replacement request',async()=>{
  let finish;const held=new Promise(resolve=>{finish=resolve;});const h=harness({read:async(_workbook,_signal,fixture)=>{await held;return fixture.preview;}});
  const old=h.render();const pending=old.generate(h.fixture.workbook);old.clear();finish();await pending;
  assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.render().preview,null);assert.equal(h.render().reading,false);assert.equal(h.calls.length,1);
});
test('failed regeneration retains prior analysis as stale and prevents save',async()=>{
  let attempt=0;const h=harness({read:async(_workbook,_signal,fixture)=>{if(attempt++)throw Error('private');return fixture.preview;}});
  await h.render().generate(h.fixture.workbook);await h.render().generate(h.fixture.workbook);
  assert.ok(h.render().preview);assert.equal(h.render().needsPreview,true);await h.render().save(h.fixture.workbook);
  assert.equal(h.calls.filter(row=>row.kind==='save').length,0);assert.equal(h.errors.length,1);
});
test('oversized captured wrapper is reported rather than escaping as an unhandled rejection',async()=>{
  const h=harness({capture:()=>{throw Error('too large');}});await h.render().generate(h.fixture.workbook);await h.render().save(h.fixture.workbook);
  assert.equal(h.render().busy,false);assert.equal(h.errors.length,1);assert.equal(h.calls.filter(row=>row.kind==='save').length,0);
});
test('late write and detached callbacks never publish a receipt, toast or new request after unmount',async()=>{
  let finish;const held=new Promise(resolve=>{finish=resolve;});const h=harness({save:async()=>{await held;return{batch:{id:'saved'},reused:false};}});
  const old=h.render();await old.generate(h.fixture.workbook);const pending=old.save(h.fixture.workbook);h.unmount();finish();assert.equal(await pending,undefined);
  await old.save(h.fixture.workbook);await old.generate(h.fixture.workbook);assert.equal(h.calls.length,2);assert.equal(h.toasts.length,0);
});
