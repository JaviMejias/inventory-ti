import { ApiError } from '../lib/errors.js';
import { sheetDictionary } from './dictionary.js';
import type { IdentityRevisionInput } from './identity-schemas.js';
import { importPlanDigest } from './plan.js';
import { buildWorkbookPreview, identifierKey, previewDate, type ExistingAsset } from './preview.js';
import type { WorkbookPreviewInput } from './schemas.js';
import { prepareSourceChanges, type SourceContext, type SourceRevisionRequest } from './source.js';

export function buildResolvedPreview(original: WorkbookPreviewInput, effective: WorkbookPreviewInput, existing: ExistingAsset[] = [], asOf = previewDate(), mode: 'SOURCE_ONLY' | 'DATABASE' = 'SOURCE_ONLY') {
  const baseline = buildWorkbookPreview(original, [], asOf);
  const preview = buildWorkbookPreview(effective, existing, asOf, mode);
  // Receipt targets retain original IDs; re-keying a verified identity must not bypass source deduplication.
  const byRecord = new Map(baseline.candidates.flatMap((candidate) => candidate.recordIds.map((id) => [id, candidate] as const)));
  const stableIds = new Map<string, string>();
  for (const candidate of preview.candidates) {
    const originalCandidate = byRecord.get(candidate.recordIds[0]);
    if (!originalCandidate || originalCandidate.recordIds.length !== candidate.recordIds.length ||
      !candidate.recordIds.every((id) => byRecord.get(id)?.id === originalCandidate.id)) {
      throw new ApiError(409, 'IDENTITY_GROUP_CHANGE_REQUIRES_REVIEW', 'Identity corrections cannot merge or split original physical candidates');
    }
    stableIds.set(candidate.id, originalCandidate.id);
  }
  if (stableIds.size !== baseline.candidates.length) throw new ApiError(409, 'IDENTITY_GROUP_CHANGE_REQUIRES_REVIEW', 'Original candidate coverage changed');
  return { ...preview, candidates: preview.candidates.map((candidate) => ({ ...candidate, id: stableIds.get(candidate.id)!, effectiveCandidateId: candidate.id })),
    issues: preview.issues.map((issue) => ({ ...issue, candidateId: issue.candidateId ? stableIds.get(issue.candidateId)! : null })) };
}

export function prepareIdentityChanges(original: WorkbookPreviewInput, effective: WorkbookPreviewInput, sourceContext: SourceContext, input: IdentityRevisionInput) {
  const baseline = buildWorkbookPreview(original);
  const candidate = baseline.candidates.find((entry) => entry.id === input.candidateId);
  if (!candidate) throw new ApiError(400, 'INVALID_SOURCE_TARGET', 'Identity review requires an original physical candidate');
  if (candidate.recordIds.length > 12) throw new ApiError(409, 'IDENTITY_REVIEW_SCOPE_LIMIT', 'Review at most twelve observations in one identity correction');
  const observations = baseline.records.filter((record) => candidate.recordIds.includes(record.id));
  const requested: SourceRevisionRequest['changes'] = [];
  for (const field of ['serialNumber', 'assetTag'] as const) {
    if (input.action === 'VERIFY' && input[field] === null && observations.some((record) => {
      const column = Object.entries(sheetDictionary[record.sheet].columns).find(([, entry]) => entry.field === field)?.[0];
      const row = effective.sheets.find((sheet) => sheet.name === record.sheet)!.rows.find((row) => row.row === record.row)!;
      return [column ? record.originalCells[column] : undefined, column ? row.cells[column] : undefined]
        .some((cell) => cell && (['formula', 'error'].includes(cell.type) || identifierKey(String(cell.value)) !== null));
    })) throw new ApiError(400, 'IDENTITY_CANNOT_DROP_SOURCE_VALUE', 'Verify each populated identity field; do not remove uncertain identifiers');
    if (input.action === 'VERIFY' && input[field] !== null && !observations.some((record) => Object.values(sheetDictionary[record.sheet].columns).some((entry) => entry.field === field))) {
      throw new ApiError(400, 'INVALID_SOURCE_FIELD', 'This identity field is not mapped in the candidate observations');
    }
    for (const record of observations) {
      const column = Object.entries(sheetDictionary[record.sheet].columns).find(([, entry]) => entry.field === field)?.[0];
      if (!column) continue;
      if (input.action === 'RESTORE') {
        if (sourceContext.corrections.some((entry) => entry.recordId === record.id && entry.field === field)) requested.push({ recordId: record.id, field, action: 'RESTORE' });
      } else if (input[field] !== null) {
        const cell = effective.sheets.find((sheet) => sheet.name === record.sheet)!.rows.find((row) => row.row === record.row)!.cells[column];
        if (importPlanDigest(cell ?? null) !== importPlanDigest({ type: 'text', value: input[field] })) requested.push({ recordId: record.id, field, action: 'REPLACE', value: input[field] });
      }
    }
  }
  if (!requested.length) throw new ApiError(409, 'SOURCE_FIELD_UNCHANGED', 'The verified identity does not change the effective source');
  return prepareSourceChanges(original, effective, { ...input, changes: requested });
}

export function validateIdentityPreview(original: WorkbookPreviewInput, proposed: WorkbookPreviewInput, input: IdentityRevisionInput) {
  const preview = buildResolvedPreview(original, proposed);
  const selected = preview.candidates.find((candidate) => candidate.id === input.candidateId)!;
  if (input.action === 'VERIFY' && preview.candidates.some((other) => other.id !== selected.id &&
    (other.serials.some((serial) => selected.serials.includes(serial)) || other.tags.some((tag) => selected.tags.includes(tag))))) {
    throw new ApiError(409, 'IDENTITY_CROSS_CANDIDATE_CONFLICT', 'Verified identifiers overlap another source candidate');
  }
}
