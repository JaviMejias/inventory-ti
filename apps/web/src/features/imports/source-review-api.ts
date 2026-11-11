import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { importReviewPath, parseImportPreview } from './import-review-api';
import { sourceFieldLabels, type AuditedChange, type ResolvedReviewSource, type RevisionIntent, type SourceEvent } from './source-review-model';

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, min = 0): boolean { return Number.isInteger(value) && Number(value) >= min; }
export function validSourceCell(value: unknown) { return value === null || (object(value) && typeof value.type === 'string' && ['string', 'number', 'boolean'].includes(typeof value.value) &&
  (value.numberFormat === undefined || typeof value.numberFormat === 'string') && (value.rawValue === undefined || typeof value.rawValue === 'string') &&
  (value.cachedValue === undefined || value.cachedValue === null || ['string', 'number', 'boolean'].includes(typeof value.cachedValue)) &&
  (value.formulaAttributes === undefined || (object(value.formulaAttributes) && Object.values(value.formulaAttributes).every((item) => typeof item === 'string')))); }
function invalid(): never { throw new ApiRequestError('Unexpected source review response', 200, 'INVALID_RESPONSE'); }
function boundedSignal(signal?: globalThis.AbortSignal) {
  const deadline = globalThis.AbortSignal.timeout(30_000);
  return signal ? globalThis.AbortSignal.any([signal, deadline]) : deadline;
}
function change(value: unknown): value is AuditedChange {
  return object(value) && ['recordId', 'candidateId', 'sheet', 'column'].every((key) => typeof value[key] === 'string') && integer(value.row, 1) &&
    typeof value.field === 'string' && Object.hasOwn(sourceFieldLabels, value.field) && ['REPLACE', 'RESTORE'].includes(String(value.action)) &&
    (value.action !== 'REPLACE' || typeof value.value === 'string') && [value.originalCell, value.beforeCell, value.afterCell].every(validSourceCell);
}
function event(value: unknown): value is SourceEvent {
  return object(value) && ['id', 'batchId', 'requestId', 'requestDigest', 'note', 'evidenceReference', 'reviewedById', 'createdAt'].every((key) => typeof value[key] === 'string') &&
    integer(value.revision, 1) && integer(value.expectedBatchVersion, 1) && Array.isArray(value.changes) && value.changes.length > 0 && value.changes.length <= 25 && value.changes.every(change) &&
    new Set(value.changes.map((item) => item.recordId + ':' + item.field)).size === value.changes.length;
}
export async function readResolvedReviewSource(id: string, signal?: globalThis.AbortSignal): Promise<ResolvedReviewSource> {
  const value = await apiRequest<unknown>(`${importReviewPath}/${id}/resolved-preview`, { signal: boundedSignal(signal) });
  if (!object(value) || value.batchId !== id || !integer(value.batchVersion, 1) || value.canApply !== false || !object(value.sourceContext) || !integer(value.sourceContext.revision) ||
    !Array.isArray(value.sourceContext.corrections) || !value.sourceContext.corrections.every((item) => object(item) && item.action === 'REPLACE' &&
      ['revisionId', 'reviewedById', 'note', 'evidenceReference'].every((key) => typeof item[key] === 'string') && integer(item.revision, 1) && Number(item.revision) <= Number((value.sourceContext as Record<string, unknown>).revision) && change(item)) ||
    (value.sourceContext.identityRevisions !== undefined && (!Array.isArray(value.sourceContext.identityRevisions) || !value.sourceContext.identityRevisions.every((item) => object(item) && typeof item.candidateId === 'string' && integer(item.revision, 1) && Number(item.revision) <= Number((value.sourceContext as Record<string, unknown>).revision))))) invalid();
  parseImportPreview(value.preview);
  return value as ResolvedReviewSource;
}
export async function readSourceEvents(id: string, offset: number, signal: globalThis.AbortSignal) {
  const value = await apiRequest<unknown>(`${importReviewPath}/${id}/source-revisions?limit=25&offset=${offset}`, { signal: boundedSignal(signal) });
  if (!object(value) || value.canApply !== false || !integer(value.revision) || !integer(value.total) || value.limit !== 25 || value.offset !== offset || typeof value.hasMore !== 'boolean' ||
    !Array.isArray(value.events) || value.events.length > 25 || !value.events.every((item) => event(item) && item.batchId === id && item.revision <= Number(value.revision)) ||
    value.hasMore !== (offset + value.events.length < Number(value.total)) || (value.hasMore && !value.events.length) ||
    value.events.some((item, index) => index > 0 && item.revision >= (value.events as SourceEvent[])[index - 1].revision)) invalid();
  return { rows: value.events as SourceEvent[], total: Number(value.total), hasMore: value.hasMore, revision: Number(value.revision) };
}
export async function saveSourceRevision(id: string, intent: RevisionIntent): Promise<SourceEvent> {
  const signal = boundedSignal();
  const token = await getCsrfToken(signal);
  const identity = 'candidateId' in intent;
  const value = await apiRequest<unknown>(`${importReviewPath}/${id}/${identity ? 'identity-revisions' : 'source-revisions'}`, { method: 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify(intent), signal });
  if (!object(value) || value.canApply !== false || typeof value.reused !== 'boolean' || !event(value.event)) invalid();
  const saved = value.event;
  if (saved.changes.some((entry) => entry.action === 'REPLACE' ?
    entry.afterCell?.value !== entry.value || entry.afterCell?.type !== (entry.field === 'receivedDate' ? 'date' : 'text') :
    JSON.stringify(entry.originalCell) !== JSON.stringify(entry.afterCell))) invalid();
  if (saved.batchId !== id || saved.requestId !== intent.requestId || saved.revision !== intent.expectedRevision + 1 || saved.expectedBatchVersion !== intent.expectedBatchVersion || saved.note !== intent.note || saved.evidenceReference !== intent.evidenceReference) invalid();
  if (identity) {
    if (saved.changes.some((entry) => entry.candidateId !== intent.candidateId || !['serialNumber', 'assetTag'].includes(entry.field) || entry.action !== (intent.action === 'VERIFY' ? 'REPLACE' : 'RESTORE') ||
      (intent.action === 'VERIFY' && entry.value !== intent[entry.field as 'serialNumber' | 'assetTag']))) invalid();
  } else if (saved.changes.length !== intent.changes.length || saved.changes.some((entry) => !intent.changes.some((requested) => requested.recordId === entry.recordId && requested.field === entry.field && requested.action === entry.action && (requested.action === 'RESTORE' || requested.value === entry.value)))) invalid();
  return saved;
}
