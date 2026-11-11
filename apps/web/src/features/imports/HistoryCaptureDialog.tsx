import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Dialog, Field, LoadingState, Select } from '../../ui';
import { createHistoryIntent, historyDay, historyKey, historyKindLabels, reconcileHistorySelection, type HistoryPreview, type HistorySelection } from './history-evidence-model';
import { HistoryCaptureDetails, HistoryEvidenceDetails } from './HistoryEvidenceDetails';
import { validateRevisionBase } from './source-review-model';
import { useHistoryCapture } from './useHistoryCapture';

export function HistoryCaptureDialog({ batchId, context, initial, open, close, exited, changed }: {
  batchId: string; context: HistoryPreview; initial: HistorySelection[]; open: boolean; close: () => void; exited: () => void; changed: () => void;
}) {
  const workflow = useHistoryCapture(batchId, context.offset, changed);
  const [selected, setSelected] = useState(initial);
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [confirmedId, setConfirmedId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discard, setDiscard] = useState(false);
  const form = useRef<globalThis.HTMLFormElement>(null);
  const preview = workflow.preview;
  const reconciled = preview ? reconcileHistorySelection(preview, selected) : [];
  const dirty = !workflow.saved && (selected.length > 0 || Boolean(note || reference));
  useEffect(() => {
    if (!dirty && !workflow.uncertain) return;
    const warn = (event: globalThis.BeforeUnloadEvent) => { event.preventDefault(); };
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, workflow.uncertain]);
  function invalid(validation: Record<string, string>) {
    setErrors(validation);
    globalThis.requestAnimationFrame(() => {
      const field = form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]');
      if (field) field.focus();
      else { const alert = form.current?.querySelector<globalThis.HTMLElement>('[role="alert"]'); if (alert) { alert.tabIndex = -1; alert.focus(); } }
    });
  }
  function requestClose() { if (workflow.busy) return; if (dirty || workflow.uncertain) setDiscard(true); else close(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (discard || workflow.busy || workflow.saved) return;
    if (workflow.uncertain) { await workflow.save(); return; }
    if (workflow.locked || !preview) return;
    const validation = validateRevisionBase(note, reference);
    if (!selected.length || selected.length > 25 || reconciled.some((entry) => entry.error)) validation.selection = 'Selecciona de 1 a 25 observaciones vigentes y revisa sus vínculos. Ninguna debe estar capturada.';
    if (confirmedId !== preview.historyPreviewId) validation.confirmation = 'Confirma el alcance documental después de revisar la evidencia vigente.';
    if (Object.keys(validation).length) { invalid(validation); return; }
    await workflow.save(createHistoryIntent(preview, selected, note, reference, globalThis.crypto.randomUUID()));
  }
  return <Dialog className="catalog-editor-dialog import-review-dialog" open={open} onClose={requestClose} onExited={exited} busy={workflow.busy}
    title="Guardar evidencia histórica" description="Solo documentación del origen. No crea entregas, devoluciones, bajas ni movimientos de stock."
    actions={discard ? <><Button key="keep-history" variant="secondary" autoFocus onClick={() => setDiscard(false)}>Seguir revisando</Button><Button onClick={close}>Descartar y cerrar</Button></> : <><Button variant="secondary" disabled={workflow.busy} onClick={requestClose}>Cerrar</Button>{!workflow.saved && <Button type="submit" form="history-capture-form" loading={workflow.busy} disabled={!workflow.uncertain && workflow.locked}>{workflow.uncertain ? 'Recuperar captura' : 'Guardar evidencia histórica'}</Button>}</>}>
    <div className="space-y-4">
      {discard && <Alert variant="warning">{workflow.uncertain ? 'Cerrar no cancela una captura que el servidor pueda haber guardado. Consulta los comprobantes al volver.' : 'Se perderán la selección, el motivo y el respaldo sin guardar.'}</Alert>}
      {workflow.reading && <LoadingState label="Comprobando evidencia histórica vigente…" />}
      {workflow.readError && <Alert variant="danger" action={<Button variant="secondary" size="sm" disabled={workflow.busy || workflow.uncertain || Boolean(workflow.saved)} onClick={() => { setConfirmedId(''); void workflow.refresh(); }}>Reintentar evidencia</Button>}>{workflow.readError}</Alert>}
      {workflow.writeError && <Alert variant="danger">{workflow.writeError}</Alert>}
      {workflow.uncertain && <Alert variant="warning">Resultado sin confirmar. Recuperar captura reutiliza exactamente la misma clave, evidencia y selección. No prepares otra captura.<p className="break-words mt-2">Clave de recuperación: {workflow.requestId}</p></Alert>}
      {workflow.needsRefresh && <Alert variant="warning" action={<Button variant="secondary" size="sm" onClick={() => { setConfirmedId(''); void workflow.refresh(); }}>Actualizar evidencia</Button>}>El borrador se conserva. Actualiza, revisa los vínculos y confirma otra vez antes de guardar.</Alert>}
      {workflow.saved ? <HistoryCaptureDetails capture={workflow.saved} /> : <form id="history-capture-form" ref={form} noValidate onSubmit={(event) => void submit(event)} className="space-y-4">
        {preview && <><div className="import-review-summary"><Badge variant="neutral">Lote v{preview.batchVersion} · origen r{preview.sourceRevision}</Badge><Badge variant="info">{selected.length} de 25 observaciones</Badge></div>
          {preview.historyPreviewId !== context.historyPreviewId && <Alert variant="warning">La consulta cambió desde la selección inicial. Revisa la evidencia y los vínculos actuales; no se sustituyeron tus elecciones.</Alert>}
        </>}
        {errors.selection && <Alert variant="danger">{errors.selection}</Alert>}
        {reconciled.map(({ selection, observation, error }) => <section className="inventory-metadata-section space-y-3" key={historyKey(selection)}>
          <h3 className="font-semibold">{historyKindLabels[selection.kind]} · {observation ? `${observation.original.sheet} · fila ${observation.original.row} · ${historyDay(observation.effectiveDay)}` : 'Observación no encontrada'}</h3>
          {error && <Alert variant="warning">{error}</Alert>}
          {observation?.stored && <p className="inventory-metadata-hint break-words">Comprobante original: {observation.stored.captureId}. Puede pertenecer a otro lote del mismo archivo; no se ofrece recapturar.</p>}
          {observation && <>
            <Field label={`Vínculo · ${historyKindLabels[selection.kind]} · fila ${observation.original.row}`} disabled={workflow.locked || Boolean(observation.stored)} hint="No se elige un activo automáticamente. El vínculo no cambia su estado."><Select value={selection.assetId ?? ''}
              onChange={(id) => { setSelected((current) => current.map((entry) => historyKey(entry) === historyKey(selection) ? { ...entry, assetId: id || null } : entry)); setConfirmedId(''); setErrors({}); }}
              options={[{ value: '', label: 'Sin vincular a un activo' }, ...observation.linkOptions.map((entry) => { const asset = observation.suggestedAssets.find((item) => item.id === entry.assetId); return { value: entry.assetId, label: `${asset ? [asset.product.name, asset.serialNumber, asset.assetTag].filter(Boolean).join(' · ') : entry.assetId} · ${entry.basis.type === 'PILOT_RECEIPT' ? 'Comprobante del piloto' : 'Decisión revisada'}` }; }), ...(selection.assetId && !observation.linkOptions.some((entry) => entry.assetId === selection.assetId) ? [{ value: selection.assetId, label: 'Vínculo anterior no autorizado' }] : [])]} /></Field>
            {!observation.linkOptions.length && <p className="inventory-metadata-hint">Sin vínculos confirmados. Se puede conservar la observación sin asociarla a un activo.</p>}
            <details><summary>Revisar origen, interpretación e incidencias</summary><HistoryEvidenceDetails observation={observation} /></details>
          </>}
          <Button variant="ghost" size="sm" disabled={workflow.locked} onClick={() => { setSelected((current) => current.filter((entry) => historyKey(entry) !== historyKey(selection))); setConfirmedId(''); }}>Quitar observación</Button>
        </section>)}
        <Field label="Motivo de la captura" required error={errors.note} disabled={workflow.locked}><textarea className="resize-none" rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
        <Field label="Referencia de evidencia" required error={errors.evidenceReference} disabled={workflow.locked}><input type="text" autoComplete="off" maxLength={500} value={reference} onChange={(event) => setReference(event.target.value)} /></Field>
        <Field label="Alcance de la captura" required error={errors.confirmation} disabled={workflow.locked}><Select value={preview && confirmedId === preview.historyPreviewId ? 'confirmed' : ''} onChange={(value) => setConfirmedId(value === 'confirmed' ? preview?.historyPreviewId ?? '' : '')} options={[{ value: '', label: 'Seleccionar confirmación' }, { value: 'confirmed', label: 'Revisé la evidencia. Guardar solo documentación, sin cambiar inventario.' }]} /></Field>
      </form>}
    </div>
  </Dialog>;
}
