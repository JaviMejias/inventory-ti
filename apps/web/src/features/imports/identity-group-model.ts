import type { AuditedChange } from './source-review-model';
import type { Candidate, ImportPreview, PreviewIssue, SourceCell, SourceRecord } from './import-review-model';

export type GroupIdentityDraft = { mode: '' | 'verified' | 'absent'; value: string };
export type IdentityGroupDraft = {
  groupId: string; serial: GroupIdentityDraft; tag: GroupIdentityDraft; evidenceReference: string;
};
export type IdentityGroupsDraft = {
  candidateIds: string[]; groups: IdentityGroupDraft[]; assignments: Record<string, string>; note: string; confirmed: boolean;
};
export type IdentityGroupInput = {
  expectedVersion: number; expectedSourceRevision: number; confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS'; candidateIds: string[]; note: string;
  groups: Array<{ groupId: string; recordIds: string[]; serialNumber: string | null; assetTag: string | null; evidenceReference: string }>;
};
export type IdentityGroupScope = { candidates: Candidate[]; records: SourceRecord[] };
type GroupCells = { serialNumber: SourceCell | null; assetTag: SourceCell | null };
export type IdentityGroupPlan = {
  scope: 'PHYSICAL_IDENTITY_GROUP_PLAN'; rulesVersion: 'mda-identity-group-plan-1'; asOf: string; timeZone: 'America/Santiago';
  canApply: false; persisted: false; affectsCurrentState: false; lineagePersistenceImplemented: false; proposalValidationComplete: boolean;
  batchId: string; batchVersion: number; sourceRevision: number; sourceHash: string; planId: string;
  currentPreviewDigest: string; simulatedPreviewDigest: string; sourceContextDigest: string; request: IdentityGroupInput;
  operationKind: 'IDENTITY_ONLY' | 'SPLIT' | 'MERGE' | 'REPARTITION';
  originalCandidates: Array<{ candidateId: string; recordIds: string[] }>;
  observations: Array<{ recordId: string; sheet: string; row: number; originalCandidateId: string; proposedGroupId: string; originalIdentityCells: GroupCells; currentIdentityCells: GroupCells }>;
  proposedGroups: Array<IdentityGroupInput['groups'][number] & {
    originalCandidateIds: string[]; simulatedCandidateIds: string[];
    candidates: Array<{ id: string; serials: string[]; tags: string[]; selectedRecordIds: string[]; outsideRecordCount: number;
      existingAssets: Candidate['existingAssets']; existingAssetCount: number; hasMoreExistingAssets: boolean }>;
  }>;
  changes: Array<Omit<AuditedChange, 'action' | 'field' | 'value'> & { action: 'REPLACE'; field: 'serialNumber' | 'assetTag'; value: string }>;
  issues: PreviewIssue[]; warnings: PreviewIssue[];
  blockers: Array<{ code: string; groupId?: string; recordId?: string; relatedId?: string; issue?: PreviewIssue }>;
  impacts: {
    pilotItems: Array<{ id: string; candidateId: string; assetId: string; applicationId: string }>;
    decisions: Array<{ id: string; targetType: 'CANDIDATE'; targetId: string; action: 'HOLD' | 'EXCLUDE' | 'LINK_EXISTING' | 'PROPOSE_NEW'; linkedAssetId: string | null; batchVersion: number; sourceRevision: number }>;
    evidence: Array<{ id: string; recordId: string; candidateId: string; captureId: string; captureBatchId: string;
      capturedAssetId: string | null; currentAssetId: string | null; capturedSourceRevision: number; sourceRevision: number;
      evidenceVersion: number; amendmentId: string | null; assignmentUse: { itemId: string; endpoint: 'START' | 'END' } | null; retirementUse: { id: string; assetId: string } | null }>;
  };
  requiresEvidenceLineageReview: boolean; requiresDecisionRenewal: boolean; requiresCoordinatedIdentityReview: boolean;
  nextWorkflow: 'LINEAGE_WORKFLOW_NOT_IMPLEMENTED' | 'IDENTITY_REVIEW_SCOPE_WORKFLOW_NOT_IMPLEMENTED' | 'COORDINATED_IDENTITY_WORKFLOW_NOT_IMPLEMENTED' | 'V8_IDENTITY_REVIEW';
  summary: { originalCandidateCount: number; proposedGroupCount: number; observationCount: number; changedCellCount: number; blockingCount: number; warningCount: number };
};
export const identityGroupOperationLabels = { IDENTITY_ONLY: 'Solo identidad', SPLIT: 'Separación', MERGE: 'Fusión', REPARTITION: 'Redistribución' };
export const identityGroupWorkflowLabels = {
  LINEAGE_WORKFLOW_NOT_IMPLEMENTED: 'La separación, fusión o redistribución necesita una revisión de agrupaciones con procedencia por fila. Esta simulación no la guarda.',
  IDENTITY_REVIEW_SCOPE_WORKFLOW_NOT_IMPLEMENTED: 'Algún candidato supera las 12 observaciones del flujo individual. No dividas su alcance para guardarlo por esa vía.',
  COORDINATED_IDENTITY_WORKFLOW_NOT_IMPLEMENTED: 'Las identidades requieren revisión coordinada. No uses series temporales ni verificaciones individuales para sortear colisiones.',
  V8_IDENTITY_REVIEW: 'La pertenencia de filas se conserva. La revisión individual de identidad requiere su flujo habilitado, una consulta y una confirmación nuevas. Los demás conflictos siguen vigentes.'
};
export function emptyIdentityGroupsDraft(): IdentityGroupsDraft { return { candidateIds: [], groups: [], assignments: {}, note: '', confirmed: false }; }
export function newIdentityGroup(groupId: string): IdentityGroupDraft {
  return { groupId, serial: { mode: '', value: '' }, tag: { mode: '', value: '' }, evidenceReference: '' };
}
export function physicalGroupCandidates(preview: ImportPreview) {
  const records = new Map(preview.records.map((record) => [record.id, record]));
  return preview.candidates.filter((candidate) => candidate.recordIds.length > 0 && candidate.recordIds.every((id) => {
    const record = records.get(id); return record && ['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(record.kind);
  }));
}
export function identityGroupScope(preview: ImportPreview, candidateIds: string[]): IdentityGroupScope {
  const ids = new Set(candidateIds); const candidates = physicalGroupCandidates(preview).filter((candidate) => ids.has(candidate.id));
  const records = new Map(preview.records.map((record) => [record.id, record]));
  return { candidates, records: candidates.flatMap((candidate) => candidate.recordIds.map((id) => records.get(id)!)) };
}
function verifiedIdentity(value: string) {
  const key = value.trim().replace(/\s+/g, ' ').toUpperCase();
  return !['', 'N/A', 'NA', 'N.A.', 'S/N', 'SIN SERIE', 'SIN ACTIVO', '-'].includes(key);
}
export function validateIdentityGroupScope(preview: ImportPreview, candidateIds: string[]): string | null {
  const scope = identityGroupScope(preview, candidateIds);
  if (!candidateIds.length || candidateIds.length > 25 || new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => !/^[a-f0-9]{64}$/.test(id)) || scope.candidates.length !== candidateIds.length) return 'Selecciona entre 1 y 25 candidatos físicos originales, sin duplicados.';
  if (!scope.records.length || scope.records.length > 25 || new Set(scope.records.map((record) => record.id)).size !== scope.records.length || scope.records.some((record) => !/^[a-f0-9]{64}$/.test(record.id))) return 'El alcance debe contener entre 1 y 25 filas completas. No se divide un candidato ni se omiten observaciones.';
  return null;
}
export function validateIdentityGroupsDraft(preview: ImportPreview, draft: IdentityGroupsDraft): Record<string, string> {
  const errors: Record<string, string> = {}; const scope = identityGroupScope(preview, draft.candidateIds);
  const uuid = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const scopeError = validateIdentityGroupScope(preview, draft.candidateIds); if (scopeError) errors.scope = scopeError;
  if (!draft.groups.length || draft.groups.length > 25 || new Set(draft.groups.map((group) => group.groupId.toLowerCase())).size !== draft.groups.length || draft.groups.some((group) => !uuid(group.groupId))) errors.groups = 'Define entre 1 y 25 grupos distintos para esta simulación.';
  const groupIds = new Set(draft.groups.map((group) => group.groupId)); const recordIds = new Set(scope.records.map((record) => record.id));
  if (scope.records.some((record) => !groupIds.has(draft.assignments[record.id])) || Object.keys(draft.assignments).some((id) => !recordIds.has(id))) errors.coverage = 'Asigna cada fila seleccionada a un grupo, sin filas externas ni observaciones omitidas.';
  for (const group of draft.groups) {
    if (!scope.records.some((record) => draft.assignments[record.id] === group.groupId)) errors[group.groupId + '.records'] = 'Asigna al menos una fila a este grupo.';
    for (const [name, identity, max] of [['serial', group.serial, 160], ['tag', group.tag, 100]] as const) {
      if (!['verified', 'absent'].includes(identity.mode) || identity.mode === 'verified' && (!verifiedIdentity(identity.value) || identity.value.trim().length > max)) errors[group.groupId + '.' + name] = `Revisa este identificador: escribe texto verificado de hasta ${max} caracteres o elige Sin identidad expresamente.`;
    }
    if (group.serial.mode === 'absent' && group.tag.mode === 'absent') errors[group.groupId + '.serial'] = 'Verifica al menos una serie o un activo fijo para este grupo.';
    if (!group.evidenceReference.trim() || group.evidenceReference.trim().length > 500) errors[group.groupId + '.reference'] = 'Indica el respaldo de este grupo (hasta 500 caracteres).';
  }
  if (!draft.note.trim() || draft.note.trim().length > 2000) errors.note = 'Indica el motivo de la propuesta (hasta 2.000 caracteres).';
  if (!draft.confirmed) errors.confirmed = 'Confirma la revisión de pertenencia e identificadores para simular sin guardar.';
  return errors;
}
export function identityGroupInput(preview: ImportPreview, draft: IdentityGroupsDraft, version: number, revision: number): IdentityGroupInput {
  if (Object.keys(validateIdentityGroupsDraft(preview, draft)).length || !Number.isInteger(version) || version < 1 || version > 2147483647 || !Number.isInteger(revision) || revision < 0 || revision > 1000) throw new Error('Invalid identity grouping draft');
  const scope = identityGroupScope(preview, draft.candidateIds);
  return normalizeIdentityGroupInput({ expectedVersion: version, expectedSourceRevision: revision, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS', candidateIds: [...draft.candidateIds], note: draft.note.trim(),
    groups: draft.groups.map((group) => ({ groupId: group.groupId.toLowerCase(), recordIds: scope.records.filter((record) => draft.assignments[record.id] === group.groupId).map((record) => record.id),
      serialNumber: group.serial.mode === 'absent' ? null : group.serial.value.trim(), assetTag: group.tag.mode === 'absent' ? null : group.tag.value.trim(), evidenceReference: group.evidenceReference.trim() })) });
}
export function normalizeIdentityGroupInput(input: IdentityGroupInput): IdentityGroupInput {
  return { ...input, candidateIds: [...input.candidateIds].sort(), groups: input.groups.map((group) => ({ ...group, recordIds: [...group.recordIds].sort() })).sort((a, b) => a.groupId.localeCompare(b.groupId)) };
}
