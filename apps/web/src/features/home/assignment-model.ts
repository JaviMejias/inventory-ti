import { inventoryDateTimeToUtc } from '../../lib/date-range';
import type { AppRole } from '../../lib/permissions';

export type ReturnStatus = 'AVAILABLE' | 'UNDER_REVIEW' | 'IN_REPAIR';
export type AssignmentSnapshot = {
  id: string;
  personName: string | null;
  recipientType?: 'PERSON' | 'OFFICE';
  officeName?: string | null;
  assignmentType?: 'STANDARD' | 'LOAN';
  expectedReturnAt?: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt?: string | null;
  returnRecordedAt?: string | null;
  returnStatus?: ReturnStatus | null;
  ticketReference?: string | null;
  otReference?: string | null;
  notes?: string | null;
  returnTicketReference?: string | null;
  returnOtReference?: string | null;
  returnNotes?: string | null;
  createdBy?: { displayName: string } | null;
  endedBy?: { displayName: string } | null;
  importedHistory?: boolean;
  importHistory?: { id: string; applicationId: string; periodId: string; startEvidenceId: string; endEvidenceId: string; application: { appliedById: string; appliedAt: string } } | null;
  groupImportHistory?: {
    id: string; applicationId: string; periodId: string; startLinkId: string; endLinkId: string;
    evidenceUses: { evidenceId: string; linkId: string; endpoint: 'START' | 'END' }[];
    application: { itemId: string; appliedById: string; appliedAt: string };
  } | null;
};
export type AssignmentRecord = AssignmentSnapshot & {
  originalAssignment?: AssignmentSnapshot | null;
  historyCorrection?: { id: string; version: number | null; correctedById: string | null; correctedAt: string | null } | null;
};
export type AssignmentForm = {
  recipientType: 'PERSON' | 'OFFICE';
  personName: string;
  officeName: string;
  assignmentType: 'STANDARD' | 'LOAN';
  expectedDate: string;
  expectedTime: string;
  effectiveDate: string;
  effectiveTime: string;
  ticketReference: string;
  otReference: string;
  notes: string;
  returnStatus: ReturnStatus;
};
export type AssignmentErrors = Partial<Record<keyof AssignmentForm, string>>;

export function emptyAssignmentForm(): AssignmentForm {
  return { recipientType: 'PERSON', personName: '', officeName: '', assignmentType: 'STANDARD', expectedDate: '', expectedTime: '', effectiveDate: '', effectiveTime: '', ticketReference: '', otReference: '', notes: '', returnStatus: 'AVAILABLE' };
}
export function assignmentRecipient(record: AssignmentSnapshot): string {
  return record.recipientType === 'OFFICE' ? record.officeName || 'Oficina sin nombre' : record.personName || 'Destinatario no registrado';
}
export function isImportedAssignment(record: AssignmentSnapshot): boolean {
  return Boolean(record.importedHistory || record.importHistory || record.groupImportHistory);
}
export function canSetAssignmentDate(role?: AppRole): boolean {
  return role === 'JEFE' || role === 'COORDINADOR';
}
function readDate(date: string, time: string, dateKey: 'effectiveDate' | 'expectedDate', timeKey: 'effectiveTime' | 'expectedTime', errors: AssignmentErrors): string | undefined {
  if (!date && !time) return undefined;
  if (!date) errors[dateKey] = 'Selecciona la fecha.';
  if (!time) errors[timeKey] = 'Indica la hora en Chile (HH:MM).';
  if (!date || !time) return undefined;
  try { return inventoryDateTimeToUtc(date, time); }
  catch { errors[dateKey] = 'La fecha u hora no es válida o coincide con un cambio de hora. Selecciona otra.'; return undefined; }
}
export function validateAssignment(form: AssignmentForm, options: { v2: boolean; role?: AppRole; returning?: AssignmentRecord; now?: Date }): AssignmentErrors {
  const errors: AssignmentErrors = {};
  const now = options.now ?? new Date();
  if (!options.returning) {
    if (!options.v2 || form.recipientType === 'PERSON') {
      if (form.personName.trim().length < 2 || !/\s+\S+/.test(form.personName.trim())) errors.personName = 'Escribe el nombre y apellido de la persona.';
      else if (form.personName.trim().length > 150) errors.personName = 'Usa hasta 150 caracteres.';
    } else if (!form.officeName.trim() || form.officeName.trim().length > 160) errors.officeName = 'Escribe el nombre de la oficina (hasta 160 caracteres).';
  }
  if (!options.v2) return errors;
  for (const key of ['ticketReference', 'otReference'] as const) if (form[key].trim().length > 160) errors[key] = 'Usa hasta 160 caracteres.';
  if (form.notes.trim().length > 10000) errors.notes = 'Usa hasta 10.000 caracteres.';
  const effective = readDate(form.effectiveDate, form.effectiveTime, 'effectiveDate', 'effectiveTime', errors);
  if ((form.effectiveDate || form.effectiveTime) && !canSetAssignmentDate(options.role)) errors.effectiveDate = 'Solo Jefe y Coordinador pueden indicar una fecha efectiva.';
  if (effective && new Date(effective) > now) errors.effectiveDate = 'La fecha efectiva no puede ser futura.';
  if (options.returning) {
    if (!['AVAILABLE', 'UNDER_REVIEW', 'IN_REPAIR'].includes(form.returnStatus)) errors.returnStatus = 'Selecciona un estado de devolución válido.';
    if (effective && new Date(effective) <= new Date(options.returning.startedAt)) errors.effectiveDate = 'La devolución debe ser posterior a la entrega.';
  } else if (form.assignmentType === 'LOAN') {
    const expected = readDate(form.expectedDate, form.expectedTime, 'expectedDate', 'expectedTime', errors);
    if (expected && new Date(expected) <= (effective ? new Date(effective) : now)) errors.expectedDate = 'La devolución prevista debe ser posterior a la entrega.';
  }
  return errors;
}
function optionalMetadata(form: AssignmentForm, role?: AppRole) {
  const result: { effectiveAt?: string; ticketReference?: string; otReference?: string; notes?: string } = {};
  for (const key of ['ticketReference', 'otReference', 'notes'] as const) if (form[key].trim()) result[key] = form[key].trim();
  if (canSetAssignmentDate(role) && form.effectiveDate && form.effectiveTime) result.effectiveAt = inventoryDateTimeToUtc(form.effectiveDate, form.effectiveTime);
  return result;
}
export function assignmentPayload(form: AssignmentForm, v2: boolean, role?: AppRole) {
  if (!v2) return { personName: form.personName.trim() };
  const recipient = form.recipientType === 'OFFICE' ? { officeName: form.officeName.trim() } : { personName: form.personName.trim() };
  return {
    recipientType: form.recipientType, ...recipient, assignmentType: form.assignmentType, ...optionalMetadata(form, role),
    ...(form.assignmentType === 'LOAN' && form.expectedDate && form.expectedTime ? { expectedReturnAt: inventoryDateTimeToUtc(form.expectedDate, form.expectedTime) } : {})
  };
}
export function assignmentReturnPayload(form: AssignmentForm, v2: boolean, role?: AppRole) {
  return v2 ? { returnStatus: form.returnStatus, ...optionalMetadata(form, role) } : undefined;
}
