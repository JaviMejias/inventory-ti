export const batchId = '00000000-0000-4000-8000-000000000001';
export const productId = '00000000-0000-4000-8000-000000000002';
export const assetId = '00000000-0000-4000-8000-000000000003';
export const receiptId = '00000000-0000-4000-8000-000000000004';
export const candidateId = 'a'.repeat(64);
export function pilotFixture() {
  const recordId = 'c'.repeat(64);
  const previewId = 'b'.repeat(64);
  const source = {fileName:'Piloto QA anónimo.xlsx',sha256:previewId};
  const product = {id:productId,name:'Notebook QA',trackingMode:'ASSET',isActive:true,brand:'QA',model:'Equipo QA',equipmentType:'Notebook'};
  const preview = {mode:'PREVIEW',persisted:false,canApply:false,previewId,source,asOf:'2026-10-05',summary:{blockingIssueCount:0},
    sheets:[{name:'Recepción',kind:'ASSET_OBSERVATION',headerValid:true,recordCount:1,populatedRows:1,excludedCount:0,hidden:false,filterRange:null}],
    records:[{id:recordId,sheet:'Recepción',row:4,hidden:false,kind:'ASSET_OBSERVATION',statusEvidence:'AVAILABLE',fields:{serialNumber:'QA-001',brand:'QA',model:'Equipo QA'},originalCells:{A:{type:'text',value:'QA-001'}}}],
    candidates:[{id:candidateId,serials:['QA-001'],tags:[],recordIds:[recordId],proposal:'REVIEW_NEW',existingAssets:[]}],issues:[],excluded:[]};
  const batch = {id:batchId,sourceFileName:source.fileName,sourceHash:source.sha256,previewId,asOf:preview.asOf,version:2,targetCount:1,createdById:'jefe-qa',createdAt:'2026-10-05T15:00:00Z',updatedAt:'2026-10-05T15:00:00Z',mode:'REVIEW',persisted:true,canApply:false};
  const decision = {id:'decision-qa',batchId,requestId:'00000000-0000-4000-8000-000000000005',targetId:candidateId,targetType:'CANDIDATE',action:'PROPOSE_NEW',linkedAssetId:null,note:'Verificado físicamente',reviewedById:'jefe-qa',createdAt:batch.createdAt,batchVersion:2};
  const resolved = {batchId,batchVersion:2,canApply:false,preview,sourceContext:{revision:0,corrections:[]}};
  const request = {expectedVersion:2,expectedSourceRevision:0,operations:[{type:'CREATE_ASSET',candidateId,confirmation:'AVAILABLE_UNASSIGNED',note:'Equipo verificado',acknowledgedWarnings:[],values:{productId,serialNumber:'QA-001'}}]};
  function planFor(input = request, warnings = []) {
    const operations = input.operations.map((entry) => ({...entry,decisionId:decision.id,product,before:null,resultingStatus:'AVAILABLE',source:[{recordId,sheet:'Recepción',row:4}],sourceCorrections:[],
      changes:Object.entries(entry.values).filter(([key])=>key!=='productId').map(([field,after])=>({field,before:null,after})),
      warnings,blockers:warnings.some((warning)=>!entry.acknowledgedWarnings.includes(warning.id))?[{code:'WARNINGS_NOT_ACKNOWLEDGED'}]:[],
      valid:warnings.every((warning)=>entry.acknowledgedWarnings.includes(warning.id))}));
    return {mode:'PILOT_PLAN',scope:'ASSET_PILOT',persisted:false,canApply:false,batchId,batchVersion:input.expectedVersion,sourceRevision:input.expectedSourceRevision,planId:'d'.repeat(64),checkedAsOf:'2026-10-05',omittedTargetCount:0,
      freshness:{stale:false},planValidationComplete:operations.every((entry)=>entry.valid),summary:{operationCount:operations.length,validCount:operations.filter((entry)=>entry.valid).length,blockedCount:operations.filter((entry)=>!entry.valid).length,createCount:operations.length,updateCount:0},operations};
  }
  function receiptFor(intent) {
    const plan=planFor(intent.plan);
    return {id:receiptId,batchId,batchVersion:2,requestId:intent.requestId,planId:intent.planId,sourceHash:source.sha256,appliedById:'jefe-qa',createdAt:'2026-10-05T16:00:00Z',plan,
      items:plan.operations.map((operation)=>({id:'item-qa',candidateId:operation.candidateId,assetId,operation,result:{id:assetId,product,serialNumber:operation.values.serialNumber,status:'AVAILABLE',isActive:true}}))};
  }
  return {preview,batch,decision,resolved,product,request,planFor,receiptFor};
}
