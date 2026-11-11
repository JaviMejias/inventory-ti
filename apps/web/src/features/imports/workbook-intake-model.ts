import { ApiRequestError } from '../../lib/api';
import type { ImportPreview, SourceCell } from './import-review-model';

export const workbookBodyLimit = 16 * 1024 * 1024;
export type WorkbookInput = { formatVersion: 1; source: { fileName: string; sha256: string }; sheets: Array<{ name: string; hidden?: boolean; filterRange?: string | null; rows: Array<{ row: number; hidden?: boolean; cells: Record<string, Omit<SourceCell, 'cachedValue'> & { cachedValue?: string | number | boolean | null }> }> }> };
export type DatabasePreview = ImportPreview & { comparisonMode: 'DATABASE'; rulesVersion: 'mda-preview-1'; payloadDigest: string; databaseSnapshotDigest: string; timeZone: 'America/Santiago' };
export type BatchIntakeIntent = { workbook: WorkbookInput; previewId: string };
type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Value, required: string[], optional: string[] = []) { return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)); }
function sized(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length <= limit; }
function scalar(value: unknown) { return value === null || sized(value, 8192) || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value); }
function cell(value: unknown) {
  if (!object(value) || !keys(value, ['type', 'value'], ['numberFormat', 'cachedValue', 'rawValue', 'formulaAttributes']) || !['text', 'number', 'date', 'formula', 'boolean', 'error'].includes(String(value.type))) return false;
  const valid = value.type === 'number' ? typeof value.value === 'number' && Number.isFinite(value.value) : value.type === 'boolean' ? typeof value.value === 'boolean' : sized(value.value, 8192);
  return valid && (value.type !== 'formula' || String(value.value).startsWith('=')) &&
    (!Object.hasOwn(value, 'numberFormat') || sized(value.numberFormat, 256)) && (!Object.hasOwn(value, 'rawValue') || sized(value.rawValue, 8192)) &&
    (!Object.hasOwn(value, 'cachedValue') || scalar(value.cachedValue)) && (!Object.hasOwn(value, 'formulaAttributes') || object(value.formulaAttributes) && Object.values(value.formulaAttributes).every((entry) => sized(entry, 256)));
}
function invalid(message: string): never { throw new ApiRequestError(message, 400, 'INVALID_WORKBOOK_INPUT'); }
export function validateWorkbookInput(value: unknown): WorkbookInput {
  if (!object(value) || !keys(value, ['formatVersion', 'source', 'sheets']) || value.formatVersion !== 1 || !object(value.source) || !keys(value.source, ['fileName', 'sha256']) ||
    !sized(value.source.fileName, 255) || !/^[^/\\]+\.xlsx$/i.test(value.source.fileName) || [...value.source.fileName].some((character) => character.charCodeAt(0) < 32) || typeof value.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.source.sha256) ||
    !Array.isArray(value.sheets) || !value.sheets.length || value.sheets.length > 32) invalid('El JSON no tiene el formato del extractor: revisa versión, origen y hojas.');
  let rows = 0; let cells = 0; const names = new Set<string>();
  for (const sheet of value.sheets) {
    if (!object(sheet) || !keys(sheet, ['name', 'rows'], ['hidden', 'filterRange']) || !sized(sheet.name, 100) || !sheet.name || names.has(sheet.name) || !Array.isArray(sheet.rows) || sheet.rows.length > 15000 ||
      Object.hasOwn(sheet, 'hidden') && typeof sheet.hidden !== 'boolean' || Object.hasOwn(sheet, 'filterRange') && sheet.filterRange !== null && !sized(sheet.filterRange, 100)) invalid('Revisa nombres únicos, filas, visibilidad y filtros de las hojas del JSON.');
    names.add(sheet.name); const positions = new Set<number>();
    for (const row of sheet.rows) {
      if (!object(row) || !keys(row, ['row', 'cells'], ['hidden']) || !Number.isInteger(row.row) || Number(row.row) < 1 || Number(row.row) > 1048576 || positions.has(Number(row.row)) ||
        Object.hasOwn(row, 'hidden') && typeof row.hidden !== 'boolean' || !object(row.cells) || Object.keys(row.cells).length > 64 || !Object.entries(row.cells).every(([column, value]) => /^[A-Z]{1,3}$/.test(column) && cell(value))) invalid('El JSON contiene filas repetidas, posiciones o celdas inválidas. No se recortará el origen.');
      positions.add(Number(row.row)); rows++; cells += Object.keys(row.cells).length;
      if (rows > 15000 || cells > 150000) invalid('El archivo supera 15.000 filas o 150.000 celdas pobladas. No se admite una extracción parcial.');
    }
  }
  return value as unknown as WorkbookInput;
}
export function freezeWorkbook<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freezeWorkbook); Object.freeze(value); } return value; }
export function parseWorkbookJSON(text: string): WorkbookInput {
  if (new globalThis.TextEncoder().encode(text).byteLength > workbookBodyLimit) invalid('El JSON supera el límite de 16 MiB.');
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return invalid('No se pudo leer el JSON. Selecciona la extracción JSON original.'); }
  return freezeWorkbook(validateWorkbookInput(value));
}
export function captureBatchIntake(workbook: WorkbookInput, preview: DatabasePreview): BatchIntakeIntent {
  const captured = globalThis.structuredClone(validateWorkbookInput(workbook));
  if (preview.source.fileName !== captured.source.fileName || preview.source.sha256 !== captured.source.sha256 || !/^[a-f0-9]{64}$/.test(preview.previewId)) invalid('La previsualización no corresponde a este origen. Vuelve a generarla.');
  const intent = { workbook: captured, previewId: preview.previewId };
  if (new globalThis.TextEncoder().encode(JSON.stringify(intent)).byteLength > workbookBodyLimit) invalid('El origen completo y su previsualización superan 16 MiB. No se recortará el archivo para guardarlo.');
  return freezeWorkbook(intent);
}
