import { validHistoricalInstant, type ClosedPlan } from './closed-assignment-model';
import type { PreviewIssue } from './import-review-model';

export type RetirementPlanInput = {
  evidenceId: string; confirmation: 'VERIFIED_HISTORICAL_RETIREMENT'; confirmedAt: string | null;
  dateEvidenceReference: string | null; note: string; evidenceReference: string; acknowledgedWarnings: string[];
};
export type RetirementDraft = {
  evidenceId: string; confirmedAt: string; dateEvidenceReference: string; note: string; reference: string;
  confirmed: boolean; acknowledgedWarnings: string[];
};
export type RetirementPlan = {
  planRulesVersion: 'mda-retirement-plan-1'; scope: 'HISTORICAL_RETIREMENT_PLAN'; mode: 'HISTORICAL_RETIREMENT_PLAN';
  canApply: false; persisted: false; affectsCurrentState: false; checkedAsOf: string; assetBefore: ClosedPlan['assetBefore'];
  request: RetirementPlanInput; currentAssignmentsDigest: string; sourceRevisionsDigest: string; planId: string;
  source: {
    evidenceId: string; captureId: string; batchId: string; sourceHash: string; recordId: string; candidateId: string;
    kind: 'RETIREMENT_OBSERVATION'; sheet: string; row: number; sourceRevision: number; capturedSourceRevision: number;
    evidenceVersion: number; amendmentId: string | null; effectiveDay: null; datePrecision: 'UNKNOWN';
    sourceReceivedDay: string | null; fields: Record<string, string | null>; snapshotDigest: string;
  };
  proposedRetirement: { assetId: string; status: 'DECOMMISSIONED'; isActive: false; decommissionedAt: string | null; historicalActorId: null };
  warnings: Array<{ id: string; evidenceId: string; issue: PreviewIssue }>;
  blockers: Array<{ code: string; relatedId?: string }>; planValidationComplete: boolean;
  summary: { retirementCount: 1; validCount: 0 | 1; blockingCount: number; warningCount: number };
};
export function emptyRetirementDraft(): RetirementDraft {
  return { evidenceId: '', confirmedAt: '', dateEvidenceReference: '', note: '', reference: '', confirmed: false, acknowledgedWarnings: [] };
}
export function validateRetirementDraft(draft: RetirementDraft) {
  const errors: Partial<Record<keyof RetirementDraft, string>> = {};
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(draft.evidenceId)) errors.evidenceId = 'Elige una observación de baja vinculada a este activo.';
  if (draft.confirmedAt.trim() && !validHistoricalInstant(draft.confirmedAt.trim())) errors.confirmedAt = 'Usa una fecha real desde 1900, con hora, segundos y zona: AAAA-MM-DDTHH:MM:SS-03:00 o Z.';
  if (draft.dateEvidenceReference.trim().length > 500) errors.dateEvidenceReference = 'Usa como máximo 500 caracteres.';
  if (!draft.note.trim() || draft.note.trim().length > 2000) errors.note = 'Indica el motivo de verificación (hasta 2000 caracteres).';
  if (!draft.reference.trim() || draft.reference.trim().length > 500) errors.reference = 'Indica el respaldo de la baja (hasta 500 caracteres).';
  if (!draft.confirmed) errors.confirmed = 'Confirma la revisión documental. Esto no aplica la baja.';
  if (draft.acknowledgedWarnings.length > 1000 || new Set(draft.acknowledgedWarnings).size !== draft.acknowledgedWarnings.length ||
    draft.acknowledgedWarnings.some((id) => !/^[a-f0-9]{64}$/.test(id))) errors.acknowledgedWarnings = 'Revisa los reconocimientos: deben ser identificadores únicos del plan, hasta 1000.';
  return errors;
}
export function retirementPlanInput(draft: RetirementDraft): RetirementPlanInput {
  if (Object.keys(validateRetirementDraft(draft)).length) throw new Error('Invalid retirement draft');
  return { evidenceId: draft.evidenceId, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: draft.confirmedAt.trim() || null,
    dateEvidenceReference: draft.dateEvidenceReference.trim() || null, note: draft.note.trim(), evidenceReference: draft.reference.trim(),
    acknowledgedWarnings: [...draft.acknowledgedWarnings] };
}
