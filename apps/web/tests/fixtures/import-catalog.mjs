import { batchId, candidateId, pilotFixture } from './import-pilot.mjs';

export function catalogFixture() {
  const fixture = pilotFixture();
  const suggestion = {
    candidateId, attributes: {equipmentType:[],brand:['QA'],model:['EQUIPO QA']}, conflict:false, hasEvidence:true,
    suggestedProducts:[{id:fixture.product.id,name:fixture.product.name,sku:null,equipmentType:fixture.product.equipmentType,brand:fixture.product.brand,model:fixture.product.model,updatedAt:'2026-10-05T15:00:00Z'}],
    matchCount:1,hasMoreSuggestions:false,requiresExplicitChoice:true,
    source:fixture.preview.records.map((row)=>({recordId:row.id,sheet:row.sheet,row:row.row}))
  };
  const target = {candidateId,revision:0,offset:0,total:1,source:suggestion.source};
  const page = {batchId,sourceRevision:0,candidates:[suggestion],total:1,limit:1,offset:0,hasMore:false,canApply:false};
  return {...fixture,suggestion,target,page};
}
