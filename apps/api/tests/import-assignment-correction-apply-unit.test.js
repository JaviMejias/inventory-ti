import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deserialize, serialize } from 'node:v8';

import { assignmentCorrectionApplySchema, assignmentCorrectionRequestDigest } from '../src/imports/assignment-correction-apply-schemas.js';
import { validateAssignmentCorrectionChain, correctionEnvelope } from '../src/imports/assignment-correction-chain.js';
import { buildAssignmentCorrectionPlan } from '../src/imports/assignment-correction-plan.js';
import { assignmentCorrectionPlanSchema } from '../src/imports/assignment-correction-schemas.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { assignmentCorrectionFixture } from './fixtures/assignment-correction.js';

const clone = (value) => deserialize(serialize(value));
function fixture() {
  const f=assignmentCorrectionFixture(); const plan=buildAssignmentCorrectionPlan(f.receipt,f.assignmentItem.id,f.audits,f.context,assignmentCorrectionPlanSchema.parse(f.input),f.now);
  const input=assignmentCorrectionApplySchema.parse({requestId:randomUUID(),correctionPlanId:plan.correctionPlanId,confirmation:'APPLY_LEGACY_ASSIGNMENT_CORRECTION',plan:f.input});
  const event={id:randomUUID(),itemId:f.assignmentItem.id,version:1,previousId:null,requestId:input.requestId,requestDigest:assignmentCorrectionRequestDigest(input),correctionPlanId:plan.correctionPlanId,
    rulesVersion:'mda-legacy-assignment-correction-application-1',plan:JSON.parse(JSON.stringify(plan)),reason:input.plan.reason,supportingReference:input.plan.supportingReference,
    correctedById:randomUUID(),correctedAt:f.now,createdTransactionId:'12345',assetSnapshot:JSON.parse(JSON.stringify(plan.currentAsset)),custodySnapshot:JSON.parse(JSON.stringify(plan.currentCustody))};
  const validate=(events)=>validateAssignmentCorrectionChain(events,f.assignmentItem.id,f.receipt.planId,importPlanDigest(f.receipt),f.now,plan.before);
  return {...f,input,event,plan,validate};
}
test('legacy correction application DTO normalizes stable intent and rejects foreign authority, actors and version overflows',()=>{
  const f=fixture();assert.equal(assignmentCorrectionApplySchema.safeParse(f.input).success,true);
  for(const change of [{confirmation:'APPLY_GROUP_ASSIGNMENT_CORRECTION'},{correctedById:randomUUID()},{force:true},{plan:{...f.input.plan,expectedCorrectionVersion:1001}}]) assert.equal(assignmentCorrectionApplySchema.safeParse({...f.input,...change}).success,false);
  const warnings=['a'.repeat(64),'b'.repeat(64)];const a={...f.input,plan:{...f.input.plan,correction:{...f.input.plan.correction,acknowledgedWarnings:warnings}}};
  assert.equal(assignmentCorrectionRequestDigest(a),assignmentCorrectionRequestDigest({...a,plan:{...a.plan,correction:{...a.plan.correction,acknowledgedWarnings:[...warnings].reverse()}}}));
  assert.notEqual(assignmentCorrectionRequestDigest(a),assignmentCorrectionRequestDigest({...a,requestId:randomUUID()}));
});
test('legacy correction chain validates sequential immutable origin, exact request and before values',()=>{
  const f=fixture();assert.equal(f.validate([f.event]).id,f.event.id);assert.equal(f.validate([]),undefined);
  for(const mutate of [(e)=>{e.itemId=randomUUID();},(e)=>{e.version=2;},(e)=>{e.previousId=randomUUID();},(e)=>{e.requestDigest='f'.repeat(64);},
    (e)=>{e.plan.before.note='Forged before';},(e)=>{e.correctedAt=new Date('2099-01-01');},(e)=>{e.createdTransactionId='0';},(e)=>{e.assetSnapshot={};},(e)=>{e.reason='Different reason';}]){
    const event=clone(f.event);mutate(event);assert.throws(()=>f.validate([event]),(error)=>error.code==='INVALID_ASSIGNMENT_CORRECTION_CHAIN');
  }
});
test('legacy correction chain rejects self-rehashed broken before or operative flags and limits unbounded versions',()=>{
  const f=fixture();const event=clone(f.event);event.plan.before.note='Forged chain boundary';
  event.plan.correctionPlanId=importPlanDigest(Object.fromEntries(Object.entries(event.plan).filter(([key])=>!correctionEnvelope.has(key))));event.correctionPlanId=event.plan.correctionPlanId;
  event.requestDigest=assignmentCorrectionRequestDigest({...f.input,correctionPlanId:event.correctionPlanId});
  assert.throws(()=>f.validate([event]),(error)=>error.code==='INVALID_ASSIGNMENT_CORRECTION_CHAIN');
  assert.throws(()=>f.validate(Array(1001).fill(f.event)),(error)=>error.code==='ASSIGNMENT_CORRECTION_LIMIT');
});
