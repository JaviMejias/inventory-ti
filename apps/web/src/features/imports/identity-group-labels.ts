import { importIssueLabels } from './import-issue-labels';

const labels: Record<string, string> = {
  IDENTITY_FIELD_NOT_MAPPED: 'El identificador propuesto no tiene una columna reconocida en alguna fila del grupo.',
  IDENTITY_CANNOT_DROP_SOURCE_VALUE: 'No se puede sustituir por ausencia un identificador significativo, numérico, añadido o incierto del origen.',
  PROPOSED_GROUP_NOT_REALIZABLE: 'La interpretación simulada no produce exactamente las filas de este grupo.',
  IDENTITY_OVERLAP_OUTSIDE_SCOPE: 'La identidad coincide con filas ajenas al alcance. Replantea la selección completa; no se absorben automáticamente.',
  PROPOSED_IDENTITY_NOT_REALIZED: 'Los identificadores del candidato simulado no corresponden a la identidad propuesta.',
  SOURCE_CANDIDATE_ALREADY_APPLIED: 'El candidato original ya fue utilizado por un piloto. Sus comprobantes no se reinterpretan.',
  SOURCE_OBSERVATION_ALREADY_APPLIED: 'La fila tiene evidencia utilizada por una asignación o baja histórica. Su antecedente no se reescribe.'
};
export function identityGroupBlockerLabel(code: string) {
  return labels[code] ?? (code.startsWith('SOURCE_') ? importIssueLabels[code.slice(7)] ?? 'Incidencia bloqueante del origen simulado.' : 'El servidor requiere una revisión adicional de la propuesta.');
}
