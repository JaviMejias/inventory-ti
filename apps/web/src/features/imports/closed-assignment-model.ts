import type { PreviewIssue } from './import-review-model';
import type { HistoryKind } from './history-evidence-model';

export type ClosedEndpoint = { evidenceId: string; confirmedAt: string | null; dateEvidenceReference: string | null };
export type ClosedPeriod = {
  periodId: string; confirmation: 'VERIFIED_CLOSED_ASSIGNMENT'; start: ClosedEndpoint; end: ClosedEndpoint;
  recipient: { type: 'PERSON' | 'OFFICE'; name: string } | null; assignmentType: 'STANDARD' | 'LOAN';
  returnStatus: 'AVAILABLE' | 'UNDER_REVIEW' | 'IN_REPAIR' | null; note: string; evidenceReference: string; acknowledgedWarnings: string[];
};
export type ClosedPlanInput = { periods: ClosedPeriod[] };
export type ClosedPlanSource = {
  endpoint: 'start' | 'end'; evidenceId: string; captureId: string; batchId: string; sourceHash: string; recordId: string; candidateId: string;
  kind: HistoryKind; sheet: string; row: number; sourceRevision: number; evidenceVersion: number; amendmentId: string | null;
  capturedSourceRevision: number; effectiveDay: string | null; datePrecision: 'DAY' | 'UNKNOWN'; fields: Record<string, string | null>; snapshotDigest: string;
};
export type ClosedPlanPeriod = ClosedPeriod & {
  sources: ClosedPlanSource[];
  proposedAssignment: { assetId: string; personId: null; recipientType: 'PERSON' | 'OFFICE' | null; personName: string | null; officeName: string | null;
    assignmentType: 'STANDARD' | 'LOAN'; startedAt: string | null; endedAt: string | null; returnStatus: ClosedPeriod['returnStatus'];
    assignedById: null; returnedById: null; ticketReference: string | null; otReference: string | null; returnTicketReference: string | null; returnOtReference: string | null };
  warnings: Array<{ id: string; evidenceId: string; issue: PreviewIssue; contextualOnly: boolean }>;
  blockers: Array<{ code: string; endpoint?: 'start' | 'end'; relatedId?: string }>; valid: boolean;
};
export type ClosedPlan = {
  planRulesVersion: 'mda-closed-assignment-plan-2'; scope: 'CLOSED_ASSIGNMENT_HISTORY_PLAN'; mode: 'CLOSED_ASSIGNMENT_PLAN';
  canApply: false; persisted: false; affectsCurrentState: false; checkedAsOf: string;
  assetBefore: { id: string; productId: string; serialNumber: string | null; assetTag: string | null; status: string; isActive: boolean;
    decommissionedAt: string | null; updatedAt: string; product: { id: string; trackingMode: string; isActive: boolean; updatedAt: string } };
  currentAssignmentsDigest: string; sourceRevisionsDigest: string; planId: string; periods: ClosedPlanPeriod[]; planValidationComplete: boolean;
  summary: { periodCount: number; validCount: number; blockingCount: number; warningCount: number };
};
export type ClosedPeriodDraft = {
  periodId: string; startId: string; endId: string; startAt: string; endAt: string; startProof: string; endProof: string;
  recipientType: '' | 'PERSON' | 'OFFICE'; recipientName: string; assignmentType: '' | 'STANDARD' | 'LOAN'; returnStatus: '' | NonNullable<ClosedPeriod['returnStatus']>;
  note: string; reference: string; confirmed: boolean; acknowledgedWarnings: string[];
};
export function emptyClosedPeriod(periodId: string): ClosedPeriodDraft {
  return { periodId, startId: '', endId: '', startAt: '', endAt: '', startProof: '', endProof: '', recipientType: '', recipientName: '',
    assignmentType: '', returnStatus: '', note: '', reference: '', confirmed: false, acknowledgedWarnings: [] };
}
// Preserve the source's local day and explicit offset; a UTC conversion would change V10's source-day comparison.
export function validHistoricalInstant(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[1] < '1900-01-01' || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  if (match[5] !== 'Z' && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4)) > 59)) return false;
  const day = new Date(match[1] + 'T00:00:00Z');
  const instant = Date.parse(value);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === match[1] && Number.isFinite(instant) && instant >= Date.parse('1900-01-01T00:00:00Z');
}
export function validateClosedPeriod(draft: ClosedPeriodDraft) {
  const errors: Partial<Record<keyof ClosedPeriodDraft, string>> = {};
  if (!draft.startId) errors.startId = 'Elige una observación de uso o préstamo.';
  if (!draft.endId) errors.endId = 'Elige una observación de recepción o uso.';
  else if (draft.startId === draft.endId) errors.endId = 'Los extremos deben ser observaciones distintas.';
  for (const field of ['startAt', 'endAt'] as const) if (draft[field].trim() && !validHistoricalInstant(draft[field].trim())) errors[field] = 'Usa una fecha real desde 1900 con hora, segundos y zona: AAAA-MM-DDTHH:MM:SS-03:00 o Z.';
  for (const field of ['startProof', 'endProof', 'reference'] as const) if (draft[field].trim().length > 500) errors[field] = 'Usa como máximo 500 caracteres.';
  if (draft.recipientType || draft.recipientName.trim()) {
    if (!draft.recipientType) errors.recipientType = 'Selecciona persona u oficina.';
    const name = draft.recipientName.trim();
    if (!name || name.length > (draft.recipientType === 'PERSON' ? 150 : 160) || (draft.recipientType === 'PERSON' && !/\s+\S+/.test(name))) errors.recipientName = 'Indica nombre y apellido de la persona, o el nombre de la oficina, dentro del límite.';
  }
  if (!draft.assignmentType) errors.assignmentType = 'Elige explícitamente entrega estándar o préstamo.';
  if (!draft.note.trim() || draft.note.trim().length > 2000) errors.note = 'Indica el motivo de verificación (hasta 2000 caracteres).';
  if (!draft.reference.trim()) errors.reference = 'Indica el respaldo del periodo cerrado.';
  if (!draft.confirmed) errors.confirmed = 'Confirma que revisaste un periodo cerrado, no una entrega activa.';
  return errors;
}
export function validateClosedPeriods(drafts: ClosedPeriodDraft[]): Record<string, ReturnType<typeof validateClosedPeriod>> {
  const errors: Record<string, ReturnType<typeof validateClosedPeriod>> = {};
  const ids = new Set<string>(); const endpoints = new Map<string, Array<{ periodId: string; field: 'startId' | 'endId' }>>();
  const uuid = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  for (const draft of drafts) {
    const row = validateClosedPeriod(draft);
    if (!uuid(draft.periodId) || ids.has(draft.periodId.toLowerCase())) row.periodId = 'Cada periodo debe tener un identificador de propuesta distinto.';
    if (draft.acknowledgedWarnings.length > 1000 || new Set(draft.acknowledgedWarnings).size !== draft.acknowledgedWarnings.length || draft.acknowledgedWarnings.some((id) => !/^[a-f0-9]{64}$/.test(id))) row.acknowledgedWarnings = 'Revisa los reconocimientos de este periodo; deben ser identificadores exactos, distintos y hasta 1000.';
    ids.add(draft.periodId.toLowerCase());
    for (const field of ['startId', 'endId'] as const) {
      if (!uuid(draft[field])) row[field] = 'Elige una observación válida.';
      if (draft[field]) { const key = draft[field].toLowerCase(); endpoints.set(key, [...endpoints.get(key) ?? [], { periodId: draft.periodId, field }]); }
    }
    if (Object.keys(row).length) errors[draft.periodId] = row;
  }
  for (const uses of endpoints.values()) if (uses.length > 1) for (const use of uses) { errors[use.periodId] ??= {}; errors[use.periodId][use.field] = 'Esta evidencia ya está seleccionada en otro extremo del conjunto.'; }
  return errors;
}
export function closedPlanInput(value: ClosedPeriodDraft | ClosedPeriodDraft[]): ClosedPlanInput {
  const drafts = Array.isArray(value) ? value : [value];
  if (!drafts.length || drafts.length > 25 || Object.keys(validateClosedPeriods(drafts)).length) throw new Error('Invalid closed period draft');
  return { periods: drafts.map((draft) => ({ periodId: draft.periodId.toLowerCase(), confirmation: 'VERIFIED_CLOSED_ASSIGNMENT',
    start: { evidenceId: draft.startId.toLowerCase(), confirmedAt: draft.startAt.trim() || null, dateEvidenceReference: draft.startProof.trim() || null },
    end: { evidenceId: draft.endId.toLowerCase(), confirmedAt: draft.endAt.trim() || null, dateEvidenceReference: draft.endProof.trim() || null },
    recipient: draft.recipientType ? { type: draft.recipientType, name: draft.recipientName.trim() } : null,
    assignmentType: draft.assignmentType as ClosedPeriod['assignmentType'], returnStatus: draft.returnStatus || null,
    note: draft.note.trim(), evidenceReference: draft.reference.trim(), acknowledgedWarnings: [...draft.acknowledgedWarnings] })) };
}
