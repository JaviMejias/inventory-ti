import type { Prisma } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { historicalEvidenceSnapshotSchema, type HistoricalPlanAsset, type HistoricalPlanAssignment, type HistoricalPlanRevision } from './assignment-plan.js';
import { currentHistoricalEvidence } from './evidence-current.js';
import { historyRulesVersion } from './history.js';
import type { GroupRetirementReconciliationInput } from './group-retirement-reconciliation-schemas.js';
import { buildGroupHistoryProjection } from './identity-group-history-apply-service.js';
import type { GroupHistoryEvidence } from './identity-group-history-plan.js';
import type { IdentityGroupReviewSource, validateIdentityGroupReviewLineage } from './identity-group-projection.js';
import { importPlanDigest } from './plan.js';
import { identifierKey } from './preview.js';
import { buildHistoricalRetirementPlan } from './retirement-plan.js';
import { reconciliationReceiptSelect } from './retirement-reconciliation.js';

export const groupRetirementReconciliationRulesVersion = 'mda-group-retirement-reconciliation-1';
export const groupReconciliationReceiptSelect = { ...reconciliationReceiptSelect, batchId: true, reviewId: true, groupKey: true, groupId: true } satisfies Prisma.ImportGroupRetirementApplicationSelect;
type LegacyReceipt = Prisma.ImportRetirementApplicationGetPayload<{ select: typeof reconciliationReceiptSelect }> & { origin: 'LEGACY' };
type GroupReceipt = Prisma.ImportGroupRetirementApplicationGetPayload<{ select: typeof groupReconciliationReceiptSelect }> & { origin: 'GROUP' };
export type GroupReconciliationReceipt = LegacyReceipt | GroupReceipt;
export type GroupReconciliationConsumption = { sourceHash: string; recordId: string; reviewId: string; applicationId: string; assetId: string; batchId: string;
  origin: 'GROUP_ASSET_PILOT' | 'GROUP_RETIREMENT' };
export type GroupReconciliationDocument = { id: string; assetId: string; evidenceId: string; evidenceVersion: number; amendmentId: string | null;
  sourceRevision: number; planId: string; recordedAt: Date; recordedById: string };
type SavedReview = ReturnType<typeof validateIdentityGroupReviewLineage>;
export type GroupReconciliationContext = {
  review: IdentityGroupReviewSource; saved: SavedReview; batchVersion: number; sourceRevision: number; identityRevisedRecordIds: string[]; reviewSourceRevisedRecordIds: string[];
  asset: HistoricalPlanAsset; evidence: GroupHistoryEvidence[]; assignments: HistoricalPlanAssignment[]; revisions: HistoricalPlanRevision[];
  consumption: GroupReconciliationConsumption[]; reservations: { reviewId: string; groupId: string; recordId: string }[];
  receipts: GroupReconciliationReceipt[]; documents: GroupReconciliationDocument[];
  latestDecision: { id: string; version: number; action: string; linkedAssetId: string | null; projectionId: string } | null;
};
function invalidEvidence(): never { throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Group reconciliation requires exact archived physical lineage'); }
export function buildGroupRetirementReconciliation(context: GroupReconciliationContext, input: GroupRetirementReconciliationInput, now = new Date()) {
  const { review, saved, asset } = context;
  const group = saved.request.groups.find((entry) => importPlanDigest(['IMPORT_IDENTITY_GROUP', review.sourceHash, review.id, entry.groupId]) === input.groupKey);
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Physical group not found in this review');
  if (context.evidence.length > 100 || context.assignments.length > 10000 || context.revisions.length > 1000 || context.reservations.length > 25 ||
    context.consumption.length > 50 || context.documents.length > 1001 || context.receipts.length > 4) throw new ApiError(409, 'GROUP_RECONCILIATION_LIMIT', 'Group reconciliation exceeds its supported context limits');
  if (input.assetId !== asset.id || new Set(context.evidence.map((entry) => entry.id)).size !== context.evidence.length) return invalidEvidence();
  const rows = saved.observations.filter((row) => group.recordIds.includes(row.recordId));
  const archives = context.evidence.map((entry) => {
    const row = rows.find((value) => value.recordId === entry.recordId && value.originalCandidateId === entry.candidateId);
    if (!row || entry.sourceHash !== review.sourceHash || entry.capture.sourceHash !== review.sourceHash || entry.captureId !== entry.capture.id ||
      entry.amendments.length > 1 || entry.amendments.some((event) => event.evidenceId !== entry.id || !Number.isInteger(event.version) || event.version < 1 || event.version > 1000)) return invalidEvidence();
    const current = currentHistoricalEvidence(entry);
    for (const value of [entry, current]) {
      const parsed = historicalEvidenceSnapshotSchema.safeParse(value.snapshot);
      if (!parsed.success || parsed.data.recordId !== entry.recordId || parsed.data.candidateId !== entry.candidateId || parsed.data.kind !== entry.kind ||
        parsed.data.original.id !== row.recordId || parsed.data.effective.id !== row.recordId || parsed.data.original.sheet !== row.sheet || parsed.data.effective.sheet !== row.sheet ||
        parsed.data.original.row !== row.row || parsed.data.effective.row !== row.row || parsed.data.effectiveDay !== value.effectiveDay ||
        (value.effectiveDay === null) !== (parsed.data.datePrecision === 'UNKNOWN') ||
        (entry.kind === 'RETIREMENT_OBSERVATION' && value.effectiveDay !== null)) return invalidEvidence();
    }
    if (importPlanDigest((entry.snapshot as { original: unknown }).original) !== importPlanDigest((current.snapshot as { original: unknown }).original)) return invalidEvidence();
    return { original: entry, current };
  });
  const selected = archives.find((entry) => entry.original.id === input.evidenceId);
  if (!selected) throw new ApiError(404, 'NOT_FOUND', 'Selected evidence does not belong to this physical group');
  const projectedSnapshot = { ...buildGroupHistoryProjection({ currentSnapshot: selected.current.snapshot, proposedAssetId: asset.id,
    proposedIdentity: { serialNumber: group.serialNumber, assetTag: group.assetTag } }, group.groupId),
  linkBasis: { type: 'DIAGNOSTIC_GROUP_PROPOSAL_ONLY', reviewId: review.id, groupId: group.groupId, authorizationGranted: false } };
  const used = context.receipts.filter((receipt) => receipt.evidenceId === input.evidenceId).map((receipt) => ({ evidenceId: input.evidenceId, itemId: receipt.id }));
  for (const use of [selected.original.assignmentUse, selected.original.groupAssignmentUse]) if (use) used.push({ evidenceId: input.evidenceId, itemId: use.itemId });
  const base = buildHistoricalRetirementPlan(asset, { ...selected.current, assetId: asset.id, snapshot: projectedSnapshot }, context.assignments, context.revisions,
    { evidenceId: input.evidenceId, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: null, dateEvidenceReference: null,
      note: 'Read-only group reconciliation without documentary confirmation', evidenceReference: 'Archived source only; no external date proof', acknowledgedWarnings: [] }, now, used);
  const diagnostics = base.blockers.filter((issue) => issue.code !== 'WARNINGS_NOT_ACKNOWLEDGED');
  const add = (code: string, relatedId?: string) => diagnostics.push({ code, ...(relatedId ? { relatedId } : {}) });
  if (identifierKey(group.serialNumber) !== identifierKey(asset.serialNumber) || identifierKey(group.assetTag) !== identifierKey(asset.assetTag)) add('GROUP_ASSET_IDENTITY_CHANGED');
  if (selected.current.assetId !== null && selected.current.assetId !== asset.id) add('EVIDENCE_LINKED_TO_ANOTHER_ASSET');
  if (context.identityRevisedRecordIds.length > 0) add('GROUP_SOURCE_IDENTITY_REVISED');
  if (context.reviewSourceRevisedRecordIds.length > 0) add('GROUP_REVIEW_SOURCE_REVISED');
  if (review.release) add('GROUP_REVIEW_RELEASED');
  if (context.latestDecision?.action === 'LINK_EXISTING' && context.latestDecision.linkedAssetId !== asset.id) add('GROUP_DECISION_POINTS_TO_ANOTHER_ASSET', context.latestDecision.id);
  for (const archive of archives) {
    const snapshot = historicalEvidenceSnapshotSchema.parse(archive.current.snapshot);
    if (archive.original.capture.rulesVersion !== historyRulesVersion) add('GROUP_ARCHIVE_RULES_CHANGED', archive.original.id);
    for (const issue of snapshot.issues) if (issue.severity === 'BLOCKING') add('GROUP_ARCHIVE_SOURCE_' + issue.code, archive.original.id);
    if (context.revisions.some((revision) => revision.batchId === archive.original.capture.batchId && revision.revision > archive.current.effectiveSourceRevision &&
      Array.isArray(revision.changes) && revision.changes.some((change) => change && typeof change === 'object' && 'candidateId' in change && change.candidateId === archive.original.candidateId))) add('GROUP_ARCHIVE_SOURCE_REVISED', archive.original.id);
    if (archive.current.assetId !== null && archive.current.assetId !== asset.id) add('GROUP_ARCHIVE_LINKED_TO_ANOTHER_ASSET', archive.original.id);
    if (archive.original.kind === 'RECEIPT_OBSERVATION' && archive.current.effectiveDay && asset.decommissionedAt &&
      archive.current.effectiveDay > asset.decommissionedAt.toISOString().slice(0, 10)) add('GROUP_ARCHIVE_RECEIPT_AFTER_CURRENT_RETIREMENT', archive.original.id);
  }
  if (context.consumption.some((row) => row.sourceHash !== review.sourceHash || !group.recordIds.includes(row.recordId)) ||
    context.reservations.some((row) => !group.recordIds.includes(row.recordId) || (row.reviewId === review.id && row.groupId !== group.groupId)) ||
    context.receipts.some((receipt) => receipt.assetId !== asset.id && receipt.evidenceId !== input.evidenceId) ||
    context.documents.some((document) => document.evidenceId !== input.evidenceId)) return invalidEvidence();
  const uniqueConsumed = new Set(context.consumption.map((row) => row.recordId));
  const conflictingConsumption = uniqueConsumed.size !== context.consumption.length || context.consumption.some((row) => row.assetId !== asset.id);
  if (conflictingConsumption) add('GROUP_SOURCE_CONSUMPTION_CONFLICT');
  if (context.reservations.some((row) => row.reviewId !== review.id)) add('GROUP_SOURCE_RESERVED_BY_ANOTHER_REVIEW');
  const ownReceipts = context.receipts.filter((receipt) => receipt.assetId === asset.id);
  const selectedReceipt = context.receipts.find((receipt) => receipt.evidenceId === input.evidenceId) ?? null;
  const terminal = asset.status === 'DECOMMISSIONED' && !asset.isActive;
  const dateInvalid = asset.decommissionedAt !== null && (asset.decommissionedAt < new Date('1900-01-01') || asset.decommissionedAt > now || !Number.isFinite(asset.decommissionedAt.getTime()));
  if (dateInvalid) add('CURRENT_RETIREMENT_DATE_UNCONFIRMED');
  if (ownReceipts.length > 1 || ownReceipts.some((receipt) => !terminal || receipt.decommissionedAt.getTime() !== asset.decommissionedAt?.getTime())) add('IMPORTED_RETIREMENT_STATE_CONFLICT');
  if (asset.decommissionedAt && base.source.sourceReceivedDay && asset.decommissionedAt.toISOString().slice(0, 10) < base.source.sourceReceivedDay) add('CURRENT_RETIREMENT_BEFORE_SOURCE_RECEIPT');
  for (const assignment of context.assignments) if (asset.decommissionedAt && assignment.endedAt && assignment.endedAt > asset.decommissionedAt) add('ASSIGNMENT_AFTER_RETIREMENT', assignment.id);
  const has = (code: string) => diagnostics.some((issue) => issue.code === code);
  const inconsistent = dateInvalid || has('CURRENT_ASSIGNMENT_STATE_INCONSISTENT') || has('OPERATIONAL_ASSIGNMENT_PERIOD_INVALID') || has('IMPORTED_RETIREMENT_STATE_CONFLICT') ||
    has('ASSIGNMENT_AFTER_RETIREMENT') || has('CURRENT_RETIREMENT_BEFORE_SOURCE_RECEIPT') || (!terminal && (!asset.isActive || asset.decommissionedAt !== null)) ||
    (asset.status === 'DECOMMISSIONED' && asset.isActive);
  const custody = has('ACTIVE_ASSIGNMENT_REQUIRES_RETURN');
  const currentState = inconsistent ? 'INCONSISTENT' : custody ? 'ACTIVE_CUSTODY' : terminal ? asset.decommissionedAt ? 'TERMINAL_DATED' : 'TERMINAL_UNDATED' : 'NONTERMINAL';
  const sourceNeedsReview = diagnostics.some((issue) => issue.code.startsWith('SOURCE_') || issue.code.startsWith('GROUP_ARCHIVE_') ||
    ['RETIREMENT_EVIDENCE_KIND_REQUIRED', 'GROUP_ASSET_IDENTITY_CHANGED', 'GROUP_SOURCE_IDENTITY_REVISED', 'GROUP_REVIEW_SOURCE_REVISED', 'EVIDENCE_LINKED_TO_ANOTHER_ASSET', 'GROUP_DECISION_POINTS_TO_ANOTHER_ASSET',
      'EVIDENCE_RULES_CHANGED', 'EVIDENCE_SOURCE_REVISED', 'PRODUCT_NOT_ASSET'].includes(issue.code));
  const evidenceState = selectedReceipt ? selectedReceipt.assetId === asset.id ? 'USED_FOR_THIS_RETIREMENT' : 'USED_FOR_OTHER_RETIREMENT' :
    selected.original.assignmentUse || selected.original.groupAssignmentUse ? 'USED_BY_ASSIGNMENT' : uniqueConsumed.has(selected.original.recordId) ? 'SOURCE_ROW_CONSUMED' : sourceNeedsReview ? 'REVIEW_REQUIRED' : 'ARCHIVED_ONLY';
  const existing = ownReceipts[0] ?? null;
  const classification = inconsistent ? 'CURRENT_STATE_REVIEW_REQUIRED' : conflictingConsumption ? 'GROUP_SOURCE_CONSUMPTION_REVIEW_REQUIRED' :
    evidenceState === 'USED_FOR_OTHER_RETIREMENT' || evidenceState === 'USED_BY_ASSIGNMENT' ? 'EVIDENCE_ALREADY_USED' :
    existing ? existing.origin === 'GROUP' ? selectedReceipt?.id === existing.id ? 'ALREADY_GROUP_IMPORTED_RETIREMENT' : 'EXISTING_GROUP_IMPORTED_RETIREMENT' : 'EXISTING_IMPORTED_RETIREMENT' :
    sourceNeedsReview ? 'EVIDENCE_REVIEW_REQUIRED' : custody ? 'CURRENT_CUSTODY_CONFLICT' : terminal ? asset.decommissionedAt ? 'EXISTING_DATED_RETIREMENT' : 'EXISTING_UNDATED_RETIREMENT' : 'RETIREMENT_DATE_UNCONFIRMED';
  const nextSteps = ['KEEP_ORIGINAL_SOURCE_UNCERTAINTY', 'DO_NOT_REUSE_LEGACY_APPLY_OR_DOCUMENT_CONFIRMATION'];
  if (inconsistent) nextSteps.push('REVIEW_CURRENT_STATE_AND_CUSTODY');
  if (custody) nextSteps.push('REVIEW_CURRENT_CUSTODY');
  if (sourceNeedsReview) nextSteps.push('REVIEW_GROUP_IDENTITY_AND_ARCHIVE');
  if (review.release) nextSteps.push('KEEP_RELEASED_REVIEW_AS_HISTORICAL_PROPOSAL');
  if (conflictingConsumption || uniqueConsumed.size > 0) nextSteps.push('PRESERVE_EXISTING_SOURCE_CONSUMPTION');
  if (existing || selectedReceipt) nextSteps.push('CONSULT_EXISTING_RETIREMENT_RECEIPTS');
  nextSteps.push(terminal ? 'GROUP_DOCUMENT_CONFIRMATION_NOT_IMPLEMENTED' : 'OBTAIN_INDEPENDENT_RETIREMENT_DATE_PROOF');
  const links = context.receipts.map((receipt) => ({ origin: receipt.origin, assetId: receipt.assetId, applicationId: receipt.id,
    url: receipt.origin === 'GROUP' ? `/inventory/imports/batches/${receipt.batchId}/identity-group-reviews/${receipt.reviewId}/retirement-applications/${receipt.id}` :
      `/assets/${receipt.assetId}/imported-retirement-applications/${receipt.id}` }));
  const content = { rulesVersion: groupRetirementReconciliationRulesVersion, scope: 'GROUP_RETIREMENT_RECONCILIATION', checkedAsOf: base.checkedAsOf, timeZone: 'America/Santiago',
    batchId: review.batchId, reviewId: review.id, groupKey: input.groupKey, groupId: group.groupId, sourceHash: review.sourceHash, request: input,
    reviewState: review.release ? 'RELEASED' : 'ACTIVE', reviewedPlanId: review.planId, reviewedBatchVersion: review.batchVersion, batchVersion: context.batchVersion,
    reviewedSourceRevision: review.sourceRevision, sourceRevision: context.sourceRevision, latestDecision: context.latestDecision, currentLinkAuthorized: false,
    reviewedIdentity: { serialNumber: group.serialNumber, assetTag: group.assetTag, basis: 'HISTORICAL_GROUP_PROPOSAL_ONLY' },
    sourceRows: rows, identityRevisedRecordIds: [...context.identityRevisedRecordIds].sort(), reviewSourceRevisedRecordIds: [...context.reviewSourceRevisedRecordIds].sort(), assetBefore: asset,
    originalEvidence: selected.original, currentEvidence: selected.current, diagnosticEvidenceProjection: projectedSnapshot,
    groupArchive: archives.map((entry) => ({ evidenceId: entry.original.id, recordId: entry.original.recordId, kind: entry.original.kind,
      capturedAssetId: entry.original.assetId, currentAssetId: entry.current.assetId, evidenceVersion: entry.current.evidenceVersion, amendmentId: entry.current.amendmentId,
      sourceRevision: entry.current.effectiveSourceRevision, snapshotDigest: importPlanDigest(entry.current.snapshot),
      issues: historicalEvidenceSnapshotSchema.parse(entry.current.snapshot).issues, appliedByThisAssessment: false })),
    source: base.source, sourceRetirement: selected.original.kind === 'RETIREMENT_OBSERVATION' ? { effectiveAt: null, datePrecision: 'UNKNOWN', historicalActorId: null } : null,
    existingRetirement: terminal ? { effectiveAt: asset.decommissionedAt, datePrecision: asset.decommissionedAt ? 'INSTANT' : 'UNKNOWN',
      dateOrigin: existing && !has('IMPORTED_RETIREMENT_STATE_CONFLICT') ? existing.origin === 'GROUP' ? 'GROUP_VERIFIED_IMPORT_RECEIPT' : 'VERIFIED_IMPORT_RECEIPT' : 'CURRENT_ASSET', confirmsSourceDate: false } : null,
    classification, currentState, evidenceState, sourceRowState: uniqueConsumed.size === 0 ? 'UNCONSUMED' : uniqueConsumed.size === group.recordIds.length ? 'CONSUMED' : 'PARTIALLY_CONSUMED',
    sourceConsumption: context.consumption, activeReservations: context.reservations, retirementReceipts: context.receipts, documentAssociations: context.documents,
    currentAssignmentsDigest: base.currentAssignmentsDigest, sourceRevisionsDigest: base.sourceRevisionsDigest, warnings: base.warnings, diagnostics, nextSteps, links };
  return { ...content, assessmentId: importPlanDigest(content), mode: 'READ_ONLY_GROUP_RECONCILIATION', canApply: false, persisted: false, affectsCurrentState: false,
    evidenceRelinked: false, confirmsSourceDate: false, documentConfirmationImplemented: false, operationalResolutionImplemented: false };
}
