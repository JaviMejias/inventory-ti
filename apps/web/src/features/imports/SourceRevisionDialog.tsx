import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Dialog, Field, LoadingState, Select } from '../../ui';
import { buildReviewTargets, type ImportPreview } from './import-review-model';
import { inventoryDate } from '../../lib/date-range';
import { SourceEvidence } from './SourceEvidence';
import { DescriptiveEditor, IdentityEditor, type DescriptiveDraft, type IdentityDraft } from './SourceRevisionEditor';
import { captureSourceIntent, validateIdentityDraft, validateRevisionBase, validateSourceChange, type IdentityIntent, type RevisionIntent, type SourceChange } from './source-review-model';
import { useSourceRevision } from './useSourceRevision';
import { SourceEventDetails } from './SourceEventDetails';

const emptyDescriptive: DescriptiveDraft = { recordId: '', field: 'brand', action: 'REPLACE', value: '', changes: [] };
const emptyIdentity: IdentityDraft = { action: 'VERIFY', serialNumber: '', assetTag: '', confirmed: false };
export function SourceRevisionDialog({ batchId, original, mode, open, close, exited, changed }: { batchId: string; original: ImportPreview; mode: 'source' | 'identity'; open: boolean; close: () => void; exited: () => void; changed: () => void }) {
  const workflow = useSourceRevision(batchId, changed);
  const targets = useMemo(() => buildReviewTargets(original).filter((target) => target.type === 'CANDIDATE'), [original]);
  const [targetId, setTargetId] = useState('');
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const target = targets.find((item) => item.id === targetId);
  const effective = useMemo(() => workflow.source ? buildReviewTargets(workflow.source.preview).find((item) => item.id === targetId) : undefined, [workflow.source, targetId]);
  const [descriptive, setDescriptive] = useState<DescriptiveDraft>(emptyDescriptive);
  const [identity, setIdentity] = useState<IdentityDraft>(emptyIdentity);
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discard, setDiscard] = useState(false);
  const form = useRef<globalThis.HTMLFormElement>(null);
  const dirty = Boolean(note || reference || descriptive.value || descriptive.changes.length || (mode === 'identity' && (identity.serialNumber !== '' || identity.assetTag !== '' || identity.confirmed || identity.action !== 'VERIFY')));
  useEffect(() => {
    if (!dirty && !workflow.uncertain) return undefined;
    const warn = (event: globalThis.BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, workflow.uncertain]);
  function invalid(validation: Record<string, string>) {
    setErrors(validation);
    globalThis.requestAnimationFrame(() => {
      const control = form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]');
      if (control) { control.focus(); return; }
      const alert = form.current?.querySelector<globalThis.HTMLElement>('[role="alert"]');
      if (alert) { alert.tabIndex = -1; alert.focus(); }
    });
  }
  function addChange() {
    if (workflow.locked || !workflow.source) return;
    const record = target?.records.find((item) => item.id === descriptive.recordId);
    const validation = validateSourceChange(record, descriptive.field, descriptive.action, descriptive.value, inventoryDate());
    if (descriptive.changes.some((item) => item.recordId === descriptive.recordId && item.field === descriptive.field)) validation.changes = 'Este campo ya está en la revisión. Quítalo antes de añadir otro valor.';
    if (descriptive.action === 'RESTORE' && !workflow.source.sourceContext.corrections.some((item) => item.recordId === descriptive.recordId && item.field === descriptive.field)) validation.value = 'Este campo no tiene una corrección activa para restaurar.';
    if (Object.keys(validation).length) { invalid(validation); return; }
    if (descriptive.changes.length >= 25) { invalid({ changes: 'La revisión permite un máximo de 25 cambios.' }); return; }
    const change: SourceChange = descriptive.action === 'RESTORE' ? { recordId: descriptive.recordId, field: descriptive.field, action: 'RESTORE' } : { recordId: descriptive.recordId, field: descriptive.field, action: 'REPLACE', value: descriptive.value.trim() };
    setDescriptive({ ...descriptive, value: '', changes: [...descriptive.changes, change] }); setErrors({});
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (pendingTargetId !== null) return;
    if (workflow.uncertain) { if (await workflow.save()) clearDraft(); return; }
    if (workflow.locked || !workflow.source) return;
    const validation = validateRevisionBase(note, reference);
    if (!target || !effective) validation.target = 'Selecciona un equipo del lote que conserve su agrupación original.';
    if (mode === 'source') {
      if (!descriptive.changes.length || descriptive.changes.length > 25) validation.changes = 'Añade entre 1 y 25 cambios verificados antes de guardar.';
      if (descriptive.value.trim()) validation.value = 'Añade este valor a la revisión o vacíalo antes de guardar los cambios de la lista.';
      const recordsById = new Map(target?.records.map((item) => [item.id, item]));
      for (const change of descriptive.changes) Object.assign(validation, validateSourceChange(recordsById.get(change.recordId), change.field, change.action, change.action === 'REPLACE' ? change.value : '', inventoryDate()));
    } else if (target) Object.assign(validation, validateIdentityDraft(target, identity.action, identity.serialNumber, identity.assetTag, identity.confirmed));
    if (Object.keys(validation).length) { invalid(validation); return; }
    const base = captureSourceIntent(workflow.source, note, reference, globalThis.crypto.randomUUID(), descriptive.changes);
    let intent: RevisionIntent = base;
    if (mode === 'identity') {
      const common = { expectedRevision: base.expectedRevision, expectedBatchVersion: base.expectedBatchVersion, requestId: base.requestId, note: base.note, evidenceReference: base.evidenceReference };
      const input: IdentityIntent = identity.action === 'RESTORE' ? { ...common, candidateId: targetId, action: 'RESTORE', confirmation: 'RESTORE_ORIGINAL_IDENTITY' } : { ...common, candidateId: targetId, action: 'VERIFY', confirmation: 'VERIFIED_PHYSICAL_IDENTITY', serialNumber: identity.serialNumber?.trim() ?? null, assetTag: identity.assetTag?.trim() ?? null };
      intent = input;
    }
    if (await workflow.save(intent)) clearDraft();
  }
  function clearDraft() { setNote(''); setReference(''); setDescriptive(emptyDescriptive); setIdentity(emptyIdentity); setErrors({}); }
  function requestClose() { if (workflow.busy) return; if (dirty || workflow.uncertain) setDiscard(true); else close(); }
  return <Dialog className="catalog-editor-dialog import-review-dialog" open={open} onClose={requestClose} onExited={exited} busy={workflow.busy} title={mode === 'source' ? 'Corregir origen descriptivo' : 'Verificar identidad física'} description="Revisión del origen guardado. No edita el archivo original ni los activos del inventario." actions={discard ? <><Button key="continue-source" variant="secondary" autoFocus onClick={() => setDiscard(false)}>Seguir revisando</Button><Button onClick={close}>Descartar y cerrar</Button></> : <><Button variant="secondary" disabled={workflow.busy} onClick={requestClose}>Cerrar</Button><Button type="submit" form="source-revision-form" loading={workflow.busy} disabled={pendingTargetId !== null || (!workflow.uncertain && workflow.locked)}>{workflow.uncertain ? 'Recuperar revisión' : 'Guardar revisión de origen'}</Button></>}>
    <div className="space-y-5">
      {discard && <Alert variant="warning">{workflow.uncertain ? 'Cerrar no cancela una revisión que el servidor pueda haber guardado. Consulta el historial al volver.' : 'Se perderán los cambios y el motivo sin guardar.'}</Alert>}
      {workflow.reading && <LoadingState label="Consultando interpretación vigente…" />}
      {workflow.readError && <Alert variant="danger" action={<Button variant="secondary" size="sm" disabled={workflow.busy || workflow.uncertain} onClick={() => void workflow.refresh()}>Reintentar lectura</Button>}>{workflow.readError}</Alert>}
      {workflow.source && <div className="import-review-summary"><Badge variant="neutral">Lote v{workflow.source.batchVersion}</Badge><Badge variant="info">Origen r{workflow.source.sourceContext.revision}</Badge></div>}
      {workflow.writeError && <Alert variant="danger">{workflow.writeError}</Alert>}
      {workflow.uncertain && <Alert variant="warning">Resultado sin confirmar. Recuperar revisión reenvía la misma clave y los mismos valores; no crea otra intención.</Alert>}
      {workflow.needsRefresh && <Alert variant="warning" action={<Button variant="secondary" size="sm" onClick={() => void workflow.refresh()}>Actualizar origen</Button>}>El contexto cambió. El borrador se conserva; actualiza y vuelve a revisar antes de guardar.</Alert>}
      {workflow.saved && <details className="inventory-metadata-section"><summary>Revisión confirmada r{workflow.saved.revision} · comprobante histórico</summary><SourceEventDetails event={workflow.saved} /></details>}
      {pendingTargetId !== null && <Alert variant="warning" action={<><Button variant="secondary" size="sm" onClick={() => setPendingTargetId(null)}>Conservar equipo y borrador</Button><Button size="sm" onClick={() => { setTargetId(pendingTargetId); setPendingTargetId(null); clearDraft(); }}>Cambiar equipo y descartar borrador</Button></>}>Cambiar de equipo descarta los valores, cambios, motivo y evidencia sin guardar.</Alert>}
      <form id="source-revision-form" ref={form} noValidate onSubmit={(event) => void submit(event)} className="space-y-4">
        <Field label="Equipo del lote original" required error={errors.target} disabled={workflow.locked}><Select searchable value={targetId} onChange={(id) => { if (dirty) setPendingTargetId(id); else { setTargetId(id); setDescriptive(emptyDescriptive); setIdentity(emptyIdentity); setErrors({}); } }} options={[{ value: '', label: 'Seleccionar equipo' }, ...targets.map((item) => ({ value: item.id, label: `${item.label} · ${item.records.length} ${item.records.length === 1 ? 'observación' : 'observaciones'}` }))]} /></Field>
        {workflow.source && (mode === 'source' ? <DescriptiveEditor target={target} source={workflow.source} draft={descriptive} update={(next) => { setDescriptive(next); setErrors({}); }} locked={workflow.locked} errors={errors} add={addChange} /> : <IdentityEditor target={target} draft={identity} update={(next) => { setIdentity(next); setErrors({}); }} locked={workflow.locked} errors={errors} />)}
        <Field label="Motivo de la revisión" required error={errors.note} disabled={workflow.locked}><textarea rows={3} maxLength={2000} className="resize-none" value={note} onChange={(event) => setNote(event.target.value)} /></Field>
        <Field label="Referencia de evidencia" required error={errors.evidenceReference} disabled={workflow.locked} hint="Por ejemplo: ticket de verificación o acta. Se conserva junto al revisor y los cambios."><input type="text" maxLength={500} autoComplete="off" value={reference} onChange={(event) => setReference(event.target.value)} /></Field>
      </form>
      {mode === 'identity' && <Alert variant="info">Después de verificar o restaurar identidad, registra una nueva decisión del equipo. Un plan o decisión anteriores no acreditan esta revisión.</Alert>}
      {effective && <details className="inventory-metadata-section"><summary>Interpretación vigente del equipo</summary><SourceEvidence key={`effective:${workflow.source?.sourceContext.revision}:${targetId}`} target={effective} interpreted /></details>}
      {target && <details className="inventory-metadata-section"><summary>Evidencia original (sin modificar)</summary><SourceEvidence key={`original:${targetId}`} target={target} /></details>}
    </div>
  </Dialog>;
}
