import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError } from '../../lib/api';
import { environment } from '../../config/environment';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, Field, LoadingState, Pagination, useRequestError } from '../../ui';
import type { ImportPreview } from './import-review-model';
import { readIdentityGroupReview, readIdentityGroupReviews } from './identity-group-review-api';
import type { IdentityGroupReview, IdentityGroupReviewMetadata } from './identity-group-review-model';
import { IdentityGroupReviewDetails } from './IdentityGroupReviewDetails';
import { IdentityGroupProjectionDialog } from './IdentityGroupProjectionDialog';
import { GroupDecisionsDialog } from './GroupDecisionsDialog';
import { useIdentityGroupProjection } from './useIdentityGroupProjection';
import { useHistoryRead } from './useHistoryRead';
import { useIdentityGroupReviewMutation } from './useIdentityGroupReviewMutation';

export function IdentityGroupReviewsDialog({ batchId, actorId, original, open, close, exited }: { batchId: string; actorId: string; original: ImportPreview; open: boolean; close: () => void; exited: () => void }) {
  const [offset, setOffset] = useState(0); const [target, setTarget] = useState<string | null>(null);
  const [updated, setUpdated] = useState<IdentityGroupReview | null>(null);
  const total = useRef<number | null>(null); const content = useRef<globalThis.HTMLDivElement>(null); const scroll = useRef(0); const returnRow = useRef<string | null>(null);
  const reportError = useRequestError();
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    try {
      const page = await readIdentityGroupReviews(batchId, offset, signal);
      if (offset && total.current !== null && total.current !== page.total) throw new ApiRequestError('Grouping review list changed', 409, 'IDENTITY_GROUP_REVIEW_LIST_CHANGED');
      if (!signal.aborted) total.current = page.total;
      return page;
    } catch (error) { if (!signal.aborted) reportError(error, 'No se pudieron consultar las revisiones de agrupación'); throw error; }
  }, [batchId, offset, reportError]);
  const query = useHistoryRead(read, 'No se pudieron consultar las revisiones de agrupación.');
  useEffect(() => {
    if (target) return;
    const frame = globalThis.requestAnimationFrame(() => {
      if (query.error) content.current?.querySelector<globalThis.HTMLElement>('[data-group-list-error]')?.focus();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [target, query.error]);
  if (target) return <IdentityGroupReviewReceiptDialog key={target} batchId={batchId} actorId={actorId} original={original} id={target} open={open} close={close} exited={exited} back={() => setTarget(null)} changed={setUpdated} />;
  const data = query.data;
  const rows: IdentityGroupReviewMetadata[] = data?.items.map((row) => row.id === updated?.id ? { ...row, release: updated.release } : row) ?? [];
  return <Dialog className="catalog-editor-dialog import-review-dialog" title="Revisiones de agrupación" description="Consulta las reservas y sus comprobantes, incluidas las cancelaciones." open={open} onClose={close} onExited={exited} initialFocus={() => { const body = content.current?.closest('.ui-dialog-body'); if (body) body.scrollTop = scroll.current; return returnRow.current ? content.current?.querySelector<globalThis.HTMLButtonElement>(`[data-group-review="${returnRow.current}"]`) ?? null : null; }} actions={<Button variant="secondary" onClick={close}>Cerrar</Button>}>
    <div ref={content} className="space-y-4">
      <Button variant="secondary" size="sm" loading={query.reading} onClick={() => { scroll.current = 0; returnRow.current = null; if (offset) setOffset(0); else void query.refresh(); }}>Actualizar revisiones desde el inicio</Button>
      {query.error && <div data-group-list-error tabIndex={-1}><Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar revisiones</Button>}>{query.error}{data && ' Se conserva la página anterior sin confirmar su vigencia.'}</Alert></div>}
      {query.reading && data && <LoadingState label="Actualizando revisiones…" />}
      <DataTable className="catalog-data-table" rows={rows} getRowKey={(row) => row.id} caption="Revisiones administrativas de agrupación, por fecha de registro" loading={query.reading && !data} empty={query.error ? <></> : <EmptyState title="Sin revisiones de agrupación" description="Simular un escenario no guarda una revisión ni reserva sus filas." />} columns={[
        { key: 'time', header: 'Revisión', mobileRole: 'identity', render: (row) => <div className="min-w-0 w-full"><strong>{formatInventoryDateTime(row.createdAt)}</strong><small className="block break-words inventory-metadata-hint">Comprobante: {row.id}</small></div> },
        { key: 'state', header: 'Reserva', mobileRole: 'full', render: (row) => <Badge variant={row.release ? 'neutral' : 'warning'}>{row.release ? 'Cancelada' : 'Activa'}</Badge> },
        { key: 'context', header: 'Contexto guardado', mobileRole: 'full', render: (row) => `Lote v${row.batchVersion} · origen r${row.sourceRevision}` },
        { key: 'actor', header: 'Revisado por (ID)', mobileRole: 'full', render: (row) => <span className="min-w-0 w-full break-words">{row.reviewedById}</span> },
        { key: 'actions', header: 'Acciones', mobileRole: 'actions', render: (row) => <Button data-group-review={row.id} variant="secondary" size="sm" onClick={() => { returnRow.current = row.id; scroll.current = content.current?.closest('.ui-dialog-body')?.scrollTop ?? 0; setTarget(row.id); }}>Ver revisión</Button> }
      ]} />
      {data && data.total > 0 && <><p className="inventory-metadata-hint">{data.offset + 1}–{data.offset + data.items.length} de {data.total} revisiones · hora de Chile</p><Pagination page={Math.floor(data.offset / 25) + 1} pageCount={Math.max(1, Math.ceil(data.total / 25))} loading={query.reading || Boolean(query.error)} onPageChange={(page) => { returnRow.current = null; scroll.current = 0; setOffset((page - 1) * 25); }} /></>}
    </div>
  </Dialog>;
}

function IdentityGroupReviewReceiptDialog({ batchId, actorId, id, original, open, close, exited, back, changed }: { batchId: string; actorId: string; id: string; original: ImportPreview; open: boolean; close: () => void; exited: () => void; back: () => void; changed: (receipt: IdentityGroupReview) => void }) {
  const reportError = useRequestError();
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    try { const receipt = await readIdentityGroupReview(batchId, id, original, signal); if (!signal.aborted) changed(receipt); return receipt; }
    catch (error) { if (!signal.aborted) reportError(error, 'No se pudo consultar el comprobante de agrupación'); throw error; }
  }, [batchId, id, original, reportError, changed]);
  const query = useHistoryRead(read, 'No se pudo consultar el comprobante de agrupación.');
  const mutation = useIdentityGroupReviewMutation(batchId, actorId, original);
  const [cancel, setCancel] = useState(false); const [note, setNote] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [invalid, setInvalid] = useState(false); const [discard, setDiscard] = useState<'close' | 'back' | null>(null);
  const [projection, setProjection] = useState(false); const projectionReturn = useRef(false);
  const [decisions, setDecisions] = useState(false); const decisionsReturn = useRef(false);
  const content = useRef<globalThis.HTMLDivElement>(null); const form = useRef<globalThis.HTMLFormElement>(null); const paused = useRef(false);
  const review = mutation.saved ?? query.data;
  const projectionQuery = useIdentityGroupProjection(review, projection && open && environment.inventoryImportIdentityGroupProjectionV18);
  const dirty = Boolean(note || confirmation || mutation.uncertain);
  const reviewed = mutation.reviewed;
  useEffect(() => { if (query.data) reviewed(); }, [query.data, reviewed]);
  useEffect(() => {
    if (!dirty || mutation.saved) return;
    const warn = (event: globalThis.BeforeUnloadEvent) => event.preventDefault(); globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, mutation.saved]);
  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => {
      const selector = discard ? '[data-group-release-safe]' : query.error || mutation.error ? '[data-group-receipt-error]' : mutation.saved || query.data ? '[data-group-review-receipt]' : null;
      const element = selector ? content.current?.closest('dialog')?.querySelector<globalThis.HTMLElement>(selector) : null; element?.focus();
    }); return () => globalThis.cancelAnimationFrame(frame);
  }, [query.data, mutation.saved, query.error, mutation.error, discard]);
  function leave(destination: 'close' | 'back') {
    if (mutation.submitting()) return;
    if (dirty && !mutation.saved) { paused.current = true; setDiscard(destination); } else if (destination === 'back') back(); else close();
  }
  function startCancel() {
    if (query.reading || query.error || !review || review.release || mutation.blocked()) return;
    setCancel(true); setConfirmation(''); globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLButtonElement>('[data-group-release-back]')?.focus());
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!open || paused.current || mutation.submitting() || !review || review.release || query.reading || query.error) return;
    if (mutation.uncertain) { const receipt = await mutation.recover(); if (receipt) changed(receipt); return; }
    if (!cancel || mutation.blocked() || mutation.needsReview) return;
    if (!note.trim() || note.trim().length > 2000 || confirmation !== 'CANCELAR') { setInvalid(true); globalThis.requestAnimationFrame(() => form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    const receipt = await mutation.release(review, note); if (receipt) { changed(receipt); setCancel(false); }
  }
  if (decisions && review && environment.inventoryImportIdentityGroupDecisionsV19) return <GroupDecisionsDialog review={review} open={open} close={close} exited={exited} back={() => { decisionsReturn.current = true; setDecisions(false); void query.refresh(); }} />;
  if (projection && review && environment.inventoryImportIdentityGroupProjectionV18) return <IdentityGroupProjectionDialog query={projectionQuery} review={review} actorId={actorId} open={open} close={close} exited={exited} back={(refresh) => { projectionReturn.current = true; setProjection(false); if (refresh) void query.refresh(); }} />;
  return <Dialog className="catalog-editor-dialog import-review-dialog" title="Detalle de agrupación" description="Comprobante administrativo y procedencia de sus filas." open={open} busy={mutation.busy} onClose={() => leave('close')} onExited={exited} initialFocus={() => { const selector = decisionsReturn.current ? '[data-open-group-decisions]:not(:disabled)' : projectionReturn.current ? '[data-open-group-projection]:not(:disabled)' : null; decisionsReturn.current = false; projectionReturn.current = false; return selector ? content.current?.querySelector<globalThis.HTMLButtonElement>(selector) ?? null : null; }} actions={discard ? <><Button key="keep-release" data-group-release-safe variant="secondary" onClick={() => { paused.current = false; setDiscard(null); }}>Seguir revisando</Button><Button key="discard-release" onClick={() => discard === 'back' ? back() : close()}>Salir y descartar borrador</Button></> : <><Button key="back-reviews" variant="secondary" disabled={mutation.busy} onClick={() => leave('back')}>Volver a revisiones</Button><Button key="close-receipt" variant="secondary" disabled={mutation.busy} onClick={() => leave('close')}>Cerrar</Button>{mutation.uncertain ? <Button key="recover-release" type="submit" form="group-release-form" loading={mutation.busy}>Recuperar mismo intento</Button> : cancel && !review?.release ? <Button key="submit-release" type="submit" form="group-release-form" loading={mutation.busy} disabled={Boolean(query.error) || query.reading || mutation.needsReview}>Cancelar reserva</Button> : review && !review.release && <Button key="start-release" disabled={mutation.locked || query.reading || Boolean(query.error)} onClick={startCancel}>Revisar cancelación</Button>}</>}>
    <div ref={content} className="space-y-4">
      {discard && <Alert variant="warning">{mutation.uncertain ? 'Se perderá la clave de recuperación en memoria. Salir no revierte ni confirma la cancelación en el servidor; consulta el comprobante al volver.' : 'Se perderá el motivo de cancelación que todavía no has guardado.'}</Alert>}
      <div data-group-receipt-error tabIndex={-1} className="space-y-3">{query.error && <Alert variant="danger">{query.error}{query.data && ' El comprobante anterior no confirma el estado vigente.'}</Alert>}{mutation.error && <Alert variant="danger">{mutation.error}</Alert>}{mutation.needsReview && <Alert variant="warning">Consulta el estado vigente y vuelve a confirmar antes de otro intento.</Alert>}</div>
      {!mutation.uncertain && !mutation.saved && <Button variant="secondary" size="sm" loading={query.reading} disabled={mutation.busy || Boolean(discard)} onClick={() => { setConfirmation(''); void query.refresh(); }}>Consultar estado de revisión</Button>}
      {query.reading && <LoadingState label="Consultando comprobante…" />}
      {mutation.uncertain && <Alert variant="warning">No se pudo confirmar la cancelación. Recupera exactamente el mismo intento; no cambies el motivo ni prepares otra clave.</Alert>}
      <form id="group-release-form" ref={form} noValidate onSubmit={(event) => void submit(event)} className="space-y-4">
        {cancel && !review?.release && <section className="inventory-metadata-section space-y-4" aria-label="Confirmar cancelación de reserva"><h3 className="font-semibold">Cancelar esta reserva</h3><p>Se liberarán todas sus filas. El comprobante y el escenario se conservan. Los demás flujos volverán a consultar el origen y sus correcciones; sus validaciones siguen vigentes.</p><Button data-group-release-back variant="secondary" disabled={mutation.locked} onClick={() => { setCancel(false); setConfirmation(''); }}>Volver al comprobante</Button><Field label="Motivo de cancelación" required disabled={mutation.locked || Boolean(discard)} error={invalid && !note.trim() ? 'Indica por qué abandonas esta revisión.' : undefined}><textarea className="resize-none" rows={3} maxLength={2000} value={note} onChange={(event) => { setNote(event.target.value); setInvalid(false); setConfirmation(''); }} /></Field><Field label="Escribe CANCELAR" required disabled={mutation.locked || Boolean(discard)} error={invalid && confirmation !== 'CANCELAR' ? 'Escribe CANCELAR para confirmar.' : undefined}><input autoComplete="off" value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setInvalid(false); }} /></Field></section>}
      </form>
      {environment.inventoryImportIdentityGroupProjectionV18 && review && !review.release && !cancel && !dirty && !discard && <Button data-open-group-projection variant="secondary" disabled={query.reading || Boolean(query.error) || mutation.locked || mutation.needsReview} onClick={() => setProjection(true)}>Consultar situación actual</Button>}
      {environment.inventoryImportIdentityGroupDecisionsV19 && review && !cancel && !dirty && !discard && <Button data-open-group-decisions variant="secondary" disabled={query.reading || Boolean(query.error) || mutation.locked || mutation.needsReview} onClick={() => setDecisions(true)}>Consultar decisiones</Button>}
      {review && <IdentityGroupReviewDetails review={review} />}
    </div>
  </Dialog>;
}
