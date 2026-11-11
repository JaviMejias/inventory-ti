import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, Field, LoadingState, Pagination, Select, useRequestError } from '../../ui';
import { closedPlanInput, emptyClosedPeriod, validateClosedPeriod, validateClosedPeriods, type ClosedPeriodDraft } from './closed-assignment-model';
import { ClosedAssignmentPlanDetails } from './ClosedAssignmentPlanDetails';
import { readAssetImportedEvidence } from './history-evidence-api';
import { historyDay, historyKindLabels, type AssetHistoryEvidence } from './history-evidence-model';
import { HistoryEvidenceDetails } from './HistoryEvidenceDetails';
import { useClosedAssignmentPlan } from './useClosedAssignmentPlan';
import { useHistoryRead } from './useHistoryRead';
import { useClosedApplication } from './useClosedApplication';
import { ClosedApplicationDetails } from './ClosedApplicationDetails';
import { formatInventoryDateTime } from '../../lib/date-range';
import { assetStatusLabels } from '../home/asset-status';

export function ClosedAssignmentPlanDialog({ asset, open, close, exited, actorId, applyEnabled = false }: {
  asset: { id: string; assetTag: string | null; serialNumber: string | null; product: { name: string } };
  open: boolean; close: () => void; exited: () => void; actorId: string; applyEnabled?: boolean;
}) {
  const [drafts, setDrafts] = useState(() => [emptyClosedPeriod(globalThis.crypto.randomUUID())]);
  const [activeId, setActiveId] = useState(drafts[0].periodId);
  const draft = drafts.find((period) => period.periodId === activeId) ?? drafts[0];
  const [planOrder, setPlanOrder] = useState<string[]>([]); const [resultId, setResultId] = useState(''); const [removeId, setRemoveId] = useState<string | null>(null);
  const paused = useRef(false); const content = useRef<globalThis.HTMLDivElement>(null);
  const [selectedByPeriod, setSelectedByPeriod] = useState<Record<string, Partial<Record<'start' | 'end', AssetHistoryEvidence>>>>({});
  const selected = selectedByPeriod[draft.periodId] ?? {};
  const [offset, setOffset] = useState(0);
  const [allErrors, setErrors] = useState<Record<string, ReturnType<typeof validateClosedPeriod>>>({});
  const errors = allErrors[draft.periodId] ?? {};
  const [discard, setDiscard] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const form = useRef<globalThis.HTMLFormElement>(null);
  const workflow = useClosedAssignmentPlan(asset.id);
  const application = useClosedApplication(asset.id, actorId);
  const reportError = useRequestError();
  const read = useCallback(async (signal: globalThis.AbortSignal) => { try { return await readAssetImportedEvidence(asset.id, offset, signal); } catch (error) { if (!signal.aborted) reportError(error, 'No se pudo consultar la evidencia de los periodos'); throw error; } }, [asset.id, offset, reportError]);
  const query = useHistoryRead(read, 'No se pudo consultar la evidencia para preparar el periodo.');
  const dirty = drafts.length > 1 || drafts.some((period) => Object.entries(period).some(([key, value]) => key !== 'periodId' && (Array.isArray(value) ? value.length > 0 : Boolean(value))));
  const resultPeriod = workflow.plan?.periods.find((period) => period.periodId === resultId) ?? workflow.plan?.periods[0];
  const resultDraft = drafts.find((period) => period.periodId === resultPeriod?.periodId);
  const locked = query.reading || Boolean(query.error) || query.data?.offset !== offset;
  useEffect(() => {
    if ((!dirty && !application.uncertain) || application.saved) return;
    const warn = (event: globalThis.BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, application.uncertain, application.saved]);
  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => {
      const selector = discard || removeId ? '[data-closed-safe]' : workflow.error || application.error ? '[data-closed-feedback]' : null;
      if (selector) content.current?.closest('dialog')?.querySelector<globalThis.HTMLElement>(selector)?.focus();
    }); return () => globalThis.cancelAnimationFrame(frame);
  }, [discard, removeId, workflow.error, application.error]);
  function changePeriod(id: string, patch: Partial<ClosedPeriodDraft>) {
    if (applying || application.blocked() || paused.current || workflow.busy || discard || removeId || !open) return;
    workflow.invalidate(); setErrors({});
    setDrafts((current) => current.map((period) => period.periodId === id ? { ...period, ...patch, confirmed: patch.confirmed ?? false, acknowledgedWarnings: patch.acknowledgedWarnings ?? [] } : period));
  }
  function update(patch: Partial<ClosedPeriodDraft>) { changePeriod(draft.periodId, patch); }
  function leave() { workflow.invalidate(); close(); }
  function requestClose() { if (application.submitting()) return; if (application.saved) { close(); return; } paused.current = true; workflow.invalidate(); if (dirty || application.uncertain) setDiscard(true); else leave(); }
  function refresh() { if (applying || application.blocked() || discard || removeId) return; workflow.invalidate(); setDrafts((current) => current.map((period) => ({ ...period, confirmed: false }))); if (offset) setOffset(0); else void query.refresh(); }
  function addPeriod() {
    if (applying || application.blocked() || workflow.busy || discard || removeId || drafts.length >= 25) return;
    const added = emptyClosedPeriod(globalThis.crypto.randomUUID()); workflow.invalidate(); setErrors({});
    setDrafts((current) => current.length < 25 ? [...current, added] : current); setActiveId(added.periodId);
  }
  function removePeriod() {
    if (!removeId || applying || application.blocked()) return;
    const remaining = drafts.filter((period) => period.periodId !== removeId); if (!remaining.length) return;
    workflow.invalidate(); setDrafts(remaining); setSelectedByPeriod((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== removeId)));
    setActiveId(remaining[0].periodId); setErrors({}); setRemoveId(null); paused.current = false;
  }
  function choose(side: 'start' | 'end', id: string) {
    if (applying || application.blocked() || workflow.busy || discard || removeId) return;
    const evidence = query.data?.evidence.find((entry) => entry.id === id) ?? (selected[side]?.id === id ? selected[side] : undefined);
    if (id && !evidence) return;
    setSelectedByPeriod((current) => ({ ...current, [draft.periodId]: { ...current[draft.periodId], [side]: evidence } }));
    update(side === 'start' ? { startId: id } : { endId: id });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (discard || removeId || applying || application.blocked() || locked || workflow.busy || !open || paused.current) return;
    const validation = validateClosedPeriods(drafts); setErrors(validation);
    if (Object.keys(validation).length) {
      const firstInvalid = drafts.find((period) => validation[period.periodId]);
      if (firstInvalid) setActiveId(firstInvalid.periodId);
      globalThis.requestAnimationFrame(() => (form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]') ?? form.current?.querySelector<globalThis.HTMLElement>('[data-closed-validation]'))?.focus());
      return;
    }
    const order = drafts.map((period) => period.periodId.toLowerCase());
    const result = await workflow.generate(closedPlanInput(drafts));
    if (result) { application.reviewed(); setPlanOrder(order); setResultId(order[0]); globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLElement>('[data-closed-plan-result]')?.focus()); }
  }
  async function apply() {
    if (!open || paused.current || !applyEnabled || discard || removeId || (!application.uncertain && (!applying || confirmation !== 'APLICAR HISTORIA' || !workflow.fresh || !workflow.plan?.planValidationComplete))) return;
    const receipt = await application.save(application.uncertain ? undefined : workflow.plan!);
    if (receipt) globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLElement>('[data-closed-application-result]')?.focus());
  }
  return <Dialog open={open} onClose={requestClose} onExited={exited} className="catalog-editor-dialog import-review-dialog"
    busy={application.busy} title={application.saved ? 'Periodo histórico aplicado' : applying ? 'Aplicar historia cerrada' : 'Preparar periodo histórico cerrado'} description={applyEnabled ? "Preparar solo revisa. Aplicar guarda historia cerrada; no cambia el estado actual ni el stock." : "Preparar solo revisa; no guarda historia ni cambia el estado actual o el stock."}
    actions={discard ? <><Button key="keep-closed-period" autoFocus variant="secondary" data-closed-safe onClick={() => { paused.current = false; setDiscard(false); }}>Seguir revisando</Button><Button variant={application.uncertain ? 'danger' : 'primary'} onClick={leave}>{application.uncertain ? 'Cerrar sin resolver el intento' : 'Descartar borrador y cerrar'}</Button></> : application.saved ? <Button variant="secondary" onClick={requestClose}>Cerrar</Button> : applying || application.uncertain ? <><Button key="back-to-plan" autoFocus variant="secondary" disabled={application.locked} onClick={() => { setApplying(false); setConfirmation(''); }}>Volver a revisar</Button><Button variant="danger" loading={application.busy} disabled={!application.uncertain && (confirmation !== 'APLICAR HISTORIA' || !workflow.fresh || application.needsPlan)} onClick={() => void apply()}>{application.uncertain ? 'Recuperar mismo intento' : 'Aplicar historia cerrada'}</Button></> : <><Button key="close-periods" variant="secondary" onClick={requestClose}>Cerrar</Button><Button key="generate-periods" type="submit" form="closed-period-form" loading={workflow.busy} disabled={locked}>{workflow.plan ? 'Generar nuevamente' : 'Generar plan'}</Button></>}>
    <div ref={content} className="space-y-4" aria-busy={workflow.busy}>
      <div className="inventory-asset-editor-summary"><div><strong>{asset.product.name}</strong><small className="break-words">{[asset.assetTag, asset.serialNumber].filter(Boolean).join(' · ') || 'Sin identificadores'}</small></div></div>
      {discard && <Alert variant="warning">{application.uncertain ? 'La aplicación pudo completarse. Cerrar no revierte el servidor y pierde la intención en memoria. Conserva la clave mostrada y consulta los comprobantes de este activo antes de preparar otro intento.' : 'Se perderá este borrador sin guardar. La preparación no creó historia permanente.'}</Alert>}
      <div data-closed-feedback tabIndex={-1} className="space-y-3">{workflow.error && <Alert variant="danger">{workflow.error}</Alert>}{application.error && <Alert variant="danger">{application.error}</Alert>}</div>
      {application.uncertain && <Alert variant="warning"><p>Resultado sin confirmar. Los datos quedan bloqueados: recupera exactamente la misma intención; no generes otra clave ni vuelvas a asignar/devolver.</p><p className="break-words">Clave de recuperación: {application.requestId}</p></Alert>}
      {application.needsPlan && <Alert variant="warning">Revisa la evidencia y genera un plan nuevo. La confirmación anterior no permite aplicar.</Alert>}
      <form id="closed-period-form" ref={form} className="space-y-4" noValidate onSubmit={(event) => void submit(event)}>
        <fieldset className="space-y-4 min-w-0" disabled={applying || application.locked} hidden={applying || Boolean(application.saved)}>
        <section className="space-y-3" aria-label="Periodos del conjunto">
          <div className="flex flex-wrap items-center gap-3"><Badge variant="info">{drafts.length} de 25 periodos</Badge><Button variant="secondary" size="sm" disabled={workflow.busy || discard || Boolean(removeId) || drafts.length >= 25} onClick={addPeriod}>Añadir periodo</Button><Button variant="ghost" size="sm" disabled={workflow.busy || discard || Boolean(removeId) || drafts.length <= 1} onClick={() => { paused.current = true; setRemoveId(draft.periodId); }}>Quitar este periodo</Button></div>
          {removeId && <Alert variant="warning" action={<><Button data-closed-safe variant="secondary" size="sm" onClick={() => { paused.current = false; setRemoveId(null); }}>Conservar periodo</Button><Button size="sm" onClick={removePeriod}>Quitar periodo del conjunto</Button></>}>Se quitarán este periodo y sus selecciones del borrador. Los demás periodos se conservan.</Alert>}
          <Field label="Periodo a editar" disabled={workflow.busy || discard || Boolean(removeId)}><Select searchable={drafts.length > 8} value={draft.periodId} onChange={setActiveId} options={drafts.map((period, index) => ({ value: period.periodId, label: 'Periodo ' + (index + 1) + (period.recipientName ? ' · ' + period.recipientName : ' · sin destinatario confirmado') }))} /></Field>
          {(errors.periodId || errors.acknowledgedWarnings) && <div data-closed-validation tabIndex={-1}><Alert variant="danger">{errors.periodId ?? errors.acknowledgedWarnings}</Alert></div>}
        </section>
        <section aria-label="Elegir evidencia del periodo" className="space-y-3">
          <div className="flex flex-wrap gap-3 items-center"><h3 className="font-semibold">Evidencia vinculada</h3><Button variant="secondary" size="sm" loading={query.reading} disabled={workflow.busy || discard || Boolean(removeId)} onClick={refresh}>Actualizar evidencia desde el inicio</Button></div>
          <p className="inventory-metadata-hint">Elige una fila para el inicio y otra para el cierre. No se emparejan automáticamente. Puedes elegirlas desde páginas distintas; se conservan los identificadores y la evidencia consultada.</p>
          {query.reading && <LoadingState label="Consultando evidencia vinculada…" />}
          {query.error && <Alert variant="danger" action={<Button size="sm" variant="secondary" onClick={() => void query.refresh()}>Reintentar evidencia</Button>}>{query.error}{query.data && ' Se conserva la página anterior; no se confirmó su vigencia.'}</Alert>}
          {query.data && !query.error && query.data.evidence.length === 0 && (query.data.offset ? <Alert variant="warning">Esta página ya no contiene documentos. Actualiza desde el inicio.</Alert> : <EmptyState title="Sin evidencia histórica vinculada" description="Primero debe documentarse y confirmarse el vínculo con este activo. No se crean extremos ni fechas automáticamente." />)}
          {(['start', 'end'] as const).map((side) => {
            const kinds = side === 'start' ? ['USAGE_OBSERVATION', 'LOAN_OBSERVATION'] : ['RECEIPT_OBSERVATION', 'USAGE_OBSERVATION'];
            const rows = query.data?.evidence.filter((entry) => kinds.includes(entry.kind)) ?? [];
            const rowIds = new Set(rows.map((entry) => entry.id));
            const previous = selected[side];
            const used = new Set(drafts.flatMap((period) => (['start', 'end'] as const).filter((endpoint) => period.periodId !== draft.periodId || endpoint !== side).map((endpoint) => endpoint === 'start' ? period.startId : period.endId)).filter(Boolean));
            const choices = previous && !rowIds.has(previous.id) ? [previous, ...rows] : rows;
            return <div key={side} className="inventory-metadata-section space-y-3">
              <Field label={side === 'start' ? 'Observación de inicio' : 'Observación de cierre'} required disabled={locked || workflow.busy || discard || Boolean(removeId)} error={errors[side === 'start' ? 'startId' : 'endId']} hint={!rows.length ? 'Esta página no contiene observaciones de la clase requerida. Consulta otra página.' : 'La selección no verifica por sí sola identidad, fecha ni vínculo.'}>
                <Select searchable value={side === 'start' ? draft.startId : draft.endId} onChange={(value) => choose(side, value)} options={[{ value: '', label: 'Sin seleccionar' }, ...choices.map((entry) => ({ value: entry.id, disabled: used.has(entry.id), label: `${historyKindLabels[entry.kind]} · ${entry.snapshot.original.sheet} · fila ${entry.snapshot.original.row} · ${historyDay(entry.effectiveDay)} · v${entry.evidenceVersion}${!rowIds.has(entry.id) ? ' · selección de otra página/consulta' : ''}` }))]} />
              </Field>
              {previous && <><Badge variant="neutral">Evidencia consultada · v{previous.evidenceVersion} · origen r{previous.effectiveSourceRevision}</Badge><p className="inventory-metadata-hint break-words">{previous.id}. El plan volverá a contrastar la versión y el vínculo del servidor.</p><details><summary>Revisar origen e interpretación del {side === 'start' ? 'inicio' : 'cierre'}</summary><HistoryEvidenceDetails observation={previous.snapshot} current /></details></>}
            </div>;
          })}
          {query.data && query.data.total > 0 && <><p className="inventory-metadata-hint">{query.data.offset + 1}–{query.data.offset + query.data.evidence.length} de {query.data.total} documentos · orden por captura, no por fecha histórica.</p><Pagination page={Math.floor(query.data.offset / 25) + 1} pageCount={Math.ceil(query.data.total / 25)} loading={locked || workflow.busy || discard || Boolean(removeId)} onPageChange={(page) => setOffset((page - 1) * 25)} /></>}
        </section>
        <section className="space-y-3" aria-label="Confirmar periodo cerrado">
          <h3 className="font-semibold">Datos históricos contrastados</h3>
          <p className="inventory-metadata-hint">Un día indicado no acredita una hora. Ingresa el instante exacto y su respaldo, con zona explícita. No se deduce del año de la hoja. Dejar datos sin confirmar permite consultar los bloqueos, no completar el plan.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
            {(['start', 'end'] as const).map((side) => <ClosedEndpointFields key={side} side={side} draft={draft} errors={errors} disabled={workflow.busy || discard} update={update} />)}
            <Field label="Tipo de destinatario" disabled={workflow.busy || discard} error={errors.recipientType}><Select value={draft.recipientType} onChange={(value) => update({ recipientType: value as ClosedPeriodDraft['recipientType'] })} options={[{ value: '', label: 'Sin confirmar' }, { value: 'PERSON', label: 'Persona' }, { value: 'OFFICE', label: 'Oficina' }]} /></Field>
            <Field label="Destinatario histórico" disabled={workflow.busy || discard} error={errors.recipientName} hint="No crea cuentas de usuario ni utiliza al revisor como destinatario."><input type="text" autoComplete="off" value={draft.recipientName} maxLength={draft.recipientType === 'PERSON' ? 150 : 160} onChange={(event) => update({ recipientName: event.target.value })} /></Field>
            <Field label="Tipo de entrega histórica" required disabled={workflow.busy || discard} error={errors.assignmentType}><Select value={draft.assignmentType} onChange={(value) => update({ assignmentType: value as ClosedPeriodDraft['assignmentType'] })} options={[{ value: '', label: 'Seleccionar tipo' }, { value: 'STANDARD', label: 'Entrega estándar' }, { value: 'LOAN', label: 'Préstamo' }]} /></Field>
            <Field label="Estado al devolver" disabled={workflow.busy || discard} hint="Estado histórico de cierre; no es el estado actual del equipo."><Select value={draft.returnStatus} onChange={(value) => update({ returnStatus: value as ClosedPeriodDraft['returnStatus'] })} options={[{ value: '', label: 'Sin confirmar' }, { value: 'AVAILABLE', label: 'Disponible' }, { value: 'UNDER_REVIEW', label: 'En revisión' }, { value: 'IN_REPAIR', label: 'En reparación' }]} /></Field>
          </div>
          <Field label="Motivo de la verificación" required disabled={workflow.busy || discard} error={errors.note}><textarea rows={3} className="resize-none" value={draft.note} maxLength={2000} onChange={(event) => update({ note: event.target.value })} /></Field>
          <Field label="Respaldo del periodo cerrado" required disabled={workflow.busy || discard} error={errors.reference}><input type="text" autoComplete="off" value={draft.reference} maxLength={500} onChange={(event) => update({ reference: event.target.value })} /></Field>
          <Field label="Alcance de la preparación" required disabled={workflow.busy || discard} error={errors.confirmed}><Select value={draft.confirmed ? 'verified' : ''} onChange={(value) => update({ confirmed: value === 'verified', acknowledgedWarnings: draft.acknowledgedWarnings })} options={[{ value: '', label: 'Sin confirmar' }, { value: 'verified', label: 'Revisé un periodo cerrado. Preparar sin guardar ni cambiar inventario.' }]} /></Field>
        </section>
        </fieldset>
      </form>
      {workflow.busy && <LoadingState label="Contrastando el periodo cerrado con el servidor…" />}
      {workflow.plan && resultPeriod && !applying && !application.saved && <section className="space-y-4" aria-label="Resultado del conjunto de periodos"><div className="import-review-summary"><Badge variant="info">{workflow.plan.summary.periodCount} periodos</Badge><Badge variant="danger">{workflow.plan.summary.blockingCount} bloqueos</Badge><Badge variant="warning">{workflow.plan.summary.warningCount} advertencias</Badge></div><Field label="Periodo del último plan" disabled={workflow.busy || discard || application.locked || Boolean(removeId)}><Select searchable={workflow.plan.periods.length > 8} value={resultPeriod.periodId} onChange={setResultId} options={[...workflow.plan.periods].sort((a, b) => planOrder.indexOf(a.periodId) - planOrder.indexOf(b.periodId)).map((period) => ({ value: period.periodId, label: 'Periodo ' + (planOrder.indexOf(period.periodId) + 1) + ' · ' + (period.valid ? 'Completo' : period.blockers.length + ' bloqueos') }))} /></Field><ClosedAssignmentPlanDetails plan={workflow.plan} periodId={resultPeriod.periodId} fresh={workflow.fresh} recognized={resultDraft?.acknowledgedWarnings ?? []} disabled={workflow.busy || discard || application.locked || Boolean(removeId) || !resultDraft} recognize={(ids) => changePeriod(resultPeriod.periodId, { acknowledgedWarnings: ids })} /></section>}
      {applyEnabled && workflow.plan?.planValidationComplete && workflow.fresh && !application.locked && !applying && !discard && !removeId && !application.needsPlan && <Button variant="secondary" onClick={() => { setApplying(true); setConfirmation(''); }}>Revisar aplicación permanente</Button>}
      {applying && !application.saved && <section aria-label="Confirmación independiente de aplicación" className="space-y-4">
        {workflow.plan && <DataTable className="catalog-data-table" rows={[...workflow.plan.periods].sort((a, b) => planOrder.indexOf(a.periodId) - planOrder.indexOf(b.periodId))} getRowKey={(period) => period.periodId} caption="Periodos que se aplicarán juntos" columns={[
          { key: 'recipient', header: 'Periodo y destinatario histórico', mobileRole: 'identity', render: (period) => <strong className="min-w-0 w-full break-words">Periodo {planOrder.indexOf(period.periodId) + 1} · {period.proposedAssignment.personName ?? period.proposedAssignment.officeName}</strong> },
          { key: 'time', header: 'Inicio y cierre · hora de Chile', mobileRole: 'full', render: (period) => <span className="min-w-0 w-full break-words">{formatInventoryDateTime(period.proposedAssignment.startedAt!)} → {formatInventoryDateTime(period.proposedAssignment.endedAt!)}</span> },
          { key: 'return', header: 'Devolución histórica', mobileRole: 'full', render: (period) => assetStatusLabels[period.proposedAssignment.returnStatus!] }
        ]} />}
        <Alert variant="warning">Se guardarán juntos {workflow.plan?.periods.length} periodos cerrados de este activo y se reservarán todas sus evidencias. La operación es atómica: si un periodo falla, no se aplica ninguno. No cambia el estado actual ni cierra una entrega vigente.</Alert>
        <Field label="Confirmar aplicación permanente" disabled={application.locked || discard} hint="Escribe APLICAR HISTORIA. Esta confirmación no es la confirmación de preparación."><input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>
      </section>}
      {application.saved && <ClosedApplicationDetails application={application.saved} />}
    </div>
  </Dialog>;
}

function ClosedEndpointFields({ side, draft, errors, disabled, update }: {
  side: 'start' | 'end'; draft: ClosedPeriodDraft; errors: ReturnType<typeof validateClosedPeriod>; disabled: boolean; update: (patch: Partial<ClosedPeriodDraft>) => void;
}) {
  const instant = side === 'start' ? 'startAt' : 'endAt'; const proof = side === 'start' ? 'startProof' : 'endProof';
  const name = side === 'start' ? 'inicio' : 'cierre';
  return <div className="space-y-3 min-w-0">
    <Field label={`Fecha y hora exactas de ${name}`} error={errors[instant]} disabled={disabled} hint="Formato ISO: 2025-01-15T10:30:00-03:00. Zona obligatoria; no hay fecha automática."><input type="text" autoComplete="off" spellCheck={false} placeholder="AAAA-MM-DDTHH:MM:SS±HH:MM" value={draft[instant]} maxLength={35} onChange={(event) => update({ [instant]: event.target.value })} /></Field>
    <Field label={`Respaldo de la fecha de ${name}`} error={errors[proof]} disabled={disabled}><input type="text" autoComplete="off" value={draft[proof]} maxLength={500} onChange={(event) => update({ [proof]: event.target.value })} /></Field>
  </div>;
}
