import type { ImportSourceRevision } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { sheetDictionary } from './dictionary.js';
import { importPlanDigest } from './plan.js';
import { buildWorkbookPreview, previewDate } from './preview.js';
import type { SourceCell, WorkbookPreviewInput } from './schemas.js';
import type { SourceChangeInput, SourceRevisionInput } from './source-schemas.js';

export type SourceField = SourceChangeInput['field'] | 'serialNumber' | 'assetTag';
export type SourceRevisionRequest = Omit<SourceRevisionInput, 'changes'> & { changes: (
  { recordId: string; field: SourceField; action: 'REPLACE'; value: string } |
  { recordId: string; field: SourceField; action: 'RESTORE' }
)[] };
export type SourceCorrection = {
  recordId: string; candidateId: string; sheet: string; row: number; column: string;
  field: SourceField; action: SourceChangeInput['action']; value?: string;
  originalCell: SourceCell | null; beforeCell: SourceCell | null; afterCell: SourceCell | null;
};
export type SourceContext = { revision: number; identityRevisions?: { candidateId: string; revision: number }[];
  corrections: (SourceCorrection & { revisionId: string; revision: number; reviewedById: string; note: string; evidenceReference: string })[] };
const savedChangesSchema = z.array(z.object({
  recordId: z.string(), candidateId: z.string(), sheet: z.string(), row: z.number().int(), column: z.string(),
  field: z.enum(['equipmentType', 'brand', 'model', 'receivedDate', 'serialNumber', 'assetTag']), action: z.enum(['REPLACE', 'RESTORE']), value: z.string().optional(),
  originalCell: z.unknown(), beforeCell: z.unknown(), afterCell: z.unknown()
})).min(1).max(25);

export function sourceRequestDigest(input: SourceRevisionInput) {
  return importPlanDigest({ ...input, changes: [...input.changes].sort((a, b) => (a.recordId + a.field).localeCompare(b.recordId + b.field)) });
}

export function resolveWorkbook(original: WorkbookPreviewInput, revisions: ImportSourceRevision[]) {
  const workbook: WorkbookPreviewInput = JSON.parse(JSON.stringify(original));
  const active = new Map<string, SourceContext['corrections'][number]>();
  const identityRevisions = new Map<string, number>();
  let revision = 0;
  for (const event of revisions) {
    if (event.revision !== revision + 1) throw new ApiError(409, 'INVALID_SOURCE_REVISION', 'Saved source revisions are not sequential');
    const parsed = savedChangesSchema.safeParse(event.changes);
    if (!parsed.success) throw new ApiError(409, 'INVALID_SOURCE_REVISION', 'Saved source corrections cannot be interpreted');
    revision = event.revision;
    for (const stored of parsed.data) {
      const correction = stored as SourceCorrection;
      // Restoration also requires reapproval, even when no active identity corrections remain.
      if (['serialNumber', 'assetTag'].includes(correction.field)) identityRevisions.set(correction.candidateId, event.revision);
      const mapping = sheetDictionary[correction.sheet];
      const row = workbook.sheets.find((sheet) => sheet.name === correction.sheet)?.rows.find((row) => row.row === correction.row);
      if (!row || mapping?.columns[correction.column]?.field !== correction.field) throw new ApiError(409, 'INVALID_SOURCE_REVISION', 'Correction does not match a source field');
      if (correction.afterCell === null) delete row.cells[correction.column];
      else row.cells[correction.column] = correction.afterCell;
      const key = correction.recordId + ':' + correction.field;
      if (correction.action === 'RESTORE') active.delete(key);
      else active.set(key, { ...correction, revisionId: event.id, revision: event.revision, reviewedById: event.reviewedById,
        note: event.note, evidenceReference: event.evidenceReference });
    }
  }
  return { workbook, sourceContext: { revision, identityRevisions: [...identityRevisions].map(([candidateId, revision]) => ({ candidateId, revision })).sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    corrections: [...active.values()].sort((a, b) => (a.recordId + a.field).localeCompare(b.recordId + b.field)) } };
}

export function prepareSourceChanges(original: WorkbookPreviewInput, effective: WorkbookPreviewInput, input: SourceRevisionRequest, asOf = previewDate()): SourceCorrection[] {
  const baseline = buildWorkbookPreview(original, [], asOf);
  return input.changes.map((change) => {
    const record = baseline.records.find((record) => record.id === change.recordId);
    const candidate = baseline.candidates.find((candidate) => candidate.recordIds.includes(change.recordId));
    if (!record || !candidate) throw new ApiError(400, 'INVALID_SOURCE_TARGET', 'Only mapped physical observations may be corrected');
    const mapping = sheetDictionary[record.sheet];
    const column = Object.entries(mapping.columns).find(([, entry]) => entry.field === change.field)?.[0];
    if (!column) throw new ApiError(400, 'INVALID_SOURCE_FIELD', 'This field is not mapped on the selected source sheet');
    const row = effective.sheets.find((sheet) => sheet.name === record.sheet)!.rows.find((row) => row.row === record.row)!;
    const originalCell = record.originalCells[column] ?? null;
    const beforeCell = row.cells[column] ?? null;
    if (change.action === 'REPLACE' && change.field === 'receivedDate' && change.value > asOf) throw new ApiError(400, 'FUTURE_SOURCE_CORRECTION', 'A corrected reception date cannot be in the future');
    const afterCell: SourceCell | null = change.action === 'RESTORE' ? originalCell : { type: change.field === 'receivedDate' ? 'date' : 'text', value: change.value };
    if (importPlanDigest(beforeCell) === importPlanDigest(afterCell)) throw new ApiError(409, 'SOURCE_FIELD_UNCHANGED', 'The correction does not change this source field');
    return { ...change, candidateId: candidate.id, sheet: record.sheet, row: record.row, column, originalCell, beforeCell, afterCell };
  });
}
