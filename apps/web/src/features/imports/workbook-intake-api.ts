import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { validHistoricalInstant } from './closed-assignment-model';
import { importReviewPath, parseImportPreview } from './import-review-api';
import { sameSnapshot } from './history-evidence-api';
import { captureBatchIntake, freezeWorkbook, validateWorkbookInput, workbookBodyLimit, type BatchIntakeIntent, type DatabasePreview, type WorkbookInput } from './workbook-intake-model';
import type { ImportBatch } from './import-review-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function invalid(): never { throw new ApiRequestError('Unexpected workbook preview receipt', 200, 'INVALID_RESPONSE'); }
export function validateDatabasePreview(value: unknown, workbook: WorkbookInput): DatabasePreview {
  const preview = parseImportPreview(value);
  if (!object(value) || preview.comparisonMode !== 'DATABASE' || value.rulesVersion !== 'mda-preview-1' || value.timeZone !== 'America/Santiago' || !['previewId', 'payloadDigest', 'databaseSnapshotDigest'].every((key) => hash(value[key])) ||
    !sameSnapshot(preview.source, workbook.source) || !/^\d{4}-\d{2}-\d{2}$/.test(preview.asOf) || !validHistoricalInstant(preview.asOf + 'T00:00:00Z') ||
    preview.sheets.length !== workbook.sheets.length || new Set(preview.sheets.map((sheet) => sheet.name)).size !== preview.sheets.length ||
    !preview.sheets.every((sheet) => workbook.sheets.some((original) => original.name === sheet.name && sheet.hidden === (original.hidden ?? false) && sheet.filterRange === (original.filterRange ?? null)))) invalid();
  const counts = preview.summary;
  const recordIds = new Set(preview.records.map((row) => row.id));
  const originalRows = new Map(workbook.sheets.flatMap((sheet) => sheet.rows.map((row) => [sheet.name + ':' + row.row, row])));
  const receivedRows = [...preview.records, ...preview.excluded];
  if (new Set(receivedRows.map((row) => row.sheet + ':' + row.row)).size !== originalRows.size || receivedRows.length !== originalRows.size || !receivedRows.every((row) => {
    const original = originalRows.get(row.sheet + ':' + row.row); return original && sameSnapshot(row.originalCells, original.cells);
  }) || !preview.records.every((row) => hash(row.id)) || recordIds.size !== preview.records.length ||
    !preview.candidates.every((candidate) => hash(candidate.id) && candidate.recordIds.every((id) => recordIds.has(id))) || new Set(preview.candidates.map((row) => row.id)).size !== preview.candidates.length ||
    !preview.sheets.every((sheet) => sheet.populatedRows === workbook.sheets.find((row) => row.name === sheet.name)?.rows.length && sheet.recordCount + sheet.excludedCount === sheet.populatedRows)) invalid();
  if (!Object.values(counts).every((count) => Number.isInteger(count) && count >= 0) || counts.sheetCount !== preview.sheets.length || counts.recordCount !== preview.records.length || counts.candidateCount !== preview.candidates.length || counts.excludedCount !== preview.excluded.length ||
    counts.populatedRows !== workbook.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) || counts.populatedRows !== counts.recordCount + counts.excludedCount ||
    ['BLOCKING', 'WARNING', 'INFO'].some((severity) => counts[severity === 'BLOCKING' ? 'blockingIssueCount' : severity === 'WARNING' ? 'warningCount' : 'infoCount'] !== preview.issues.filter((issue) => issue.severity === severity).length)) invalid();
  return freezeWorkbook(globalThis.structuredClone(value)) as DatabasePreview;
}
function bounded(signal?: globalThis.AbortSignal) { const timeout = globalThis.AbortSignal.timeout(30_000); return signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout; }
export async function previewWorkbook(workbook: WorkbookInput, signal: globalThis.AbortSignal): Promise<DatabasePreview> {
  const captured = globalThis.structuredClone(validateWorkbookInput(workbook)); const body = JSON.stringify(captured);
  if (new globalThis.TextEncoder().encode(body).byteLength > workbookBodyLimit) throw new ApiRequestError('El JSON supera 16 MiB.', 400, 'INVALID_WORKBOOK_INPUT');
  const deadline = bounded(signal); const csrf = await getCsrfToken(deadline);
  return validateDatabasePreview(await apiRequest<unknown>('/inventory/imports/preview', { method: 'POST', signal: deadline, headers: { 'X-CSRF-Token': csrf }, body }), captured);
}
export async function createWorkbookBatch(intent: BatchIntakeIntent, preview: DatabasePreview): Promise<{ batch: ImportBatch; reused: boolean }> {
  const captured = captureBatchIntake(intent.workbook, validateDatabasePreview(preview, intent.workbook));
  if (!sameSnapshot(intent, captured)) throw new ApiRequestError('Revisa el origen y su previsualización.', 400, 'INVALID_WORKBOOK_INPUT');
  const body = JSON.stringify(captured); const deadline = bounded(); const csrf = await getCsrfToken(deadline);
  const value = await apiRequest<unknown>(importReviewPath, { method: 'POST', signal: deadline, headers: { 'X-CSRF-Token': csrf }, body });
  if (!object(value) || !object(value.batch) || typeof value.reused !== 'boolean') invalid();
  const batch = value.batch;
  if (batch.mode !== 'REVIEW' || batch.persisted !== true || batch.canApply !== false || !uuid(batch.id) || !uuid(batch.createdById) || !['createdAt', 'updatedAt'].every((key) => typeof batch[key] === 'string' && validHistoricalInstant(batch[key] as string)) ||
    !Number.isInteger(batch.version) || Number(batch.version) < 1 || batch.sourceFileName !== preview.source.fileName || batch.sourceHash !== preview.source.sha256 || batch.previewId !== preview.previewId || batch.payloadDigest !== preview.payloadDigest || batch.databaseSnapshotDigest !== preview.databaseSnapshotDigest || batch.rulesVersion !== preview.rulesVersion || batch.asOf !== preview.asOf ||
    batch.targetCount !== preview.candidates.length + preview.records.filter((record) => !['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(record.kind)).length) invalid();
  return freezeWorkbook(globalThis.structuredClone({ batch, reused: value.reused })) as { batch: ImportBatch; reused: boolean };
}
export function batchIntakeNeedsRecovery(error: unknown) { return !(error instanceof ApiRequestError) || error.status >= 500 || ['NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code ?? ''); }
