import type { ImportGroupAssignmentCorrection } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { groupCorrectionApplySchema, groupCorrectionRequestDigest } from './group-correction-apply-schemas.js';
import { importPlanDigest } from './plan.js';

export const correctionEnvelope = new Set(['correctionPlanId', 'mode', 'persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'operationalHistoryApplied', 'correctionApplicationImplemented', 'planValidationComplete']);
export function validateGroupCorrectionChain(events: ImportGroupAssignmentCorrection[], itemId: string, originPlanId: string, originReceiptDigest: string, now = new Date(), initialValues?: unknown) {
  if (events.length > 1000) throw new ApiError(409, 'GROUP_CORRECTION_LIMIT', 'Correction chain exceeds supported versions');
  let previous: ImportGroupAssignmentCorrection | undefined;
  let previousValues: unknown = initialValues;
  const ordered = [...events].sort((a, b) => a.version - b.version);
  for (const event of ordered) {
    const parsed = z.record(z.unknown()).safeParse(event.plan); const period = z.record(z.unknown()).safeParse(parsed.success ? parsed.data.proposedPeriod : null);
    if (!parsed.success || !period.success) return invalid();
    const plan = parsed.data;
    const side = (value: unknown) => { const parsed = z.record(z.unknown()).safeParse(value); return parsed.success ? { confirmedAt: parsed.data.confirmedAt, dateEvidenceReference: parsed.data.dateEvidenceReference } : null; };
    const request = groupCorrectionApplySchema.safeParse({ requestId: event.requestId, correctionPlanId: event.correctionPlanId,
      confirmation: 'APPLY_GROUP_ASSIGNMENT_CORRECTION', plan: { expectedOriginPlanId: originPlanId, expectedCorrectionVersion: event.version - 1,
        reason: event.reason, supportingReference: event.supportingReference,
        correction: { start: side(period.data.start), end: side(period.data.end), recipient: period.data.recipient,
          assignmentType: period.data.assignmentType, returnStatus: period.data.returnStatus, note: period.data.note,
          evidenceReference: period.data.evidenceReference, acknowledgedWarnings: period.data.acknowledgedWarnings } } });
    if (!request.success || groupCorrectionRequestDigest(request.data) !== event.requestDigest || event.itemId !== itemId ||
      event.rulesVersion !== 'mda-group-assignment-correction-application-1' || event.version !== (previous?.version ?? 0) + 1 || event.previousId !== (previous?.id ?? null) ||
      plan.currentCorrectionVersion !== event.version - 1 || plan.currentCorrectionId !== event.previousId || plan.originPlanId !== originPlanId || plan.originReceiptDigest !== originReceiptDigest ||
      plan.assignmentItemId !== itemId || plan.correctionPlanId !== event.correctionPlanId || plan.scope !== 'GROUP_CLOSED_ASSIGNMENT_CORRECTION_PLAN' ||
      plan.rulesVersion !== 'mda-group-assignment-correction-plan-1' || plan.planValidationComplete !== true || plan.affectsCurrentState !== false || plan.persisted !== false ||
      plan.canApply !== false || plan.evidenceRelinked !== false || plan.operationalHistoryApplied !== false || plan.correctionApplicationImplemented !== false ||
      !z.string().uuid().safeParse(event.correctedById).success || !/^[1-9][0-9]{0,19}$/.test(event.createdTransactionId) ||
      importPlanDigest(Object.fromEntries(Object.entries(plan).filter(([key]) => !correctionEnvelope.has(key)))) !== event.correctionPlanId ||
      ((previous || initialValues !== undefined) && importPlanDigest(plan.before) !== importPlanDigest(previousValues)) || !(event.correctedAt instanceof Date) ||
      !Number.isFinite(event.correctedAt.getTime()) || event.correctedAt > now || (previous && event.correctedAt < previous.correctedAt)) return invalid();
    previous = event; previousValues = plan.proposed;
  }
  return previous;
}
function invalid(): never { throw new ApiError(409, 'INVALID_GROUP_CORRECTION_CHAIN', 'Saved correction versions cannot establish immutable effective history'); }
