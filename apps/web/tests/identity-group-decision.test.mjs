import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decisionDraft, decisionFlags, decisionList, decisionUuid, groupDecisionFixture } from './fixtures/identity-group-decision.mjs';

class ApiError extends Error {constructor(message,status,code){super(message);this.status=status;this.code=code;}}
function harness(responder,csrf){
  const calls=[],tokens=[],loaded=new Map();const modules={
    '../../lib/api':{ApiRequestError:ApiError,apiRequest:async(path,options)=>{calls.push({path,options});options.signal.throwIfAborted();return responder(path,options);},getCsrfToken:async signal=>{tokens.push(signal);await csrf?.();return'synthetic';}},
    './closed-assignment-model':{validHistoricalInstant:value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value.slice(0,10)},
    './history-evidence-api':{sameSnapshot:(a,b)=>{const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));}},
    './import-review-api':{importReviewPath:'/inventory/imports/batches'},
    './source-review-api':{validSourceCell:value=>value===null||value&&typeof value==='object'&&typeof value.type==='string'&&'value'in value}
  };
  function load(name){if(modules[name])return modules[name];if(loaded.has(name))return loaded.get(name);const exports={};loaded.set(name,exports);runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/imports/'+name.slice(2)+'.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:load,globalThis,Date,Object,Map,Set,JSON});return exports;}
  return{api:load('./identity-group-decision-api'),model:load('./identity-group-decision-model'),projection:load('./identity-group-projection-api'),calls,tokens};
}
const signal=()=>new globalThis.AbortController().signal;
for(const [kind,action] of [['evidence','PROPOSE_NEW'],['linked','LINK_EXISTING'],['changed','HOLD'],['consumed','EXCLUDE'],['scale','PROPOSE_NEW']])test(kind+' / '+action+' captures a detached immutable administrative intention and validates the exact stored projection',async()=>{
  const f=groupDecisionFixture(kind,action),h=harness(()=>f.receipt);const intent=h.api.captureGroupDecisionIntent(f.intent);
  assert.ok(Object.isFrozen(intent.input.evidenceReviews));assert.ok(Object.isFrozen(intent.projection.groups[0].evidence));
  assert.equal((await h.api.writeGroupDecision(intent)).decision.action,action);assert.equal(h.calls.length,1);assert.match(h.calls[0].path,/\/identity-group-reviews\/[^/]+\/decisions$/);
  assert.deepEqual(JSON.parse(h.calls[0].options.body),f.input);assert.equal(h.tokens[0],h.calls[0].options.signal);assert.equal(intent.projection.canApply,false);
});
test('empty initial form chooses no action, asset or evidence disposition; all evidence needs an explicit motive and reference',()=>{
  const f=groupDecisionFixture(),h=harness(),empty=h.model.emptyGroupDecision();assert.equal(empty.action,'');assert.equal(empty.linkedAssetId,'');assert.deepEqual(Object.keys(empty.evidence),[]);
  const draft=decisionDraft(f);delete draft.evidence[f.input.evidenceReviews[1].evidenceId];
  const errors=h.model.validateGroupDecisionDraft(f.context,f.input.groupKey,draft);assert.equal(Object.keys(errors).length,3);assert.ok(Object.keys(errors).every(key=>key.startsWith(f.input.evidenceReviews[1].evidenceId)));
  draft.evidence=decisionDraft(f).evidence;assert.deepEqual(Object.keys(h.model.validateGroupDecisionDraft(f.context,f.input.groupKey,draft)),[]);
});
test('global decision version, not batch or per-group version, is copied into a trimmed strict body with no operational fields',()=>{
  const f=groupDecisionFixture(),h=harness();f.context.latest.decisionVersion=17;const draft=decisionDraft(f);draft.note='  '+draft.note+'  ';
  const input=h.model.groupDecisionInput(f.context,f.input.groupKey,draft,decisionUuid(2000).toUpperCase());assert.equal(input.expectedDecisionVersion,17);assert.equal(input.expectedBatchVersion,f.projection.batchVersion);assert.equal(input.note,f.input.note);assert.equal(input.projection,undefined);assert.equal(input.linkedAssetId,undefined);
  f.context.latest.decisionVersion=2147483647;assert.ok(h.model.validateGroupDecisionDraft(f.context,f.input.groupKey,draft).context);
});
test('HOLD and EXCLUDE can diagnose blocked/consumed contexts with [] while evidence review requires the entire current set',()=>{
  const f=groupDecisionFixture('consumed','HOLD'),h=harness();assert.ok(h.api.captureGroupDecisionIntent(f.intent));
  const draft=decisionDraft(f);draft.reviewEvidence=true;assert.ok(h.model.validateGroupDecisionDraft(f.context,f.input.groupKey,draft).reviewEvidence);
  const fresh=groupDecisionFixture();fresh.input.action='HOLD';fresh.input.evidenceReviews.pop();assert.throws(()=>h.api.captureGroupDecisionIntent(fresh.intent));
});
test('proposals refuse partial matches, arbitrary assets, blocked contexts and another group already proposing the same asset regardless of freshness',()=>{
  const f=groupDecisionFixture('linked'),h=harness(),key=f.input.groupKey;assert.equal(h.model.groupDecisionOptions(f.projection,key).canLink,true);assert.equal(h.model.groupDecisionOptions(f.projection,key).canCreate,false);
  const other={...f.decision,groupKey:'f'.repeat(64),projectionId:'e'.repeat(64)};assert.equal(h.model.groupDecisionOptions(f.projection,key,[other]).canLink,false);
  for(const mutate of [v=>v.input.linkedAssetId=decisionUuid(777),v=>v.input.action='PROPOSE_NEW',v=>v.input.evidenceReviews=[],v=>v.input.evidenceReviews[0].expectedEvidenceVersion++,v=>v.input.evidenceReviews.push(v.input.evidenceReviews[0]),v=>v.input.evidenceReviews[0].disposition='AUTO']){const value=globalThis.structuredClone(f.intent);mutate(value);assert.throws(()=>h.api.captureGroupDecisionIntent(value),e=>e.code==='VALIDATION_ERROR',String(mutate));}
  const blocked=groupDecisionFixture('changed','PROPOSE_NEW');assert.throws(()=>h.api.captureGroupDecisionIntent(blocked.intent));
});
test('invalid envelopes, overflow, private snapshot fields and invalid parent/actor fail before CSRF or any write',async()=>{
  const f=groupDecisionFixture(),h=harness(()=>f.receipt);
  const mutations=[v=>v.force=true,v=>v.actorId='bad',v=>v.review.release={id:decisionUuid(5)},v=>v.input.projection=f.projection,v=>v.input.force=true,v=>v.input.expectedDecisionVersion=2147483647,v=>v.input.expectedSourceRevision=1001,v=>v.input.note=' ',v=>v.input.evidenceReference='x'.repeat(501),v=>v.input.expectedBatchVersion++,v=>v.input.projectionId='b'.repeat(64),v=>v.input.groupKey='b'.repeat(64)];
  for(const mutate of mutations){const value=globalThis.structuredClone(f.intent);mutate(value);await assert.rejects(h.api.writeGroupDecision(value));}assert.equal(h.tokens.length,0);assert.equal(h.calls.length,0);
});
test('body is frozen before awaiting CSRF; recovery may return its original version under a later global version',async()=>{
  const f=groupDecisionFixture();const response=globalThis.structuredClone({...f.receipt,reused:true,decisionVersion:8});let release;const held=new Promise(resolve=>release=resolve);const h=harness(()=>response,()=>held);
  const pending=h.api.writeGroupDecision(f.intent);f.input.note='Mutated';f.projection.groups[0].evidence[0].currentAssetId=decisionUuid(6);release();const saved=await pending;assert.equal(saved.decisionVersion,8);assert.equal(saved.decision.version,1);assert.notEqual(JSON.parse(h.calls[0].options.body).note,'Mutated');
});
test('forged stored actor, request, source, group, intent, evidence, flags and global version cannot report success',async()=>{
  const f=groupDecisionFixture();const mutations=[v=>v.evidenceRelinked=true,v=>v.affectsCurrentState=true,v=>v.groupedPilotImplemented=true,v=>v.decision.reviewId=decisionUuid(7),v=>v.decision.reviewedById=decisionUuid(7),v=>v.decision.requestId=decisionUuid(7),v=>v.decision.groupId=decisionUuid(7),v=>v.decision.groupKey='a'.repeat(64),v=>v.decision.note='Changed',v=>v.decision.evidenceReviews.pop(),v=>v.decision.evidenceReviews[0].disposition='EXCLUDE_FROM_GROUP_PILOT',v=>v.decisionVersion=9,v=>v.decision.projection.groups[0].evidence[0].linkedToGroup=true,v=>v.decision.internal='private'];
  for(const mutate of mutations){const value=globalThis.structuredClone(f.receipt);mutate(value);await assert.rejects(harness(()=>value).api.writeGroupDecision(f.intent),e=>e.code==='INVALID_RESPONSE',String(mutate));}
});
test('history pages25 then2 use metadata only, version descending, optional group filter and no CSRF',async()=>{
  const f=groupDecisionFixture();const rows=Array.from({length:27},(_,i)=>({...f.decision,id:decisionUuid(2100+i),version:27-i}));
  const h=harness(path=>{const query=new URL('https://synthetic.test'+path).searchParams;assert.equal(query.get('groupKey'),f.input.groupKey);return decisionList(f,rows,'history',Number(query.get('offset')));});
  for(const offset of [0,25]){const page=await h.api.readGroupDecisions(f.review,'history',f.input.groupKey,offset,signal());assert.equal(page.items.length,offset?2:25);assert.equal(page.decisionVersion,27);assert.equal(page.items[0].projection,undefined);assert.equal(page.items[0].projectionCurrent,true);}
  assert.equal(h.tokens.length,0);assert.equal(h.calls.length,2);assert.ok(h.calls.every(call=>!call.options.method&&!call.options.body));
});
test('list privacy leaks, malformed paging, duplicated versions/identities and false current flags fail visibly',async()=>{
  const f=groupDecisionFixture();const mutations=[v=>v.decisions[0].projection=f.projection,v=>v.total=2,v=>v.hasMore=true,v=>v.limit=100,v=>v.offset=25,v=>v.mode='history',v=>v.decisions[0].projectionCurrent=false,v=>v.reviewActive=false,v=>v.decisions.push(v.decisions[0])];
  for(const mutate of mutations){const value=decisionList(f,[f.decision]);mutate(value);await assert.rejects(harness(()=>value).api.readGroupDecisions(f.review,'latest','',0,signal()),e=>e.code==='INVALID_RESPONSE');}
});
test('released reviews retain full immutable archived receipts without weakening the current V18 guard',async()=>{
  const f=groupDecisionFixture();f.review.release={id:decisionUuid(2200)};f.review.rows.forEach(row=>row.isReserved=false);
  const value={...decisionFlags,decisionVersion:9,reviewActive:false,currentProjectionId:null,projectionCurrent:false,decision:f.decision};
  const h=harness(()=>value);const saved=await h.api.readGroupDecision(f.review,f.decision.id,signal());assert.equal(saved.reviewActive,false);assert.equal(saved.projectionCurrent,false);assert.equal(saved.decision.projection.groups[0].evidence[0].currentAssetId,null);
  assert.throws(()=>h.projection.validateIdentityGroupProjection(f.projection,f.review));assert.ok(h.projection.validateArchivedIdentityGroupProjection(f.projection,f.review));
  const list=harness(()=>decisionList(f,[f.decision],'latest',0,false));assert.equal((await list.api.readGroupDecisions(f.review,'latest','',0,signal())).items[0].projectionCurrent,false);
});
test('projectionCurrent can be true for an older historical decision and never supplies apply authority',async()=>{
  const f=groupDecisionFixture();const h=harness(()=>({...decisionFlags,decisionVersion:12,reviewActive:true,currentProjectionId:f.projection.projectionId,projectionCurrent:true,decision:f.decision}));
  const saved=await h.api.readGroupDecision(f.review,f.decision.id,signal());assert.equal(saved.decision.version,1);assert.equal(saved.decisionVersion,12);assert.equal(saved.projectionCurrent,true);assert.equal(saved.decision.projection.canApply,false);
});
test('context joins V18 and the global latest version only when they describe the same active projection',async()=>{
  const f=groupDecisionFixture();let page=decisionList(f);const h=harness(path=>path.endsWith('/effective-preview')?f.projection:page);
  await h.api.readGroupDecisionContext(f.review,signal(),f.projection);assert.equal(h.calls.length,1);await h.api.readGroupDecisionContext(f.review,signal());assert.equal(h.calls.length,3);
  page={...page,currentProjectionId:'e'.repeat(64)};await assert.rejects(h.api.readGroupDecisionContext(f.review,signal(),f.projection),e=>e.code==='IDENTITY_GROUP_PROJECTION_CHANGED');
  page={...page,reviewActive:false,currentProjectionId:null};await assert.rejects(h.api.readGroupDecisionContext(f.review,signal(),f.projection));
});
test('paging refuses a different global version, projection or reservation even when the total stays the same',()=>{
  const f=groupDecisionFixture(),h=harness();const old={...f.context.latest,mode:'history',total:27,decisionVersion:27};const page={...old,offset:25};
  h.model.validateGroupDecisionPageContinuation(old,page);
  for(const patch of [{decisionVersion:28},{total:28},{currentProjectionId:'f'.repeat(64)},{reviewActive:false},{mode:'latest'},{groupKey:'f'.repeat(64)}])assert.throws(()=>h.model.validateGroupDecisionPageContinuation(old,{...page,...patch}),error=>error.code==='IDENTITY_GROUP_DECISION_LIST_CHANGED');
  assert.throws(()=>h.model.validateGroupDecisionPageContinuation(null,page));h.model.validateGroupDecisionPageContinuation(old,{...page,offset:0,decisionVersion:29});
});
test('read errors/aborts stay failures; uncertain writes preserve the attempt while known conflicts require a fresh confirmation',async()=>{
  const f=groupDecisionFixture(),fail=new ApiError('PRIVATE',503,'IMPORT_REVIEW_NOT_READY'),h=harness(()=>{throw fail;});await assert.rejects(h.api.readGroupDecisions(f.review,'latest','',0,signal()),e=>e===fail);
  const c=new globalThis.AbortController();c.abort();await assert.rejects(h.api.readGroupDecision(f.review,f.decision.id,c.signal),{name:'AbortError'});
  for(const error of [fail,new Error('Lost'),new ApiError('Bad',200,'INVALID_RESPONSE'),new ApiError('Busy',409,'IDENTITY_GROUP_REVIEW_BUSY')])assert.equal(h.api.groupDecisionNeedsRecovery(error),true);
  for(const code of ['IDENTITY_GROUP_DECISION_VERSION_CONFLICT','IDENTITY_GROUP_PROJECTION_CHANGED','EVIDENCE_VERSION_CONFLICT','IDENTITY_GROUP_ALREADY_RELEASED','FORBIDDEN'])assert.equal(h.api.groupDecisionNeedsRecovery(new ApiError('PRIVATE',409,code)),false);
});
