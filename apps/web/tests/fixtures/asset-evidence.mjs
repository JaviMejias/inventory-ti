import { assetId, receiptId } from './import-pilot.mjs';
import { historyFixture } from './import-history.mjs';

export function assetEvidenceFixture() {
  const history = historyFixture();
  const capture = history.receiptFor({records:history.observations.map((entry)=>({recordId:entry.recordId,kind:entry.kind,assetId})),
    expectedVersion:2,expectedSourceRevision:0,historyPreviewId:'e'.repeat(64),requestId:receiptId,note:'Captura documental QA',evidenceReference:'Acta QA'});
  const evidence = capture.items.map((entry)=>({...entry,capture:history.metadata(capture),effectiveSourceRevision:0,evidenceVersion:0,
    amendmentId:null,amendedAt:null,capturedAssetId:assetId,capturedEffectiveDay:entry.effectiveDay,capturedSourceRevision:0}));
  const amended = evidence[0];
  amended.evidenceVersion=1; amended.effectiveSourceRevision=1; amended.amendmentId=receiptId; amended.amendedAt='2026-10-05T17:00:00Z';
  amended.capturedAssetId=null; amended.effectiveDay='2025-01-02'; amended.snapshot.effectiveDay=amended.effectiveDay;
  amended.snapshot.effective.fields.receivedDate=amended.effectiveDay;
  amended.snapshot.effective.originalCells.B.value=amended.effectiveDay;
  function pageFor(offset=0,rows=evidence) {
    return {...history.scope,evidence:globalThis.structuredClone(rows.slice(offset,offset+25)),total:rows.length,offset,limit:25,hasMore:offset+25<rows.length};
  }
  return {history,evidence,pageFor};
}
