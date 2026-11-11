import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { identityGroupReviewFixture } from './fixtures/identity-group-review.mjs';

const stub=()=>null;
function render(review){const exports={},jsx=(type,props,key)=>({type,props,key});const modules={'react/jsx-runtime':{jsx,jsxs:jsx},'../../ui':{Badge:stub},'../../lib/date-range':{formatInventoryDateTime:value=>value},'./IdentityGroupPlanDetails':{IdentityGroupPlanDetails:stub}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/imports/IdentityGroupReviewDetails.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>{assert.ok(name in modules,name);return modules[name];}});return exports.IdentityGroupReviewDetails({review});}
function nodes(node){return !node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(2).flatMap(nodes)];}
function text(node){return nodes(node).flatMap(n=>[n.props?.children].flat(2)).filter(v=>typeof v==='string'||typeof v==='number').join(' ');}
test('a saved review exposes administrative time, recorder and active reservation without claiming operational application',()=>{
  const f=identityGroupReviewFixture();const tree=render(f.review),copy=text(tree);assert.match(copy,/Reserva activa/);assert.match(copy,/sin aplicar al inventario/);assert.match(copy,/Registro administrativo/);assert.ok(copy.includes(f.review.createdAt));assert.ok(copy.includes(f.review.reviewedById));assert.match(copy,/no crea activos/);assert.equal(nodes(tree).some(n=>['input','button','select'].includes(n.type)),false);
});
test('a cancellation keeps its reason, immutable event and actor distinct from the original reviewer',()=>{
  const f=identityGroupReviewFixture(true);f.review.release.releasedById='00000000-0000-4000-8000-000000000999';const tree=render(f.review),copy=text(tree);assert.match(copy,/Reserva cancelada/);assert.ok(copy.includes(f.review.release.note));assert.ok(copy.includes(f.review.release.id));assert.ok(copy.includes(f.review.release.releasedById));assert.ok(copy.includes(f.review.reviewedById));assert.match(copy,/grupos abandonados no sustituyen al origen/);
});
test('receipt renders the shared V16 details in an explicit archived variant without rewriting historical readonly flags',()=>{
  const f=identityGroupReviewFixture();const tree=render(f.review);const details=nodes(tree).find(n=>n.props?.plan);assert.equal(details.props.archived,true);assert.equal(details.props.plan,f.review.plan);assert.equal(details.props.plan.persisted,false);assert.equal(details.props.plan.canApply,false);assert.equal(details.props.plan.lineagePersistenceImplemented,false);
});
