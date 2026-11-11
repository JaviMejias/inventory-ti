import type { Asset, Assignment, ImportGroupAssignmentCorrection } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { historicalAssignmentValues, validateGroupAssignmentApplicationProof, type GroupAssignmentApplicationProof, type GroupAssignmentAuditProof } from './group-assignment-application-proof.js';
import type { GroupAssignmentCorrectionPlanInput } from './group-assignment-correction-schemas.js';
import { buildGroupClosedAssignmentPlan } from './group-assignment-plan.js';
import type { GroupClosedAssignmentContext } from './group-assignment-plan-service.js';
import { importPlanDigest } from './plan.js';
import { validateGroupCorrectionChain } from './group-correction-chain.js';
import type { HistoricalPlanAssignment } from './assignment-plan.js';
import { z } from 'zod';

export const groupAssignmentCorrectionRulesVersion = 'mda-group-assignment-correction-plan-1';
export function buildGroupAssignmentCorrectionPlan(context: GroupClosedAssignmentContext, receipt: GroupAssignmentApplicationProof,
  assignmentItemId: string, audits: GroupAssignmentAuditProof[], currentState: { asset: Asset | null; custody: Assignment[] },
  input: GroupAssignmentCorrectionPlanInput, now = new Date(), corrections: ImportGroupAssignmentCorrection[] = [], effectiveAssignments: HistoricalPlanAssignment[] = context.assignments) {
  const item = receipt.items.find((entry) => entry.id === assignmentItemId);
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Imported assignment item not found in this receipt');
  if (input.expectedOriginPlanId !== receipt.planId) throw new ApiError(409, 'GROUP_ASSIGNMENT_ORIGIN_CHANGED', 'Choose the exact saved assignment origin');
  const origin = validateGroupAssignmentApplicationProof(context, receipt, audits, now);
  const previous = origin.request.plan.periods.find((period) => period.periodId === item.periodId)!;
  const initialValues = { ...historicalAssignmentValues(item.assignment), note: item.assignment.notes, evidenceReference: item.assignment.returnNotes,
    startDateEvidenceReference: previous.start.dateEvidenceReference, endDateEvidenceReference: previous.end.dateEvidenceReference };
  const latest = validateGroupCorrectionChain(corrections, item.id, receipt.planId, importPlanDigest(receipt), now, initialValues);
  if ((input.expectedCorrectionVersion ?? 0) !== (latest?.version ?? 0)) throw new ApiError(409, 'GROUP_CORRECTION_VERSION_CONFLICT', 'Reload current correction version', { currentVersion: latest?.version ?? 0 });
  if (!currentState.asset || currentState.asset.id !== receipt.assetId || currentState.custody.length > 1 ||
    currentState.custody.some((entry) => entry.assetId !== receipt.assetId || entry.endedAt !== null)) {
    throw new ApiError(409, 'GROUP_CORRECTION_CURRENT_STATE_INVALID', 'Current asset and open custody cannot be established');
  }
  const ownEvidence = new Set(item.evidenceUses.map((use) => use.evidenceId));
  const period = { ...input.correction, periodId: item.periodId, confirmation: 'VERIFIED_CLOSED_ASSIGNMENT' as const,
    start: { ...input.correction.start, evidenceId: previous.start.evidenceId }, end: { ...input.correction.end, evidenceId: previous.end.evidenceId } };
  const checked = buildGroupClosedAssignmentPlan(context.application, context.item.id, context.asset, context.receipts,
    context.evidence.map((entry) => ownEvidence.has(entry.id) ? { ...entry, groupAssignmentUse: null } : entry),
    effectiveAssignments.filter((entry) => entry.id !== item.assignmentId), context.revisions,
    { expectedApplicationPlanId: origin.request.expectedApplicationPlanId,
      links: origin.request.links.filter((link) => ownEvidence.has(link.evidenceId)), plan: { periods: [period] } }, now);
  const candidate = checked.periods[0];
  const latestPlan = latest ? z.record(z.unknown()).parse(latest.plan) : null;
  const before = latestPlan ? z.record(z.unknown()).parse(latestPlan.proposed) : initialValues;
  const after = { ...candidate.proposedAssignment, note: period.note, evidenceReference: period.evidenceReference,
    startDateEvidenceReference: period.start.dateEvidenceReference, endDateEvidenceReference: period.end.dateEvidenceReference };
  const changes = Object.entries(after).filter(([field, value]) => importPlanDigest(before[field as keyof typeof before]) !== importPlanDigest(value))
    .map(([field, value]) => ({ field, before: before[field as keyof typeof before], after: value }));
  const blockers = [...candidate.blockers]; if (changes.length === 0) blockers.push({ code: 'GROUP_ASSIGNMENT_CORRECTION_UNCHANGED' });
  if (latest?.version === 1000) blockers.push({ code: 'GROUP_CORRECTION_LIMIT' });
  const content = { rulesVersion: groupAssignmentCorrectionRulesVersion, scope: 'GROUP_CLOSED_ASSIGNMENT_CORRECTION_PLAN',
    batchId: context.application.batchId, reviewId: context.application.reviewId, applicationId: context.application.id,
    itemId: context.item.id, groupApplicationId: receipt.id, assignmentItemId: item.id, assignmentId: item.assignmentId, assetId: receipt.assetId,
    originPlanId: receipt.planId, originReceiptDigest: importPlanDigest(receipt), originAuditDigest: importPlanDigest([...audits].sort((a, b) =>
      (a.entityType + a.entityId + a.action + a.userId).localeCompare(b.entityType + b.entityId + b.action + b.userId))),
    currentCorrectionVersion: latest?.version ?? 0, currentCorrectionId: latest?.id ?? null, correctionChainDigest: importPlanDigest(corrections),
    currentContextDigest: importPlanDigest({ currentState, asset: context.asset, assignments: effectiveAssignments, revisions: context.revisions }),
    validationContextPlanId: checked.planId, checkedAsOf: checked.checkedAsOf, timeZone: checked.timeZone,
    reason: input.reason, supportingReference: input.supportingReference, before, proposed: after, changes,
    originalPeriod: item.snapshot, proposedPeriod: candidate, sources: candidate.sources,
    ownership: item.evidenceUses, originalAssignment: item.assignment, currentAsset: currentState.asset, currentCustody: currentState.custody,
    acknowledgedWarnings: candidate.acknowledgedWarnings, warnings: candidate.warnings, blockers };
  return { ...content, correctionPlanId: importPlanDigest(content), mode: 'CORRECTION_REVIEW_ONLY', persisted: false, canApply: false,
    affectsCurrentState: false, evidenceRelinked: false, operationalHistoryApplied: false, correctionApplicationImplemented: false,
    planValidationComplete: blockers.length === 0 };
}
