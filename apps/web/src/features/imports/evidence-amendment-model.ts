import type { CaptureMetadata, CapturedObservation, HistoryCapture } from './history-evidence-model';

export type EvidenceOwner = Pick<HistoryCapture['items'][number], 'id' | 'captureId' | 'recordId' | 'candidateId' | 'kind'>;
export type OriginalEvidence = HistoryCapture['items'][number] & { capture: CaptureMetadata };
export type CurrentEvidence = OriginalEvidence & {
  evidenceVersion: number; amendmentId: string | null; amendedAt: string | null; effectiveSourceRevision: number;
  capturedAssetId: string | null; capturedEffectiveDay: string | null; capturedSourceRevision: number;
};
export type AmendmentMetadata = {
  id: string; evidenceId: string; version: number; previousAmendmentId: string | null; batchVersion: number; sourceRevision: number;
  requestId: string; amendmentPlanId: string; rulesVersion: string; assetId: string | null; effectiveDay: string | null;
  note: string; evidenceReference: string; amendedById: string; amendedAt: string;
};
export type EvidenceAmendment = AmendmentMetadata & { requestDigest: string; snapshot: CapturedObservation };
export type AmendmentPage = { original: OriginalEvidence; current: CurrentEvidence; events: AmendmentMetadata[]; total: number; offset: number; hasMore: boolean };
export type AmendmentPlan = {
  rulesVersion: string; evidenceId: string; batchId: string; batchVersion: number; sourceRevision: number;
  evidenceVersion: number; previousAmendmentId: string | null; originalEvidence: OriginalEvidence; current: CurrentEvidence;
  proposed: CapturedObservation | null; used: { evidenceId: string; itemId: string; endpoint: 'START' | 'END' | 'RETIREMENT' } | null;
  historyPreviewId: string; blockers: string[]; amendmentPlanId: string; valid: boolean;
};
export type AmendmentIntent = {
  requestId: string; amendmentPlanId: string; expectedEvidenceVersion: number; expectedBatchVersion: number; expectedSourceRevision: number;
  confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY'; assetId: string | null; note: string; evidenceReference: string;
};
export type AmendmentDraft = { target: '' | 'unlinked' | 'current' | 'asset'; assetId: string; note: string; reference: string; confirmed: boolean };
export function amendmentTarget(draft: AmendmentDraft, current: CurrentEvidence): string | null | undefined {
  if (draft.target === 'unlinked') return null;
  if (draft.target === 'current') return current.assetId ?? undefined;
  if (draft.target === 'asset' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(draft.assetId.trim())) return draft.assetId.trim().toLowerCase();
  return undefined;
}
export function validateAmendmentDraft(draft: AmendmentDraft, saving = false): Partial<Record<keyof AmendmentDraft, string>> {
  const errors: Partial<Record<keyof AmendmentDraft, string>> = {};
  if (!draft.target) errors.target = 'Elige expresamente el vínculo propuesto.';
  if (draft.target === 'asset' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(draft.assetId.trim())) errors.assetId = 'Ingresa el UUID completo del activo revisado.';
  if (saving) {
    if (!draft.note.trim() || draft.note.trim().length > 2000) errors.note = 'Indica el motivo, entre 1 y 2000 caracteres.';
    if (!draft.reference.trim() || draft.reference.trim().length > 500) errors.reference = 'Indica el respaldo, entre 1 y 500 caracteres.';
    if (!draft.confirmed) errors.confirmed = 'Confirma que guardarás solo una nueva versión documental.';
  }
  return errors;
}
export function createAmendmentIntent(plan: AmendmentPlan, draft: AmendmentDraft, requestId: string): AmendmentIntent {
  if (!plan.valid || !plan.proposed || plan.used || plan.blockers.length || plan.evidenceVersion >= 1000 || Object.keys(validateAmendmentDraft(draft, true)).length ||
    amendmentTarget(draft, plan.current) !== plan.proposed.assetId) throw new Error('Unreviewed evidence amendment');
  return { requestId, amendmentPlanId: plan.amendmentPlanId, expectedEvidenceVersion: plan.evidenceVersion, expectedBatchVersion: plan.batchVersion,
    expectedSourceRevision: plan.sourceRevision, confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: plan.proposed.assetId,
    note: draft.note.trim(), evidenceReference: draft.reference.trim() };
}
export const amendmentBlockerLabels: Record<string, string> = {
  EVIDENCE_ALREADY_APPLIED: 'Esta evidencia ya se usó en historia aplicada. Requiere un flujo de corrección distinto; no se puede enmendar.',
  EVIDENCE_AMENDMENT_LIMIT: 'La evidencia alcanzó el límite de versiones.',
  EVIDENCE_RULES_CHANGED: 'Las reglas de la captura no son compatibles con esta revisión.',
  OBSERVATION_NO_LONGER_MAPPED: 'El origen ya no reconoce esta observación con la misma clase e identidad.',
  HISTORY_ASSET_LINK_UNCONFIRMED: 'El vínculo no está aprobado en la identidad vigente. Revisa la decisión del lote original o elige expresamente Sin vincular.',
  EVIDENCE_AMENDMENT_UNCHANGED: 'La propuesta coincide con la versión vigente; no hay una nueva interpretación o vínculo que guardar.'
};
