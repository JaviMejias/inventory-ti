import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError } from '../../lib/api';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, Field, LoadingState, Pagination, Select } from '../../ui';
import { readAmendment, readAmendments } from './evidence-amendment-api';
import { amendmentBlockerLabels, amendmentTarget, validateAmendmentDraft, type AmendmentDraft, type EvidenceAmendment, type EvidenceOwner, type OriginalEvidence } from './evidence-amendment-model';
import { historyDay, historyKindLabels, type CapturedObservation } from './history-evidence-model';
import { HistoryEvidenceDetails } from './HistoryEvidenceDetails';
import { useEvidenceAmendment } from './useEvidenceAmendment';
import { useHistoryRead } from './useHistoryRead';

export function EvidenceAmendmentDialog({ owner, actorId, open, close, exited }: { owner: EvidenceOwner; actorId: string; open: boolean; close: () => void; exited: () => void }) {
  const [offset, setOffset] = useState(0);
  const head = useRef<string | null>(null);
  const [draft, setDraft] = useState<AmendmentDraft>({ target: '', assetId: '', note: '', reference: '', confirmed: false });
  const [errors, setErrors] = useState<ReturnType<typeof validateAmendmentDraft>>({});
  const [review, setReview] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const detailTrigger = useRef<globalThis.HTMLElement | null>(null);
  const form = useRef<globalThis.HTMLFormElement>(null);
  const readError = useRef<globalThis.HTMLDivElement>(null);
  const result = useRef<globalThis.HTMLDivElement>(null);
  const workflow = useEvidenceAmendment(owner, actorId);
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    const page = await readAmendments(owner, offset, signal);
    const fingerprint = `${page.current.evidenceVersion}:${page.current.amendmentId}`;
    if (offset && head.current !== null && head.current !== fingerprint) throw new ApiRequestError('Evidence history changed', 409, 'EVIDENCE_HISTORY_CHANGED');
    if (!signal.aborted) head.current = fingerprint;
    return page;
  }, [owner, offset]);
  const query = useHistoryRead(read, 'No se pudieron consultar las versiones documentales.');
  const data = query.data;
  const dirty = Boolean(draft.target || draft.assetId || draft.note || draft.reference);
  const locked = workflow.saving || workflow.uncertain || Boolean(workflow.saved);
  const readLocked = query.reading || Boolean(query.error) || data?.offset !== offset;
  useEffect(() => {
    if (!query.error) return;
    const frame = globalThis.requestAnimationFrame(() => readError.current?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [query.error]);
  useEffect(() => {
    if ((!dirty && !workflow.uncertain) || workflow.saved) return;
    const warn = (event: globalThis.BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, workflow.uncertain, workflow.saved]);
  function update(patch: Partial<AmendmentDraft>) {
    if (workflow.blocked() || review) return;
    if ('target' in patch || 'assetId' in patch) workflow.invalidate();
    setErrors({}); setDraft((current) => ({ ...current, ...patch, confirmed: false }));
  }
  function leave() { workflow.invalidate(); close(); }
  function requestClose() {
    if (workflow.submitting()) return;
    if (workflow.saved) { close(); return; }
    workflow.invalidate();
    if (dirty || workflow.uncertain) setDiscard(true); else leave();
  }
  function focusResult() { globalThis.requestAnimationFrame(() => result.current?.focus()); }
  function focusInvalid() { globalThis.requestAnimationFrame(() => form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]')?.focus()); }
  function refresh() {
    if (workflow.submitting() || workflow.uncertain) return;
    workflow.invalidate(); setReview(false); setDraft((current) => ({ ...current, confirmed: false })); setDetail(null);
    if (offset) setOffset(0); else void query.refresh();
  }
  async function generate(event: FormEvent) {
    event.preventDefault(); if (!open || discard || review || workflow.blocked() || readLocked || !data) return;
    const validation = validateAmendmentDraft(draft); setErrors(validation);
    const assetId = amendmentTarget(draft, data.current);
    if (Object.keys(validation).length || assetId === undefined) { focusInvalid(); return; }
    // The explicitly chosen current link becomes a fixed target, not a moving default.
    if (draft.target === 'current' && assetId) setDraft((current) => ({ ...current, target: 'asset', assetId, confirmed: false }));
    if (await workflow.generate(assetId)) focusResult();
  }
  async function save() {
    if (!open || discard || workflow.submitting()) return;
    if (!workflow.uncertain) {
      if (!review || !workflow.plan?.valid) return;
      const validation = validateAmendmentDraft(draft, true); setErrors(validation);
      if (Object.keys(validation).length) { focusInvalid(); return; }
    }
    const receipt = await workflow.save(workflow.uncertain ? undefined : workflow.plan!, workflow.uncertain ? undefined : draft);
    if (receipt) { setReview(false); focusResult(); }
    else if (!workflow.uncertain) { setDraft((current) => ({ ...current, confirmed: false })); }
  }
  return <Dialog className="catalog-editor-dialog import-review-dialog" open={open} busy={workflow.saving} onClose={requestClose} onExited={exited}
    title={workflow.saved ? 'Versión documental guardada' : review || workflow.uncertain ? 'Confirmar enmienda documental' : 'Versiones de evidencia histórica'}
    description="La captura original se conserva. Una enmienda no cambia stock, estado ni entregas actuales."
    actions={discard ? <><Button key="keep-evidence" autoFocus variant="secondary" onClick={() => setDiscard(false)}>Seguir revisando</Button><Button variant={workflow.uncertain ? 'danger' : 'primary'} onClick={leave}>{workflow.uncertain ? 'Cerrar sin resolver el intento' : 'Descartar borrador y cerrar'}</Button></> : workflow.saved ? <Button variant="secondary" onClick={requestClose}>Cerrar</Button> : review || workflow.uncertain ? <><Button key="back-evidence" autoFocus variant="secondary" disabled={locked} onClick={() => { setReview(false); setDraft((current) => ({ ...current, confirmed: false })); }}>Volver a revisar</Button><Button loading={workflow.saving} disabled={!workflow.uncertain && (!draft.confirmed || !workflow.plan?.valid)} onClick={() => void save()}>{workflow.uncertain ? 'Recuperar mismo intento' : 'Guardar versión documental'}</Button></> : <><Button variant="secondary" onClick={requestClose}>Cerrar</Button><Button form="evidence-amendment-form" type="submit" loading={workflow.planning} disabled={readLocked || discard}>Generar propuesta</Button></>}>
    <div className="space-y-4">
      {discard && <Alert variant="warning">{workflow.uncertain ? 'Guardar pudo completarse. Cerrar no revierte el servidor y pierde la intención en memoria. Conserva la clave y consulta las versiones antes de preparar otro intento.' : 'Se perderá este borrador. Generar la propuesta no guardó cambios.'}</Alert>}
      {workflow.error && <Alert variant="danger">{workflow.error}</Alert>}
      {workflow.uncertain && <Alert variant="warning"><p>Resultado sin confirmar. Recupera exactamente la misma intención; no generes otra clave.</p><p className="break-words">Clave de recuperación: {workflow.requestId}</p></Alert>}
      {query.reading && <LoadingState label="Consultando versiones documentales…" />}
      {query.error && <div ref={readError} tabIndex={-1}><Alert variant="danger" action={<><Button variant="secondary" size="sm" disabled={locked || review} onClick={() => void query.refresh()}>Reintentar página</Button><Button variant="secondary" size="sm" disabled={workflow.saving || workflow.uncertain} onClick={refresh}>Consultar desde el inicio</Button></>}>{query.error}{data && ' Se conserva la consulta anterior; su vigencia no está confirmada.'}</Alert></div>}
      <div ref={result} tabIndex={-1} className="space-y-4">
        {workflow.saved && <><Alert variant="success">Se confirmó la versión {workflow.saved.version}. Este comprobante puede no ser la versión más reciente, especialmente después de una recuperación.</Alert><AmendmentDetails event={workflow.saved} /></>}
        {workflow.plan && !workflow.saved && <section className="space-y-3" aria-label="Propuesta documental del servidor">
          <Badge variant={workflow.plan.valid ? 'success' : 'warning'}>{workflow.plan.valid ? 'Propuesta válida · todavía no guardada' : 'Propuesta bloqueada'}</Badge>
          <p className="inventory-metadata-hint">Lote v{workflow.plan.batchVersion} · origen r{workflow.plan.sourceRevision} · evidencia v{workflow.plan.evidenceVersion}. La propuesta no elimina incidencias de origen ni acredita un ejecutor histórico.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 min-w-0"><ObservationSummary title="Vigente al preparar" snapshot={workflow.plan.current.snapshot} /><ObservationSummary title="Propuesta sin guardar" snapshot={workflow.plan.proposed} /></div>
          {workflow.plan.blockers.map((code) => <Alert key={code} variant="warning">{amendmentBlockerLabels[code] ?? 'El servidor bloqueó esta propuesta. Revisa el origen antes de continuar.'}<small className="block break-words">{code}</small></Alert>)}
          {workflow.plan.used && <p className="inventory-metadata-hint break-words">Uso aplicado: {workflow.plan.used.itemId} · {workflow.plan.used.endpoint}. No se puede enmendar esta evidencia.</p>}
        </section>}
      </div>
      <form id="evidence-amendment-form" ref={form} noValidate onSubmit={(event) => void generate(event)} className="space-y-4" hidden={Boolean(workflow.saved)}>
        <fieldset className="space-y-4 min-w-0" disabled={locked || workflow.planning || discard}>
          {!review && <><Field label="Vínculo propuesto" required error={errors.target} hint="El UUID identifica una propuesta; el servidor exige identidad aprobada en el lote original. No autoriza el vínculo por sí solo."><Select value={draft.target} onChange={(value) => update({ target: value as AmendmentDraft['target'] })} options={[{ value: '', label: 'Elegir expresamente' }, { value: 'unlinked', label: 'Sin vincular (null)' }, ...(data?.current.assetId ? [{ value: 'current', label: 'Conservar vínculo consultado' }] : []), { value: 'asset', label: 'Activo revisado (UUID)' }]} /></Field>
          {draft.target === 'asset' && <Field label="UUID del activo revisado" required error={errors.assetId}><input type="text" autoComplete="off" value={draft.assetId} onChange={(event) => update({ assetId: event.target.value })} /></Field>}</>}
          <Field label="Motivo de la enmienda" required error={errors.note}><textarea className="resize-none" rows={3} maxLength={2000} readOnly={review} value={draft.note} onChange={(event) => update({ note: event.target.value })} /></Field>
          <Field label="Respaldo documental" required error={errors.reference}><input type="text" autoComplete="off" maxLength={500} readOnly={review} value={draft.reference} onChange={(event) => update({ reference: event.target.value })} /></Field>
          {review && <Field label="Confirmación independiente" required error={errors.confirmed}><Select value={draft.confirmed ? 'confirmed' : ''} onChange={(value) => { if (!workflow.blocked()) setDraft((current) => ({ ...current, confirmed: value === 'confirmed' })); }} options={[{ value: '', label: 'Sin confirmar' }, { value: 'confirmed', label: 'Guardar solo una versión documental. Conservar captura e inventario.' }]} /></Field>}
        </fieldset>
      </form>
      {!review && !discard && !locked && workflow.plan?.valid && !workflow.planning && <Button variant="secondary" onClick={() => {
        const validation = validateAmendmentDraft({ ...draft, confirmed: true }, true); setErrors(validation);
        if (Object.keys(validation).length) focusInvalid(); else { setReview(true); setDraft((current) => ({ ...current, confirmed: false })); }
      }}>Revisar guardado permanente</Button>}
      {!review && !workflow.uncertain && <section aria-label="Consulta documental" className="space-y-3">
        <Button variant="secondary" size="sm" loading={query.reading} disabled={workflow.planning || workflow.saving || discard} onClick={refresh}>Consultar versión vigente desde el inicio</Button>
        {data && <><ObservationSummary title="Captura original · v0 · inmutable" snapshot={data.original.snapshot} /><ObservationSummary title={`Vigente en esta consulta · v${data.current.evidenceVersion}`} snapshot={data.current.snapshot} />
          <p className="inventory-metadata-hint break-words">Lote original: {data.original.capture.batchId} · capturada {formatInventoryDateTime(data.original.capturedAt)}. Revisor de captura: {data.original.capture.capturedById}; no es el ejecutor histórico.</p>
          <DataTable className="catalog-data-table" caption="Enmiendas documentales, más recientes primero" rows={data.events} getRowKey={(entry) => entry.id} loading={query.reading && !data}
            empty={query.error ? <></> : <EmptyState title="Sin enmiendas documentales" description="Solo existe la captura original. Ninguna versión se elimina o sobrescribe." />} columns={[
              { key: 'version', header: 'Versión', mobileRole: 'identity', render: (entry) => <strong>v{entry.version}</strong> },
              { key: 'date', header: 'Registrada en la app', render: (entry) => formatInventoryDateTime(entry.amendedAt) },
              { key: 'note', header: 'Motivo y respaldo', mobileRole: 'full', render: (entry) => <span className="break-words whitespace-pre-wrap">{entry.note} · {entry.evidenceReference}</span> },
              { key: 'actions', header: 'Detalle', mobileRole: 'actions', render: (entry) => <Button variant="secondary" size="sm" disabled={readLocked || discard} onClick={(event) => { detailTrigger.current = event.currentTarget; setDetail(entry.id); }}>Ver versión {entry.version}</Button> }
            ]} />
          {data.total > 0 && <Pagination page={Math.floor(data.offset / 25) + 1} pageCount={Math.ceil(data.total / 25)} loading={readLocked || workflow.planning || discard} onPageChange={(page) => { setDetail(null); setOffset((page - 1) * 25); }} />}
          {detail && <AmendmentReadDetails key={detail} original={data.original} id={detail} close={() => { setDetail(null); globalThis.requestAnimationFrame(() => { if (detailTrigger.current?.isConnected) detailTrigger.current.focus(); }); }} />}
        </>}
      </section>}
    </div>
  </Dialog>;
}

function ObservationSummary({ title, snapshot }: { title: string; snapshot: CapturedObservation | null }) {
  return <section className="inventory-metadata-section space-y-2 min-w-0"><h3 className="font-semibold">{title}</h3>{snapshot ? <><dl className="inventory-metadata-detail"><div><dt>Observación</dt><dd>{historyKindLabels[snapshot.kind]}</dd></div><div><dt>Fecha indicada</dt><dd>{historyDay(snapshot.effectiveDay)}</dd></div><div><dt>Vínculo</dt><dd className="break-words">{snapshot.assetId ?? 'Sin vincular'}</dd></div></dl><details><summary>Origen, interpretación e incidencias · {snapshot.issues.length}</summary><HistoryEvidenceDetails observation={snapshot} /></details></> : <p>Sin propuesta reconocida por el servidor.</p>}</section>;
}
function AmendmentDetails({ event }: { event: EvidenceAmendment }) {
  return <section className="inventory-metadata-section space-y-3" aria-label={`Comprobante de versión ${event.version}`}><Badge variant="info">Versión {event.version} · comprobante inmutable</Badge><dl className="inventory-metadata-detail">
    <div><dt>Registrada en la app</dt><dd>{formatInventoryDateTime(event.amendedAt)}</dd></div><div><dt>Revisor de enmienda</dt><dd className="break-words">{event.amendedById} · no acredita ejecutor histórico</dd></div>
    <div><dt>Motivo</dt><dd className="whitespace-pre-wrap break-words">{event.note}</dd></div><div><dt>Respaldo</dt><dd className="break-words">{event.evidenceReference}</dd></div>
    <div><dt>Procedencia</dt><dd>Lote v{event.batchVersion} · origen r{event.sourceRevision}</dd></div><div><dt>Clave de recuperación</dt><dd className="break-words">{event.requestId}</dd></div><div><dt>Versión anterior</dt><dd className="break-words">{event.previousAmendmentId ?? 'Captura original'}</dd></div>
  </dl><ObservationSummary title="Interpretación guardada en esta versión" snapshot={event.snapshot} /></section>;
}
function AmendmentReadDetails({ original, id, close }: { original: OriginalEvidence; id: string; close: () => void }) {
  const ref = useRef<globalThis.HTMLDivElement>(null);
  const read = useCallback((signal: globalThis.AbortSignal) => readAmendment(original, id, signal), [original, id]);
  const query = useHistoryRead(read, 'No se pudo consultar esta versión documental.');
  useEffect(() => { ref.current?.focus(); }, []);
  return <div ref={ref} tabIndex={-1} className="space-y-3"><Button variant="secondary" size="sm" onClick={close}>Cerrar detalle de versión</Button>{query.reading && <LoadingState label="Consultando versión documental…" />}{query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar versión</Button>}>{query.error}</Alert>}{query.data && <AmendmentDetails event={query.data} />}</div>;
}
