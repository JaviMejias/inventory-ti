import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Dialog, EmptyState, Field, LoadingState, Pagination, Select } from '../../ui';
import { formatInventoryDateTime } from '../../lib/date-range';
import { readAssetImportedEvidence } from './history-evidence-api';
import type { AssetHistoryEvidence } from './history-evidence-model';
import { HistoryEvidenceDetails } from './HistoryEvidenceDetails';
import { emptyRetirementDraft, retirementPlanInput, validateRetirementDraft, type RetirementDraft } from './retirement-plan-model';
import { RetirementPlanDetails } from './RetirementPlanDetails';
import { useHistoryRead } from './useHistoryRead';
import { useRetirementPlan } from './useRetirementPlan';
import { useRetirementApplication } from './useRetirementApplication';
import { RetirementApplicationDetails } from './RetirementApplicationDetails';
import type { RetirementApplication } from './retirement-application-model';

export function RetirementPlanDialog({ asset, open, close, exited, actorId, applyEnabled = false, onApplied, initialEvidence }: {
  asset: { id: string; assetTag: string | null; serialNumber: string | null; product: { name: string } };
  open: boolean; close: () => void; exited: () => void; actorId: string; applyEnabled?: boolean; onApplied: (receipt: RetirementApplication) => void;
  initialEvidence?: AssetHistoryEvidence;
}) {
  const [draft, setDraft] = useState(() => ({ ...emptyRetirementDraft(), evidenceId: initialEvidence?.id ?? '' }));
  const [selected, setSelected] = useState<AssetHistoryEvidence | null>(initialEvidence ?? null);
  const [offset, setOffset] = useState(0);
  const [errors, setErrors] = useState<ReturnType<typeof validateRetirementDraft>>({});
  const [discard, setDiscard] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const form = useRef<globalThis.HTMLFormElement>(null);
  const feedback = useRef<globalThis.HTMLDivElement>(null);
  const returnFocus = useRef<globalThis.HTMLElement | null>(null);
  const workflow = useRetirementPlan(asset.id);
  const application = useRetirementApplication(asset.id, actorId);
  const read = useCallback((signal: globalThis.AbortSignal) => readAssetImportedEvidence(asset.id, offset, signal), [asset.id, offset]);
  const query = useHistoryRead(read, 'No se pudo consultar la evidencia de la baja.');
  const dirty = Object.values(draft).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
  const locked = query.reading || Boolean(query.error) || query.data?.offset !== offset;
  const rows = query.data?.evidence.filter((entry) => entry.kind === 'RETIREMENT_OBSERVATION') ?? [];
  const rowIds = new Set(rows.map((entry) => entry.id));
  const choices = selected && !rowIds.has(selected.id) ? [selected, ...rows] : rows;
  useEffect(() => {
    if ((!dirty && !application.uncertain) || application.saved) return;
    const warn = (event: globalThis.BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, application.uncertain, application.saved]);
  useEffect(() => {
    if (!query.error && !workflow.error && !application.error) return;
    const frame = globalThis.requestAnimationFrame(() => feedback.current?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [query.error, workflow.error, application.error]);
  useEffect(() => {
    if (!applying && !discard && !returnFocus.current) return;
    const frame = globalThis.requestAnimationFrame(() => {
      if (applying || discard) {
        const dialog = form.current?.closest('dialog');
        const body = dialog?.querySelector<globalThis.HTMLElement>('.ui-dialog-body');
        if (body) body.scrollTop = 0;
        dialog?.querySelector<globalThis.HTMLElement>('[data-retirement-safe-action]')?.focus({ preventScroll: true });
        return;
      }
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target?.isConnected) target.focus();
      else {
        const content = form.current?.parentElement;
        const fallback = content?.querySelector<globalThis.HTMLElement>('[data-retirement-application-trigger]') ?? content?.querySelector<globalThis.HTMLElement>('[data-retirement-plan-result], input:not(:disabled), textarea:not(:disabled)');
        fallback?.focus();
      }
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [applying, discard]);
  useEffect(() => {
    if (!application.saved) return;
    const frame = globalThis.requestAnimationFrame(() => {
      const body = form.current?.closest('dialog')?.querySelector<globalThis.HTMLElement>('.ui-dialog-body');
      if (body) body.scrollTop = 0;
      form.current?.parentElement?.querySelector<globalThis.HTMLElement>('[data-retirement-application-result]')?.focus({ preventScroll: true });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [application.saved]);
  function update(patch: Partial<RetirementDraft>) {
    if (!open || discard || workflow.busy || applying || application.blocked()) return;
    workflow.invalidate(); setErrors({});
    setDraft((current) => ({ ...current, ...patch, confirmed: patch.confirmed ?? false, acknowledgedWarnings: patch.acknowledgedWarnings ?? [] }));
  }
  function requestClose() {
    if (application.submitting()) return;
    if (application.saved) { close(); return; }
    workflow.invalidate();
    if (dirty || application.uncertain) {
      returnFocus.current = globalThis.document.activeElement instanceof globalThis.HTMLElement ? globalThis.document.activeElement : null;
      setDiscard(true);
    } else close();
  }
  function refresh() {
    if (workflow.busy || discard || applying || application.blocked()) return;
    workflow.invalidate(); setDraft((current) => ({ ...current, confirmed: false }));
    if (offset) setOffset(0); else void query.refresh();
  }
  function choose(id: string) {
    if (locked || workflow.busy || discard || applying || application.blocked()) return;
    const evidence = choices.find((entry) => entry.id === id);
    if (id && !evidence) return;
    setSelected(evidence ?? null); update({ evidenceId: id });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!open || locked || workflow.busy || discard || applying || application.blocked()) return;
    const validation = validateRetirementDraft(draft); setErrors(validation);
    if (Object.keys(validation).length) {
      globalThis.requestAnimationFrame(() => form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]')?.focus()); return;
    }
    const result = await workflow.generate(retirementPlanInput(draft));
    if (result) { application.reviewed(); globalThis.requestAnimationFrame(() => form.current?.parentElement?.querySelector<globalThis.HTMLElement>('[data-retirement-plan-result]')?.focus()); }
  }
  async function apply() {
    if (!open || !applyEnabled || discard || (!application.uncertain && (!applying || confirmation !== 'DAR DE BAJA' || !workflow.fresh || !workflow.plan?.planValidationComplete || application.needsPlan))) return;
    const receipt = await application.save(application.uncertain ? undefined : workflow.plan!);
    if (receipt) onApplied(receipt);
  }
  function backToPlan() {
    if (application.blocked()) return;
    setApplying(false); setConfirmation('');
    if (application.needsPlan) workflow.invalidate();
  }
  return <Dialog open={open} onClose={requestClose} onExited={exited} className="catalog-editor-dialog import-review-dialog"
    busy={application.busy} closeOnBackdrop={!applying && !application.uncertain}
    title={application.saved ? 'Baja histórica aplicada' : applying ? 'Confirmar baja histórica' : 'Preparar baja histórica'}
    description={applyEnabled ? 'Preparar no modifica datos. Aplicar retira definitivamente este activo, conservando su evidencia e historial.' : 'Revisa evidencia y bloqueos. No da de baja el activo ni modifica stock o entregas.'}
    actions={discard ? <><Button key="keep-retirement" autoFocus data-retirement-safe-action variant="secondary" onClick={() => setDiscard(false)}>Seguir revisando</Button><Button variant={application.uncertain ? 'danger' : 'primary'} onClick={() => { workflow.invalidate(); close(); }}>{application.uncertain ? 'Cerrar sin resolver el intento' : 'Descartar borrador y cerrar'}</Button></> : application.saved ? <Button variant="secondary" onClick={requestClose}>Cerrar comprobante</Button> : applying || application.uncertain ? <><Button key="back-retirement" autoFocus data-retirement-safe-action variant="secondary" disabled={application.locked} onClick={backToPlan}>Volver a revisar</Button><Button variant="danger" loading={application.busy} disabled={discard || !applyEnabled || (!application.uncertain && (confirmation !== 'DAR DE BAJA' || !workflow.fresh || application.needsPlan))} onClick={() => void apply()}>{application.uncertain ? 'Recuperar mismo intento' : 'Aplicar baja histórica'}</Button></> : <><Button variant="secondary" onClick={requestClose}>Cerrar</Button><Button type="submit" form="retirement-plan-form" loading={workflow.busy} disabled={locked}>{workflow.plan ? 'Generar nuevamente' : 'Generar plan'}</Button></>}>
    <div className="space-y-4" aria-busy={workflow.busy}>
      <div className="inventory-asset-editor-summary"><div><strong>{asset.product.name}</strong><small className="break-words">{[asset.assetTag, asset.serialNumber].filter(Boolean).join(' · ') || 'Sin identificadores'}</small></div></div>
      {discard && <Alert variant="warning">{application.uncertain ? 'La baja pudo haberse aplicado. Cerrar no revierte el servidor y pierde la intención en memoria. Conserva la clave mostrada y consulta los comprobantes de este activo antes de preparar otro intento.' : 'Se perderá el borrador. Preparar no creó una baja ni historia permanente.'}</Alert>}
      <div ref={feedback} tabIndex={-1} className="space-y-3">
        {workflow.error && <Alert variant="danger">{workflow.error}</Alert>}
        {application.error && <Alert variant="danger">{application.error}</Alert>}
        {application.uncertain && <Alert variant="warning"><p>Resultado sin confirmar. Recupera el mismo intento: no cambies el plan ni generes otra clave.</p><p className="break-words">Clave de recuperación: {application.requestId}</p></Alert>}
        {application.needsPlan && <Alert variant="warning">La baja no fue confirmada. Actualiza la evidencia, genera un plan nuevo y vuelve a confirmar antes de aplicar.</Alert>}
        {query.error && <Alert variant="danger" action={<Button size="sm" variant="secondary" disabled={discard} onClick={() => void query.refresh()}>Reintentar evidencia</Button>}>{query.error}{query.data && ' Se conserva la página anterior; no se confirmó su vigencia.'}</Alert>}
      </div>
      <form id="retirement-plan-form" ref={form} className="space-y-4" noValidate onSubmit={(event) => void submit(event)}>
        <fieldset className="space-y-4 min-w-0" disabled={workflow.busy || discard || applying || application.locked} hidden={applying || Boolean(application.saved)}>
          <section aria-label="Elegir evidencia de baja" className="space-y-3">
            <div className="flex flex-wrap gap-3 items-center"><h3 className="font-semibold">Evidencia vinculada</h3><Button variant="secondary" size="sm" loading={query.reading} onClick={refresh}>Actualizar evidencia desde el inicio</Button></div>
            <p className="inventory-metadata-hint">Elige expresamente una observación de baja. No se selecciona la última fila ni se enlaza por coincidencia de texto.</p>
            {query.reading && <LoadingState label="Consultando evidencia vinculada…" />}
            {query.data && !query.error && !query.reading && query.data.evidence.length === 0 && (query.data.offset ? <Alert variant="warning">Esta página ya no contiene documentos. Actualiza desde el inicio.</Alert> : <EmptyState title="Sin evidencia histórica vinculada" description="Primero debe archivarse y confirmarse el vínculo. No se crea una observación desde este modal." />)}
            <Field label="Observación de baja" required disabled={locked} error={errors.evidenceId} hint={!rows.length ? 'Esta página no contiene observaciones de baja. Consulta otra página o revisa el origen.' : 'Elegir no verifica por sí solo identidad, fecha ni vínculo.'}><Select searchable value={draft.evidenceId} onChange={choose} options={[{ value: '', label: 'Sin seleccionar' }, ...choices.map((entry) => ({ value: entry.id, label: `Baja indicada · ${entry.snapshot.original.sheet} · fila ${entry.snapshot.original.row} · v${entry.evidenceVersion}${!rowIds.has(entry.id) ? ' · otra página/consulta' : ''}` }))]} /></Field>
            {selected && <><Badge variant="neutral">Evidencia consultada · v{selected.evidenceVersion} · origen r{selected.effectiveSourceRevision}</Badge><p className="inventory-metadata-hint break-words">{selected.id}. El plan contrastará la versión y el vínculo actuales del servidor.</p><details><summary>Revisar origen e interpretación consultada</summary><HistoryEvidenceDetails observation={selected.snapshot} current /></details></>}
            {query.data && query.data.evidence.length > 0 && <><p className="inventory-metadata-hint">{query.data.offset + 1}–{query.data.offset + query.data.evidence.length} de {query.data.total} documentos · orden por captura, no por fecha del retiro.</p><Pagination page={Math.floor(query.data.offset / 25) + 1} pageCount={Math.ceil(query.data.total / 25)} loading={locked || workflow.busy || discard} onPageChange={(page) => setOffset((page - 1) * 25)} /></>}
          </section>
          <section aria-label="Datos históricos de retiro" className="space-y-3"><h3 className="font-semibold">Retiro contrastado</h3>
            <Alert variant="info">La recepción y el año de la hoja no prueban el retiro. Si no conoces fecha, hora o zona, deja el instante vacío: el servidor mostrará el faltante. No se completa con hoy ni medianoche.</Alert>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
              <Field label="Fecha y hora exactas del retiro" error={errors.confirmedAt} hint="ISO con segundos y zona. Ejemplo: 2025-01-15T10:30:00-03:00. Desde 1900; sin fecha automática."><input type="text" autoComplete="off" spellCheck={false} placeholder="AAAA-MM-DDTHH:MM:SS±HH:MM" maxLength={35} value={draft.confirmedAt} onChange={(event) => update({ confirmedAt: event.target.value })} /></Field>
              <Field label="Respaldo del instante exacto" error={errors.dateEvidenceReference}><input type="text" autoComplete="off" maxLength={500} value={draft.dateEvidenceReference} onChange={(event) => update({ dateEvidenceReference: event.target.value })} /></Field>
            </div>
            <Field label="Motivo de la verificación" required error={errors.note}><textarea rows={3} className="resize-none" maxLength={2000} value={draft.note} onChange={(event) => update({ note: event.target.value })} /></Field>
            <Field label="Respaldo de la baja" required error={errors.reference}><input type="text" autoComplete="off" maxLength={500} value={draft.reference} onChange={(event) => update({ reference: event.target.value })} /></Field>
            <Field label="Alcance de la preparación" required error={errors.confirmed}><Select value={draft.confirmed ? 'verified' : ''} onChange={(value) => update({ confirmed: value === 'verified', acknowledgedWarnings: draft.acknowledgedWarnings })} options={[{ value: '', label: 'Sin confirmar' }, { value: 'verified', label: 'Revisé la evidencia de retiro. Preparar sin aplicar la baja.' }]} /></Field>
            {errors.acknowledgedWarnings && <Alert variant="danger">{errors.acknowledgedWarnings}</Alert>}
          </section>
        </fieldset>
      </form>
      {workflow.busy && <LoadingState label="Contrastando la baja histórica con el servidor…" />}
      {workflow.plan && !applying && !application.saved && <RetirementPlanDetails key={workflow.plan.planId} plan={workflow.plan} fresh={workflow.fresh} recognized={draft.acknowledgedWarnings} disabled={workflow.busy || discard || application.locked} recognize={(ids) => update({ acknowledgedWarnings: ids })} />}
      {applyEnabled && workflow.plan?.planValidationComplete && workflow.fresh && !application.blocked() && !applying && !discard && !application.needsPlan && !locked && <Button data-retirement-application-trigger variant="secondary" onClick={(event) => { returnFocus.current = event.currentTarget; setApplying(true); setConfirmation(''); }}>Revisar aplicación de baja</Button>}
      {applying && !application.saved && <section aria-label="Confirmación independiente de baja histórica" className="space-y-4">
        {workflow.plan && <dl className="inventory-metadata-detail"><div><dt>Activo</dt><dd>{asset.product.name} · {asset.assetTag ?? asset.serialNumber ?? 'Sin identificador'}</dd></div><div><dt>Fecha histórica verificada · hora de Chile</dt><dd>{formatInventoryDateTime(workflow.plan.proposedRetirement.decommissionedAt!)}</dd></div><div><dt>Fecha y zona ingresadas</dt><dd className="break-words">{workflow.plan.request.confirmedAt}</dd></div><div><dt>Efecto definitivo</dt><dd>Dado de baja · inactivo · no podrá asignarse ni reactivarse</dd></div></dl>}
        <Alert variant="warning">Se retirará definitivamente este activo con la fecha histórica verificada. La evidencia quedará utilizada y el comprobante no podrá editarse ni eliminarse. No se cerrarán entregas ni cambiará el stock por cantidad.</Alert>
        <Field label="Confirmar retiro definitivo" disabled={application.locked || discard} hint="Escribe DAR DE BAJA. Esta confirmación es independiente de la preparación."><input type="text" autoComplete="off" spellCheck={false} maxLength={30} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>
      </section>}
      {application.saved && <RetirementApplicationDetails application={application.saved} />}
    </div>
  </Dialog>;
}
