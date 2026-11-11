import { Field, Select, Button, DataTable, Alert } from '../../ui';
import type { ReviewTarget } from './import-review-model';
import { descriptiveFields, sourceFieldLabels, type DescriptiveField, type ResolvedReviewSource, type SourceChange } from './source-review-model';

export type DescriptiveDraft = { recordId: string; field: DescriptiveField; action: 'REPLACE' | 'RESTORE'; value: string; changes: SourceChange[] };
export function DescriptiveEditor({ target, source, draft, update, errors, locked, add }: { target?: ReviewTarget; source: ResolvedReviewSource; draft: DescriptiveDraft; update: (next: DescriptiveDraft) => void; errors: Record<string, string>; locked: boolean; add: () => void }) {
  const record = target?.records.find((item) => item.id === draft.recordId);
  const effective = source.preview.records.find((item) => item.id === draft.recordId);
  return <div className="space-y-4">
    <Field label="Fila de origen" required error={errors.record} disabled={locked}><Select value={draft.recordId} onChange={(recordId) => { const next = target?.records.find((item) => item.id === recordId); update({ ...draft, recordId, field: next ? descriptiveFields(next)[0] ?? 'brand' : 'brand', value: '' }); }} options={[{ value: '', label: 'Seleccionar fila' }, ...(target?.records.filter((item) => descriptiveFields(item).length) ?? []).map((item) => ({ value: item.id, label: `${item.sheet} · fila ${item.row}` }))]} /></Field>
    <Field label="Campo a revisar" required error={errors.field} disabled={locked || !record}><Select value={draft.field} onChange={(field) => update({ ...draft, field: field as DescriptiveField, value: '' })} options={(record ? descriptiveFields(record) : ['brand'] as DescriptiveField[]).map((field) => ({ value: field, label: sourceFieldLabels[field] }))} /></Field>
    <Field label="Acción sobre la celda" disabled={locked}><Select value={draft.action} onChange={(action) => update({ ...draft, action: action as DescriptiveDraft['action'] })} options={[{ value: 'REPLACE', label: 'Corregir con valor verificado' }, { value: 'RESTORE', label: 'Restaurar la celda original' }]} /></Field>
    {record && <p className="inventory-metadata-hint break-words">Valor interpretado actual: {effective?.fields[draft.field] ?? 'Sin dato'}. Valor interpretado original: {record.fields[draft.field] ?? 'Sin dato'}.</p>}
    {draft.action === 'REPLACE' ? <Field label={draft.field === 'receivedDate' ? 'Fecha verificada (AAAA-MM-DD)' : 'Valor verificado'} required error={errors.value} disabled={locked} hint={draft.field === 'receivedDate' ? 'Escritura ISO para fechas históricas desde 1900. No se completa con la fecha de hoy.' : 'Mantén el valor tal como se verificó; no se infiere del nombre del producto.'}><input type="text" maxLength={draft.field === 'model' ? 160 : 100} autoComplete="off" value={draft.value} onChange={(event) => update({ ...draft, value: event.target.value })} /></Field> : <Alert variant="warning">Se restaurará la celda exacta del archivo, incluido su tipo o fórmula literal. Puede volver a bloquear el análisis. Añade este cambio y revisa la lista antes de guardar.</Alert>}
    {errors.changes && <Alert variant="danger">{errors.changes}</Alert>}
    {draft.action === 'RESTORE' && errors.value && <Alert variant="danger">{errors.value}</Alert>}
    <Button variant="secondary" disabled={locked || draft.changes.length >= 25} onClick={add}>Añadir cambio a la revisión</Button>
    <DataTable rows={draft.changes.map((item) => ({ ...item, id: item.recordId + ':' + item.field }))} getRowKey={(item) => item.id} caption="Cambios por guardar (máximo 25)" columns={[
      { key: 'source', header: 'Origen', mobileRole: 'identity', render: (item) => { const row = target?.records.find((entry) => entry.id === item.recordId); return `${row?.sheet} · fila ${row?.row}`; } },
      { key: 'field', header: 'Campo', render: (item) => sourceFieldLabels[item.field] },
      { key: 'value', header: 'Cambio solicitado', mobileRole: 'full', render: (item) => item.action === 'RESTORE' ? 'Restaurar celda original' : <span className="break-words">{item.value}</span> },
      { key: 'action', header: 'Acciones', mobileRole: 'actions', render: (item) => <Button variant="ghost" size="sm" disabled={locked} onClick={() => update({ ...draft, changes: draft.changes.filter((change) => change.recordId + ':' + change.field !== item.id) })}>Quitar {sourceFieldLabels[item.field]}</Button> }
    ]} />
  </div>;
}
export type IdentityDraft = { action: 'VERIFY' | 'RESTORE'; serialNumber: string | null; assetTag: string | null; confirmed: boolean };
export function IdentityEditor({ target, draft, update, errors, locked }: { target?: ReviewTarget; draft: IdentityDraft; update: (next: IdentityDraft) => void; errors: Record<string, string>; locked: boolean }) {
  return <div className="space-y-4">
    <Field label="Revisión de identidad" disabled={locked}><Select value={draft.action} onChange={(action) => update({ ...draft, action: action as IdentityDraft['action'], confirmed: false })} options={[{ value: 'VERIFY', label: 'Verificar la identidad física' }, { value: 'RESTORE', label: 'Restaurar toda la identidad original' }]} /></Field>
    {draft.action === 'VERIFY' && (['serialNumber', 'assetTag'] as const).map((field) => <section key={field} className="space-y-3">
      <Field label={`${sourceFieldLabels[field]} · tratamiento`} disabled={locked}><Select value={draft[field] === null ? 'ABSENT' : 'VERIFIED'} onChange={(mode) => update({ ...draft, [field]: mode === 'ABSENT' ? null : '' })} options={[{ value: 'VERIFIED', label: 'Identificador verificado' }, { value: 'ABSENT', label: 'Sin identidad (ausente también en el origen)' }]} /></Field>
      {draft[field] !== null ? <Field label={field === 'serialNumber' ? 'Serie verificada' : 'Activo fijo verificado'} required disabled={locked} error={errors[field]} hint="Texto literal: conserva los ceros iniciales. No se interpreta como número."><input type="text" autoComplete="off" maxLength={field === 'serialNumber' ? 160 : 100} value={draft[field]} onChange={(event) => update({ ...draft, [field]: event.target.value })} /></Field> : <><p className="inventory-metadata-hint">El servidor rechazará esta opción si elimina evidencia original, incierta o previamente corregida.</p>{errors[field] && <Alert variant="danger">{errors[field]}</Alert>}</>}
    </section>)}
    {draft.action === 'RESTORE' && <Alert variant="warning">Se restaurarán todas las celdas originales de serie y activo fijo del equipo. No se borra el historial. La restauración también requiere una nueva decisión y puede reintroducir bloqueos.</Alert>}
    {errors.scope && <Alert variant="danger">{errors.scope}</Alert>}
    <Field label="Confirmación de alcance" required error={errors.confirmation} disabled={locked} hint={draft.action === 'VERIFY' ? `Verifica físicamente ${target?.records.length === 1 ? 'la observación' : 'las ' + (target?.records.length ?? 0) + ' observaciones'} del mismo equipo y la identidad indicada.` : 'Restaurar afecta la identidad original completa del equipo, no una fila aislada.'}><Select value={draft.confirmed ? 'CONFIRMED' : ''} onChange={(value) => update({ ...draft, confirmed: value === 'CONFIRMED' })} options={[{ value: '', label: 'Pendiente de confirmar' }, { value: 'CONFIRMED', label: draft.action === 'VERIFY' ? 'Verifiqué el equipo completo y su identidad' : 'Confirmo restaurar toda la identidad original' }]} /></Field>
  </div>;
}
