import { ApiRequestError } from '../../lib/api';
import type { IdentityGroupProjection } from './identity-group-projection-model';
import type { IdentityGroupReview } from './identity-group-review-model';

export type GroupDecisionAction = 'HOLD' | 'EXCLUDE' | 'LINK_EXISTING' | 'PROPOSE_NEW';
export type GroupEvidenceDisposition = 'CONFIRM_GROUP_MEMBERSHIP' | 'EXCLUDE_FROM_GROUP_PILOT';
export type GroupEvidenceReview = { evidenceId: string; expectedEvidenceVersion: number; disposition: GroupEvidenceDisposition; note: string; evidenceReference: string };
export type GroupDecisionInput = {
  requestId: string; confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY'; expectedDecisionVersion: number; expectedBatchVersion: number;
  expectedSourceRevision: number; projectionId: string; groupKey: string; action: GroupDecisionAction; linkedAssetId?: string;
  note: string; evidenceReference: string; evidenceReviews: GroupEvidenceReview[];
};
export type GroupDecisionMetadata = {
  id: string; reviewId: string; version: number; requestId: string; requestDigest: string; rulesVersion: 'mda-identity-group-decision-1';
  groupId: string; groupKey: string; batchVersion: number; sourceRevision: number; projectionId: string; action: GroupDecisionAction;
  linkedAssetId: string | null; note: string; evidenceReference: string; evidenceReviews: GroupEvidenceReview[]; reviewedById: string; createdAt: string;
};
export type GroupDecision = GroupDecisionMetadata & { projection: IdentityGroupProjection };
export type GroupDecisionRead = { decision: GroupDecision; decisionVersion: number; reviewActive: boolean; currentProjectionId: string | null; projectionCurrent: boolean };
export type GroupDecisionSaved = { decision: GroupDecision; decisionVersion: number; reused: boolean };
export type GroupDecisionPage = {
  items: Array<GroupDecisionMetadata & { projectionCurrent: boolean }>; decisionVersion: number; reviewActive: boolean; currentProjectionId: string | null;
  mode: 'latest' | 'history'; groupKey: string; total: number; offset: number; limit: 25; hasMore: boolean;
};
export type GroupDecisionContext = { projection: IdentityGroupProjection; latest: GroupDecisionPage };
export type GroupDecisionIntent = { review: IdentityGroupReview; actorId: string; projection: IdentityGroupProjection; input: GroupDecisionInput };
export type GroupDecisionDraft = {
  action: '' | GroupDecisionAction; linkedAssetId: string; note: string; reference: string; reviewEvidence: boolean;
  evidence: Record<string, { disposition: '' | GroupEvidenceDisposition; note: string; reference: string }>;
};
export const groupDecisionLabels = { HOLD: 'Dejar pendiente', EXCLUDE: 'Excluir del futuro piloto', LINK_EXISTING: 'Proponer vínculo con activo', PROPOSE_NEW: 'Proponer activo nuevo' };
export const groupEvidenceLabels = { CONFIRM_GROUP_MEMBERSHIP: 'Confirmar pertenencia al grupo', EXCLUDE_FROM_GROUP_PILOT: 'Excluir del piloto del grupo' };
export function emptyGroupDecision(): GroupDecisionDraft { return { action: '', linkedAssetId: '', note: '', reference: '', reviewEvidence: false, evidence: {} }; }
export function validateGroupDecisionPageContinuation(previous: GroupDecisionPage | null, page: GroupDecisionPage) {
  if (page.offset && (!previous || page.mode !== previous.mode || page.groupKey !== previous.groupKey || page.total !== previous.total ||
    page.decisionVersion !== previous.decisionVersion || page.currentProjectionId !== previous.currentProjectionId || page.reviewActive !== previous.reviewActive)) {
    throw new ApiRequestError('Decision list changed', 409, 'IDENTITY_GROUP_DECISION_LIST_CHANGED');
  }
}
export function groupDecisionOptions(projection: IdentityGroupProjection, groupKey: string, latest: GroupDecisionMetadata[] = []) {
  const group = projection.groups.find((entry) => entry.groupKey === groupKey);
  const matches = new Map(group?.candidates.flatMap((candidate) => candidate.existingAssets.map((asset) => [asset.id, asset] as const)) ?? []);
  const sole = matches.size === 1 ? [...matches.values()][0] : null;
  const alreadyProposed = sole && latest.some((row) => row.groupKey !== groupKey && row.action === 'LINK_EXISTING' && row.linkedAssetId === sole.id);
  return {
    group, matches: [...matches.values()],
    canCreate: Boolean(group && projection.projectionValidationComplete && group.candidates.every((candidate) => candidate.existingAssetCount === 0)),
    canLink: Boolean(group && projection.projectionValidationComplete && sole && !alreadyProposed && group.candidates.every((candidate) => candidate.existingAssetCount === 1 && !candidate.hasMoreExistingAssets)),
    consumed: Boolean(group?.evidence.some((entry) => entry.assignmentUse || entry.retirementUse))
  };
}
export function validateGroupDecisionDraft(context: GroupDecisionContext, groupKey: string, draft: GroupDecisionDraft) {
  const errors: Record<string, string> = {}; const options = groupDecisionOptions(context.projection, groupKey, context.latest.items);
  if (!options.group || !context.latest.reviewActive || context.latest.currentProjectionId !== context.projection.projectionId) errors.context = 'Consulta el contexto actual antes de decidir.';
  if (context.latest.decisionVersion >= 2147483647) errors.context = 'Esta revisión alcanzó su límite de decisiones. Solicita una revisión administrativa.';
  if (!draft.action || !Object.hasOwn(groupDecisionLabels, draft.action)) errors.action = 'Elige una decisión para este grupo.';
  else if (draft.action === 'LINK_EXISTING' && !options.canLink || draft.action === 'PROPOSE_NEW' && !options.canCreate) errors.action = 'Esta propuesta no está disponible en el contexto consultado. Revisa sus conflictos y coincidencias.';
  if (draft.action === 'LINK_EXISTING' && !options.matches.some((asset) => asset.id === draft.linkedAssetId)) errors.linkedAssetId = 'Selecciona el único activo sugerido para este grupo.';
  if (!draft.note.trim() || draft.note.trim().length > 2000) errors.note = 'Indica el motivo de la decisión (hasta 2.000 caracteres).';
  if (!draft.reference.trim() || draft.reference.trim().length > 500) errors.reference = 'Indica su respaldo (hasta 500 caracteres).';
  const review = ['LINK_EXISTING', 'PROPOSE_NEW'].includes(draft.action) || draft.reviewEvidence;
  if (review && options.consumed) errors.reviewEvidence = 'La evidencia utilizada en historia aplicada no admite una nueva revisión de pertenencia.';
  if (review) for (const evidence of options.group?.evidence ?? []) {
    const item = draft.evidence[evidence.id];
    if (!item?.disposition || !Object.hasOwn(groupEvidenceLabels, item.disposition)) errors[evidence.id + '.disposition'] = 'Elige expresamente qué hacer con esta evidencia.';
    if (!item?.note.trim() || item.note.trim().length > 2000) errors[evidence.id + '.note'] = 'Indica el motivo para esta evidencia (hasta 2.000 caracteres).';
    if (!item?.reference.trim() || item.reference.trim().length > 500) errors[evidence.id + '.reference'] = 'Indica el respaldo de esta evidencia (hasta 500 caracteres).';
  }
  return errors;
}
export function groupDecisionInput(context: GroupDecisionContext, groupKey: string, draft: GroupDecisionDraft, requestId: string): GroupDecisionInput {
  if (Object.keys(validateGroupDecisionDraft(context, groupKey, draft)).length) throw new ApiRequestError('Revisa la decisión y su evidencia antes de confirmar.', 400, 'VALIDATION_ERROR');
  const group = context.projection.groups.find((entry) => entry.groupKey === groupKey)!;
  return { requestId: requestId.toLowerCase(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY', expectedDecisionVersion: context.latest.decisionVersion,
    expectedBatchVersion: context.projection.batchVersion, expectedSourceRevision: context.projection.sourceRevision, projectionId: context.projection.projectionId,
    groupKey, action: draft.action as GroupDecisionAction, ...(draft.action === 'LINK_EXISTING' ? { linkedAssetId: draft.linkedAssetId.toLowerCase() } : {}),
    note: draft.note.trim(), evidenceReference: draft.reference.trim(),
    evidenceReviews: ['LINK_EXISTING', 'PROPOSE_NEW'].includes(draft.action) || draft.reviewEvidence ? group.evidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion,
      disposition: draft.evidence[entry.id].disposition as GroupEvidenceDisposition, note: draft.evidence[entry.id].note.trim(), evidenceReference: draft.evidence[entry.id].reference.trim() })).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)) : [] };
}
