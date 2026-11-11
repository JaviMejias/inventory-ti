import { closedBlockerLabel } from './closed-assignment-labels';

const labels: Record<string, string> = {
  RETIREMENT_EVIDENCE_KIND_REQUIRED: 'La observación debe indicar una baja, no recepción, uso ni préstamo.',
  EVIDENCE_ALREADY_APPLIED: 'Esta evidencia ya fue utilizada. Consulta su comprobante; no puede reutilizarse.',
  EXISTING_RETIREMENT_REQUIRES_RECONCILIATION: 'El activo ya está retirado o inactivo. Requiere conciliación; este flujo no lo reabre ni reemplaza su fecha.',
  ACTIVE_ASSIGNMENT_REQUIRES_RETURN: 'Existe una entrega vigente. Debe resolverse en su flujo propio; esta consulta no la cierra.',
  EXACT_RETIREMENT_DATE_REQUIRED: 'Falta confirmar el instante exacto de retiro, con hora y zona.',
  EXACT_RETIREMENT_DATE_PROOF_REQUIRED: 'Falta un respaldo explícito para el instante de retiro.',
  SOURCE_RECEIPT_DATE_UNCONFIRMED: 'La recepción informada no es una fecha válida confirmada. Revisa el origen.',
  RETIREMENT_BEFORE_RECEIPT_DAY: 'El día local del retiro es anterior al día de recepción indicado.',
  ASSIGNMENT_AFTER_RETIREMENT: 'Una entrega termina después del retiro propuesto. Requiere revisión; no se modifica ese periodo.',
  OPERATIONAL_ASSIGNMENT_PERIOD_INVALID: 'Una entrega registrada tiene un periodo inválido. Requiere revisión operativa.',
  CURRENT_RETIREMENT_DATE_UNCONFIRMED: 'La fecha registrada del activo es inválida, anterior a 1900 o futura. Requiere revisión; no confirma el retiro histórico.',
  IMPORTED_RETIREMENT_STATE_CONFLICT: 'El estado o la fecha del activo contradicen su comprobante de baja. Revisa la inconsistencia antes de continuar.'
};
export function retirementBlockerLabel(code: string) { return labels[code] ?? closedBlockerLabel(code); }
