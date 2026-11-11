import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function harness(select){
  const layout=[],effects=[],frames=new Map(),focused=[];let sequence=0;
  class Element{isConnected=true;owner=null;focus(options){focused.push({target:this,options});}}
  const dialog=new Element();dialog.open=false;dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};dialog.contains=target=>target.owner===dialog;
  const own=new Element();own.owner=dialog;const outside=new Element();const previous=new Element();const jsx=(type,props)=>({type,props});
  const modules={react:{useCallback:fn=>fn,useEffect:fn=>effects.push(fn),useLayoutEffect:fn=>layout.push(fn),useRef:value=>({current:value}),useId:()=> 'test-id',useState:value=>[value,()=>{}]},'react/jsx-runtime':{jsx,jsxs:jsx},'../utils':{cx:(...classes)=>classes.filter(Boolean).join(' ')}};
  const exports={};runInNewContext(ts.transpileModule(readFileSync(new URL('../src/ui/overlays/Dialog.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>{assert.ok(name in modules,name);return modules[name];},globalThis:{HTMLElement:Element,document:{activeElement:previous},scrollX:0,scrollY:240,scrollTo:()=>{},requestAnimationFrame:fn=>{const id=++sequence;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)}});
  const node=exports.Dialog({open:true,title:'Prueba',onClose:()=>{},children:null,initialFocus:select?()=>select({own,outside}):undefined});node.props.ref.current=dialog;const clean=layout.map(fn=>fn());effects.forEach(fn=>fn());
  return{dialog,own,focused,flush:()=>{for(const [id,fn]of frames){frames.delete(id);fn();}},cleanup:()=>clean.forEach(fn=>fn?.())};
}
test('canonical Dialog retains its default focus when no initial destination was requested',()=>{const h=harness();h.flush();assert.equal(h.focused.length,1);assert.equal(h.focused[0].target,h.dialog);assert.equal(h.focused[0].options.preventScroll,true);});
test('a connected return-row target inside Dialog receives the owned initial focus without scrolling the page',()=>{const h=harness(({own})=>own);h.flush();assert.equal(h.focused.length,1);assert.equal(h.focused[0].target,h.own);assert.equal(h.focused[0].options.preventScroll,true);});
test('outside and removed initial destinations fall back to the modal instead of escaping its focus boundary',()=>{for(const select of [({outside})=>outside,({own})=>{own.isConnected=false;return own;},()=>null]){const h=harness(select);h.flush();assert.equal(h.focused[0].target,h.dialog);}});
test('unmount cancels the pending initial focus and closes the native dialog',()=>{const h=harness(({own})=>own);h.cleanup();const before=h.focused.length;h.flush();assert.equal(h.focused.length,before);assert.equal(h.dialog.open,false);});
