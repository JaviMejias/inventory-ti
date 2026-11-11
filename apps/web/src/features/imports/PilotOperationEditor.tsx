import { useState } from 'react';
import { Alert, Button, DataTable, Field, Select } from '../../ui';
import { AssetMetadataFields } from '../home/AssetMetadataFields';
import { assetMetadataFields, assetMetadataForm, assetMetadataPayload, type AssetMetadataForm } from '../home/inventory-metadata';
import { operationType, pilotFieldLabels, validatePilotOperation, type PilotContext, type PilotOperation, type PilotValues } from './pilot-model';
import { buildReviewTargets } from './import-review-model';
import { SourceEvidence } from './SourceEvidence';
import { environment } from '../../config/environment';
import { CatalogSuggestions } from './CatalogSuggestions';

type Draft = { productId: string; serialNumber: string; assetTag: string; note: string; verified: boolean; metadata: AssetMetadataForm; updates: PilotValues };
const emptyDraft = (): Draft => ({ productId: '', serialNumber: '', assetTag: '', note: '', verified: false, metadata: assetMetadataForm(), updates: {} });
export function PilotOperationEditor({ context, busy, queued, add, edited, refreshContext }: {
  context: PilotContext; busy: boolean; queued: string[]; add: (operation: PilotOperation) => void; edited: () => void; refreshContext: () => void;
}) {
  const [candidateId, setCandidateId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [field, setField] = useState('technicalCondition');
  const [mode, setMode] = useState('SET');
  const [value, setValue] = useState('');
  const queuedIds = new Set(queued);
  const targets = buildReviewTargets(context.source.preview).filter((target) => target.type === 'CANDIDATE');
  const target = targets.find((entry) => entry.id === candidateId);
  const decision = context.decisions.find((entry) => entry.targetType === 'CANDIDATE' && entry.targetId === candidateId);
  const type = operationType(decision);
  const draft = drafts[candidateId] ?? emptyDraft();
  function change(patch: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [candidateId]: { ...(current[candidateId] ?? emptyDraft()), ...patch } }));
    setErrors({}); edited();
  }
  function append() {
    if (!type || busy || queued.includes(candidateId) || queued.length >= 25) return;
    const operation: PilotOperation = {
      candidateId, type, note: draft.note.trim(), acknowledgedWarnings: [],
      ...(type === 'CREATE_ASSET' ? { confirmation: 'AVAILABLE_UNASSIGNED' as const } : { assetId: decision!.linkedAssetId! }),
      values: type === 'CREATE_ASSET'
        ? { productId: draft.productId, ...(draft.serialNumber.trim() ? { serialNumber: draft.serialNumber.trim() } : {}), ...(draft.assetTag.trim() ? { assetTag: draft.assetTag.trim() } : {}), ...assetMetadataPayload(draft.metadata) }
        : draft.updates
    };
    const validation = validatePilotOperation(operation, draft.verified, context.products);
    setErrors(validation);
    if (Object.keys(validation).length) {
      globalThis.requestAnimationFrame(() => globalThis.document.querySelector<globalThis.HTMLElement>('.import-review-dialog [aria-invalid="true"]')?.focus());
      return;
    }
    add(globalThis.structuredClone(operation));
  }
  return <section className="space-y-4" aria-label="Preparar operación">
    <Field label="Equipo del origen" disabled={busy}>
      <Select searchable value={candidateId} onChange={(id) => { setCandidateId(id); setErrors({}); }} options={[{ value: '', label: 'Seleccionar equipo' }, ...targets.map((entry) => ({ value: entry.id, label: entry.label, disabled: queuedIds.has(entry.id) }))]} />
    </Field>
    {target && !type && <Alert variant="warning">Este equipo necesita una decisión vigente de proponer o vincular antes de preparar una operación. Vuelve a la revisión del lote.</Alert>}
    {target && queued.includes(candidateId) && <Alert variant="info">Este equipo ya está en la selección. Para cambiar sus valores, quítalo del piloto y vuelve a añadirlo; su borrador se conserva.</Alert>}
    {target && type && !queued.includes(candidateId) && <>
      <p className="font-semibold">{type === 'CREATE_ASSET' ? 'Crear equipo disponible y sin entrega' : 'Actualizar solo metadatos del activo vinculado'}</p>
      {type === 'CREATE_ASSET' ? <>
        <Field label="Producto" required disabled={busy} error={errors.productId}>
          <Select searchable value={draft.productId} onChange={(productId) => change({ productId })} options={[{ value: '', label: 'Seleccionar producto del catálogo' }, ...context.products.map((product) => ({ value: product.id, label: [product.name, product.equipmentType, product.brand, product.model].filter(Boolean).join(' · ') }))]} />
        </Field>
        {environment.inventoryImportSourceV7 && <CatalogSuggestions key={`${candidateId}:${context.source.sourceContext.revision}:${context.source.batchVersion}`} context={context} candidateId={candidateId} selected={draft.productId} disabled={busy} choose={(productId) => change({ productId })} refreshContext={refreshContext} />}
        <p className="inventory-metadata-hint">Identidad interpretada: serie {target.candidate?.serials.join(' / ') || 'sin dato'}; activo fijo {target.candidate?.tags.join(' / ') || 'sin dato'}. Ingresa los valores verificados; el servidor comprobará que coincidan.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Serie verificada" disabled={busy} error={errors.serialNumber}><input maxLength={160} value={draft.serialNumber} onChange={(event) => change({ serialNumber: event.target.value })} /></Field>
          <Field label="Activo fijo verificado" disabled={busy} error={errors.assetTag}><input maxLength={100} value={draft.assetTag} onChange={(event) => change({ assetTag: event.target.value })} /></Field>
        </div>
        <details className="inventory-metadata-section"><summary>Metadatos opcionales · no se copian automáticamente del Excel</summary>
          <AssetMetadataFields form={draft.metadata} busy={busy} errors={errors} onChange={(key, next) => change({ metadata: { ...draft.metadata, [key]: next } })} />
        </details>
        <Field label="Verificación física" disabled={busy} error={errors.confirmation} hint="Confirma que verificaste disponibilidad y ausencia de entrega; no reemplaza la evidencia exigida al origen.">
          <Select value={draft.verified ? 'yes' : ''} onChange={(next) => change({ verified: next === 'yes' })} options={[{ value: '', label: 'Sin confirmar' }, { value: 'yes', label: 'Verificado: disponible y sin entrega' }]} />
        </Field>
      </> : <>
        <p className="inventory-metadata-hint">Activo vinculado: {decision?.linkedAssetId}. Producto, serie, activo fijo, estado y entregas se conservan. Omitir un campo no lo borra.</p>
        <Field label="Campo a actualizar" disabled={busy}><Select value={field} onChange={setField} options={assetMetadataFields.map((entry) => ({ value: entry.key, label: entry.label }))} /></Field>
        <Field label="Tipo de cambio" disabled={busy}><Select value={mode} onChange={setMode} options={[{ value: 'SET', label: 'Establecer un valor' }, { value: 'CLEAR', label: 'Borrar explícitamente' }]} /></Field>
        {mode === 'SET' && <Field label="Nuevo valor" disabled={busy}><textarea className="resize-none" rows={3} maxLength={assetMetadataFields.find((entry) => entry.key === field)?.max} value={value} onChange={(event) => { setValue(event.target.value); edited(); }} /></Field>}
        <Button variant="secondary" disabled={busy || (mode === 'SET' && !value.trim())} onClick={() => change({ updates: { ...draft.updates, [field]: mode === 'CLEAR' ? null : value.trim() } })}>Añadir cambio</Button>
        {errors.values && <Alert variant="danger">{errors.values}</Alert>}
        <DataTable rows={Object.entries(draft.updates).map(([key, next]) => ({ id: key, value: next }))} getRowKey={(entry) => entry.id} caption="Metadatos elegidos" columns={[
          { key: 'field', header: 'Campo', mobileRole: 'identity', render: (entry) => pilotFieldLabels[entry.id] },
          { key: 'value', header: 'Nuevo valor', mobileRole: 'full', render: (entry) => entry.value ?? 'Borrar valor' },
          { key: 'remove', header: 'Acciones', mobileRole: 'actions', render: (entry) => <Button size="sm" variant="secondary" disabled={busy} onClick={() => { const next = { ...draft.updates }; delete next[entry.id]; change({ updates: next }); }}>Quitar cambio</Button> }
        ]} />
      </>}
      <Field label="Motivo de la operación" required disabled={busy} error={errors.note}><textarea rows={4} className="resize-none" maxLength={2000} value={draft.note} onChange={(event) => change({ note: event.target.value })} /></Field>
      <Button variant="secondary" disabled={busy || queued.includes(candidateId) || queued.length >= 25} onClick={append}>Añadir al piloto</Button>
      <details className="inventory-metadata-section"><summary>Consultar evidencia interpretada del equipo</summary><p className="inventory-metadata-hint">Estas celdas pueden incorporar correcciones. El snapshot original se consulta en la revisión del lote; las correcciones muestran el valor original por separado.</p><SourceEvidence key={target.id} target={target} interpreted /></details>
    </>}
  </section>;
}
