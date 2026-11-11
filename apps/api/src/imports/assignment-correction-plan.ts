import type { Asset, Assignment, ImportAssignmentCorrection } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { validateAssignmentApplicationProof, type AssignmentApplicationProof, type AssignmentOriginAudit, type AssignmentOriginEvidence } from './assignment-application-proof.js';
import type { AssignmentCorrectionPlanInput } from './assignment-correction-schemas.js';
import { buildClosedAssignmentPlan, type HistoricalPlanAsset, type HistoricalPlanAssignment, type HistoricalPlanRevision } from './assignment-plan.js';
import { historicalAssignmentValues } from './historical-assignment-values.js';
import { importPlanDigest } from './plan.js';
import { validateAssignmentCorrectionChain } from './assignment-correction-chain.js';
import { z } from 'zod';

export type AssignmentCorrectionContext = { asset: HistoricalPlanAsset; currentAsset: Asset; custody: Assignment[]; assignments: HistoricalPlanAssignment[];
  evidence: AssignmentOriginEvidence[]; revisions: HistoricalPlanRevision[]; originalAssignments?: HistoricalPlanAssignment[] };
export const assignmentCorrectionRulesVersion = 'mda-legacy-assignment-correction-plan-1';
export function buildAssignmentCorrectionPlan(receipt: AssignmentApplicationProof, itemId: string, audits: AssignmentOriginAudit[], context: AssignmentCorrectionContext,
  input: AssignmentCorrectionPlanInput, now = new Date(), corrections: ImportAssignmentCorrection[] = []) {
  const item = receipt.items.find((entry) => entry.id === itemId); if (!item) throw new ApiError(404, 'NOT_FOUND', 'Legacy assignment item not found in this receipt');
  if (input.expectedOriginPlanId !== receipt.planId) throw new ApiError(409, 'ASSIGNMENT_ORIGIN_CHANGED', 'Select the exact saved historical origin');
  if (context.assignments.length > 10000 || context.revisions.length > 1000 || context.evidence.length > 50 || receipt.items.length > 25 || audits.length > 26) {
    throw new ApiError(409, 'ASSIGNMENT_CORRECTION_LIMIT', 'Legacy correction context exceeds supported limits');
  }
  const origin = validateAssignmentApplicationProof(receipt, context.evidence, audits, now);
  if (context.currentAsset.id !== receipt.assetId || context.asset.id !== receipt.assetId || context.custody.length > 1 ||
    context.custody.some((entry) => entry.assetId !== receipt.assetId || entry.endedAt !== null) ||
    receipt.items.some((entry) => !(context.originalAssignments ?? context.assignments).some((assignment) => assignment.id === entry.assignmentId &&
      importPlanDigest(assignment.startedAt) === importPlanDigest(entry.assignment.startedAt) && importPlanDigest(assignment.endedAt) === importPlanDigest(entry.assignment.endedAt)))) {
    throw new ApiError(409, 'ASSIGNMENT_CORRECTION_CURRENT_STATE_INVALID', 'Current legacy assignment origin and custody cannot be established');
  }
  const previous = origin.request.periods.find((period) => period.periodId === item.periodId)!;
  const initial = { ...historicalAssignmentValues(item.assignment), note: item.assignment.notes, evidenceReference: item.assignment.returnNotes,
    startDateEvidenceReference: previous.start.dateEvidenceReference, endDateEvidenceReference: previous.end.dateEvidenceReference };
  const latest = validateAssignmentCorrectionChain(corrections, item.id, receipt.planId, importPlanDigest(receipt), now, initial);
  if (input.expectedCorrectionVersion !== undefined && input.expectedCorrectionVersion !== (latest?.version ?? 0)) throw new ApiError(409, 'ASSIGNMENT_CORRECTION_VERSION_CONFLICT', 'Reload the current legacy correction version', { currentVersion: latest?.version ?? 0 });
  const period = { ...input.correction, periodId: item.periodId, confirmation: 'VERIFIED_CLOSED_ASSIGNMENT' as const,
    start: { ...input.correction.start, evidenceId: item.startEvidenceId }, end: { ...input.correction.end, evidenceId: item.endEvidenceId } };
  const selectedEvidence = context.evidence.filter((entry) => entry.id === item.startEvidenceId || entry.id === item.endEvidenceId);
  // Only this fully proven period is exempted locally; normal import readers retain ownership checks.
  const checked = buildClosedAssignmentPlan(context.asset, selectedEvidence, context.assignments.filter((entry) => entry.id !== item.assignmentId), context.revisions, { periods: [period] }, now);
  const candidate = checked.periods[0]!;
  const before = latest ? z.record(z.unknown()).parse(z.record(z.unknown()).parse(latest.plan).proposed) : initial;
  const proposed = { ...candidate.proposedAssignment, note: period.note, evidenceReference: period.evidenceReference,
    startDateEvidenceReference: period.start.dateEvidenceReference, endDateEvidenceReference: period.end.dateEvidenceReference };
  const changes = Object.entries(proposed).filter(([key, value]) => importPlanDigest(before[key as keyof typeof before]) !== importPlanDigest(value))
    .map(([field, after]) => ({ field, before: before[field as keyof typeof before], after }));
  const blockers = [...candidate.blockers]; if (changes.length === 0) blockers.push({ code: 'ASSIGNMENT_CORRECTION_UNCHANGED' });
  if (latest?.version === 1000) blockers.push({ code: 'ASSIGNMENT_CORRECTION_LIMIT' });
  const content = { rulesVersion: assignmentCorrectionRulesVersion, scope: 'LEGACY_CLOSED_ASSIGNMENT_CORRECTION_PLAN',
    assetId: receipt.assetId, applicationId: receipt.id, assignmentItemId: item.id, assignmentId: item.assignmentId, originPlanId: receipt.planId,
    originReceiptDigest: importPlanDigest(receipt), originAuditDigest: importPlanDigest([...audits].sort((a, b) =>
      (a.entityType + a.entityId + a.action + a.userId).localeCompare(b.entityType + b.entityId + b.action + b.userId))),
    currentContextDigest: importPlanDigest({ currentAsset: context.currentAsset, asset: context.asset, custody: context.custody, assignments: context.assignments, revisions: context.revisions }),
    validationContextPlanId: checked.planId, checkedAsOf: checked.checkedAsOf, timeZone: 'America/Santiago', currentCorrectionVersion: latest?.version ?? 0,
    currentCorrectionId: latest?.id ?? null, correctionChainDigest: importPlanDigest(corrections),
    request: { ...input, correction: { ...input.correction, acknowledgedWarnings: [...input.correction.acknowledgedWarnings].sort() } },
    reason: input.reason, supportingReference: input.supportingReference, before, proposed, changes, originalPeriod: item.snapshot,
    originalAssignment: item.assignment, currentAsset: context.currentAsset, currentCustody: context.custody, proposedPeriod: candidate,
    sources: candidate.sources, currentEvidence: selectedEvidence, ownership: item.evidenceUses, acknowledgedWarnings: candidate.acknowledgedWarnings,
    warnings: candidate.warnings, blockers };
  return { ...content, correctionPlanId: importPlanDigest(content), mode: 'CORRECTION_REVIEW_ONLY', persisted: false, canApply: false,
    affectsCurrentState: false, evidenceRelinked: false, operationalHistoryApplied: false, correctionApplicationImplemented: false,
    planValidationComplete: blockers.length === 0 };
}
