import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import type { BatchDetail, Freshness, ImportBatch, ImportPreview, ReviewDecision, ReviewIntent } from './import-review-model';
import type { ApplicationMetadata } from './pilot-model';

export const importReviewPath = '/inventory/imports/batches';
type ObjectValue = Record<string, unknown>;
export function applicationMetadata(value: unknown): value is ApplicationMetadata {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['id', 'batchId', 'requestId', 'planId', 'sourceHash', 'appliedById', 'createdAt'].every((key) => typeof row[key] === 'string') && Number.isInteger(row.batchVersion);
}
function object(value: unknown): value is ObjectValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function strings(value: unknown): boolean { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function batch(value: unknown): value is ImportBatch {
  return object(value) && typeof value.id === 'string' && typeof value.sourceFileName === 'string' && typeof value.createdAt === 'string' && typeof value.asOf === 'string' && typeof value.previewId === 'string' &&
    Number.isInteger(value.version) && Number(value.version) > 0 && Number.isInteger(value.targetCount) && value.mode === 'REVIEW' && value.persisted === true && value.canApply === false;
}
function decision(value: unknown): value is ReviewDecision {
  return object(value) && ['id', 'batchId', 'requestId', 'targetId', 'note', 'reviewedById', 'createdAt'].every((key) => typeof value[key] === 'string') &&
    ['CANDIDATE', 'RECORD'].includes(String(value.targetType)) && ['HOLD', 'EXCLUDE', 'LINK_EXISTING', 'PROPOSE_NEW'].includes(String(value.action)) && Number.isInteger(value.batchVersion) &&
    (value.sourceRevision === undefined || (Number.isInteger(value.sourceRevision) && Number(value.sourceRevision) >= 0));
}
function invalid(): never { throw new ApiRequestError('Unexpected import review response', 200, 'INVALID_RESPONSE'); }

export async function readBatch(id: string, signal?: globalThis.AbortSignal): Promise<BatchDetail> {
  const value = await apiRequest<unknown>(`${importReviewPath}/${id}`, { signal });
  if (!object(value) || !batch(value.batch) || value.batch.id !== id || !object(value.reviewSummary) ||
    !['targetCount', 'reviewedTargetCount', 'unreviewedCount', 'holdCount', 'excludedCount', 'linkedCount', 'newProposalCount', 'pendingTargetCount'].every((key) => Number.isInteger((value.reviewSummary as ObjectValue)[key])) || typeof value.reviewSummary.decisionCoverageComplete !== 'boolean') invalid();
  return value as BatchDetail;
}

export async function readSnapshot(id: string, signal?: globalThis.AbortSignal): Promise<ImportPreview> {
  const wrapper = await apiRequest<unknown>(`${importReviewPath}/${id}/preview`, { signal });
  if (!object(wrapper) || wrapper.batchId !== id || wrapper.persisted !== true || wrapper.canApply !== false || !object(wrapper.snapshot)) invalid();
  return parseImportPreview(wrapper.snapshot);
}

export function parseImportPreview(value: unknown): ImportPreview {
  if (!object(value)) invalid();
  const arrays = ['records', 'candidates', 'issues', 'excluded', 'sheets'];
  if (value.mode !== 'PREVIEW' || value.canApply !== false || value.persisted !== false || !object(value.source) || typeof value.source.fileName !== 'string' || typeof value.previewId !== 'string' || !object(value.summary) || !arrays.every((key) => Array.isArray(value[key]))) invalid();
  if (!(value.records as unknown[]).every((record) => object(record) && typeof record.id === 'string' && typeof record.sheet === 'string' && Number.isInteger(record.row) && typeof record.kind === 'string' && object(record.fields) && Object.values(record.fields).every((field) => field === null || typeof field === 'string') && object(record.originalCells) && Object.values(record.originalCells).every((cell) => object(cell) && typeof cell.type === 'string' && ['string', 'number', 'boolean'].includes(typeof cell.value)))) invalid();
  if (!(value.candidates as unknown[]).every((candidate) => object(candidate) && typeof candidate.id === 'string' && strings(candidate.serials) && strings(candidate.tags) && strings(candidate.recordIds) && typeof candidate.proposal === 'string' && Array.isArray(candidate.existingAssets) && candidate.existingAssets.every((asset) => object(asset) && typeof asset.id === 'string' && object(asset.product) && typeof asset.product.name === 'string'))) invalid();
  if (!(value.issues as unknown[]).every((issue) => object(issue) && typeof issue.code === 'string' && ['BLOCKING', 'WARNING', 'INFO'].includes(String(issue.severity)))) invalid();
  if (!(value.sheets as unknown[]).every((sheet) => object(sheet) && typeof sheet.name === 'string' && typeof sheet.kind === 'string' && typeof sheet.headerValid === 'boolean' && Number.isInteger(sheet.recordCount))) invalid();
  if (!(value.excluded as unknown[]).every((record) => object(record) && typeof record.sheet === 'string' && Number.isInteger(record.row) && typeof record.reason === 'string' && object(record.originalCells))) invalid();
  return value as ImportPreview;
}

export async function readFreshness(id: string, signal?: globalThis.AbortSignal): Promise<Freshness> {
  const value = await apiRequest<unknown>(`${importReviewPath}/${id}/freshness`, { signal });
  if (!object(value) || value.batchId !== id || !['stale', 'rulesChanged', 'databaseChanged', 'reviewDateChanged'].every((key) => typeof value[key] === 'boolean') || typeof value.checkedAsOf !== 'string' || value.canApply !== false) invalid();
  return value as Freshness;
}

export async function readReviewPage<Row>(path: string, kind: 'batches' | 'decisions' | 'applications', signal: globalThis.AbortSignal): Promise<{ rows: Row[]; total: number; hasMore: boolean }> {
  const value = await apiRequest<unknown>(path, { signal });
  if (!object(value) || !Array.isArray(value[kind]) || !(value[kind] as unknown[]).every(kind === 'batches' ? batch : kind === 'applications' ? applicationMetadata : decision) || !Number.isInteger(value.total) || Number(value.total) < 0 || typeof value.hasMore !== 'boolean' || (value.hasMore && value[kind].length === 0)) invalid();
  const url = new globalThis.URL(path, 'https://inventory.invalid');
  const query = url.searchParams;
  const batchId = url.pathname.split('/').at(-2);
  if (kind === 'applications' && (value.applications as { batchId: string }[]).some((item) => item.batchId !== batchId)) invalid();
  if (kind === 'decisions' && (value.mode !== (query.get('mode') ?? 'latest') || (value.decisions as ReviewDecision[]).some((item) => item.batchId !== batchId || (query.has('targetId') && item.targetId !== query.get('targetId')) || (query.has('targetType') && item.targetType !== query.get('targetType'))))) invalid();
  return { rows: value[kind] as Row[], total: Number(value.total), hasMore: value.hasMore };
}

export async function saveReviewDecision(id: string, intent: ReviewIntent): Promise<void> {
  const token = await getCsrfToken();
  const value = await apiRequest<unknown>(`${importReviewPath}/${id}/decisions`, { method: 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify(intent) });
  if (!object(value) || !batch(value.batch) || !decision(value.decision) || value.batch.id !== id || value.decision.batchId !== id || value.decision.requestId !== intent.requestId || value.decision.targetType !== intent.targetType || value.decision.targetId !== intent.targetId || typeof value.reused !== 'boolean') invalid();
  if (value.decision.action !== intent.action || value.decision.note !== intent.note || value.decision.linkedAssetId !== (intent.linkedAssetId ?? null) || value.decision.batchVersion !== intent.expectedVersion + 1 || (intent.expectedSourceRevision !== undefined && value.decision.sourceRevision !== intent.expectedSourceRevision)) invalid();
}
