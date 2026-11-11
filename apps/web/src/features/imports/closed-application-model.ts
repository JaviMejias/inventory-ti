import type { ClosedPlan, ClosedPlanInput, ClosedPlanPeriod } from './closed-assignment-model';
import type { LegacyClosedApplication } from './legacy-closed-application-model';

export type ClosedApplicationIntent = { requestId: string; planId: string; confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY'; plan: ClosedPlanInput };
export type ClosedApplicationMetadata = { id: string; assetId: string; requestId: string; planId: string; rulesVersion: string; appliedById: string; appliedAt: string };
export type ClosedApplicationItem = { id: string; applicationId: string; periodId: string; assignmentId: string; startEvidenceId: string; endEvidenceId: string; snapshot: ClosedPlanPeriod };
export type CurrentClosedApplication = ClosedApplicationMetadata & { rulesVersion: ClosedPlan['planRulesVersion']; requestDigest: string; plan: ClosedPlan; items: ClosedApplicationItem[] };
export type ClosedApplication = CurrentClosedApplication | LegacyClosedApplication;
export type ClosedApplicationPage = { items: ClosedApplicationMetadata[]; total: number; offset: number; hasMore: boolean };

export function closedInputFromPlan(plan: ClosedPlan): ClosedPlanInput {
  if (plan.planRulesVersion !== 'mda-closed-assignment-plan-2' || plan.periods.length < 1 || plan.periods.length > 25) throw new Error('Only current closed assignment plans with 1–25 periods can create write input');
  return { periods: plan.periods.map(({ periodId, confirmation, start, end, recipient, assignmentType, returnStatus, note, evidenceReference, acknowledgedWarnings }) =>
    globalThis.structuredClone({ periodId, confirmation, start, end, recipient, assignmentType, returnStatus, note, evidenceReference, acknowledgedWarnings })) };
}
export function createClosedApplicationIntent(plan: ClosedPlan, requestId: string): ClosedApplicationIntent {
  if (plan.planRulesVersion !== 'mda-closed-assignment-plan-2' || !plan.planValidationComplete || !plan.periods.length || plan.periods.length > 25 || plan.periods.some((period) => !period.valid || period.blockers.length)) throw new Error('Blocked closed assignment plan');
  return { requestId, planId: plan.planId, confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: closedInputFromPlan(plan) };
}
