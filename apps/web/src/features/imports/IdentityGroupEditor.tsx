import { useMemo } from 'react';
import { Alert, Badge, Button, DataTable, EmptyState, Field, Select } from '../../ui';
import type { IdentityGroupDraft, IdentityGroupsDraft, IdentityGroupScope } from './identity-group-model';
import type { ImportPreview } from './import-review-model';
import { SourceFields } from './SourceEvidence';

export function IdentityGroupEditor({ scope, current, draft, disabled, errors, add, change, remove, assign }: {
  scope: IdentityGroupScope; current: ImportPreview | undefined; draft: IdentityGroupsDraft; disabled: boolean; errors: Record<string, string>;
  add: () => void; change: (id: string, patch: Partial<IdentityGroupDraft>) => void; remove: (id: string) => void; assign: (recordId: string, groupId: string) => void;
}) {
  const currentRecords = useMemo(() => new Map(current?.records.map((record) => [record.id, record])), [current]);
  const owners = new Map(scope.candidates.flatMap((candidate, index) => candidate.recordIds.map((id) => [id, index + 1])));
  const missing = scope.records.filter((record) => !draft.groups.some((group) => group.groupId === draft.assignments[record.id])).length;
  return <div className="space-y-5">
    <section aria-label="Grupos propuestos" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><h3 className="font-semibold">1. Define los grupos</h3><Button variant="secondary" size="sm" disabled={disabled || draft.groups.length >= 25} onClick={add}>Añadir grupo</Button><Badge variant="neutral">{draft.groups.length} de 25</Badge></div>
      {!draft.groups.length && <EmptyState title="Todavía no hay grupos propuestos" description="Añade un grupo por cada activo físico que hayas verificado. Después asigna sus filas expresamente." />}
      {errors.groups && <Alert variant="danger">{errors.groups}</Alert>}
      {draft.groups.map((group, index) => <section key={group.groupId} className="inventory-metadata-section space-y-4" aria-label={`Grupo propuesto ${index + 1}`}>
        <div className="flex flex-wrap justify-between items-center gap-3"><h4 className="font-semibold">Grupo {index + 1} · propuesta</h4><Button variant="ghost" size="sm" disabled={disabled} onClick={() => remove(group.groupId)}>Quitar grupo {index + 1}</Button></div>
        <p className="inventory-metadata-hint">Es una etiqueta de esta simulación. Quitar el grupo deja sus filas pendientes de asignación.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
          <IdentityField label="Serie" identity={group.serial} max={160} disabled={disabled} error={errors[group.groupId + '.serial']} update={(serial) => change(group.groupId, { serial })} />
          <IdentityField label="Activo fijo" identity={group.tag} max={100} disabled={disabled} error={errors[group.groupId + '.tag']} update={(tag) => change(group.groupId, { tag })} />
        </div>
        <Field label="Respaldo del grupo" required disabled={disabled} error={errors[group.groupId + '.reference']} hint="Referencia de verificación física o documental; no se consulta una URL automáticamente."><input type="text" autoComplete="off" maxLength={500} value={group.evidenceReference} onChange={(event) => change(group.groupId, { evidenceReference: event.target.value })} /></Field>
        {errors[group.groupId + '.records'] && <Alert variant="danger">{errors[group.groupId + '.records']}</Alert>}
      </section>)}
    </section>
    <section aria-label="Pertenencia de las filas seleccionadas" className="space-y-4"><div className="flex flex-wrap items-center gap-3"><h3 className="font-semibold">2. Reparte todas las filas</h3><Badge variant={missing ? 'warning' : 'info'}>{missing} sin asignar de {scope.records.length}</Badge></div>
      {errors.coverage && <Alert variant="danger">{errors.coverage}</Alert>}
      <p className="inventory-metadata-hint">Cada fila debe pertenecer a un solo grupo. Los valores interpretados no sustituyen una identidad verificada ni permiten deducir dígitos perdidos.</p>
      <DataTable className="catalog-data-table" rows={scope.records} getRowKey={(record) => record.id} caption="Asignación expresa de todas las observaciones seleccionadas" columns={[
        { key: 'row', header: 'Observación original', mobileRole: 'identity', render: (record) => <strong>{record.sheet} · fila {record.row}</strong> },
        { key: 'source', header: 'Interpretación consultada', mobileRole: 'full', render: (record) => <details className="inventory-metadata-section"><summary>Candidato original {owners.get(record.id)} · comparar valores</summary><p className="font-semibold">Archivo original interpretado</p><SourceFields fields={{ serialNumber: record.fields.serialNumber ?? null, assetTag: record.fields.assetTag ?? null }} /><p className="font-semibold mt-3">Origen vigente interpretado</p><SourceFields fields={{ serialNumber: currentRecords.get(record.id)?.fields.serialNumber ?? null, assetTag: currentRecords.get(record.id)?.fields.assetTag ?? null }} /></details> },
{ key: 'group', header: 'Grupo propuesto', mobileRole: 'full', render: (record) => <Field label="Grupo" className="min-w-0 w-full" required disabled={disabled}><Select aria-label={`Grupo para ${record.sheet} · fila ${record.row} Obligatorio`} searchable={draft.groups.length > 8} value={draft.assignments[record.id] ?? ''} onChange={(id) => assign(record.id, id)} options={[{ value: '', label: 'Sin asignar' }, ...draft.groups.map((group, index) => ({ value: group.groupId, label: `Grupo ${index + 1}${group.serial.mode === 'verified' && group.serial.value ? ' · ' + group.serial.value : ''}` }))]} /></Field> }
      ]} />
    </section>
  </div>;
}
function IdentityField({ label, identity, max, disabled, error, update }: {
  label: string; identity: IdentityGroupDraft['serial']; max: number; disabled: boolean; error?: string; update: (value: IdentityGroupDraft['serial']) => void;
}) {
  return <div className="space-y-3"><Field label={`Revisión de ${label.toLocaleLowerCase('es-CL')}`} required disabled={disabled} error={identity.mode === 'verified' ? undefined : error}><Select value={identity.mode} onChange={(mode) => update({ ...identity, mode: mode as typeof identity.mode })} options={[{ value: '', label: 'Sin revisar' }, { value: 'verified', label: 'Verificar con texto' }, { value: 'absent', label: 'Sin identidad' }]} /></Field>
    {identity.mode === 'verified' && <Field label={label === 'Serie' ? 'Serie verificada' : 'Activo fijo verificado'} required disabled={disabled} error={error}><input type="text" autoComplete="off" spellCheck={false} maxLength={max} value={identity.value} onChange={(event) => update({ ...identity, value: event.target.value })} /></Field>}
    {identity.mode === 'absent' && <p className="inventory-metadata-hint">Se propone ausencia explícita. El servidor bloqueará el borrado de valores significativos, numéricos o inciertos del origen.</p>}
  </div>;
}
