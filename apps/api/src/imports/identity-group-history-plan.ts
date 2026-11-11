import type { ImportEvidenceAmendment, ImportHistoricalEvidence, ImportHistoryCapture } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { historicalEvidenceSnapshotSchema, historicalRevisionChangesSchema, type HistoricalPlanAsset, type HistoricalPlanRevision } from './assignment-plan.js';
import { currentHistoricalEvidence } from './evidence-current.js';
import { historyRulesVersion } from './history.js';
import { validateGroupApplicationProof, type GroupApplicationProof } from './identity-group-application-proof.js';
import type { IdentityGroupHistoryPlanInput } from './identity-group-history-schemas.js';
import { importPlanDigest } from './plan.js';
import { identifierKey, previewDate } from './preview.js';

export type GroupHistoryEvidence = ImportHistoricalEvidence & {
  capture: Pick<ImportHistoryCapture, 'id' | 'batchId' | 'sourceHash' | 'sourceRevision' | 'rulesVersion'>;
  amendments: ImportEvidenceAmendment[];
  assignmentUse: { itemId: string; endpoint: string } | null;
  groupAssignmentUse?: { itemId: string; endpoint: string } | null;
  groupHistoryLink?: { id: string; historyApplicationId: string; assetId: string; version: number } | null;
  retirementUse: { id: string; assetId: string } | null
};
export const groupHistoryPlanRulesVersion = 'mda-group-history-link-plan-2';
function invalidEvidence(): never { throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Archived evidence does not preserve its captured source provenance'); }

export function buildGroupHistoryPlan(application: GroupApplicationProof, itemId: string, asset: HistoricalPlanAsset | null,
  evidence: GroupHistoryEvidence[], revisions: HistoricalPlanRevision[], input: IdentityGroupHistoryPlanInput, asOf = previewDate()) {
  const proofs = validateGroupApplicationProof(application);
  const proof = proofs.find(({ item }) => item.id === itemId);
  if (!proof) throw new ApiError(404, 'NOT_FOUND', 'Applied group item not found in this application');
  if (input.expectedApplicationPlanId !== application.planId) throw new ApiError(409, 'IDENTITY_GROUP_APPLICATION_CHANGED', 'Choose the exact saved group application');
  if (evidence.length > 100 || revisions.length > 1000) throw new ApiError(409, 'GROUP_HISTORY_PLAN_LIMIT', 'Group history exceeds the supported planning limits');
  if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length) return invalidEvidence();
  const changes = revisions.map((revision) => {
    const parsed = historicalRevisionChangesSchema.safeParse(revision.changes);
    if (!parsed.success) throw new ApiError(409, 'INVALID_SOURCE_REVISION', 'Saved source revisions cannot be interpreted safely');
    return { ...revision, changes: parsed.data };
  });
  const groupEvidence = evidence.map((entry) => {
    if (entry.sourceHash !== application.sourceHash || entry.capture.sourceHash !== entry.sourceHash || entry.capture.id !== entry.captureId ||
      !proof.source.some((row) => row.recordId === entry.recordId && row.originalCandidateId === entry.candidateId)) return invalidEvidence();
    if (entry.amendments.length > 1 || entry.amendments.some((event) => event.evidenceId !== entry.id || !Number.isInteger(event.version) || event.version < 1 || event.version > 1000)) return invalidEvidence();
    return { original: entry, current: currentHistoricalEvidence(entry) };
  });
  const operations = [...input.operations].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)).map((operation) => {
    const entry = groupEvidence.find(({ original }) => original.id === operation.evidenceId);
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Evidence does not belong to this applied physical group');
    const { original, current } = entry;
    const previousReview = proof.evidenceReviews.find((review) => review.id === original.id);
    if (operation.expectedEvidenceVersion !== current.evidenceVersion) throw new ApiError(409, 'EVIDENCE_VERSION_CONFLICT', 'Reload the current evidence version', { evidenceId: original.id, currentVersion: current.evidenceVersion });
    const captured = historicalEvidenceSnapshotSchema.safeParse(original.snapshot);
    const effective = historicalEvidenceSnapshotSchema.safeParse(current.snapshot);
    const capturedRaw = z.record(z.unknown()).safeParse(original.snapshot);
    const effectiveRaw = z.record(z.unknown()).safeParse(current.snapshot);
    if (!captured.success || !effective.success || !capturedRaw.success || !effectiveRaw.success ||
      importPlanDigest(capturedRaw.data.original) !== importPlanDigest(effectiveRaw.data.original)) return invalidEvidence();
    const source = proof.source.find((row) => row.recordId === original.recordId)!;
    for (const snapshot of [captured, effective]) {
      if (!snapshot.success || snapshot.data.recordId !== original.recordId || snapshot.data.candidateId !== original.candidateId || snapshot.data.kind !== original.kind ||
        snapshot.data.original.id !== original.recordId || snapshot.data.effective.id !== original.recordId ||
        snapshot.data.original.sheet !== source.sheet || snapshot.data.original.row !== source.row ||
        snapshot.data.effective.sheet !== source.sheet || snapshot.data.effective.row !== source.row) return invalidEvidence();
    }
    if (!captured.success || !effective.success || captured.data.effectiveDay !== original.effectiveDay || effective.data.effectiveDay !== current.effectiveDay ||
      (current.effectiveDay === null) !== (effective.data.datePrecision === 'UNKNOWN')) return invalidEvidence();
    const blockers: string[] = [];
    if (original.groupHistoryLink) blockers.push('GROUP_HISTORY_LINK_ALREADY_SAVED');
    if (!asset || asset.id !== proof.item.assetId) blockers.push('GROUP_ASSET_NOT_FOUND');
    else {
      if (asset.productId !== proof.identity.productId || identifierKey(asset.serialNumber) !== identifierKey(proof.identity.serialNumber) ||
        identifierKey(asset.assetTag) !== identifierKey(proof.identity.assetTag)) blockers.push('GROUP_ASSET_IDENTITY_CHANGED');
      if (asset.product.trackingMode !== 'ASSET') blockers.push('PRODUCT_NOT_ASSET');
    }
    if (original.assignmentUse || original.groupAssignmentUse || original.retirementUse) blockers.push('EVIDENCE_ALREADY_APPLIED');
    if (original.capture.rulesVersion !== historyRulesVersion) blockers.push('EVIDENCE_RULES_CHANGED');
    if (current.assetId !== null && current.assetId !== proof.item.assetId) blockers.push('EVIDENCE_LINKED_TO_ANOTHER_ASSET');
    if (changes.some((event) => event.batchId === original.capture.batchId && event.revision > current.effectiveSourceRevision &&
      event.changes.some((change) => change.candidateId === original.candidateId))) blockers.push('EVIDENCE_SOURCE_REVISED');
    const requiresIdentityProjection = effective.data.effective.serialKey !== identifierKey(proof.identity.serialNumber) ||
      effective.data.effective.tagKey !== identifierKey(proof.identity.assetTag);
    if (current.assetId === proof.item.assetId && !requiresIdentityProjection) blockers.push('NO_HISTORY_LINK_CHANGE');
    const warnings = requiresIdentityProjection ? [{ code: 'GROUP_HISTORY_IDENTITY_PROJECTION_REQUIRED',
      id: importPlanDigest({ evidenceId: original.id, evidenceVersion: current.evidenceVersion, itemId, code: 'GROUP_HISTORY_IDENTITY_PROJECTION_REQUIRED' }) }] : [];
    if (warnings.some((warning) => !operation.acknowledgedWarnings.includes(warning.id))) blockers.push('WARNINGS_NOT_ACKNOWLEDGED');
    if (operation.acknowledgedWarnings.some((id) => !warnings.some((warning) => warning.id === id))) blockers.push('UNKNOWN_WARNING_ACKNOWLEDGEMENT');
    return { ...operation, acknowledgedWarnings: [...operation.acknowledgedWarnings].sort(), evidenceVersion: current.evidenceVersion,
      amendmentId: current.amendmentId, captureId: original.captureId, captureBatchId: original.capture.batchId,
      savedGroupLink: original.groupHistoryLink ?? null,
      recordId: original.recordId, originalCandidateId: original.candidateId, sheet: source.sheet, row: source.row, kind: original.kind,
      capturedAssetId: current.capturedAssetId, currentAssetId: current.assetId, proposedAssetId: proof.item.assetId,
      originalSnapshot: original.snapshot, currentSnapshot: current.snapshot,
      assetApplicationReview: previousReview ? { evidenceVersion: previousReview.evidenceVersion, disposition: previousReview.review?.disposition ?? null, antecedentOnly: true } : null,
      effectiveSourceRevision: current.effectiveSourceRevision, capturedSourceRevision: current.capturedSourceRevision,
      effectiveDay: current.effectiveDay, datePrecision: effective.data.datePrecision, historicalActorId: null,
      requiresIdentityProjection, proposedIdentity: { serialNumber: proof.identity.serialNumber, assetTag: proof.identity.assetTag },
      assignmentUse: original.assignmentUse, retirementUse: original.retirementUse, warnings, blockers, valid: blockers.length === 0 };
  });
  const selected = new Set(input.operations.map((operation) => operation.evidenceId));
  const omittedEvidence = groupEvidence.filter(({ original }) => !selected.has(original.id)).map(({ original, current }) => ({
    evidenceId: original.id, recordId: original.recordId, kind: original.kind, currentAssetId: current.assetId, evidenceVersion: current.evidenceVersion,
    savedGroupLink: original.groupHistoryLink ?? null
  })).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const content = { rulesVersion: groupHistoryPlanRulesVersion, scope: 'IDENTITY_GROUP_HISTORY_LINK_PLAN',
    batchId: application.batchId, reviewId: application.reviewId, applicationId: application.id, applicationPlanId: application.planId,
    itemId, groupKey: proof.item.groupKey, groupId: proof.item.groupId, sourceHash: application.sourceHash,
    appliedById: application.appliedById, appliedAt: application.appliedAt, checkedAsOf: asOf, timeZone: 'America/Santiago',
    asset, sourceRows: proof.item.rows, revisions, operations, omittedEvidence };
  return { ...content, historyLinkPlanId: importPlanDigest(content), persisted: false, canApply: false, affectsCurrentState: false,
    evidenceRelinked: false, historyLinkApplicationImplemented: false, planValidationComplete: operations.every((operation) => operation.valid),
    summary: { selectedEvidenceCount: operations.length, validCount: operations.filter((operation) => operation.valid).length,
      blockedCount: operations.filter((operation) => !operation.valid).length, omittedEvidenceCount: omittedEvidence.length } };
}
