import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { batchId } from './fixtures/import-pilot.mjs';
import { catalogFixture } from './fixtures/import-catalog.mjs';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url),'utf8');
  for (const [specifier,url] of Object.entries(imports)) source = source.replaceAll("'"+specifier+"'",JSON.stringify(url));
  return 'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
}
const apiUrl = moduleUrl('../src/lib/api.ts',{'../config/environment':'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};'});
const reviewUrl = moduleUrl('../src/features/imports/import-review-api.ts',{'../../lib/api':apiUrl});
const api = await import(moduleUrl('../src/features/imports/catalog-review-api.ts',{'../../lib/api':apiUrl,'./import-review-api':reviewUrl}));
const errors = await import(apiUrl);
async function respond(value, operation, status = 200) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async(url,options) => {calls.push({url,options});return new globalThis.Response(JSON.stringify(value),{status});};
  try {return await operation(calls);} finally {globalThis.fetch = original;}
}
const signal = () => new globalThis.AbortController().signal;
test('catalog consult is read-only, bounded to the selected candidate with no automatic choice',async()=>{
  const fixture = catalogFixture(); const original = globalThis.structuredClone({page:fixture.page,target:fixture.target,request:fixture.request});
  await respond(fixture.page,async(calls)=>{
    const result = await api.readCatalogSuggestion(batchId,fixture.target,signal());
    assert.equal(result.requiresExplicitChoice,true); assert.equal(result.matchCount,1);
    assert.match(calls[0].url,/catalog-review\?limit=1&offset=0$/);
    assert.equal(calls[0].options.body,undefined); assert.equal(calls[0].options.method,undefined);
    assert.ok(calls[0].options.signal instanceof globalThis.AbortSignal);
  });
  assert.deepEqual({page:fixture.page,target:fixture.target,request:fixture.request},original);
});
test('candidate pages use the real offset, total and server ordering',async()=>{
  const fixture = catalogFixture(); const target = {...fixture.target,offset:25,total:27};
  await respond({...fixture.page,offset:25,total:27,hasMore:true},async()=>assert.equal((await api.readCatalogSuggestion(batchId,target,signal())).candidateId,target.candidateId));
  for (const patch of [{offset:0},{total:26},{hasMore:false},{candidates:[]}]) await respond({...fixture.page,offset:25,total:27,hasMore:true,...patch},()=>assert.rejects(api.readCatalogSuggestion(batchId,target,signal()),{code:'INVALID_RESPONSE'}));
});
test('catalog revision mismatch is a refreshable conflict, never accepted as current',async()=>{
  const fixture = catalogFixture();
  await respond({...fixture.page,sourceRevision:1},()=>assert.rejects(api.readCatalogSuggestion(batchId,fixture.target,signal()),{code:'SOURCE_REVISION_CONFLICT'}));
});
test('wrong owner, candidate, provenance, mutable response or malformed product are rejected',async()=>{
  const fixture = catalogFixture();
  for (const mutate of [
    (page)=>{page.batchId='other';},(page)=>{page.canApply=true;},(page)=>{page.sourceRevision=-1;},
    (page)=>{page.candidates[0].candidateId='other';},(page)=>{page.candidates[0].requiresExplicitChoice=false;},
    (page)=>{page.candidates[0].source[0].row=5;},(page)=>{page.candidates[0].source[0].recordId='other';},
    (page)=>{page.candidates[0].suggestedProducts[0].updatedAt='unknown';},(page)=>{page.candidates[0].suggestedProducts[0].brand=12;},
    (page)=>{page.candidates[0].suggestedProducts[0].name='';},
    (page)=>{page.candidates[0].attributes.unexpected=null;}
  ]) {
    const page=globalThis.structuredClone(fixture.page); mutate(page);
    await respond(page,()=>assert.rejects(api.readCatalogSuggestion(batchId,fixture.target,signal()),{code:'INVALID_RESPONSE'}));
  }
});
test('conflicting or missing attributes yield no suggestions, not an empty full catalog',async()=>{
  const fixture = catalogFixture();
  for (const attributes of [{equipmentType:[],brand:['A','B'],model:[]},{equipmentType:[],brand:[],model:[]}]) {
    const candidate={...fixture.suggestion,attributes,conflict:attributes.brand.length>1,hasEvidence:attributes.brand.length>0,matchCount:0,suggestedProducts:[]};
    await respond({...fixture.page,candidates:[candidate]},async()=>assert.equal((await api.readCatalogSuggestion(batchId,fixture.target,signal())).matchCount,0));
    await respond({...fixture.page,candidates:[{...candidate,matchCount:1,suggestedProducts:fixture.suggestion.suggestedProducts}]},()=>assert.rejects(api.readCatalogSuggestion(batchId,fixture.target,signal()),{code:'INVALID_RESPONSE'}));
  }
});
test('only ten unique suggestions are shown even when the server reports more matches',async()=>{
  const fixture = catalogFixture(); const products=Array.from({length:10},(_,index)=>({...fixture.suggestion.suggestedProducts[0],id:'product-'+index}));
  const candidate={...fixture.suggestion,suggestedProducts:products,matchCount:44,hasMoreSuggestions:true};
  await respond({...fixture.page,candidates:[candidate]},async()=>assert.equal((await api.readCatalogSuggestion(batchId,fixture.target,signal())).suggestedProducts.length,10));
  for (const patch of [{hasMoreSuggestions:false},{matchCount:5001},{suggestedProducts:products.slice(0,9)},{suggestedProducts:[...products.slice(0,9),products[0]]}]) {
    await respond({...fixture.page,candidates:[{...candidate,...patch}]},()=>assert.rejects(api.readCatalogSuggestion(batchId,fixture.target,signal()),{code:'INVALID_RESPONSE'}));
  }
});
test('catalog limit and service failures remain safe, localized and distinct from no matches',async()=>{
  const fixture=catalogFixture();
  await respond({code:'IMPORT_CATALOG_LIMIT',message:'private database detail'},()=>assert.rejects(api.readCatalogSuggestion(batchId,fixture.target,signal()),(error)=>{
    const message=errors.getApiErrorMessage(error,'Fallback'); assert.match(message,/5.000/); assert.doesNotMatch(message,/private/); return true;
  }),409);
  await respond({message:'private database detail'},()=>assert.rejects(api.readCatalogSuggestion(batchId,fixture.target,signal()),(error)=>{
    assert.doesNotMatch(errors.getApiErrorMessage(error,'Fallback'),/private/); return true;
  }),503);
});
