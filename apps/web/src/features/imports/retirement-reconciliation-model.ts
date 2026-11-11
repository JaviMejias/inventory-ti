import type { HistoryKind } from './history-evidence-model';
import type { RetirementPlan } from './retirement-plan-model';

export const retirementClassificationLabels = {
  CURRENT_STATE_REVIEW_REQUIRED: 'Revisar el estado actual',
  EVIDENCE_ALREADY_USED: 'Evidencia utilizada en otro contexto',
  ALREADY_IMPORTED_RETIREMENT: 'Esta baja ya tiene comprobante',
  EXISTING_IMPORTED_RETIREMENT: 'El activo tiene otra baja importada',
  EVIDENCE_REVIEW_REQUIRED: 'Revisar la evidencia y su vínculo',
  CURRENT_CUSTODY_CONFLICT: 'Existe una entrega vigente',
  EXISTING_UNDATED_RETIREMENT: 'Baja existente sin fecha',
  EXISTING_DATED_RETIREMENT: 'Baja existente con fecha registrada',
  RETIREMENT_DATE_UNCONFIRMED: 'Falta verificar el instante del retiro'
};
export const retirementCurrentStateLabels = {
  INCONSISTENT: 'Estado o cronología por conciliar', ACTIVE_CUSTODY: 'Con custodia vigente',
  TERMINAL_UNDATED: 'Dado de baja sin fecha', TERMINAL_DATED: 'Dado de baja con fecha', NONTERMINAL: 'Sin baja terminal'
};
export const retirementEvidenceStateLabels = {
  USED_FOR_THIS_RETIREMENT: 'Usada en esta baja', USED_FOR_OTHER_RETIREMENT: 'Usada en la baja de otro activo',
  USED_BY_ASSIGNMENT: 'Usada en una asignación histórica', REVIEW_REQUIRED: 'Origen o vínculo por revisar', ARCHIVED_ONLY: 'Solo archivada'
};
export const retirementNextStepLabels: Record<string, string> = {
  REVIEW_EVIDENCE_LINK_AND_SOURCE: 'Revisa la identidad, el vínculo y la versión de origen. Una enmienda no elimina los conflictos operativos.',
  REVIEW_CURRENT_STATE: 'Contrasta el estado y la cronología reales del activo antes de continuar.',
  REVIEW_CURRENT_CUSTODY: 'Investiga la entrega vigente. No registres una devolución ficticia para desbloquear la baja.',
  REVIEW_EVIDENCE_CONSUMPTION: 'Consulta dónde se utilizó la evidencia. No la dupliques ni la traslades a otro activo.',
  CONSULT_EXISTING_RETIREMENT_RECEIPT: 'Consulta el comprobante de baja ya registrado para este activo.',
  RECONCILE_EXISTING_RETIREMENT_SEPARATELY: 'La baja previa necesita una revisión documental separada. No apliques otra baja ni reemplaces su fecha.',
  PROVIDE_VERIFIED_DATE_AND_REQUEST_V13_PLAN: 'Obtén fecha, hora, zona y respaldo externos. Después prepara una baja nueva para que el servidor reevalúe todos los requisitos.',
  KEEP_UNDATED_SOURCE_EVIDENCE: 'Conserva la fecha desconocida del archivo original. Recepción, año de la hoja y fecha de captura no prueban el retiro.'
};
export type RetirementReconciliationReceipt = {
  id: string; assetId: string; evidenceId: string; evidenceVersion: number; amendmentId: string | null;
  sourceRevision: number; decommissionedAt: string; appliedAt: string; appliedById: string;
};
export type RetirementReconciliation = {
  rulesVersion: 'mda-retirement-reconciliation-1'; scope: 'HISTORICAL_RETIREMENT_RECONCILIATION'; mode: 'READ_ONLY_RECONCILIATION';
  canApply: false; persisted: false; affectsCurrentState: false; operationalResolutionImplemented: false;
  checkedAsOf: string; assessmentId: string; retirementPlanDigest: string;
  classification: keyof typeof retirementClassificationLabels;
  currentState: keyof typeof retirementCurrentStateLabels; evidenceState: keyof typeof retirementEvidenceStateLabels;
  assetBefore: RetirementPlan['assetBefore'];
  source: Omit<RetirementPlan['source'], 'kind' | 'effectiveDay' | 'datePrecision'> & { kind: HistoryKind; effectiveDay: string | null; datePrecision: 'DAY' | 'UNKNOWN' };
  sourceRetirement: { effectiveAt: null; datePrecision: 'UNKNOWN'; historicalActorId: null } | null;
  existingRetirement: { effectiveAt: string | null; datePrecision: 'INSTANT' | 'UNKNOWN'; dateOrigin: 'CURRENT_ASSET' | 'VERIFIED_IMPORT_RECEIPT'; confirmsSourceDate: false } | null;
  existingApplication: RetirementReconciliationReceipt | null; evidenceApplication: RetirementReconciliationReceipt | null;
  warnings: RetirementPlan['warnings']; diagnostics: RetirementPlan['blockers']; nextSteps: string[];
  links: { verifiedPlan: string | null; existingApplication: string | null };
};
