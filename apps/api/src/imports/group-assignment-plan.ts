import { ApiError } from '../lib/errors.js';
import { buildClosedAssignmentPlan, historicalEvidenceSnapshotSchema, type HistoricalPlanAsset,
  type HistoricalPlanAssignment, type HistoricalPlanRevision } from './assignment-plan.js';
import { currentHistoricalEvidence } from './evidence-current.js';
import type { GroupClosedAssignmentPlanInput } from './group-assignment-plan-schemas.js';
import { validateGroupHistoryApplicationProof, type GroupHistoryApplicationProof } from './group-history-application-proof.js';
import { validateGroupApplicationProof, type GroupApplicationProof } from './identity-group-application-proof.js';
import type { GroupHistoryEvidence } from './identity-group-history-plan.js';
import { importPlanDigest } from './plan.js';
import { identifierKey } from './preview.js';

export const groupClosedAssignmentRulesVersion = 'mda-group-closed-assignment-plan-1';

export function buildGroupClosedAssignmentPlan(application: GroupApplicationProof, itemId: string, asset: HistoricalPlanAsset | null,
  receipts: GroupHistoryApplicationProof[], evidence: GroupHistoryEvidence[], assignments: HistoricalPlanAssignment[],
  revisions: HistoricalPlanRevision[], input: GroupClosedAssignmentPlanInput, now = new Date()) {
  const proof = validateGroupApplicationProof(application).find(({ item }) => item.id === itemId);
  if (!proof) throw new ApiError(404, 'NOT_FOUND', 'Applied group item not found in this application');
  if (input.expectedApplicationPlanId !== application.planId) throw new ApiError(409, 'IDENTITY_GROUP_APPLICATION_CHANGED', 'Choose the exact saved group application');
  if (!asset || asset.id !== proof.item.assetId) throw new ApiError(404, 'NOT_FOUND', 'Applied group asset not found');
  if (receipts.length > 100 || evidence.length > 100 || assignments.length > 10000 || revisions.length > 1000 || receipts.reduce((count, receipt) => count + receipt.links.length, 0) > 100) {
    throw new ApiError(409, 'GROUP_ASSIGNMENT_PLAN_LIMIT', 'Group assignment context exceeds supported planning limits');
  }
  const proofs = receipts.flatMap((receipt) => validateGroupHistoryApplicationProof(receipt, proof, application));
  if (new Set(receipts.map((receipt) => receipt.id)).size !== receipts.length || new Set(proofs.map(({ link }) => link.id)).size !== proofs.length ||
    new Set(proofs.map(({ link }) => link.evidenceId)).size !== proofs.length) throw new ApiError(409, 'INVALID_GROUP_HISTORY_APPLICATION', 'Group history confirmations contain duplicate ownership');
  if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length || evidence.some((entry) => entry.sourceHash !== application.sourceHash ||
    entry.capture.sourceHash !== application.sourceHash || entry.capture.id !== entry.captureId ||
    !proof.source.some((row) => row.recordId === entry.recordId && row.originalCandidateId === entry.candidateId))) {
    throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Group evidence does not retain physical source ownership');
  }
  const selected = [...input.links].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)).map((pin) => {
    const saved = proofs.find(({ link }) => link.id === pin.linkId && link.evidenceId === pin.evidenceId);
    if (!saved) throw new ApiError(404, 'NOT_FOUND', 'Confirmed history link does not belong to this applied group endpoint');
    const entry = evidence.find((value) => value.id === saved.link.evidenceId);
    if (!entry) throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Confirmed history link has no matching archive');
    if (entry.amendments.length > 1 || entry.amendments.some((event) => event.evidenceId !== entry.id || !Number.isInteger(event.version) || event.version < 1 || event.version > 1000)) {
      throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Current group archive cannot establish its evidence version');
    }
    const current = currentHistoricalEvidence(entry);
    const source = proof.source.find((row) => row.recordId === entry.recordId)!;
    for (const interpretation of [entry, current]) {
      const parsed = historicalEvidenceSnapshotSchema.safeParse(interpretation.snapshot);
      if (!parsed.success || parsed.data.recordId !== entry.recordId || parsed.data.candidateId !== entry.candidateId || parsed.data.kind !== entry.kind ||
        parsed.data.effectiveDay !== interpretation.effectiveDay || (interpretation.effectiveDay === null) !== (parsed.data.datePrecision === 'UNKNOWN') ||
        parsed.data.original.id !== entry.recordId || parsed.data.effective.id !== entry.recordId ||
        parsed.data.original.sheet !== source.sheet || parsed.data.effective.sheet !== source.sheet ||
        parsed.data.original.row !== source.row || parsed.data.effective.row !== source.row) {
        throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Current group evidence cannot establish physical snapshot provenance');
      }
    }
    if (pin.expectedLinkVersion !== saved.link.version) throw new ApiError(409, 'GROUP_HISTORY_LINK_VERSION_CONFLICT', 'Reload the confirmed history link', { linkId: saved.link.id, currentVersion: saved.link.version });
    if (pin.expectedEvidenceVersion !== current.evidenceVersion) throw new ApiError(409, 'EVIDENCE_VERSION_CONFLICT', 'Reload the current archive evidence', { evidenceId: entry.id, currentVersion: current.evidenceVersion });
    const changed = saved.link.evidenceVersion !== current.evidenceVersion || saved.link.amendmentId !== current.amendmentId ||
      saved.link.sourceRevision !== current.effectiveSourceRevision || saved.operation.captureId !== entry.captureId ||
      saved.operation.captureBatchId !== entry.capture.batchId || saved.operation.capturedSourceRevision !== entry.capture.sourceRevision ||
      saved.operation.kind !== entry.kind || saved.operation.effectiveDay !== current.effectiveDay || saved.operation.currentAssetId !== current.assetId ||
      saved.operation.capturedAssetId !== current.capturedAssetId ||
      importPlanDigest(saved.raw.originalSnapshot) !== importPlanDigest(entry.snapshot) ||
      importPlanDigest(saved.raw.currentSnapshot) !== importPlanDigest(current.snapshot);
    return { ...saved, original: entry, current, changed };
  });
  const projected = selected.map(({ link, original, operation }) => ({ ...original, assetId: link.assetId, snapshot: link.projection,
    effectiveDay: operation.effectiveDay, effectiveSourceRevision: link.sourceRevision, evidenceVersion: link.evidenceVersion, amendmentId: link.amendmentId }));
  const used = selected.flatMap(({ original }) => original.assignmentUse ? [{ evidenceId: original.id, itemId: original.assignmentUse.itemId }]
    : original.groupAssignmentUse ? [{ evidenceId: original.id, itemId: original.groupAssignmentUse.itemId }]
    : original.retirementUse ? [{ evidenceId: original.id, itemId: original.retirementUse.id }] : []);
  const base = buildClosedAssignmentPlan(asset, projected, assignments, revisions, input.plan, now, used);
  const identityChanged = asset.productId !== proof.identity.productId || identifierKey(asset.serialNumber) !== identifierKey(proof.identity.serialNumber) ||
    identifierKey(asset.assetTag) !== identifierKey(proof.identity.assetTag);
  const periods = base.periods.map((period) => {
    const blockers = [...period.blockers];
    if (identityChanged) blockers.push({ code: 'GROUP_ASSET_IDENTITY_CHANGED' });
    const sources = period.sources.map((source) => {
      const chosen = selected.find(({ link }) => link.evidenceId === source.evidenceId)!;
      if (chosen.changed) blockers.push({ code: 'GROUP_HISTORY_EVIDENCE_CHANGED', endpoint: source.endpoint });
      return { ...source, groupHistoryLinkId: chosen.link.id, groupHistoryLinkVersion: chosen.link.version,
        historyApplicationId: chosen.receipt.id, historyLinkPlanId: chosen.receipt.planId };
    });
    return { ...period, sources, blockers, valid: blockers.length === 0 };
  });
  const selectedIds = new Set(selected.map(({ link }) => link.id)); const linkedEvidence = new Set(proofs.map(({ link }) => link.evidenceId));
  const historyLinks = selected.map(({ link, receipt, current }) => ({ ...link, historyLinkPlanId: receipt.planId,
    confirmedById: receipt.appliedById, confirmedAt: receipt.appliedAt, capturedAssetId: current.capturedAssetId,
    currentAssetId: current.assetId, currentEvidenceVersion: current.evidenceVersion, currentAmendmentId: current.amendmentId,
    currentSourceRevision: current.effectiveSourceRevision, currentSnapshot: current.snapshot, groupAssignmentUse: current.groupAssignmentUse ?? null }));
  const unselectedHistoryLinks = proofs.filter(({ link }) => !selectedIds.has(link.id)).map(({ link, receipt }) => ({
    id: link.id, evidenceId: link.evidenceId, assetId: link.assetId, version: link.version, evidenceVersion: link.evidenceVersion,
    historyApplicationId: receipt.id, historyLinkPlanId: receipt.planId,
    groupAssignmentUse: evidence.find((entry) => entry.id === link.evidenceId)?.groupAssignmentUse ?? null
  })).sort((a, b) => a.id.localeCompare(b.id));
  const unlinkedEvidence = evidence.filter((entry) => !linkedEvidence.has(entry.id)).map((entry) => ({
    evidenceId: entry.id, recordId: entry.recordId, kind: entry.kind, evidenceVersion: currentHistoricalEvidence(entry).evidenceVersion
  })).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const content = { rulesVersion: groupClosedAssignmentRulesVersion, scope: 'GROUP_CLOSED_ASSIGNMENT_HISTORY_PLAN',
    batchId: application.batchId, reviewId: application.reviewId, applicationId: application.id, applicationPlanId: application.planId,
    itemId, groupKey: proof.item.groupKey, groupId: proof.item.groupId, sourceHash: application.sourceHash,
    checkedAsOf: base.checkedAsOf, timeZone: 'America/Santiago', assetBefore: asset, sourceRows: proof.item.rows,
    applicationProofDigest: importPlanDigest(application),
    historyReceiptProofs: [...receipts].sort((a, b) => a.id.localeCompare(b.id)).map((receipt) => ({
      id: receipt.id, planId: receipt.planId, requestDigest: receipt.requestDigest, appliedById: receipt.appliedById, appliedAt: receipt.appliedAt
    })), currentAssignmentsDigest: base.currentAssignmentsDigest, sourceRevisionsDigest: base.sourceRevisionsDigest,
    periods, historyLinks, unselectedHistoryLinks, unlinkedEvidence };
  return { ...content, planId: importPlanDigest(content), persisted: false, canApply: false, affectsCurrentState: false,
    evidenceRelinked: false, operationalHistoryApplied: false, closedAssignmentApplicationImplemented: false,
    planValidationComplete: periods.every((period) => period.valid), summary: { periodCount: periods.length, validCount: periods.filter((period) => period.valid).length,
      blockingCount: periods.reduce((count, period) => count + period.blockers.length, 0), warningCount: periods.reduce((count, period) => count + period.warnings.length, 0),
      selectedEndpointCount: selected.length, omittedLinkCount: unselectedHistoryLinks.length, unlinkedEvidenceCount: unlinkedEvidence.length } };
}
