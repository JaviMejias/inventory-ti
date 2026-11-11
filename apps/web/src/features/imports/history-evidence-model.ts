import type { Candidate, PreviewIssue, SourceRecord } from './import-review-model';
import type { ResolvedReviewSource } from './source-review-model';

export const historyKindLabels = {
  RECEIPT_OBSERVATION: 'Recepción indicada', USAGE_OBSERVATION: 'Uso indicado',
  LOAN_OBSERVATION: 'Préstamo indicado', RETIREMENT_OBSERVATION: 'Baja indicada'
};
export type HistoryKind = keyof typeof historyKindLabels;
export type HistoryBasis = { type: 'REVIEW_DECISION' | 'PILOT_RECEIPT'; id: string };
export type HistoricalObservation = {
  recordId: string; candidateId: string; kind: HistoryKind; effectiveDay: string | null;
  datePrecision: 'DAY' | 'UNKNOWN'; dateField: 'receivedDate' | 'usedDate' | 'loanDate' | null;
  sourceDateText: string | null; dateUncertainty: 'DATE_NOT_REPORTED' | 'DATE_UNCONFIRMED' | 'RETIREMENT_DATE_NOT_MAPPED' | null;
  original: SourceRecord; effective: SourceRecord; issues: PreviewIssue[];
  sourceCorrections: ResolvedReviewSource['sourceContext']['corrections'];
  suggestedAssets: Candidate['existingAssets']; identityLinkBlocked: boolean;
  historicalActorId: null; affectsCurrentState: false;
};
export type PreviewObservation = HistoricalObservation & {
  stored: { id: string; captureId: string; recordId: string; kind: HistoryKind; assetId: string | null; capturedAt: string } | null;
  linkOptions: Array<{ assetId: string; basis: HistoryBasis }>;
};
export type HistoryPreview = {
  batchId: string; batchVersion: number; sourceRevision: number; historyPreviewId: string;
  historyRulesVersion: string; observations: PreviewObservation[]; total: number; offset: number; limit: number; hasMore: boolean;
};
export type HistorySelection = { recordId: string; kind: HistoryKind; assetId: string | null };
export type HistoryIntent = {
  expectedVersion: number; expectedSourceRevision: number; requestId: string; historyPreviewId: string;
  confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY'; note: string; evidenceReference: string; records: HistorySelection[];
};
export type CaptureMetadata = {
  id: string; batchId: string; batchVersion: number; sourceRevision: number; sourceHash: string;
  historyPreviewId: string; rulesVersion: string; note: string; evidenceReference: string; capturedById: string; capturedAt: string;
};
export type CapturedObservation = HistoricalObservation & { assetId: string | null; linkBasis: HistoryBasis | null };
export type HistoryCapture = CaptureMetadata & {
  requestId: string; requestDigest: string; selection: CapturedObservation[];
  items: Array<{ id: string; captureId: string; sourceHash: string; recordId: string; candidateId: string; kind: HistoryKind;
    effectiveDay: string | null; assetId: string | null; snapshot: CapturedObservation; capturedAt: string }>;
};
export type AssetHistoryEvidence = HistoryCapture['items'][number] & {
  assetId: string; capture: CaptureMetadata; effectiveSourceRevision: number;
  evidenceVersion: number; amendmentId: string | null; amendedAt: string | null;
  capturedAssetId: string | null; capturedEffectiveDay: string | null; capturedSourceRevision: number;
};
export type AssetHistoryPage = { evidence: AssetHistoryEvidence[]; total: number; offset: number; limit: number; hasMore: boolean };
export function historyKey(value: { recordId: string; kind: HistoryKind }) { return `${value.recordId}:${value.kind}`; }
export function historyDay(day: string | null) { return day === null ? 'Fecha desconocida' : day.split('-').reverse().join('-'); }
export const historyUncertaintyLabels = {
  DATE_NOT_REPORTED: 'El origen no informa una fecha.', DATE_UNCONFIRMED: 'La fecha del origen no está confirmada.',
  RETIREMENT_DATE_NOT_MAPPED: 'El origen no identifica la fecha de baja; no se deduce del nombre de la hoja.'
};
export function reconcileHistorySelection(preview: HistoryPreview, selected: HistorySelection[]) {
  const byKey = new Map(preview.observations.map((entry) => [historyKey(entry), entry]));
  return selected.map((entry) => ({ selection: entry, observation: byKey.get(historyKey(entry)),
    error: !byKey.has(historyKey(entry)) ? 'La observación ya no aparece en esta página. Vuelve a seleccionarla desde la consulta.' :
      byKey.get(historyKey(entry))!.stored ? 'Esta observación ya fue capturada. Consulta su comprobante.' :
        entry.assetId !== null && !byKey.get(historyKey(entry))!.linkOptions.some((link) => link.assetId === entry.assetId) ? 'El vínculo elegido ya no está autorizado. Revisa y elige expresamente otro vínculo o Sin vincular.' : null }));
}
export function createHistoryIntent(preview: HistoryPreview, records: HistorySelection[], note: string, reference: string, requestId: string): HistoryIntent {
  return { expectedVersion: preview.batchVersion, expectedSourceRevision: preview.sourceRevision, requestId,
    historyPreviewId: preview.historyPreviewId, confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: note.trim(),
    evidenceReference: reference.trim(), records: globalThis.structuredClone(records) };
}
