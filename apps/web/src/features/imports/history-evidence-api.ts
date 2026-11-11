import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { importReviewPath } from './import-review-api';
import { historyKey, historyKindLabels, type AssetHistoryEvidence, type AssetHistoryPage, type CaptureMetadata, type CapturedObservation, type HistoricalObservation, type HistoryCapture, type HistoryIntent, type HistoryPreview, type PreviewObservation } from './history-evidence-model';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, min = 0) { return Number.isInteger(value) && Number(value) >= min; }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value); }
function timestamp(value: unknown) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.includes('T'); }
function nullableText(value: unknown) { return value === null || typeof value === 'string'; }
function kind(value: unknown) { return typeof value === 'string' && Object.hasOwn(historyKindLabels, value); }
function day(value: unknown) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function cell(value: unknown) { return object(value) && typeof value.type === 'string' && ['string', 'number', 'boolean'].includes(typeof value.value); }
function record(value: unknown, id: unknown) {
  return object(value) && value.id === id && typeof value.sheet === 'string' && integer(value.row, 1) && typeof value.hidden === 'boolean' &&
    typeof value.kind === 'string' && object(value.fields) && Object.values(value.fields).every(nullableText) &&
    object(value.originalCells) && Object.values(value.originalCells).every(cell) && [null, 'AVAILABLE', 'DECOMMISSIONED'].includes(value.statusEvidence as null);
}
function basis(value: unknown) { return object(value) && ['REVIEW_DECISION', 'PILOT_RECEIPT'].includes(String(value.type)) && uuid(value.id); }
function observation(value: unknown): value is HistoricalObservation & ObjectValue {
  return object(value) && hash(value.recordId) && hash(value.candidateId) && kind(value.kind) && day(value.effectiveDay) &&
    ['DAY', 'UNKNOWN'].includes(String(value.datePrecision)) && ((value.datePrecision === 'DAY') === (value.effectiveDay !== null)) &&
    [null, 'receivedDate', 'usedDate', 'loanDate'].includes(value.dateField as null) && nullableText(value.sourceDateText) &&
    [null, 'DATE_NOT_REPORTED', 'DATE_UNCONFIRMED', 'RETIREMENT_DATE_NOT_MAPPED'].includes(value.dateUncertainty as null) &&
    ((value.datePrecision === 'DAY') === (value.dateUncertainty === null)) && value.historicalActorId === null && value.affectsCurrentState === false &&
    record(value.original, value.recordId) && record(value.effective, value.recordId) &&
    (value.original as ObjectValue).sheet === (value.effective as ObjectValue).sheet && (value.original as ObjectValue).row === (value.effective as ObjectValue).row &&
    typeof value.identityLinkBlocked === 'boolean' && Array.isArray(value.issues) && value.issues.every((issue) => object(issue) && typeof issue.code === 'string' && ['BLOCKING', 'WARNING', 'INFO'].includes(String(issue.severity))) &&
    Array.isArray(value.sourceCorrections) && value.sourceCorrections.every((entry) => object(entry) && entry.recordId === value.recordId && entry.candidateId === value.candidateId &&
      integer(entry.revision, 1) && ['field', 'revisionId', 'reviewedById', 'note', 'evidenceReference', 'sheet', 'column'].every((key) => typeof entry[key] === 'string') && entry.action === 'REPLACE' && typeof entry.value === 'string' && integer(entry.row, 1) &&
      [entry.originalCell, entry.beforeCell, entry.afterCell].every((item) => item === null || cell(item))) &&
    Array.isArray(value.suggestedAssets) && value.suggestedAssets.every((asset) => object(asset) && uuid(asset.id) && object(asset.product) && typeof asset.product.name === 'string' &&
      nullableText(asset.serialNumber) && nullableText(asset.assetTag) && typeof asset.status === 'string' && typeof asset.isActive === 'boolean');
}
function previewObservation(value: unknown): value is PreviewObservation {
  if (!observation(value) || !object(value)) return false;
  const stored = value.stored;
  return (stored === null || (object(stored) && uuid(stored.id) && uuid(stored.captureId) && stored.recordId === value.recordId && stored.kind === value.kind &&
    (stored.assetId === null || uuid(stored.assetId)) && timestamp(stored.capturedAt))) &&
    Array.isArray(value.linkOptions) && value.linkOptions.every((entry) => object(entry) && uuid(entry.assetId) && basis(entry.basis)) &&
    new Set(value.linkOptions.map((entry) => entry.assetId)).size === value.linkOptions.length;
}
function scope(value: unknown): value is ObjectValue { return object(value) && value.scope === 'HISTORICAL_EVIDENCE_ONLY' && value.affectsCurrentState === false && value.canApply === false; }
function metadata(value: unknown): value is CaptureMetadata & ObjectValue {
  return object(value) && uuid(value.id) && uuid(value.batchId) && integer(value.batchVersion, 1) && integer(value.sourceRevision) &&
    hash(value.sourceHash) && hash(value.historyPreviewId) && typeof value.rulesVersion === 'string' &&
    ['note', 'evidenceReference', 'capturedById'].every((key) => typeof value[key] === 'string') && timestamp(value.capturedAt);
}
export function captured(value: unknown): value is CapturedObservation & ObjectValue { return observation(value) && (value.assetId === null ? value.linkBasis === null : uuid(value.assetId) && basis(value.linkBasis)); }
export function captureMetadata(value: unknown): value is CaptureMetadata { return metadata(value); }
export function sameSnapshot(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (Array.isArray(first) && Array.isArray(second)) return first.length === second.length && first.every((item, index) => sameSnapshot(item, second[index]));
  if (!object(first) || !object(second)) return false;
  return Object.keys(first).length === Object.keys(second).length && Object.entries(first).every(([key, value]) => Object.hasOwn(second, key) && sameSnapshot(value, second[key]));
}
function capture(value: unknown): value is HistoryCapture {
  if (!metadata(value) || !object(value) || !uuid(value.requestId) || !hash(value.requestDigest) || !Array.isArray(value.selection) ||
    !value.selection.length || value.selection.length > 25 || !value.selection.every(captured) || !Array.isArray(value.items) || value.items.length !== value.selection.length) return false;
  const selection = new Map(value.selection.map((entry) => [historyKey(entry), entry]));
  if (selection.size !== value.selection.length) return false;
  const keys = new Set<string>();
  return value.items.every((item) => {
    if (!object(item) || !uuid(item.id) || item.captureId !== value.id || item.sourceHash !== value.sourceHash || !captured(item.snapshot) || !timestamp(item.capturedAt)) return false;
    const key = historyKey(item.snapshot);
    const selected = selection.get(key);
    if (keys.has(key) || !selected || item.recordId !== selected.recordId || item.kind !== selected.kind || item.candidateId !== selected.candidateId ||
      item.effectiveDay !== selected.effectiveDay || item.assetId !== selected.assetId || !sameSnapshot(item.snapshot, selected)) return false;
    keys.add(key); return true;
  });
}
function invalid(): never { throw new ApiRequestError('Unexpected historical evidence response', 200, 'INVALID_RESPONSE'); }
function bounded(signal?: globalThis.AbortSignal) { const deadline = globalThis.AbortSignal.timeout(30_000); return signal ? globalThis.AbortSignal.any([signal, deadline]) : deadline; }
function page(value: ObjectValue, rows: unknown[], offset: number) {
  return integer(value.total) && value.limit === 25 && value.offset === offset && rows.length <= 25 && rows.length === Math.min(25, Math.max(0, Number(value.total) - offset)) &&
    value.hasMore === (offset + rows.length < Number(value.total));
}
function assetEvidence(value: unknown, assetId: string): value is AssetHistoryEvidence {
  if (!object(value) || !captured(value.snapshot)) return false;
  const snapshot = value.snapshot;
  if (!object(value) || !uuid(value.id) || value.assetId !== assetId || !metadata(value.capture) ||
    value.captureId !== value.capture.id || value.sourceHash !== value.capture.sourceHash || !timestamp(value.capturedAt) ||
    snapshot.assetId !== assetId ||
    !['recordId', 'candidateId', 'kind', 'effectiveDay'].every((key) => value[key] === snapshot[key]) ||
    !integer(value.evidenceVersion) || Number(value.evidenceVersion) > 1000 || !integer(value.effectiveSourceRevision) ||
    value.capturedSourceRevision !== value.capture.sourceRevision || Number(value.effectiveSourceRevision) < Number(value.capturedSourceRevision) ||
    !(value.capturedAssetId === null || uuid(value.capturedAssetId)) || !day(value.capturedEffectiveDay)) return false;
  if (value.evidenceVersion === 0) return value.amendmentId === null && value.amendedAt === null &&
    value.assetId === value.capturedAssetId && value.effectiveDay === value.capturedEffectiveDay && value.effectiveSourceRevision === value.capturedSourceRevision;
  return uuid(value.amendmentId) && timestamp(value.amendedAt);
}
export async function readAssetImportedEvidence(assetId: string, offset: number, signal: globalThis.AbortSignal): Promise<AssetHistoryPage> {
  const value = await apiRequest<unknown>(`/assets/${encodeURIComponent(assetId)}/imported-evidence?limit=25&offset=${offset}`, { signal: bounded(signal) });
  if (!scope(value) || !Array.isArray(value.evidence) || !value.evidence.every((entry) => assetEvidence(entry, assetId)) ||
    !page(value, value.evidence, offset) || new Set(value.evidence.map((entry) => entry.id)).size !== value.evidence.length) invalid();
  return { evidence: value.evidence as AssetHistoryEvidence[], total: Number(value.total), offset, limit: 25, hasMore: Boolean(value.hasMore) };
}
export async function readHistoryPreview(batchId: string, offset: number, signal: globalThis.AbortSignal): Promise<HistoryPreview> {
  const value = await apiRequest<unknown>(`${importReviewPath}/${batchId}/history-preview?limit=25&offset=${offset}`, { signal: bounded(signal) });
  if (!scope(value) || value.batchId !== batchId || value.mode !== 'HISTORY_PREVIEW' || value.persisted !== false || !integer(value.batchVersion, 1) || !integer(value.sourceRevision) ||
    !hash(value.historyPreviewId) || typeof value.historyRulesVersion !== 'string' || !Array.isArray(value.observations) || !value.observations.every(previewObservation) ||
    !page(value, value.observations, offset) || new Set(value.observations.map(historyKey)).size !== value.observations.length) invalid();
  return value as unknown as HistoryPreview;
}
export async function readHistoryCaptures(batchId: string, offset: number, signal: globalThis.AbortSignal) {
  const value = await apiRequest<unknown>(`${importReviewPath}/${batchId}/history-captures?limit=25&offset=${offset}`, { signal: bounded(signal) });
  if (!scope(value) || !Array.isArray(value.captures) || !value.captures.every((entry) => metadata(entry) && entry.batchId === batchId) ||
    !page(value, value.captures, offset) || new Set(value.captures.map((entry) => entry.id)).size !== value.captures.length) invalid();
  return { items: value.captures as CaptureMetadata[], total: Number(value.total), hasMore: Boolean(value.hasMore) };
}
export async function readHistoryCapture(batchId: string, captureId: string, signal: globalThis.AbortSignal) {
  const value = await apiRequest<unknown>(`${importReviewPath}/${batchId}/history-captures/${captureId}`, { signal: bounded(signal) });
  if (!scope(value) || value.persisted !== true || !capture(value.capture) || value.capture.id !== captureId || value.capture.batchId !== batchId) invalid();
  return value.capture;
}
export async function saveHistoryCapture(batchId: string, intent: HistoryIntent) {
  const signal = bounded();
  const token = await getCsrfToken(signal);
  const value = await apiRequest<unknown>(`${importReviewPath}/${batchId}/history-captures`, { method: 'POST', signal, headers: { 'X-CSRF-Token': token }, body: JSON.stringify(intent) });
  if (!scope(value) || value.persisted !== true || typeof value.reused !== 'boolean' || !capture(value.capture)) invalid();
  const saved = value.capture;
  if (saved.batchId !== batchId || saved.requestId !== intent.requestId || saved.batchVersion !== intent.expectedVersion || saved.sourceRevision !== intent.expectedSourceRevision ||
    saved.historyPreviewId !== intent.historyPreviewId || saved.note !== intent.note || saved.evidenceReference !== intent.evidenceReference || saved.items.length !== intent.records.length ||
    !intent.records.every((entry) => saved.items.some((item) => historyKey(item) === historyKey(entry) && item.assetId === entry.assetId))) invalid();
  return saved;
}
export function historyNeedsRecovery(error: unknown) {
  return !(error instanceof ApiRequestError) || error.status >= 500 || ['NETWORK_ERROR', 'INVALID_RESPONSE', 'HISTORY_CAPTURE_BUSY', 'HISTORY_CAPTURE_CONFLICT'].includes(error.code ?? '');
}
