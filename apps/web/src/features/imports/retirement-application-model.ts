import { ApiRequestError } from '../../lib/api';
import { sameSnapshot } from './history-evidence-api';
import { validateRetirementPlan } from './retirement-plan-api';
import { retirementPlanInput, type RetirementPlan, type RetirementPlanInput } from './retirement-plan-model';

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type RetirementApplicationIntent = Immutable<{
  requestId: string; planId: string; confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT'; plan: RetirementPlanInput;
}>;
export type RetirementApplicationMetadata = Readonly<{
  id: string; assetId: string; evidenceId: string; evidenceVersion: number; amendmentId: string | null; sourceRevision: number;
  decommissionedAt: string; requestId: string; planId: string; rulesVersion: 'mda-retirement-plan-1'; appliedById: string; appliedAt: string;
}>;
export type RetirementApplicationResult = Readonly<{
  id: string; productId: string; serialNumber: string | null; assetTag: string | null;
  status: 'DECOMMISSIONED'; isActive: false; decommissionedAt: string; updatedAt: string;
}>;
export type RetirementApplication = Readonly<RetirementApplicationMetadata & {
  requestDigest: string; plan: RetirementPlan; result: RetirementApplicationResult;
}>;
export type RetirementApplicationPage = Readonly<{
  items: readonly RetirementApplicationMetadata[]; total: number; limit: 25; offset: number; hasMore: boolean;
}>;

export function validateRetirementApplicationIntent(value: unknown): RetirementApplicationIntent {
  const invalid = (): never => { throw new ApiRequestError('Revisa la intención de baja y genera un plan válido.', 400, 'VALIDATION_ERROR'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const intent = value as Record<string, unknown>;
  if (typeof intent.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(intent.requestId) ||
    typeof intent.planId !== 'string' || !/^[a-f0-9]{64}$/.test(intent.planId) || intent.confirmation !== 'APPLY_VERIFIED_HISTORICAL_RETIREMENT' ||
    !intent.plan || typeof intent.plan !== 'object' || Array.isArray(intent.plan)) return invalid();
  const plan = intent.plan as RetirementPlanInput;
  let input: RetirementPlanInput;
  try {
    input = retirementPlanInput({ evidenceId: plan.evidenceId, confirmedAt: plan.confirmedAt ?? '', dateEvidenceReference: plan.dateEvidenceReference ?? '',
      note: plan.note, reference: plan.evidenceReference, acknowledgedWarnings: plan.acknowledgedWarnings, confirmed: true });
  } catch { return invalid(); }
  const canonical = { requestId: intent.requestId, planId: intent.planId, confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT' as const, plan: input };
  if (!input.confirmedAt || !input.dateEvidenceReference || !sameSnapshot(intent, canonical)) return invalid();
  Object.freeze(input.acknowledgedWarnings);
  return Object.freeze({ ...canonical, requestId: canonical.requestId.toLowerCase(), plan: Object.freeze(input) });
}

export function retirementInputFromPlan(plan: RetirementPlan): RetirementPlanInput {
  return globalThis.structuredClone(plan.request);
}

export function createRetirementApplicationIntent(plan: RetirementPlan, requestId: string): RetirementApplicationIntent {
  const intent = validateRetirementApplicationIntent({ requestId, planId: plan.planId, confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT', plan: retirementInputFromPlan(plan) });
  validateRetirementPlan(plan, { ...intent.plan, acknowledgedWarnings: [...intent.plan.acknowledgedWarnings] }, plan.assetBefore.id);
  if (!plan.planValidationComplete || plan.blockers.length) throw new ApiRequestError('Resuelve los bloqueos y revisa un plan de baja vigente.', 409, 'RETIREMENT_PLAN_BLOCKED');
  return intent;
}
