import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { identityGroupProjectionFixture } from './identity-group-projection.mjs';

export const decisionUuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const decisionFlags={scope:'IDENTITY_GROUP_DECISION_ONLY',persisted:true,canApply:false,affectsCurrentState:false,groupedPilotImplemented:false,evidenceRelinked:false};
// Projections were generated offline by the pure V18 projector and accepted by the pure V19 policy.
// Receipt identifiers and metadata below are synthetic storage envelopes; no live API/database is used.
export function groupDecisionFixture(kind='evidence',action=kind==='linked'?'LINK_EXISTING':'PROPOSE_NEW') {
  const base=identityGroupProjectionFixture();
  const projections=JSON.parse(readFileSync(new URL('./identity-group-decision.json',import.meta.url),'utf8'));
  const projection=projections[kind]??base[kind];const group=projection.groups[0];
  const input={requestId:decisionUuid(2000),confirmation:'RECORD_IDENTITY_GROUP_DECISION_ONLY',expectedDecisionVersion:0,expectedBatchVersion:projection.batchVersion,expectedSourceRevision:projection.sourceRevision,projectionId:projection.projectionId,groupKey:group.groupKey,action,...(action==='LINK_EXISTING'?{linkedAssetId:group.candidates[0].existingAssets[0].id}:{}),note:'Decisión sintética de QA',evidenceReference:'Respaldo sintético de QA',evidenceReviews:['HOLD','EXCLUDE'].includes(action)?[]:group.evidence.map((row,i)=>({evidenceId:row.id,expectedEvidenceVersion:row.evidenceVersion,disposition:i%2?'EXCLUDE_FROM_GROUP_PILOT':'CONFIRM_GROUP_MEMBERSHIP',note:'Motivo sintético '+i,evidenceReference:'Respaldo sintético '+i}))};
  const decision={id:decisionUuid(2001),reviewId:base.review.id,version:1,requestId:input.requestId,requestDigest:'d'.repeat(64),rulesVersion:'mda-identity-group-decision-1',groupId:group.groupId,groupKey:group.groupKey,batchVersion:projection.batchVersion,sourceRevision:projection.sourceRevision,projectionId:projection.projectionId,projection,action,linkedAssetId:input.linkedAssetId??null,note:input.note,evidenceReference:input.evidenceReference,evidenceReviews:input.evidenceReviews,reviewedById:base.review.reviewedById,createdAt:'2026-10-26T12:10:00Z'};
  const receipt={...decisionFlags,reused:false,decisionVersion:1,decision};
  const context={projection,latest:{items:[],decisionVersion:0,reviewActive:true,currentProjectionId:projection.projectionId,mode:'latest',groupKey:'',total:0,offset:0,limit:25,hasMore:false}};
  return{...base,projection,input,decision,receipt,context,intent:{review:base.review,actorId:base.review.reviewedById,projection,input}};
}
export function decisionMetadata(decision){return Object.fromEntries(Object.entries(decision).filter(([key])=>key!=='projection'));}
export function decisionList(f,rows=[],mode='latest',offset=0,active=true){return{...decisionFlags,decisionVersion:Math.max(0,...rows.map(row=>row.version)),reviewActive:active,currentProjectionId:active?f.projection.projectionId:null,mode,decisions:rows.slice(offset,offset+25).map(row=>({...decisionMetadata(row),projectionCurrent:active&&row.projectionId===f.projection.projectionId})),total:rows.length,offset,limit:25,hasMore:offset+25<rows.length};}
export function decisionDraft(f){return{action:f.input.action,linkedAssetId:f.input.linkedAssetId??'',note:f.input.note,reference:f.input.evidenceReference,reviewEvidence:false,evidence:Object.fromEntries(f.input.evidenceReviews.map(row=>[row.evidenceId,{disposition:row.disposition,note:row.note,reference:row.evidenceReference}]))};}
