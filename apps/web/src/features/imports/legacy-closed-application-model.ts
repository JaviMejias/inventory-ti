import type { ClosedApplicationItem, ClosedApplicationMetadata } from './closed-application-model';
import type { ClosedPlan, ClosedPlanPeriod, ClosedPlanSource } from './closed-assignment-model';

type ReadonlySnapshot<T> = { readonly [Key in keyof T]: ReadonlySnapshot<T[Key]> };

// V10/V11 rules1 predates the V12 projection fields. Absence is not evidence version zero.
export type LegacyClosedPlanSource = ReadonlySnapshot<Omit<ClosedPlanSource, 'evidenceVersion' | 'amendmentId' | 'capturedSourceRevision'>>;
export type LegacyClosedPlanPeriod = ReadonlySnapshot<Omit<ClosedPlanPeriod, 'sources'> & { sources: LegacyClosedPlanSource[] }>;
export type LegacyClosedPlan = ReadonlySnapshot<Omit<ClosedPlan, 'planRulesVersion' | 'periods'> & {
  planRulesVersion: 'mda-closed-assignment-plan-1'; periods: LegacyClosedPlanPeriod[];
}>;
export type LegacyClosedApplication = ReadonlySnapshot<ClosedApplicationMetadata & {
  rulesVersion: 'mda-closed-assignment-plan-1'; requestDigest: string; plan: LegacyClosedPlan;
  items: Array<Omit<ClosedApplicationItem, 'snapshot'> & { snapshot: LegacyClosedPlanPeriod }>;
}>;
