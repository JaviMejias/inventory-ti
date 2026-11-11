import type { ImportPreview, ReviewTarget, SourceCell, SourceRecord } from './import-review-model';

export const sourceFieldLabels = { equipmentType: 'Tipo de equipo', brand: 'Marca', model: 'Modelo', receivedDate: 'Fecha de recepción', serialNumber: 'Serie', assetTag: 'Activo fijo' };
export type DescriptiveField = 'equipmentType' | 'brand' | 'model' | 'receivedDate';
export type SourceField = keyof typeof sourceFieldLabels;
export type SourceChange = { recordId: string; field: DescriptiveField; action: 'RESTORE' } | { recordId: string; field: DescriptiveField; action: 'REPLACE'; value: string };
export type RevisionBase = { expectedRevision: number; expectedBatchVersion: number; requestId: string; note: string; evidenceReference: string };
export type SourceIntent = RevisionBase & { changes: SourceChange[] };
export type IdentityIntent = RevisionBase & { candidateId: string } & (
  { action: 'VERIFY'; confirmation: 'VERIFIED_PHYSICAL_IDENTITY'; serialNumber: string | null; assetTag: string | null } |
  { action: 'RESTORE'; confirmation: 'RESTORE_ORIGINAL_IDENTITY' }
);
export type RevisionIntent = SourceIntent | IdentityIntent;
export type AuditedChange = { candidateId: string; recordId: string; sheet: string; row: number; column: string; field: SourceField; action: 'REPLACE' | 'RESTORE'; value?: string; originalCell: SourceCell | null; beforeCell: SourceCell | null; afterCell: SourceCell | null };
export type SourceEvent = Omit<RevisionBase, 'expectedRevision'> & { id: string; batchId: string; revision: number; requestDigest: string; reviewedById: string; createdAt: string; changes: AuditedChange[] };
export type ResolvedReviewSource = {
  batchId: string; batchVersion: number; canApply: false; preview: ImportPreview;
  sourceContext: { revision: number; corrections: Array<AuditedChange & { revisionId: string; revision: number; reviewedById: string; note: string; evidenceReference: string }>; identityRevisions?: Array<{ candidateId: string; revision: number }> };
};

export function descriptiveFields(record: SourceRecord): DescriptiveField[] {
  if (!['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(record.kind)) return [];
  // The preview supplies the mapped keys, including absent cells. Do not guess columns from values.
  return (['equipmentType', 'brand', 'model', 'receivedDate'] as const).filter((field) => Object.hasOwn(record.fields, field));
}
function verifiedText(value: string) { return Boolean(value.trim()) && !/^(?:n\/?a|s\/?n|sin (?:dato|serie|activo)|no aplica|null|undefined|-+)$/i.test(value.trim()); }
export function validateRevisionBase(note: string, evidenceReference: string): Record<string, string> {
  return { ...(!note.trim() || note.trim().length > 2000 ? { note: 'Escribe un motivo de entre 1 y 2.000 caracteres.' } : {}),
    ...(!evidenceReference.trim() || evidenceReference.trim().length > 500 ? { evidenceReference: 'Indica la evidencia de verificación (hasta 500 caracteres).' } : {}) };
}
export function validateSourceChange(record: SourceRecord | undefined, field: DescriptiveField, action: 'REPLACE' | 'RESTORE', value: string, asOf: string): Record<string, string> {
  if (!record || !descriptiveFields(record).includes(field)) return { record: 'Selecciona una fila física y un campo reconocido en su hoja.' };
  if (action === 'RESTORE') return {};
  const text = value.trim();
  if (!verifiedText(text) || text.length > (field === 'model' ? 160 : 100)) return { value: `Escribe un valor verificado (hasta ${field === 'model' ? 160 : 100} caracteres).` };
  if (field === 'receivedDate') {
    const date = new Date(text + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text || text < '1900-01-01' || text > asOf) return { value: `Usa una fecha real entre 1900-01-01 y ${asOf}, en formato AAAA-MM-DD.` };
  }
  return {};
}
export function validateIdentityDraft(target: ReviewTarget, action: 'VERIFY' | 'RESTORE', serial: string | null, tag: string | null, confirmed: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (target.type !== 'CANDIDATE' || !target.records.length || target.records.length > 12) errors.scope = 'La identidad requiere un equipo físico con un máximo de 12 observaciones.';
  if (!confirmed) errors.confirmation = action === 'VERIFY' ? 'Confirma que todas las observaciones corresponden al mismo equipo físico.' : 'Confirma la restauración de todas las celdas originales de identidad.';
  if (action === 'VERIFY') {
    if (serial === null && tag === null) errors.serialNumber = 'Verifica al menos una serie o un activo fijo.';
    for (const [field, value, max] of [['serialNumber', serial, 160], ['assetTag', tag, 100]] as const) {
      if (value !== null && (!verifiedText(value) || value.trim().length > max)) errors[field] = `Escribe el identificador verificado (hasta ${max} caracteres), o selecciona explícitamente Sin identidad.`;
      if (value !== null && !target.records.some((record) => Object.hasOwn(record.fields, field))) errors[field] = 'Este identificador no está reconocido en las hojas del equipo.';
    }
  }
  // Whether null drops uncertain source evidence is exclusively a server rule; never infer from scalar fields.
  return errors;
}
export function captureSourceIntent(source: ResolvedReviewSource, note: string, evidenceReference: string, requestId: string, changes: SourceChange[]): SourceIntent {
  return { expectedRevision: source.sourceContext.revision, expectedBatchVersion: source.batchVersion, requestId, note: note.trim(), evidenceReference: evidenceReference.trim(), changes: globalThis.structuredClone(changes) };
}
export function requiresIdentityRedecision(source: ResolvedReviewSource, candidateId: string, decisionRevision = 0) {
  return (source.sourceContext.identityRevisions?.find((entry) => entry.candidateId === candidateId)?.revision ?? 0) > decisionRevision;
}
