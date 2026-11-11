import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { sheetDictionary, type SheetKind } from './dictionary.js';
import type { SourceCell, SourceRow, WorkbookPreviewInput } from './schemas.js';

export const previewRulesVersion = 'mda-preview-1';
type Severity = 'BLOCKING' | 'WARNING' | 'INFO';
export type PreviewIssue = { code: string; severity: Severity; sheet: string | null; row: number | null; cell: string | null; candidateId: string | null };
export type ExistingAsset = {
  id: string; productId: string; serialNumber: string | null; assetTag: string | null;
  status: string; isActive: boolean; updatedAt: Date | string; product: { name: string };
};
type PreviewRecord = {
  id: string; sheet: string; row: number; hidden: boolean; kind: SheetKind;
  fields: Record<string, string | null>; originalCells: SourceRow['cells'];
  serialKey: string | null; tagKey: string | null;
  statusEvidence: 'AVAILABLE' | 'DECOMMISSIONED' | null;
};

export function normalizedText(value: string): string {
  return value.replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ');
}

function comparisonText(value: string): string {
  return normalizedText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

export function identifierKey(value: string | null): string | null {
  if (value === null) return null;
  const key = normalizedText(value).toUpperCase();
  return ['', 'N/A', 'NA', 'N.A.', 'S/N', 'SIN SERIE', 'SIN ACTIVO', '-'].includes(key) ? null : key;
}

function scalarText(cell: SourceCell | undefined): string | null {
  if (!cell || cell.type === 'formula' || cell.type === 'error') return null;
  return normalizedText(String(cell.value));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function previewDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function workbookPayloadDigest(input: WorkbookPreviewInput): string {
  return digest(input);
}

export function buildWorkbookPreview(input: WorkbookPreviewInput, existing: ExistingAsset[] = [], asOf = previewDate(), comparisonMode: 'SOURCE_ONLY' | 'DATABASE' = 'SOURCE_ONLY') {
  const issues: PreviewIssue[] = [];
  const records: PreviewRecord[] = [];
  const excluded: { sheet: string; row: number; reason: 'HEADER_OR_TITLE' | 'REPEATED_HEADER' | 'EMPTY'; originalCells: SourceRow['cells'] }[] = [];
  const sheets: { name: string; kind: SheetKind; headerValid: boolean; populatedRows: number; recordCount: number; excludedCount: number; hidden: boolean; filterRange: string | null }[] = [];
  const issue = (code: string, severity: Severity, sheet: string | null = null, row: number | null = null, cell: string | null = null, candidateId: string | null = null) => {
    issues.push({ code, severity, sheet, row, cell, candidateId });
  };
  for (const sheetName of Object.keys(sheetDictionary)) {
    if (!input.sheets.some((sheet) => sheet.name === sheetName)) issue('MISSING_SHEET', 'WARNING', sheetName);
  }
  for (const sheet of [...input.sheets].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const mapping = Object.hasOwn(sheetDictionary, sheet.name) ? sheetDictionary[sheet.name] : undefined;
    const header = mapping ? sheet.rows.find((row) => row.row === mapping.headerRow) : undefined;
    const headerMatches = (row: SourceRow) => mapping ? Object.entries(mapping.columns).filter(([column, definition]) => {
      return comparisonText(scalarText(row.cells[column]) ?? '') === comparisonText(definition.header);
    }).length : 0;
    const headerValid = Boolean(mapping && header && headerMatches(header) === Object.keys(mapping.columns).length);
    if (!mapping) issue('UNKNOWN_SHEET', 'BLOCKING', sheet.name);
    else if (!headerValid) issue('HEADER_MISMATCH', 'BLOCKING', sheet.name, mapping.headerRow);
    if (mapping?.kind === 'CONSUMABLE_REVIEW') issue('CONSUMABLE_UNIT_UNCONFIRMED', 'BLOCKING', sheet.name);
    if (mapping?.kind === 'MANUAL_SUMMARY') issue('MANUAL_SUMMARY_NOT_STOCK', 'INFO', sheet.name);
    const initialRecords = records.length;
    const initialExcluded = excluded.length;
    for (const row of [...sheet.rows].sort((a, b) => a.row - b.row)) {
      const exclusion = !Object.keys(row.cells).length ? 'EMPTY'
        : mapping && row.row <= mapping.headerRow ? 'HEADER_OR_TITLE'
          : mapping && headerMatches(row) >= Math.max(3, Math.ceil(Object.keys(mapping.columns).length / 2)) ? 'REPEATED_HEADER' : null;
      if (exclusion) {
        excluded.push({ sheet: sheet.name, row: row.row, reason: exclusion, originalCells: row.cells });
        continue;
      }
      const fields: Record<string, string | null> = {};
      const fieldCells = new Map<string, SourceCell | undefined>();
      if (mapping && headerValid) {
        for (const [column, definition] of Object.entries(mapping.columns)) {
          fields[definition.field] = scalarText(row.cells[column]);
          fieldCells.set(definition.field, row.cells[column]);
        }
      }
      let kind: SheetKind = headerValid ? mapping!.kind : 'UNMAPPED';
      const populatedFields = [...fieldCells.entries()].filter(([, cell]) => cell !== undefined);
      if ((kind === 'ASSET_OBSERVATION' || kind === 'RETIREMENT_HISTORY') && populatedFields.length > 0 &&
        populatedFields.length === Object.keys(row.cells).length && populatedFields.every(([field]) => ['notes', 'details', 'description'].includes(field))) {
        kind = 'SOURCE_NOTE';
        issue('SOURCE_NOTE_NOT_ASSET', 'INFO', sheet.name, row.row);
      }
      for (const [column, cell] of Object.entries(row.cells)) {
        if (cell.type === 'formula') issue('FORMULA_REQUIRES_REVIEW', 'BLOCKING', sheet.name, row.row, column + row.row);
        if (cell.type === 'error') issue('EXCEL_CELL_ERROR', 'BLOCKING', sheet.name, row.row, column + row.row);
        if (mapping && headerValid && !Object.hasOwn(mapping.columns, column)) issue('UNMAPPED_COLUMN', 'BLOCKING', sheet.name, row.row, column + row.row);
        const field = mapping?.columns[column]?.field;
        if (field?.endsWith('Date') && identifierKey(scalarText(cell)) !== null) {
          const value = scalarText(cell) ?? '';
          const dateOnly = value.slice(0, 10);
          const parsed = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.test(value) ? new Date(dateOnly + 'T00:00:00Z') : null;
          if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateOnly) {
            issue('DATE_REQUIRES_REVIEW', 'BLOCKING', sheet.name, row.row, column + row.row);
          } else if (dateOnly > asOf) issue('FUTURE_SOURCE_DATE', 'BLOCKING', sheet.name, row.row, column + row.row);
        }
      }
      const physical = kind === 'ASSET_OBSERVATION' || kind === 'RETIREMENT_HISTORY';
      const serialCell = fieldCells.get('serialNumber');
      const numericSerial = serialCell?.type === 'number';
      const serialKey = physical && serialCell?.type === 'text' ? identifierKey(fields.serialNumber ?? null) : null;
      const tagCell = fieldCells.get('assetTag');
      const numericTagUnsafe = tagCell?.type === 'number' && (!Number.isSafeInteger(tagCell.value) || String(tagCell.value).length > 15);
      const numericTagFormatAmbiguous = tagCell?.type === 'number' &&
        ((tagCell.numberFormat !== undefined && !['General', '0'].includes(tagCell.numberFormat)) || /^0\d/.test(tagCell.rawValue ?? ''));
      const validTagType = tagCell?.type === 'text' || tagCell?.type === 'number';
      const tagKey = physical && validTagType && !numericTagUnsafe && !numericTagFormatAmbiguous ? identifierKey(fields.assetTag ?? null) : null;
      if (physical && ((serialCell && !['text', 'number', 'formula', 'error'].includes(serialCell.type)) || (tagCell && !['text', 'number', 'formula', 'error'].includes(tagCell.type)))) issue('IDENTIFIER_TYPE_REQUIRES_REVIEW', 'BLOCKING', sheet.name, row.row);
      if (numericSerial) issue('NUMERIC_SERIAL_REQUIRES_REVIEW', 'BLOCKING', sheet.name, row.row);
      if (numericTagUnsafe) issue('NUMERIC_TAG_PRECISION_RISK', 'BLOCKING', sheet.name, row.row);
      if (numericTagFormatAmbiguous) issue('NUMERIC_TAG_FORMAT_REQUIRES_REVIEW', 'BLOCKING', sheet.name, row.row);
      if (physical && !serialKey && !tagKey) issue('MISSING_ASSET_IDENTITY', 'BLOCKING', sheet.name, row.row);
      if (physical && !identifierKey(fields.model ?? null)) issue('MISSING_PRODUCT_MODEL', 'WARNING', sheet.name, row.row);
      const availability = comparisonText(fields.availability ?? fields.mixedState ?? '');
      const statusEvidence = kind === 'RETIREMENT_HISTORY' || availability === 'BAJA' || availability === 'RETIRADO' ? 'DECOMMISSIONED'
        : availability === 'DISPONIBLE' ? 'AVAILABLE' : null;
      if (physical && availability && statusEvidence === null) issue('OPERATIONAL_STATE_UNRESOLVED', 'WARNING', sheet.name, row.row);
      if (fields.mixedState && /^(BODEGA|CIUDAD EMPRESARIAL|CE$)/.test(comparisonText(fields.mixedState))) issue('POSSIBLE_SHIFTED_STATE_COLUMN', 'BLOCKING', sheet.name, row.row);
      const details = [fields.details, fields.notes, fields.recipientText].filter(Boolean).join(' ');
      if (statusEvidence === 'AVAILABLE' && /ASIGNAD|ENVIAD|PRESTAM/i.test(comparisonText(details))) issue('AVAILABILITY_ASSIGNMENT_CONFLICT', 'BLOCKING', sheet.name, row.row);
      if (fields.ipAddress && !isIP(fields.ipAddress)) issue('INVALID_IP_ADDRESS', 'BLOCKING', sheet.name, row.row);
      if (fields.networkPrefix && fields.ipAddress && isIP(fields.ipAddress) === 4 && !fields.ipAddress.startsWith(fields.networkPrefix + '.')) issue('NETWORK_PREFIX_IP_CONFLICT', 'BLOCKING', sheet.name, row.row);
      if (fields.usedDate && fields.receivedDate && /^\d{4}-\d{2}-\d{2}/.test(fields.usedDate) && /^\d{4}-\d{2}-\d{2}/.test(fields.receivedDate) && fields.usedDate.slice(0, 10) < fields.receivedDate.slice(0, 10)) issue('SOURCE_DATE_ORDER_CONFLICT', 'BLOCKING', sheet.name, row.row);
      if (kind === 'RETIREMENT_HISTORY') issue('RETIREMENT_DATE_UNCONFIRMED', 'WARNING', sheet.name, row.row);
      records.push({ id: digest([input.source.sha256, sheet.name, row.row]), sheet: sheet.name, row: row.row, hidden: row.hidden, kind, fields, originalCells: row.cells, serialKey, tagKey, statusEvidence });
    }
    sheets.push({ name: sheet.name, kind: headerValid ? mapping!.kind : 'UNMAPPED', headerValid, populatedRows: sheet.rows.length, recordCount: records.length - initialRecords, excludedCount: excluded.length - initialExcluded, hidden: sheet.hidden, filterRange: sheet.filterRange ?? null });
  }

  const physical = records.filter((record) => record.kind === 'ASSET_OBSERVATION' || record.kind === 'RETIREMENT_HISTORY');
  const tagSerials = new Map<string, Set<string>>();
  for (const record of physical) {
    if (record.tagKey && record.serialKey) {
      const serials = tagSerials.get(record.tagKey) ?? new Set<string>();
      serials.add(record.serialKey);
      tagSerials.set(record.tagKey, serials);
    }
  }
  const grouped = new Map<string, PreviewRecord[]>();
  for (const record of physical) {
    const serials = record.tagKey ? tagSerials.get(record.tagKey) : undefined;
    const serial = record.serialKey ?? (serials?.size === 1 ? [...serials][0] : null);
    const key = serial ? 'SERIAL:' + serial : record.tagKey ? 'TAG:' + record.tagKey : 'UNIDENTIFIED:' + record.id;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  const bySerial = new Map<string, ExistingAsset[]>();
  const byTag = new Map<string, ExistingAsset[]>();
  for (const asset of existing) {
    for (const [index, key] of [[bySerial, identifierKey(asset.serialNumber)], [byTag, identifierKey(asset.assetTag)]] as const) {
      if (key) index.set(key, [...(index.get(key) ?? []), asset]);
    }
  }
  const candidates = [...grouped.keys()].sort().map((key) => {
    const observations = grouped.get(key)!;
    const id = digest([input.source.sha256, key]);
    const tags = [...new Set(observations.map((record) => record.tagKey).filter((value): value is string => Boolean(value)))].sort();
    const serials = [...new Set(observations.map((record) => record.serialKey).filter((value): value is string => Boolean(value)))].sort();
    const matched = new Map<string, ExistingAsset>();
    for (const serial of serials) for (const asset of bySerial.get(serial) ?? []) matched.set(asset.id, asset);
    for (const tag of tags) for (const asset of byTag.get(tag) ?? []) matched.set(asset.id, asset);
    if (tags.length > 1) issue('SERIAL_HAS_MULTIPLE_TAGS', 'BLOCKING', null, null, null, id);
    if (tags.some((tag) => (tagSerials.get(tag)?.size ?? 0) > 1)) issue('TAG_HAS_MULTIPLE_SERIALS', 'BLOCKING', null, null, null, id);
    for (const field of ['brand', 'model', 'equipmentType']) {
      const values = new Set(observations.map((record) => identifierKey(record.fields[field] ?? null)).filter(Boolean));
      if (values.size > 1) issue('PRODUCT_' + field.toUpperCase() + '_CONFLICT', 'BLOCKING', null, null, null, id);
    }
    if (new Set(observations.map((record) => record.statusEvidence).filter(Boolean)).size > 1) issue('CROSS_SHEET_STATE_CONFLICT', 'BLOCKING', null, null, null, id);
    if (matched.size > 1) issue('AMBIGUOUS_EXISTING_ASSET', 'BLOCKING', null, null, null, id);
    for (const asset of matched.values()) {
      if (identifierKey(asset.serialNumber) && serials.length && !serials.includes(identifierKey(asset.serialNumber)!)) issue('EXISTING_SERIAL_CONFLICT', 'BLOCKING', null, null, null, id);
      if (identifierKey(asset.assetTag) && tags.length && !tags.includes(identifierKey(asset.assetTag)!)) issue('EXISTING_TAG_CONFLICT', 'BLOCKING', null, null, null, id);
      if ((!asset.isActive || asset.status === 'DECOMMISSIONED') && observations.some((record) => record.statusEvidence === 'AVAILABLE')) issue('EXISTING_TERMINAL_STATE_CONFLICT', 'BLOCKING', null, null, null, id);
    }
    if (observations.length > 1) issue('MULTIPLE_SOURCE_OBSERVATIONS', 'INFO', null, null, null, id);
    return { id, identityKey: key, serials, tags, recordIds: observations.map((record) => record.id), reviewRequired: true,
      proposal: matched.size > 1 ? 'REVIEW_MATCH' : matched.size === 1 ? 'REVIEW_EXISTING' : key.startsWith('UNIDENTIFIED:') ? 'REVIEW_IDENTITY' : comparisonMode === 'SOURCE_ONLY' ? 'REVIEW_SOURCE_ONLY' : 'REVIEW_NEW',
      existingAssets: [...matched.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      proposedStatus: null };
  });
  const payloadDigest = workbookPayloadDigest(input);
  const databaseSnapshotDigest = comparisonMode === 'DATABASE'
    ? digest([...existing].map((asset) => ({ ...asset, updatedAt: new Date(asset.updatedAt).toISOString() })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : null;
  return {
    mode: 'PREVIEW' as const, canApply: false, persisted: false, comparisonMode, source: input.source, rulesVersion: previewRulesVersion,
    asOf, timeZone: 'America/Santiago', payloadDigest, databaseSnapshotDigest,
    previewId: digest([previewRulesVersion, payloadDigest, databaseSnapshotDigest, asOf, comparisonMode]),
    summary: {
      sheetCount: sheets.length, populatedRows: sheets.reduce((sum, sheet) => sum + sheet.populatedRows, 0),
      recordCount: records.length, excludedCount: excluded.length, candidateCount: candidates.length,
      matchedCandidateCount: candidates.filter((candidate) => candidate.existingAssets.length > 0).length,
      consumableReviewCount: records.filter((record) => record.kind === 'CONSUMABLE_REVIEW').length,
      manualSummaryCount: records.filter((record) => record.kind === 'MANUAL_SUMMARY').length,
      sourceNoteCount: records.filter((record) => record.kind === 'SOURCE_NOTE').length,
      blockingIssueCount: issues.filter((entry) => entry.severity === 'BLOCKING').length,
      warningCount: issues.filter((entry) => entry.severity === 'WARNING').length,
      infoCount: issues.filter((entry) => entry.severity === 'INFO').length
    }, sheets, records, candidates, issues, excluded
  };
}
