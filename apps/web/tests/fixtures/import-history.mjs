import { assetId, batchId, candidateId, pilotFixture, receiptId } from './import-pilot.mjs';

export function historyFixture() {
  const pilot = pilotFixture();
  const scope = {scope:'HISTORICAL_EVIDENCE_ONLY',affectsCurrentState:false,canApply:false};
  const observations = Array.from({length:27},(_,index)=> {
    const recordId=(index+1).toString(16).padStart(64,'0');
    const original={...globalThis.structuredClone(pilot.preview.records[0]),id:recordId,row:index+4,fields:{serialNumber:'000012',receivedDate:index===1?'no confirmado':'2025-01-01',incomingTicket:'T-01',incomingOt:'OT-01',purchaseOrder:'OC-01'},originalCells:{A:{type:'text',value:'000012'},B:{type:'text',value:'2025-01-01'}}};
    const effective=globalThis.structuredClone(original);
    const kind=index===2?'RETIREMENT_OBSERVATION':'RECEIPT_OBSERVATION';
    const unknown=index===1||index===2;
    return {recordId,candidateId,kind,effectiveDay:unknown?null:'2025-01-01',datePrecision:unknown?'UNKNOWN':'DAY',dateField:index===2?null:'receivedDate',sourceDateText:index===1?'no confirmado':index===2?null:'2025-01-01',
      dateUncertainty:index===1?'DATE_UNCONFIRMED':index===2?'RETIREMENT_DATE_NOT_MAPPED':null,original,effective,issues:[],sourceCorrections:[],
      suggestedAssets:[{id:assetId,serialNumber:'000012',assetTag:null,status:'ASSIGNED',isActive:true,product:{name:'Notebook QA'}}],identityLinkBlocked:false,
      historicalActorId:null,affectsCurrentState:false,stored:null,linkOptions:[{assetId,basis:{type:'REVIEW_DECISION',id:receiptId}}]};
  });
  function previewFor(offset=0,patch={}) {
    return {...scope,mode:'HISTORY_PREVIEW',persisted:false,batchId,batchVersion:2,sourceRevision:0,historyRulesVersion:'mda-history-evidence-1',historyPreviewId:'e'.repeat(64),
      observations:globalThis.structuredClone(observations.slice(offset,offset+25)),total:observations.length,limit:25,offset,hasMore:offset+25<observations.length,...patch};
  }
  function receiptFor(intent) {
    const selection=intent.records.map((entry)=>{
      const observation=observations.find((item)=>item.recordId===entry.recordId&&item.kind===entry.kind);
      const {stored:unusedStored,linkOptions,...snapshot}=globalThis.structuredClone(observation);
      void unusedStored;
      return {...snapshot,assetId:entry.assetId,linkBasis:entry.assetId?linkOptions.find((item)=>item.assetId===entry.assetId).basis:null};
    });
    return {id:receiptId,batchId,batchVersion:intent.expectedVersion,sourceRevision:intent.expectedSourceRevision,sourceHash:'b'.repeat(64),historyPreviewId:intent.historyPreviewId,
      requestId:intent.requestId,requestDigest:'f'.repeat(64),note:intent.note,evidenceReference:intent.evidenceReference,rulesVersion:'mda-history-evidence-1',capturedById:assetId,capturedAt:'2026-10-05T16:00:00Z',selection,
      items:selection.map((snapshot,index)=>({id:`00000000-0000-4000-8000-${String(index+100).padStart(12,'0')}`,captureId:receiptId,sourceHash:'b'.repeat(64),recordId:snapshot.recordId,candidateId:snapshot.candidateId,
        kind:snapshot.kind,effectiveDay:snapshot.effectiveDay,assetId:snapshot.assetId,snapshot:globalThis.structuredClone(snapshot),capturedAt:'2026-10-05T16:00:00Z'}))};
  }
  function metadata(capture) { const {items,selection,requestId,requestDigest,...entry}=capture; void items; void selection; void requestId; void requestDigest; return entry; }
  return {pilot,scope,observations,previewFor,receiptFor,metadata};
}
