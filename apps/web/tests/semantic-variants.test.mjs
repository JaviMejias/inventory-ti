import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(path) {
  const source = readFileSync(new URL(path,import.meta.url),'utf8'); const exports = {};
  const jsx = (type,props) => ({type,props});
  const compiled = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const modules = { '../utils':{cx:(...args)=>args.filter(Boolean).join(' ')},'react/jsx-runtime':{jsx,jsxs:jsx} };
  runInNewContext(compiled,{exports,require:(name)=>{assert.ok(name in modules,name);return modules[name];}});
  return {source,exports};
}
test('every Alert semantic variant uses a literal Tailwind-detectable class and correct live-region role',()=>{
  const {source,exports}=load('../src/ui/feedback/Alert.tsx');
  for(const variant of ['info','success','warning','danger']) {
    assert.ok(source.includes("'ui-alert-"+variant+"'"));
    const node=exports.Alert({variant,children:'Mensaje'}); assert.equal(node.props.className,'ui-alert ui-alert-'+variant); assert.equal(node.props.role,variant==='danger'?'alert':'status');
  }
});
test('every Badge semantic variant is preserved in generated CSS instead of relying on dynamic class interpolation',()=>{
  const {source,exports}=load('../src/ui/primitives/Badge.tsx');
  for(const variant of ['default','info','success','warning','danger','neutral']) {
    assert.ok(source.includes("'ui-badge-"+variant+"'")); assert.equal(exports.Badge({variant,children:'Estado'}).props.className,'ui-badge ui-badge-'+variant);
  }
});

test('canonical Alert preserves readable message width and wrapping touch actions in narrow containers',()=>{
  const styles=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
  assert.match(styles,/\.ui-alert \{[^}]*flex-wrap/);
  assert.match(styles,/\.ui-alert-content \{[^}]*basis-48[^}]*overflow-wrap: anywhere/);
  assert.match(styles,/\.ui-alert-action \{[^}]*max-w-full[^}]*flex-wrap/);
  assert.match(styles,/\.ui-alert-action \.ui-button \{[^}]*min-height: 2\.75rem[^}]*white-space: normal/);
});
