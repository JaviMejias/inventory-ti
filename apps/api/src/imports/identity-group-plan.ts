import { ApiError } from '../lib/errors.js';
import { sheetDictionary } from './dictionary.js';
import type { IdentityGroupPlanInput } from './identity-group-plan-schemas.js';
import { buildResolvedPreview } from './identity.js';
import { importPlanDigest, type PlanDecision } from './plan.js';
import { buildWorkbookPreview, identifierKey, previewDate, type ExistingAsset, type PreviewIssue } from './preview.js';
import { workbookPreviewSchema, type SourceCell, type WorkbookPreviewInput } from './schemas.js';
import { prepareSourceChanges, type SourceContext, type SourceCorrection, type SourceRevisionRequest } from './source.js';

export const identityGroupPlanRulesVersion = 'mda-identity-group-plan-1';
export type IdentityGroupImpacts = {
  pilotItems: { id: string; candidateId: string; assetId: string; applicationId: string }[];
  decisions: PlanDecision[];
  evidence: { id: string; recordId: string; candidateId: string; captureId: string; capturedAssetId: string | null; currentAssetId: string | null;
    evidenceVersion: number; amendmentId: string | null; sourceRevision: number; captureBatchId: string; capturedSourceRevision: number;
    assignmentUse: { itemId: string; endpoint: string } | null; retirementUse: { id: string; assetId: string } | null }[];
};

export function projectIdentityGroupWorkbook(effective: WorkbookPreviewInput, changes: SourceCorrection[]) {
  const proposed: WorkbookPreviewInput = JSON.parse(JSON.stringify(effective));
  for (const change of changes) {
    const row = proposed.sheets.find((sheet) => sheet.name === change.sheet)?.rows.find((entry) => entry.row === change.row);
    if (!row) throw new ApiError(409, 'INVALID_IDENTITY_GROUP_REVIEW', 'Identity grouping does not match source rows');
    if (change.afterCell === null) delete row.cells[change.column];
    else row.cells[change.column] = change.afterCell;
  }
  if (!workbookPreviewSchema.safeParse(proposed).success) throw new ApiError(400, 'SOURCE_CORRECTION_LIMIT', 'Identity scenario exceeds supported source limits');
  return proposed;
}

export function selectIdentityGroupScope(baseline: ReturnType<typeof buildWorkbookPreview>, input: IdentityGroupPlanInput) {
  const selected = baseline.candidates.filter((candidate) => input.candidateIds.includes(candidate.id));
  if (selected.length !== input.candidateIds.length) throw new ApiError(400, 'INVALID_SOURCE_TARGET', 'Select existing original physical candidates');
  const selectedRecords = new Set(selected.flatMap((candidate) => candidate.recordIds));
  if (selectedRecords.size > 25) throw new ApiError(409, 'IDENTITY_GROUP_SCOPE_LIMIT', 'Review at most twenty-five complete candidate observations');
  const requestedRecords = input.groups.flatMap((group) => group.recordIds);
  if (requestedRecords.length !== selectedRecords.size || new Set(requestedRecords).size !== requestedRecords.length || requestedRecords.some((id) => !selectedRecords.has(id))) {
    throw new ApiError(400, 'IDENTITY_GROUP_COVERAGE_REQUIRED', 'Every selected observation must appear exactly once; no external rows or omissions');
  }
  return { selected, selectedRecords };
}

export function buildIdentityGroupPlan(original: WorkbookPreviewInput, effective: WorkbookPreviewInput, existing: ExistingAsset[],
  context: { batchId: string; batchVersion: number; sourceContext: SourceContext }, input: IdentityGroupPlanInput,
  impacts: IdentityGroupImpacts = { pilotItems: [], decisions: [], evidence: [] }, asOf = previewDate()) {
  const baseline = buildWorkbookPreview(original, [], asOf);
  const { selected, selectedRecords } = selectIdentityGroupScope(baseline, input);
  const current = buildResolvedPreview(original, effective, existing, asOf, 'DATABASE');
  const blockers: { code: string; groupId?: string; recordId?: string; relatedId?: string; issue?: PreviewIssue }[] = [];
  const block = (code: string, details: Omit<(typeof blockers)[number], 'code'> = {}) => { blockers.push({ code, ...details }); };
  const groups = [...input.groups].map((group) => ({ ...group, recordIds: [...group.recordIds].sort() })).sort((a, b) => a.groupId.localeCompare(b.groupId));
  const recordsById = new Map(current.records.map((record) => [record.id, record]));
  const originalsById = new Map(baseline.records.map((record) => [record.id, record]));
  const requests: SourceRevisionRequest['changes'] = [];
  for (const group of groups) for (const recordId of group.recordIds) {
    const record = recordsById.get(recordId)!; const originalRecord = originalsById.get(recordId)!;
    for (const field of ['serialNumber', 'assetTag'] as const) {
      const column = Object.entries(sheetDictionary[record.sheet].columns).find(([, definition]) => definition.field === field)?.[0];
      const value = group[field];
      if (!column) { if (value !== null) block('IDENTITY_FIELD_NOT_MAPPED', { groupId: group.groupId, recordId }); continue; }
      const originalCell = originalRecord.originalCells[column]; const currentCell = record.originalCells[column];
      const significant = (cell: SourceCell | undefined) => cell && (['formula', 'error'].includes(cell.type) || identifierKey(String(cell.value)) !== null);
      if (value === null) { if (significant(originalCell) || significant(currentCell)) block('IDENTITY_CANNOT_DROP_SOURCE_VALUE', { groupId: group.groupId, recordId }); continue; }
      if (importPlanDigest(currentCell ?? null) !== importPlanDigest({ type: 'text', value })) requests.push({ recordId, field, action: 'REPLACE', value });
    }
  }
  requests.sort((a, b) => (a.recordId + a.field).localeCompare(b.recordId + b.field));
  const changes = prepareSourceChanges(original, effective, { expectedRevision: context.sourceContext.revision, expectedBatchVersion: context.batchVersion,
    requestId: context.batchId, note: input.note, evidenceReference: 'Read-only identity grouping scenario', changes: requests }, asOf);
  const proposed = projectIdentityGroupWorkbook(effective, changes);
  const simulated = buildWorkbookPreview(proposed, existing, asOf, 'DATABASE');
  const candidatesByRecord = new Map(simulated.candidates.flatMap((candidate) => candidate.recordIds.map((id) => [id, candidate] as const)));
  const outside = current.records.filter((record) => !selectedRecords.has(record.id) && ['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(record.kind));
  const outsideSerials = new Set(outside.map((record) => record.serialKey).filter(Boolean));
  const outsideTags = new Set(outside.map((record) => record.tagKey).filter(Boolean));
  const proposedGroups = groups.map((group) => {
    const candidates = [...new Map(group.recordIds.flatMap((id) => { const candidate = candidatesByRecord.get(id); return candidate ? [[candidate.id, candidate] as const] : []; })).values()];
    const candidate = candidates.length === 1 ? candidates[0] : null;
    if (!candidate || candidate.recordIds.length !== group.recordIds.length || !candidate.recordIds.every((id) => group.recordIds.includes(id))) {
      block('PROPOSED_GROUP_NOT_REALIZABLE', { groupId: group.groupId });
    }
    const serial = identifierKey(group.serialNumber); const tag = identifierKey(group.assetTag);
    if ((serial && outsideSerials.has(serial)) || (tag && outsideTags.has(tag))) block('IDENTITY_OVERLAP_OUTSIDE_SCOPE', { groupId: group.groupId });
    if (candidate && (candidate.serials.some((value) => value !== serial) || candidate.tags.some((value) => value !== tag))) block('PROPOSED_IDENTITY_NOT_REALIZED', { groupId: group.groupId });
    return { ...group, originalCandidateIds: selected.filter((entry) => entry.recordIds.some((id) => group.recordIds.includes(id))).map((entry) => entry.id).sort(),
      simulatedCandidateIds: candidates.map((entry) => entry.id).sort(), candidates: candidates.map((entry) => ({ id: entry.id, serials: entry.serials, tags: entry.tags,
        selectedRecordIds: entry.recordIds.filter((id) => selectedRecords.has(id)).sort(), outsideRecordCount: entry.recordIds.filter((id) => !selectedRecords.has(id)).length,
        existingAssets: entry.existingAssets.slice(0, 10), existingAssetCount: entry.existingAssets.length, hasMoreExistingAssets: entry.existingAssets.length > 10 })) };
  });
  const affectedIds = new Set(proposedGroups.flatMap((group) => group.simulatedCandidateIds));
  const selectedPositions = new Set(current.records.filter((record) => selectedRecords.has(record.id)).map((record) => record.sheet + ':' + record.row));
  const selectedSheets = new Set(current.records.filter((record) => selectedRecords.has(record.id)).map((record) => record.sheet));
  const issues = simulated.issues.filter((issue) => issue.candidateId ? affectedIds.has(issue.candidateId) : issue.sheet === null ||
    (issue.row === null ? selectedSheets.has(issue.sheet) : selectedPositions.has(issue.sheet + ':' + issue.row)));
  for (const issue of issues) if (issue.severity === 'BLOCKING') block('SOURCE_' + issue.code, { issue });
  for (const item of [...impacts.pilotItems].sort((a, b) => a.id.localeCompare(b.id))) block('SOURCE_CANDIDATE_ALREADY_APPLIED', { relatedId: item.id });
  for (const evidence of [...impacts.evidence].sort((a, b) => a.id.localeCompare(b.id))) {
    if (evidence.assignmentUse || evidence.retirementUse) block('SOURCE_OBSERVATION_ALREADY_APPLIED', { recordId: evidence.recordId, relatedId: evidence.id });
  }
  const samePartition = selected.every((candidate) => groups.some((group) => group.recordIds.length === candidate.recordIds.length && group.recordIds.every((id) => candidate.recordIds.includes(id))));
  const operationKind = samePartition ? 'IDENTITY_ONLY' : selected.length === 1 ? 'SPLIT' : groups.length === 1 ? 'MERGE' : 'REPARTITION';
  const requiresCoordinatedIdentityReview = samePartition && proposedGroups.some((group) => current.candidates.some((candidate) =>
    input.candidateIds.includes(candidate.id) && !group.originalCandidateIds.includes(candidate.id) &&
    ((identifierKey(group.serialNumber) !== null && candidate.serials.includes(identifierKey(group.serialNumber)!)) ||
      (identifierKey(group.assetTag) !== null && candidate.tags.includes(identifierKey(group.assetTag)!)))));
  const observations = [...selectedRecords].sort().map((recordId) => {
    const originalRecord = originalsById.get(recordId)!; const record = recordsById.get(recordId)!;
    const cells = (entry: typeof record) => Object.fromEntries(['serialNumber', 'assetTag'].map((field) => {
      const column = Object.entries(sheetDictionary[entry.sheet].columns).find(([, definition]) => definition.field === field)?.[0];
      return [field, column ? entry.originalCells[column] ?? null : null];
    }));
    return { recordId, sheet: record.sheet, row: record.row, originalCandidateId: selected.find((candidate) => candidate.recordIds.includes(recordId))!.id,
      proposedGroupId: groups.find((group) => group.recordIds.includes(recordId))!.groupId, originalIdentityCells: cells(originalRecord), currentIdentityCells: cells(record) };
  });
  const content = { rulesVersion: identityGroupPlanRulesVersion, scope: 'PHYSICAL_IDENTITY_GROUP_PLAN', asOf, timeZone: 'America/Santiago',
    batchId: context.batchId, batchVersion: context.batchVersion, sourceRevision: context.sourceContext.revision, sourceHash: original.source.sha256,
    currentPreviewDigest: current.previewId, simulatedPreviewDigest: simulated.previewId, sourceContextDigest: importPlanDigest(context.sourceContext),
    request: { ...input, candidateIds: [...input.candidateIds].sort(), groups }, operationKind,
    originalCandidates: selected.map((candidate) => ({ candidateId: candidate.id, recordIds: [...candidate.recordIds].sort() })).sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    observations, proposedGroups, changes, blockers, issues, warnings: issues.filter((issue) => issue.severity === 'WARNING'),
    impacts: { pilotItems: [...impacts.pilotItems].sort((a, b) => a.id.localeCompare(b.id)), decisions: [...impacts.decisions].sort((a, b) => a.id.localeCompare(b.id)),
      evidence: [...impacts.evidence].sort((a, b) => a.id.localeCompare(b.id)) },
    requiresEvidenceLineageReview: impacts.evidence.length > 0, requiresDecisionRenewal: impacts.decisions.length > 0, requiresCoordinatedIdentityReview,
    nextWorkflow: operationKind !== 'IDENTITY_ONLY' ? 'LINEAGE_WORKFLOW_NOT_IMPLEMENTED' :
      selected.some((candidate) => candidate.recordIds.length > 12) ? 'IDENTITY_REVIEW_SCOPE_WORKFLOW_NOT_IMPLEMENTED' :
        requiresCoordinatedIdentityReview ? 'COORDINATED_IDENTITY_WORKFLOW_NOT_IMPLEMENTED' : 'V8_IDENTITY_REVIEW' };
  return { ...content, planId: importPlanDigest(content), canApply: false, persisted: false, affectsCurrentState: false, lineagePersistenceImplemented: false,
    proposalValidationComplete: blockers.length === 0, summary: { originalCandidateCount: selected.length, proposedGroupCount: groups.length,
      observationCount: selectedRecords.size, changedCellCount: changes.length, blockingCount: blockers.length, warningCount: content.warnings.length } };
}
