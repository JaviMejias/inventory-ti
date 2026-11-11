import { importIssueLabels } from './import-issue-labels';

const labels: Record<string, string> = {
  EXACT_DATE_REQUIRED: 'Falta una fecha exacta con hora y zona.', EXACT_DATE_PROOF_REQUIRED: 'Falta respaldo para la fecha exacta.',
  SOURCE_DAY_MISMATCH: 'El día local confirmado no coincide con el día del origen.', HISTORICAL_DATE_IN_FUTURE: 'La fecha histórica no puede estar en el futuro.',
  HISTORICAL_PERIOD_ORDER_INVALID: 'El cierre debe ser posterior al inicio.', CONFIRMED_RECIPIENT_REQUIRED: 'Falta confirmar persona u oficina.',
  CONFIRMED_RETURN_STATUS_REQUIRED: 'Falta confirmar el estado al devolver.', OPERATIONAL_ASSIGNMENT_OVERLAP: 'El periodo se cruza con una entrega ya registrada.',
  PROPOSED_PERIOD_OVERLAP: 'El periodo se cruza con otro periodo propuesto.', EVIDENCE_ASSET_LINK_REQUIRED: 'La evidencia necesita un vínculo confirmado.',
  EVIDENCE_ASSET_MISMATCH: 'La evidencia está vinculada a otro activo.', EVIDENCE_IDENTITY_UNRESOLVED: 'La identidad del origen no está resuelta.',
  EVIDENCE_RULES_CHANGED: 'Las reglas de la evidencia cambiaron.', EVIDENCE_SOURCE_REVISED: 'El origen fue corregido después de contrastar esta evidencia. Requiere revisión documental.',
  CURRENT_ASSET_IDENTITY_CONFLICT: 'La identidad vigente del activo no coincide con la evidencia.', CURRENT_ASSIGNMENT_STATE_INCONSISTENT: 'El estado del activo no concuerda con sus entregas actuales.',
  DECOMMISSION_DATE_UNCONFIRMED: 'La fecha de baja del activo no está confirmada.', HISTORICAL_PERIOD_AFTER_DECOMMISSION: 'El cierre es posterior a la baja confirmada.',
  DISTINCT_ENDPOINT_RECORDS_REQUIRED: 'Inicio y cierre deben provenir de filas originales distintas, no de dos interpretaciones de una misma fila.',
  EVIDENCE_ENDPOINT_KIND_INVALID: 'Esta clase de observación no corresponde al extremo elegido.', SOURCE_RECIPIENT_MISMATCH: 'El destinatario no coincide con el origen.',
  SOURCE_RECIPIENT_TYPE_MISMATCH: 'El origen indica oficina; no corresponde a una persona.', SOURCE_LOAN_TYPE_MISMATCH: 'El origen indica un préstamo.',
  SOURCE_REFERENCE_TOO_LONG: 'Una referencia del origen excede el límite; no se recorta automáticamente.',
  WARNINGS_NOT_ACKNOWLEDGED: 'Hay advertencias pendientes de reconocimiento.', UNKNOWN_WARNING_ACKNOWLEDGEMENT: 'Un reconocimiento ya no corresponde al plan vigente. Revisa la lista actual.',
  ENDPOINT_EVIDENCE_ALREADY_APPLIED: 'Esta evidencia ya pertenece a un periodo aplicado. Consulta su comprobante; no puede reutilizarse.', PRODUCT_NOT_ASSET: 'El producto no corresponde a activos rastreables.'
};
export function closedBlockerLabel(code: string) {
  return labels[code] ?? (code.startsWith('SOURCE_') ? importIssueLabels[code.slice(7)] ?? 'Incidencia bloqueante del origen.' : 'El servidor requiere una revisión adicional.');
}
