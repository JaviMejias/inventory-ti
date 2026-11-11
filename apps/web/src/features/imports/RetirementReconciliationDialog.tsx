import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Dialog, EmptyState, Field, LoadingState, Pagination, Select, useRequestError } from '../../ui';
import { RetirementReceipt } from './AssetRetirementApplications';
import { readAssetImportedEvidence } from './history-evidence-api';
import type { AssetHistoryEvidence } from './history-evidence-model';
import { HistoryEvidenceDetails } from './HistoryEvidenceDetails';
import { RetirementReconciliationDetails } from './RetirementReconciliationDetails';
import { useHistoryRead } from './useHistoryRead';
import { useRetirementReconciliation } from './useRetirementReconciliation';

export function RetirementReconciliationDialog({ asset, open, close, exited, prepare, receiptsEnabled = false }: {
  asset: { id: string; assetTag: string | null; serialNumber: string | null; product: { name: string } };
  open: boolean; close: () => void; exited: () => void; prepare?: (evidence: AssetHistoryEvidence) => void; receiptsEnabled?: boolean;
}) {
  const [selected, setSelected] = useState<AssetHistoryEvidence | null>(null);
  const [offset, setOffset] = useState(0);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const form = useRef<globalThis.HTMLFormElement>(null);
  const feedback = useRef<globalThis.HTMLDivElement>(null);
  const workflow = useRetirementReconciliation(asset.id);
  const reportError = useRequestError();
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    try { return await readAssetImportedEvidence(asset.id, offset, signal); }
    catch (error) { if (!signal.aborted) reportError(error, 'No se pudo consultar la evidencia para conciliar la baja.'); throw error; }
  }, [asset.id, offset, reportError]);
  const query = useHistoryRead(read, 'No se pudo consultar la evidencia para conciliar la baja.');
  const locked = query.reading || Boolean(query.error) || query.data?.offset !== offset;
  const rows = query.data?.evidence.filter((entry) => entry.kind === 'RETIREMENT_OBSERVATION') ?? [];
  const choices = selected && !rows.some((entry) => entry.id === selected.id) ? [selected, ...rows] : rows;
  useEffect(() => {
    if (!open || !workflow.error && !query.error) return;
    const frame = globalThis.requestAnimationFrame(() => feedback.current?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [workflow.error, query.error, open]);
  function requestClose() { workflow.invalidate(); close(); }
  function refresh() {
    workflow.invalidate(); setReceiptId(null);
    if (offset) setOffset(0); else void query.refresh();
  }
  function choose(id: string) {
    if (!open || locked || workflow.busy) return;
    const evidence = choices.find((entry) => entry.id === id);
    if (id && !evidence) return;
    workflow.invalidate(); setReceiptId(null); setSelectionError(null); setSelected(evidence ?? null);
  }
  async function consult(event: FormEvent) {
    event.preventDefault();
    if (!open || locked || workflow.busy) return;
    if (!selected) {
      setSelectionError('Elige una observación de baja vinculada a este activo.');
      globalThis.requestAnimationFrame(() => form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setSelectionError(null); setReceiptId(null);
    const result = await workflow.consult(selected.id);
    if (result) globalThis.requestAnimationFrame(() => {
      const heading = form.current?.parentElement?.querySelector<globalThis.HTMLElement>('[data-retirement-reconciliation-result]');
      heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
      heading?.focus({ preventScroll: true });
    });
  }
  const assessment = workflow.assessment;
  return <Dialog className="catalog-editor-dialog import-review-dialog" open={open} onClose={requestClose} onExited={exited}
    title="Conciliar baja histórica" description="Revisa evidencia, fechas y custodia sin modificar el inventario."
    actions={<><Button variant="secondary" onClick={requestClose}>Cerrar</Button>{!receiptId && <Button type="submit" form="retirement-reconciliation-form" loading={workflow.busy} disabled={locked}>{assessment ? 'Consultar nuevamente' : 'Consultar conciliación'}</Button>}</>}>
    <div className="space-y-4">
      <div className="inventory-asset-editor-summary"><div><strong>{asset.product.name}</strong><small className="break-words">{[asset.assetTag, asset.serialNumber].filter(Boolean).join(' · ') || 'Sin identificadores'}</small></div></div>
      <div ref={feedback} tabIndex={-1} className="space-y-3">
        {workflow.error && <Alert variant="danger">{workflow.error}</Alert>}
        {query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => { workflow.invalidate(); void query.refresh(); }}>Reintentar evidencia de conciliación</Button>}>{query.error}{query.data && ' Se conserva la página anterior sin confirmar su vigencia.'}</Alert>}
      </div>
      <form ref={form} id="retirement-reconciliation-form" className="space-y-4" noValidate onSubmit={(event) => void consult(event)} hidden={Boolean(receiptId)}>
        <div className="flex flex-wrap gap-3 items-center"><h3 className="font-semibold">Evidencia vinculada</h3><Button variant="secondary" size="sm" loading={query.reading} disabled={workflow.busy} onClick={refresh}>Actualizar evidencia desde el inicio</Button></div>
        {query.reading && <LoadingState label="Consultando evidencia vinculada…" />}
        {query.data && !query.error && !query.reading && query.data.evidence.length === 0 && (offset ? <Alert variant="warning">Esta página ya no contiene documentos. Actualiza desde el inicio.</Alert> : <EmptyState title="Sin evidencia histórica vinculada" description="Primero debe archivarse y confirmarse el vínculo de una observación. Esta consulta no crea evidencia." />)}
        <Field label="Observación de baja" required disabled={locked || workflow.busy} error={selectionError} hint={!rows.length ? 'Esta página no contiene observaciones de baja. Consulta otra página.' : 'Selecciona expresamente la observación que quieres contrastar; consultar no aprueba su vínculo.'}><Select searchable value={selected?.id ?? ''} onChange={choose} options={[{ value: '', label: 'Sin seleccionar' }, ...choices.map((entry) => ({ value: entry.id, label: `Baja indicada · ${entry.snapshot.original.sheet} · fila ${entry.snapshot.original.row} · v${entry.evidenceVersion}${rows.some((row) => row.id === entry.id) ? '' : ' · otra página/consulta'}` }))]} /></Field>
        {selected && <><Badge variant="neutral">Selección consultada · evidencia v{selected.evidenceVersion} · origen r{selected.effectiveSourceRevision}</Badge><details><summary>Revisar evidencia seleccionada al consultar</summary><HistoryEvidenceDetails observation={selected.snapshot} /></details></>}
        {query.data && query.data.evidence.length > 0 && <><p className="inventory-metadata-hint">{query.data.offset + 1}–{query.data.offset + query.data.evidence.length} de {query.data.total} documentos · orden por captura</p><Pagination page={Math.floor(query.data.offset / 25) + 1} pageCount={Math.ceil(query.data.total / 25)} loading={locked || workflow.busy} onPageChange={(page) => { workflow.invalidate(); setOffset((page - 1) * 25); }} /></>}
      </form>
      {workflow.busy && <LoadingState label="Contrastando evidencia, custodia y bajas existentes…" />}
      {assessment && !receiptId && <RetirementReconciliationDetails key={assessment.assessmentId} assessment={assessment} fresh={workflow.fresh} />}
      {assessment && workflow.fresh && !locked && !workflow.busy && !receiptId && <div className="flex flex-wrap gap-3">
        {prepare && assessment.links.verifiedPlan && selected && <Button variant="secondary" onClick={() => prepare(selected)}>Preparar baja con fecha verificada</Button>}
        {receiptsEnabled && assessment.links.existingApplication && assessment.existingApplication && <Button data-retirement-existing-receipt variant="secondary" onClick={() => setReceiptId(assessment.existingApplication!.id)}>Consultar comprobante existente</Button>}
      </div>}
      {receiptId && <RetirementReceipt key={receiptId} assetId={asset.id} id={receiptId} close={() => { setReceiptId(null); globalThis.requestAnimationFrame(() => form.current?.parentElement?.querySelector<globalThis.HTMLElement>('[data-retirement-existing-receipt]')?.focus()); }} />}
    </div>
  </Dialog>;
}
