import type { ImportIdentityGroupDecision } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { historicalEvidenceSnapshotSchema, type HistoricalPlanAsset, type HistoricalPlanAssignment, type HistoricalPlanRevision } from './assignment-plan.js';
import { currentHistoricalEvidence } from './evidence-current.js';
import type { GroupRetirementPlanInput } from './group-retirement-plan-schemas.js';
import { validateIdentityGroupDecision, type IdentityGroupProjection } from './identity-group-decision.js';
import type { GroupHistoryEvidence } from './identity-group-history-plan.js';
import { buildGroupHistoryProjection } from './identity-group-history-apply-service.js';
import { validateStoredDecision } from './identity-group-pilot.js';
import { importPlanDigest } from './plan.js';
import { identifierKey } from './preview.js';
import { buildHistoricalRetirementPlan } from './retirement-plan.js';

export const groupRetirementRulesVersion = 'mda-group-retirement-plan-1';
function invalidEvidence(): never { throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Retirement archive must preserve exact physical source ownership'); }

export function buildGroupRetirementPlan(projection: IdentityGroupProjection, decisions: ImportIdentityGroupDecision[], asset: HistoricalPlanAsset | null,
  evidence: GroupHistoryEvidence[], assignments: HistoricalPlanAssignment[], revisions: HistoricalPlanRevision[], consumedRows: { recordId: string }[],
  input: GroupRetirementPlanInput, now = new Date()) {
  if (projection.batchVersion !== input.expectedBatchVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the current batch');
  if (projection.sourceRevision !== input.expectedSourceRevision) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload the source interpretation');
  if (projection.projectionId !== input.projectionId) throw new ApiError(409, 'IDENTITY_GROUP_PROJECTION_CHANGED', 'Review the current physical grouping');
  if (decisions.length > 25 || evidence.length > 100 || assignments.length > 10000 || revisions.length > 1000) throw new ApiError(409, 'GROUP_RETIREMENT_PLAN_LIMIT', 'Group retirement context exceeds supported limits');
  if (new Set(decisions.map((entry) => entry.groupKey)).size !== decisions.length || new Set(decisions.map((entry) => entry.version)).size !== decisions.length) {
    throw new ApiError(409, 'INVALID_IDENTITY_GROUP_DECISION', 'Latest group decisions must be unique');
  }
  const version = Math.max(0, ...decisions.map((entry) => entry.version));
  if (version !== input.expectedDecisionVersion) throw new ApiError(409, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT', 'Reload the latest group decisions', { currentVersion: version });
  const intents = new Map(decisions.map((decision) => [decision.groupKey, validateStoredDecision(decision, projection)]));
  const group = projection.groups.find((entry) => entry.groupKey === input.groupKey);
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Physical group not found in this review');
  const decision = decisions.find((entry) => entry.groupKey === group.groupKey);
  if (!decision || decision.id !== input.decisionId) throw new ApiError(409, 'GROUP_DECISION_NOT_LATEST', 'Choose the latest saved decision for this physical group');
  if (decision.projectionId !== projection.projectionId) throw new ApiError(409, 'GROUP_DECISION_STALE', 'Review a new decision against the current grouping');
  const intent = intents.get(group.groupKey)!;
  validateIdentityGroupDecision(projection, intent);
  if (decision.action !== 'LINK_EXISTING' || !decision.linkedAssetId) throw new ApiError(409, 'GROUP_RETIREMENT_EXISTING_ASSET_REQUIRED', 'Explicitly link one existing asset before reviewing its retirement');
  if (!asset || asset.id !== decision.linkedAssetId) throw new ApiError(404, 'NOT_FOUND', 'Reviewed existing asset not found');
  if (evidence.length !== group.evidence.length || new Set(evidence.map((entry) => entry.id)).size !== evidence.length) return invalidEvidence();
  const archives = evidence.map((entry) => {
    const source = group.observations.find((row) => row.recordId === entry.recordId && row.originalCandidateId === entry.candidateId);
    const pin = group.evidence.find((value) => value.id === entry.id);
    if (!source || !pin || entry.sourceHash !== projection.sourceHash || entry.capture.sourceHash !== projection.sourceHash || entry.captureId !== entry.capture.id ||
      entry.amendments.length > 1 || entry.amendments.some((event) => event.evidenceId !== entry.id || !Number.isInteger(event.version) || event.version < 1 || event.version > 1000)) return invalidEvidence();
    const current = currentHistoricalEvidence(entry);
    if (pin.recordId !== entry.recordId || pin.candidateId !== entry.candidateId || pin.captureId !== entry.captureId || pin.captureBatchId !== entry.capture.batchId ||
      pin.capturedAssetId !== entry.assetId || pin.currentAssetId !== current.assetId || pin.evidenceVersion !== current.evidenceVersion || pin.amendmentId !== current.amendmentId ||
      pin.sourceRevision !== current.effectiveSourceRevision || pin.capturedSourceRevision !== entry.capture.sourceRevision) return invalidEvidence();
    for (const value of [entry, current]) {
      const parsed = historicalEvidenceSnapshotSchema.safeParse(value.snapshot);
      if (!parsed.success || parsed.data.recordId !== entry.recordId || parsed.data.candidateId !== entry.candidateId || parsed.data.kind !== entry.kind ||
        parsed.data.effectiveDay !== value.effectiveDay || (value.effectiveDay === null) !== (parsed.data.datePrecision === 'UNKNOWN') ||
        parsed.data.original.id !== entry.recordId || parsed.data.effective.id !== entry.recordId || parsed.data.original.sheet !== source.sheet || parsed.data.effective.sheet !== source.sheet ||
        parsed.data.original.row !== source.row || parsed.data.effective.row !== source.row) return invalidEvidence();
    }
    if (importPlanDigest((entry.snapshot as { original: unknown }).original) !== importPlanDigest((current.snapshot as { original: unknown }).original)) return invalidEvidence();
    return { original: entry, current };
  });
  const selected = archives.find((entry) => entry.original.id === input.plan.evidenceId);
  if (!selected) throw new ApiError(404, 'NOT_FOUND', 'Retirement evidence does not belong to this physical group');
  const { original, current } = selected;
  if (input.expectedEvidenceVersion !== current.evidenceVersion) throw new ApiError(409, 'EVIDENCE_VERSION_CONFLICT', 'Reload current retirement evidence', { currentVersion: current.evidenceVersion });
  const identityProjection = { ...buildGroupHistoryProjection({ currentSnapshot: current.snapshot, proposedAssetId: asset.id,
    proposedIdentity: { serialNumber: group.serialNumber, assetTag: group.assetTag } }, group.groupId),
  linkBasis: { type: 'REVIEWED_IDENTITY_GROUP_PROPOSAL', reviewId: projection.reviewId, groupId: group.groupId } };
  const projected = { ...current, assetId: asset.id, snapshot: identityProjection };
  const used = [original.assignmentUse && { evidenceId: original.id, itemId: original.assignmentUse.itemId },
    original.groupAssignmentUse && { evidenceId: original.id, itemId: original.groupAssignmentUse.itemId },
    original.retirementUse && { evidenceId: original.id, itemId: original.retirementUse.id }].filter((use) => !!use);
  const base = buildHistoricalRetirementPlan(asset, projected, assignments, revisions, input.plan, now, used);
  const blockers: { code: string; relatedId?: string }[] = [...base.blockers];
  if (identifierKey(asset.serialNumber) !== identifierKey(group.serialNumber) || identifierKey(asset.assetTag) !== identifierKey(group.assetTag)) blockers.push({ code: 'GROUP_ASSET_IDENTITY_CHANGED' });
  if (current.assetId !== null && current.assetId !== asset.id) blockers.push({ code: 'EVIDENCE_LINKED_TO_ANOTHER_ASSET' });
  if (original.groupHistoryLink) blockers.push({ code: 'GROUP_HISTORY_LINK_ALREADY_SAVED' });
  if (consumedRows.some((row) => group.recordIds.includes(row.recordId))) blockers.push({ code: 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED' });
  const positions = new Set(group.observations.map((row) => row.sheet + ':' + row.row)); const sheets = new Set(group.observations.map((row) => row.sheet));
  const issues = projection.issues.filter((issue) => issue.candidateId ? group.simulatedCandidateIds.includes(issue.candidateId) :
    issue.sheet === null || (issue.row === null ? sheets.has(issue.sheet) : positions.has(issue.sheet + ':' + issue.row)));
  for (const issue of issues) if (issue.severity === 'BLOCKING') blockers.push({ code: 'SOURCE_' + issue.code, relatedId: importPlanDigest(issue) });
  const groupWarnings = issues.filter((issue) => issue.severity === 'WARNING').map((issue) => ({ id: importPlanDigest(issue), issue }));
  if (groupWarnings.some((warning) => !input.acknowledgedGroupWarnings.includes(warning.id))) blockers.push({ code: 'GROUP_WARNINGS_NOT_ACKNOWLEDGED' });
  if (input.acknowledgedGroupWarnings.some((id) => !groupWarnings.some((warning) => warning.id === id))) blockers.push({ code: 'UNKNOWN_GROUP_WARNING_ACKNOWLEDGEMENT' });
  const content = { rulesVersion: groupRetirementRulesVersion, scope: 'GROUP_HISTORICAL_RETIREMENT_PLAN',
    batchId: projection.batchId, reviewId: projection.reviewId, sourceHash: projection.sourceHash, projectionId: projection.projectionId,
    groupKey: group.groupKey, groupId: group.groupId, decisionId: decision.id, decisionVersion: version, decisionProofDigest: importPlanDigest(decision),
    request: { ...input, acknowledgedGroupWarnings: [...input.acknowledgedGroupWarnings].sort(), plan: base.request },
    checkedAsOf: base.checkedAsOf, timeZone: 'America/Santiago', assetBefore: asset, sourceRows: group.observations,
    originalEvidence: original, currentEvidence: current, proposedEvidenceProjection: identityProjection,
    source: base.source, sourceRetirement: original.kind === 'RETIREMENT_OBSERVATION' ? { effectiveAt: null, datePrecision: 'UNKNOWN', historicalActorId: null } : null,
    proposedRetirement: base.proposedRetirement, currentAssignmentsDigest: base.currentAssignmentsDigest, sourceRevisionsDigest: base.sourceRevisionsDigest,
    consumedSourceRows: [...consumedRows].sort((a, b) => a.recordId.localeCompare(b.recordId)),
    warnings: base.warnings, groupWarnings, blockers, omittedEvidence: archives.filter((entry) => entry.original.id !== original.id).map((entry) => ({
      evidenceId: entry.original.id, recordId: entry.original.recordId, kind: entry.original.kind, evidenceVersion: entry.current.evidenceVersion
    })).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)) };
  return { ...content, planId: importPlanDigest(content), mode: 'GROUP_RETIREMENT_REVIEW_ONLY', persisted: false, canApply: false,
    affectsCurrentState: false, evidenceRelinked: false, operationalHistoryApplied: false, retirementApplicationImplemented: false,
    planValidationComplete: blockers.length === 0,
    summary: { retirementCount: 1, validCount: blockers.length === 0 ? 1 : 0, blockingCount: blockers.length,
      warningCount: base.warnings.length + groupWarnings.length, omittedEvidenceCount: content.omittedEvidence.length } };
}
