import { batchId, candidateId, pilotFixture } from './import-pilot.mjs';
export function sourceFixture() {
  const fixture = pilotFixture();
  const record = fixture.preview.records[0];
  record.fields = {equipmentType:'Notebook', brand:'QA', model:'Modelo incompleto', receivedDate:null, serialNumber:null, assetTag:null};
  record.originalCells = {C:{type:'text',value:'Notebook'},D:{type:'text',value:'QA'},E:{type:'text',value:'Modelo incompleto'},F:{type:'number',value:12,numberFormat:'000000',rawValue:'12'}};
  fixture.preview.candidates[0].serials = [];
  fixture.preview.candidates[0].proposal = 'REVIEW_IDENTITY';
  fixture.decision.action = 'HOLD'; fixture.decision.sourceRevision = 0;
  fixture.resolved = {...fixture.resolved, preview:globalThis.structuredClone(fixture.preview), sourceContext:{revision:0,corrections:[],identityRevisions:[]}};
  const columns = {equipmentType:'C',brand:'D',model:'E',receivedDate:'A',serialNumber:'F',assetTag:'G'};
  function eventFor(intent) {
    const changes = 'changes' in intent ? intent.changes : intent.action === 'RESTORE' ?
      fixture.resolved.sourceContext.corrections.filter((entry)=>['serialNumber','assetTag'].includes(entry.field)).map((entry)=>({recordId:entry.recordId,field:entry.field,action:'RESTORE'})) :
      ['serialNumber','assetTag'].filter((field)=>intent[field]!==null).map((field)=>({recordId:record.id,field,action:'REPLACE',value:intent[field]}));
    return {id:'revision-'+intent.requestId,batchId,revision:intent.expectedRevision+1,expectedBatchVersion:intent.expectedBatchVersion,requestId:intent.requestId,requestDigest:'d'.repeat(64),note:intent.note,evidenceReference:intent.evidenceReference,reviewedById:'jefe-qa',createdAt:'2026-10-05T16:00:00Z',
      changes:changes.map((entry)=>({...entry,candidateId,sheet:record.sheet,row:record.row,column:columns[entry.field],originalCell:record.originalCells[columns[entry.field]]??null,beforeCell:fixture.resolved.preview.records[0].originalCells[columns[entry.field]]??null,
        afterCell:entry.action==='RESTORE'?record.originalCells[columns[entry.field]]??null:{type:entry.field==='receivedDate'?'date':'text',value:entry.value}}))};
  }
  function commit(event) {
    fixture.resolved.sourceContext.revision = event.revision;
    for (const change of event.changes) {
      const effective = fixture.resolved.preview.records[0];
      if (change.afterCell === null) delete effective.originalCells[change.column]; else effective.originalCells[change.column]=globalThis.structuredClone(change.afterCell);
      effective.fields[change.field]=change.afterCell===null?null:String(change.afterCell.value);
      fixture.resolved.sourceContext.corrections=fixture.resolved.sourceContext.corrections.filter((entry)=>entry.recordId!==change.recordId||entry.field!==change.field);
      if(change.action==='REPLACE') fixture.resolved.sourceContext.corrections.push({...change,revision:event.revision,revisionId:event.id,reviewedById:event.reviewedById,note:event.note,evidenceReference:event.evidenceReference});
    }
    if(event.changes.some((entry)=>['serialNumber','assetTag'].includes(entry.field))) {
      fixture.resolved.sourceContext.identityRevisions=[{candidateId,revision:event.revision}];
      const candidate=fixture.resolved.preview.candidates[0];
      const fields=fixture.resolved.preview.records[0].fields;
      candidate.serials=fields.serialNumber?[fields.serialNumber]:[]; candidate.tags=fields.assetTag?[fields.assetTag]:[];
      candidate.proposal=candidate.serials.length||candidate.tags.length?'REVIEW_NEW':'REVIEW_IDENTITY';
      candidate.effectiveCandidateId='e'.repeat(64);
    }
  }
  return {...fixture,eventFor,commit};
}
