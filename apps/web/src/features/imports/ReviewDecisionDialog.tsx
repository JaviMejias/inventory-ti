import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError, getApiErrorMessage } from '../../lib/api';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, Field, ListFooter, LoadingState, Select, useRequestError, useToast } from '../../ui';
import { importReviewPath, readBatch, readFreshness, readReviewPage, saveReviewDecision } from './import-review-api';
import { availableReviewActions, createReviewIntent, reviewActionLabels, validateReviewDraft, type BatchDetail, type Freshness, type ReviewAction, type ReviewDecision, type ReviewIntent, type ReviewTarget } from './import-review-model';
import { SourceEvidence } from './SourceEvidence';
import { useReviewPage } from './useReviewPage';
import { environment } from '../../config/environment';
import { buildReviewTargets } from './import-review-model';
import { readResolvedReviewSource } from './source-review-api';
import { requiresIdentityRedecision, type ResolvedReviewSource } from './source-review-model';

type ReviewContext = { detail: BatchDetail; freshness: Freshness; latest: ReviewDecision | null; source: ResolvedReviewSource | null; effective: ReviewTarget };
export function ReviewDecisionDialog({ batchId, target, open, close, exited, changed }: { batchId: string; target: ReviewTarget; open: boolean; close: () => void; exited: () => void; changed: () => void }) {
  const reportError = useRequestError();
  const { showToast } = useToast();
  const [context, setContext] = useState<ReviewContext | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const [action, setAction] = useState<ReviewAction>('HOLD');
  const [note, setNote] = useState('');
  const [linkedAssetId, setLinkedAssetId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const intent = useRef<ReviewIntent | null>(null);
  const submitting = useRef(false);
  const active = useRef(true);
  const readController = useRef<globalThis.AbortController | null>(null);
  const formRef = useRef<globalThis.HTMLFormElement>(null);
  const targetQuery = `targetType=${target.type}&targetId=${target.id}`;
  const history = useReviewPage<ReviewDecision>(`${importReviewPath}/${batchId}/decisions?mode=history&${targetQuery}`, 'decisions');

  const refresh = useCallback(async () => {
    readController.current?.abort();
    const controller = new globalThis.AbortController();
    readController.current = controller;
    setReading(true);
    setReadError(null);
    try {
      const sourceAware = environment.inventoryImportSourceV7 || environment.inventoryImportIdentityV8;
      const [detail, freshness, latest, source] = await Promise.all([
        readBatch(batchId, controller.signal), readFreshness(batchId, controller.signal),
        readReviewPage<ReviewDecision>(`${importReviewPath}/${batchId}/decisions?mode=latest&${targetQuery}&limit=1&offset=0`, 'decisions', controller.signal),
        sourceAware ? readResolvedReviewSource(batchId, controller.signal) : Promise.resolve(null)
      ]);
      const effective = source ? buildReviewTargets(source.preview).find((item) => item.id === target.id && item.type === target.type) : target;
      if (!effective || (source && (source.batchVersion !== detail.batch.version || latest.rows.some((item) => !Number.isInteger(item.sourceRevision)))) ||
        (environment.inventoryImportIdentityV8 && !source?.sourceContext.identityRevisions)) throw new ApiRequestError('Inconsistent source review context', 200, 'INVALID_RESPONSE');
      if (!controller.signal.aborted) {
        setContext({ detail, freshness, latest: latest.rows[0] ?? null, source, effective });
        setNeedsRefresh(false);
      }
    } catch (caughtError) {
      if (!controller.signal.aborted) setReadError(getApiErrorMessage(caughtError, 'No se pudo actualizar la revisión.'));
    } finally { if (!controller.signal.aborted) setReading(false); }
  }, [batchId, targetQuery, target]);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; readController.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    if (!dirty && !uncertain) return undefined;
    const warn = (event: globalThis.BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, uncertain]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (submitting.current || (!uncertain && (!context || reading || readError || needsRefresh))) return;
    if (!uncertain && context) {
      const validation = validateReviewDraft(context.effective, context.freshness.stale, action, note, linkedAssetId);
      setErrors(validation);
      if (Object.keys(validation).length) {
        globalThis.requestAnimationFrame(() => formRef.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]')?.focus());
        return;
      }
      intent.current = createReviewIntent(target, context.detail.batch.version, action, note, linkedAssetId, globalThis.crypto.randomUUID());
      if (context.source) intent.current.expectedSourceRevision = context.source.sourceContext.revision;
    }
    if (!intent.current) return;
    submitting.current = true;
    setBusy(true);
    setWriteError(null);
    try {
      await saveReviewDecision(batchId, intent.current);
      if (!active.current) return;
      intent.current = null;
      setUncertain(false);
      setDirty(false);
      setNote('');
      showToast({ tone: 'success', title: 'Decisión guardada', description: 'La revisión se guardó. No se modificó el inventario.' });
      changed();
      await Promise.all([refresh(), history.reload()]);
    } catch (caughtError) {
      if (!active.current) return;
      setWriteError(reportError(caughtError, 'No se pudo guardar la decisión.'));
      const unknownOutcome = !(caughtError instanceof ApiRequestError) || ['NETWORK_ERROR', 'INVALID_RESPONSE'].includes(caughtError.code ?? '') || caughtError.status >= 500;
      setUncertain(unknownOutcome);
      if (!unknownOutcome) {
        intent.current = null;
        setNeedsRefresh(caughtError instanceof ApiRequestError && ['REVIEW_VERSION_CONFLICT', 'BATCH_SNAPSHOT_STALE', 'SOURCE_REVISION_CONFLICT'].includes(caughtError.code ?? ''));
      }
    } finally { submitting.current = false; if (active.current) setBusy(false); }
  }
  function requestClose() { if (busy) return; if (dirty || uncertain) setDiscard(true); else close(); }
  const locked = busy || uncertain || reading || Boolean(readError) || needsRefresh || !context;
  const actions = availableReviewActions(context?.effective ?? target, context?.freshness.stale ?? true);
  const options = actions.map((value) => ({ value, label: reviewActionLabels[value] }));
  if (!actions.includes(action)) options.unshift({ value: action, label: `${reviewActionLabels[action]} (no disponible)` });

  return <Dialog className="catalog-editor-dialog import-review-dialog" open={open} onClose={requestClose} onExited={exited} title={target.label} description="Revisa el origen y registra una decisión. Este paso no crea ni modifica activos." busy={busy} actions={discard ? <><Button key="continue-review" variant="secondary" autoFocus onClick={() => setDiscard(false)}>Seguir revisando</Button><Button onClick={close}>Descartar y cerrar</Button></> : <><Button variant="secondary" onClick={requestClose} disabled={busy}>Cerrar</Button>{uncertain ? <Button loading={busy} onClick={() => void submit()}>Recuperar decisión</Button> : <Button type="submit" form="import-decision-form" loading={busy} disabled={locked}>Guardar decisión</Button>}</>}>
    <div className="space-y-5">
      {discard && <Alert variant="warning">{uncertain ? 'El resultado está sin confirmar. Cerrar no cancela una decisión que el servidor pueda haber guardado; vuelve a consultar su historial.' : 'Hay un motivo sin guardar. Si cierras, perderás este borrador.'}</Alert>}
      {reading && <LoadingState label="Actualizando revisión…" />}
      {readError && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>Reintentar lectura</Button>}>{readError}</Alert>}
      {context && <>
        <div className="import-review-summary"><Badge variant="neutral">Versión {context.detail.batch.version}</Badge>{context.source && <Badge variant="info">Origen r{context.source.sourceContext.revision}</Badge>}<Badge variant={context.freshness.stale ? 'warning' : 'info'}>{context.freshness.stale ? 'Origen desactualizado' : 'Vigencia comprobada'}</Badge></div>
        {context.source && requiresIdentityRedecision(context.source, target.id, context.latest?.sourceRevision) && <Alert variant="warning">La identidad fue revisada después de la decisión anterior. Comprueba la interpretación vigente y registra una nueva decisión explícita; el historial anterior no aprueba esta identidad.</Alert>}
        {context.freshness.stale && <Alert variant="warning">Cambió el inventario o las reglas. Solo puedes dejar pendiente o excluir; genera un lote vigente antes de vincular o proponer equipos.</Alert>}
        {context.latest ? <section aria-label="Decisión vigente" className="inventory-metadata-section"><h3 className="font-semibold">Decisión vigente · {reviewActionLabels[context.latest.action]}</h3><p className="whitespace-pre-wrap break-words mt-2">{context.latest.note}</p><p className="inventory-metadata-hint mt-2">{formatInventoryDateTime(context.latest.createdAt)} · Revisor {context.latest.reviewedById}</p></section> : <p className="inventory-metadata-hint">Este registro todavía no tiene una decisión guardada.</p>}
      </>}
      {writeError && <Alert variant="danger">{writeError}</Alert>}
      {uncertain && <Alert variant="warning">El resultado no está confirmado. Recuperar decisión reenvía exactamente la misma intención y clave; el servidor evita duplicarla.</Alert>}
      {needsRefresh && <Alert variant="warning" action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>Actualizar revisión</Button>}>La revisión cambió. Actualiza, vuelve a comprobar la decisión vigente y confirma tu motivo antes de guardar otra vez.</Alert>}
      <form ref={formRef} id="import-decision-form" noValidate onSubmit={(event) => void submit(event)} className="space-y-4">
        <Field label="Decisión" error={errors.action} disabled={locked}><Select value={action} onChange={(value) => { setAction(value as ReviewAction); setDirty(true); setErrors({}); }} options={options} /></Field>
        {action === 'LINK_EXISTING' && <Field label="Activo sugerido" required error={errors.linkedAssetId} disabled={locked}><Select searchable value={linkedAssetId} onChange={(value) => { setLinkedAssetId(value); setDirty(true); setErrors({}); }} options={[{ value: '', label: 'Seleccionar activo' }, ...(context?.effective.candidate?.existingAssets ?? []).map((asset) => ({ value: asset.id, label: `${asset.product.name} · ${asset.assetTag || asset.serialNumber || asset.id}${!asset.isActive ? ' · Inactivo' : ''}` }))]} /></Field>}
        <Field label="Motivo de la decisión" required error={errors.note} disabled={locked} hint="Se guardará en el historial de revisión. Excluir conserva el origen; proponer no crea un equipo."><textarea className="resize-none" rows={4} maxLength={2000} value={note} onChange={(event) => { setNote(event.target.value); setDirty(true); setErrors({}); }} /></Field>
      </form>
      {context?.source && <section className="space-y-3" aria-label="Interpretación vigente"><h3 className="font-semibold">Interpretación vigente · origen r{context.source.sourceContext.revision}</h3><SourceEvidence key={context.source.sourceContext.revision} target={context.effective} interpreted /></section>}
      <details className="inventory-metadata-section" open={!context?.source}><summary>Evidencia original (sin modificar)</summary><SourceEvidence target={target} /></details>
      <section aria-label="Historial de decisiones"><h3 className="font-semibold mb-3">Historial de decisiones</h3>
        {history.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void history.retry()}>Reintentar historial</Button>}>{history.error}</Alert>}
        <DataTable rows={history.page.items} getRowKey={(decision) => decision.id} caption="Historial de decisiones del registro" loading={history.loading && !history.page.items.length} empty={history.error ? <></> : <EmptyState title="Sin decisiones anteriores" />} columns={[
          { key: 'action', header: 'Decisión', mobileRole: 'identity', render: (decision) => reviewActionLabels[decision.action] },
          { key: 'note', header: 'Motivo', mobileRole: 'full', render: (decision) => <span className="whitespace-pre-wrap break-words">{decision.note}</span> },
          { key: 'date', header: 'Registro', render: (decision) => `${formatInventoryDateTime(decision.createdAt)} · v${decision.batchVersion}${decision.sourceRevision !== undefined ? ' · origen r' + decision.sourceRevision : ''}` },
          { key: 'author', header: 'Revisor', mobileRole: 'full', render: (decision) => decision.reviewedById }
        ]} />
        {!history.error && <ListFooter loaded={history.page.items.length} total={history.page.total} hasMore={history.page.hasMore} loading={history.loading} onLoadMore={history.more} />}
      </section>
    </div>
  </Dialog>;
}
