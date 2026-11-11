import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Dialog, Field, LoadingState, Select } from '../../ui';
import type { Candidate, ImportPreview } from './import-review-model';
import { emptyIdentityGroupsDraft, identityGroupInput, identityGroupScope, newIdentityGroup, validateIdentityGroupScope, validateIdentityGroupsDraft, type IdentityGroupDraft, type IdentityGroupsDraft } from './identity-group-model';
import { IdentityGroupEditor } from './IdentityGroupEditor';
import { IdentityGroupPlanDetails } from './IdentityGroupPlanDetails';
import { IdentityGroupScopePicker } from './IdentityGroupScopePicker';
import { useIdentityGroupPlan } from './useIdentityGroupPlan';
import { environment } from '../../config/environment';
import { useAuth } from '../auth/auth-context';
import { IdentityGroupReviewDetails } from './IdentityGroupReviewDetails';
import { useIdentityGroupReviewMutation } from './useIdentityGroupReviewMutation';

export function IdentityGroupPlanDialog({ batchId, original, open, close, exited }: { batchId: string; original: ImportPreview; open: boolean; close: () => void; exited: () => void }) {
  const workflow = useIdentityGroupPlan(batchId, original);
  const { user } = useAuth();
  const mutation = useIdentityGroupReviewMutation(batchId, user?.id ?? '', original);
  const [reservation, setReservation] = useState(false);
  const [reservationConfirmation, setReservationConfirmation] = useState('');
  const [reservationInvalid, setReservationInvalid] = useState(false);
  const [draft, setDraft] = useState(emptyIdentityGroupsDraft);
  const [stage, setStage] = useState<'scope' | 'groups'>('scope');
  const [review, setReview] = useState(false);
  const [planGroupOrder, setPlanGroupOrder] = useState<string[]>([]);
  const [discard, setDiscard] = useState(false);
  const [changingScope, setChangingScope] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const form = useRef<globalThis.HTMLFormElement>(null);
  const content = useRef<globalThis.HTMLDivElement>(null);
  const feedback = useRef<globalThis.HTMLDivElement>(null);
  const returnFocus = useRef<globalThis.HTMLElement | null>(null);
  const paused = useRef(false);
  const scope = useMemo(() => identityGroupScope(original, draft.candidateIds), [original, draft.candidateIds]);
  const dirty = Boolean(draft.candidateIds.length || draft.groups.length || draft.note);
  const disabled = workflow.busy || workflow.reading || discard || changingScope || reservation || mutation.locked;
  useEffect(() => {
    if (!dirty || mutation.saved) return;
    const warn = (event: globalThis.BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, mutation.saved]);
  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => {
      const selector = mutation.error ? '[data-group-reservation-error]' : mutation.saved ? '[data-group-review-receipt]' : reservation ? '[data-group-reservation-back]' : null;
      const target = selector ? content.current?.closest('dialog')?.querySelector<globalThis.HTMLElement>(selector) : null;
      target?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); target?.focus();
    }); return () => globalThis.cancelAnimationFrame(frame);
  }, [reservation, mutation.error, mutation.saved]);
  useEffect(() => {
    if (!open || !workflow.readError && !workflow.error) return;
    const frame = globalThis.requestAnimationFrame(() => feedback.current?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [open, workflow.readError, workflow.error]);
  useEffect(() => {
    if (!discard && !changingScope && !returnFocus.current) return;
    const frame = globalThis.requestAnimationFrame(() => {
      if (discard || changingScope) { content.current?.closest('dialog')?.querySelector<globalThis.HTMLElement>('[data-identity-group-safe]')?.focus(); return; }
      const target = returnFocus.current; returnFocus.current = null;
      if (target?.isConnected) target.focus();
      else (content.current?.querySelector<globalThis.HTMLElement>('[data-identity-group-result]') ?? form.current?.querySelector<globalThis.HTMLElement>('input:not(:disabled), button:not(:disabled), textarea:not(:disabled)'))?.focus();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [discard, changingScope]);
  function rememberFocus() { returnFocus.current = globalThis.document.activeElement instanceof globalThis.HTMLElement ? globalThis.document.activeElement : null; }
  function update(change: (value: IdentityGroupsDraft) => IdentityGroupsDraft, confirm = false) {
    if (!open || disabled || paused.current) return;
    workflow.invalidate(); setErrors({});
    setDraft((current) => ({ ...change(current), confirmed: confirm }));
  }
  function toggle(candidate: Candidate) {
    if (stage !== 'scope') return;
    update((current) => ({ ...current, candidateIds: current.candidateIds.includes(candidate.id) ? current.candidateIds.filter((id) => id !== candidate.id) : [...current.candidateIds, candidate.id] }));
  }
  function validationFocus() {
    globalThis.requestAnimationFrame(() => {
      const target = form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"], [role="alert"]') ?? content.current?.querySelector<globalThis.HTMLElement>('[data-identity-group-validation]');
      if (target?.getAttribute('role') === 'alert') target.tabIndex = -1;
      target?.focus();
    });
  }
  function continueScope() {
    if (!open || disabled || paused.current || !workflow.contextFresh) return;
    const error = validateIdentityGroupScope(original, draft.candidateIds);
    if (error) { setErrors({ scope: error }); validationFocus(); return; }
    setErrors({}); setStage('groups');
    globalThis.requestAnimationFrame(() => form.current?.querySelector<globalThis.HTMLElement>('[data-identity-group-editor]')?.focus());
  }
  function changeGroup(id: string, patch: Partial<IdentityGroupDraft>) { update((current) => ({ ...current, groups: current.groups.map((group) => group.groupId === id ? { ...group, ...patch } : group) })); }
  function removeGroup(id: string) { update((current) => ({ ...current, groups: current.groups.filter((group) => group.groupId !== id), assignments: Object.fromEntries(Object.entries(current.assignments).filter(([, groupId]) => groupId !== id)) })); }
  function requestClose() {
    if (mutation.submitting()) return;
    if (mutation.saved) { close(); return; }
    paused.current = true; workflow.cancel(); setChangingScope(false);
    if (dirty) { rememberFocus(); setDiscard(true); } else close();
  }
  function edit() { if (paused.current) return; setReview(false); globalThis.requestAnimationFrame(() => form.current?.querySelector<globalThis.HTMLElement>('[data-identity-group-editor]')?.focus()); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!open || disabled || paused.current || !workflow.contextFresh || !workflow.context || stage !== 'groups' || review) return;
    const validation = validateIdentityGroupsDraft(original, draft); setErrors(validation);
    if (Object.keys(validation).length) { validationFocus(); return; }
    const input = identityGroupInput(original, draft, workflow.context.batchVersion, workflow.context.sourceContext.revision);
    const order = draft.groups.map((group) => group.groupId.toLowerCase());
    const result = await workflow.generate(input);
    if (result) {
      mutation.reviewed(); setReservation(false); setReservationConfirmation(''); setPlanGroupOrder(order); setReview(true);
      globalThis.requestAnimationFrame(() => { const heading = content.current?.querySelector<globalThis.HTMLElement>('[data-identity-group-result]'); heading?.scrollIntoView({ block: 'start', behavior: 'instant' }); heading?.focus({ preventScroll: true }); });
    }
  }
  function prepareReservation() {
    if (!environment.inventoryImportIdentityGroupReviewsV17 || !workflow.fresh || !workflow.contextFresh || !workflow.plan?.proposalValidationComplete || workflow.plan.blockers.length || mutation.blocked() || mutation.needsReview || paused.current) return;
    setReservation(true); setReservationConfirmation(''); setReservationInvalid(false);
  }
  async function reserve(event: FormEvent) {
    event.preventDefault();
    if (!open || paused.current || discard || mutation.submitting() || !environment.inventoryImportIdentityGroupReviewsV17 || !reservation) return;
    if (mutation.uncertain) { await mutation.recover(); return; }
    if (!workflow.fresh || !workflow.contextFresh || !workflow.plan || mutation.blocked() || mutation.needsReview) return;
    if (reservationConfirmation !== 'RESERVAR') { setReservationInvalid(true); globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLElement>('[data-group-reservation-form] [aria-invalid="true"]')?.focus()); return; }
    await mutation.reserve(workflow.plan);
  }
  function reservationActions() {
    if (mutation.saved) return <Button key="close-reserved" variant="secondary" onClick={requestClose}>Cerrar</Button>;
    if (discard) return <><Button key="keep-group-draft" variant="secondary" autoFocus data-identity-group-safe onClick={() => { paused.current = false; setDiscard(false); }}>Seguir editando</Button><Button key="discard-identity-group" type="button" onClick={(event) => { event.preventDefault(); close(); }}>Descartar propuesta y cerrar</Button></>;
    if (reservation) return <><Button key="back-reservation" type="button" data-group-reservation-back variant="secondary" disabled={mutation.locked} onClick={(event) => { event.preventDefault(); setReservation(false); setReservationConfirmation(''); globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLElement>('[data-identity-group-result]')?.focus()); }}>Volver a revisar</Button><Button key="close-reservation" variant="secondary" disabled={mutation.busy} onClick={requestClose}>Cerrar</Button><Button key={mutation.uncertain ? 'recover-reservation' : 'submit-reservation'} type="submit" form="group-reservation-form" loading={mutation.busy} disabled={mutation.needsReview}>{mutation.uncertain ? 'Recuperar mismo intento' : 'Reservar revisión'}</Button></>;
    return <><Button key="close-identity-group" type="button" variant="secondary" onClick={requestClose}>Cerrar</Button>{review ? <><Button key="edit-identity-group" type="button" variant="secondary" disabled={changingScope} onClick={(event) => { event.preventDefault(); edit(); }}>Editar propuesta</Button>{environment.inventoryImportIdentityGroupReviewsV17 && workflow.fresh && workflow.contextFresh && workflow.plan?.proposalValidationComplete && !workflow.plan.blockers.length && <Button key="prepare-reservation" type="button" disabled={changingScope || mutation.needsReview} onClick={(event) => { event.preventDefault(); prepareReservation(); }}>Revisar reserva</Button>}</> : stage === 'scope' ? <Button key="scope-identity-group" type="button" disabled={disabled || !workflow.contextFresh} onClick={(event) => { event.preventDefault(); continueScope(); }}>Definir grupos</Button> : <Button key="simulate-identity-group" type="submit" form="identity-group-plan-form" loading={workflow.busy} disabled={disabled || !workflow.contextFresh}>Simular agrupación</Button>}</>;
  }
  return <Dialog className="catalog-editor-dialog import-review-dialog" open={open} busy={mutation.busy} onClose={requestClose} onExited={exited} title={mutation.saved ? 'Revisión de agrupación' : reservation ? 'Reservar revisión de agrupación' : 'Simular agrupación física'} description={reservation || mutation.saved ? 'Reserva administrativa y procedencia; el inventario no cambia.' : 'Revisa la pertenencia de filas e identidades sin modificar el lote o el inventario.'} actions={reservationActions()}>
    <div ref={content} className="space-y-4">
      {discard && <Alert variant="warning">{mutation.uncertain ? 'Se perderá la clave de recuperación en memoria. Salir no revierte ni confirma la reserva en el servidor; consulta las revisiones al volver.' : 'Se perderán la selección, los grupos y el motivo de esta propuesta. La simulación no guardó cambios en el servidor.'}</Alert>}
      <div className="space-y-4" hidden={reservation || Boolean(mutation.saved)}>
      <div className="inventory-asset-editor-summary"><div><strong className="break-words">{original.source.fileName}</strong><small>Propuesta temporal · máximo 25 observaciones completas</small></div></div>
      {workflow.context && <div className="import-review-summary"><Badge variant="neutral">Lote v{workflow.context.batchVersion}</Badge><Badge variant="info">Origen r{workflow.context.sourceContext.revision}</Badge><Badge variant="neutral">Sin cambios de inventario</Badge></div>}
      <div ref={feedback} tabIndex={-1} className="space-y-3">
        {workflow.readError && <Alert variant="danger">{workflow.readError}</Alert>}{workflow.error && <Alert variant="danger">{workflow.error}</Alert>}
        {!workflow.contextFresh && !workflow.reading && <Alert variant="warning">Actualiza el contexto y revisa el borrador antes de simular. El resultado anterior no acredita vigencia.</Alert>}
        {errors.scope && <div tabIndex={-1} data-identity-group-validation><Alert variant="danger">{errors.scope}</Alert></div>}
      </div>
      <Button variant="secondary" size="sm" loading={workflow.reading} disabled={discard || changingScope || workflow.busy} onClick={() => { workflow.invalidate(); setDraft((current) => ({ ...current, confirmed: false })); void workflow.refresh(); }}>Actualizar contexto de agrupación</Button>
      {workflow.reading && <LoadingState label="Consultando lote y origen vigente…" />}
      {changingScope && <Alert variant="warning" action={<><Button variant="secondary" size="sm" data-identity-group-safe onClick={() => { paused.current = false; setChangingScope(false); }}>Conservar grupos</Button><Button size="sm" onClick={() => { workflow.invalidate(); setDraft((current) => ({ ...current, groups: [], assignments: {}, confirmed: false })); setErrors({}); paused.current = false; setChangingScope(false); setStage('scope'); }}>Descartar grupos y cambiar alcance</Button></>}>Cambiar el alcance descartará los grupos y su reparto. El motivo se conserva para que puedas revisarlo.</Alert>}
      <div hidden={review}>
        {stage === 'scope' && <IdentityGroupScopePicker original={original} selected={draft.candidateIds} disabled={disabled} toggle={toggle} />}
        <form id="identity-group-plan-form" ref={form} className="space-y-4" noValidate onSubmit={(event) => void submit(event)} hidden={stage !== 'groups'}>
          <div className="flex flex-wrap items-center gap-3"><h3 className="font-semibold" tabIndex={-1} data-identity-group-editor>Propuesta · {scope.records.length} filas seleccionadas</h3><Button variant="ghost" size="sm" disabled={disabled} onClick={() => { paused.current = true; rememberFocus(); setChangingScope(true); }}>Cambiar alcance</Button>{workflow.plan && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setReview(true)}>Ver último resultado</Button>}</div>
          <IdentityGroupEditor scope={scope} current={workflow.context?.preview} draft={draft} disabled={disabled} errors={errors} add={() => { const id = globalThis.crypto.randomUUID(); update((current) => current.groups.length >= 25 ? current : { ...current, groups: [...current.groups, newIdentityGroup(id)] }); }} change={changeGroup} remove={removeGroup} assign={(recordId, groupId) => update((current) => ({ ...current, assignments: { ...current.assignments, [recordId]: groupId } }))} />
          <Field label="Motivo de la propuesta" required disabled={disabled} error={errors.note}><textarea rows={3} maxLength={2000} className="resize-none" value={draft.note} onChange={(event) => update((current) => ({ ...current, note: event.target.value }))} /></Field>
          <Field label="Revisión para simular" required disabled={disabled} error={errors.confirmed}><Select value={draft.confirmed ? 'reviewed' : ''} onChange={(value) => update((current) => current, value === 'reviewed')} options={[{ value: '', label: 'Sin confirmar' }, { value: 'reviewed', label: 'Revisé pertenencia e identificadores. Simular sin guardar.' }]} /></Field>
        </form>
      </div>
      {workflow.busy && <LoadingState label="Contrastando agrupación, coincidencias y antecedentes…" />}
      {review && workflow.plan && <IdentityGroupPlanDetails key={workflow.plan.planId} plan={workflow.plan} fresh={workflow.fresh} groupOrder={planGroupOrder} />}
      </div>
      <div data-group-reservation-error tabIndex={-1} className="space-y-3">{mutation.error && <Alert variant="danger">{mutation.error}</Alert>}{mutation.needsReview && <Alert variant="warning">Vuelve a revisar, actualiza el contexto y genera otro escenario antes de reservar.</Alert>}</div>
      {reservation && !mutation.saved && <form id="group-reservation-form" data-group-reservation-form noValidate onSubmit={(event) => void reserve(event)} className="space-y-4"><h3 className="font-semibold">Confirma la reserva</h3><p>{scope.records.length} filas · {draft.groups.length} grupos · lote v{workflow.plan?.batchVersion} · origen r{workflow.plan?.sourceRevision}</p><Alert variant="warning">Estas filas quedarán reservadas, incluso en otros lotes del mismo archivo. Se bloquearán los flujos anteriores que intenten utilizarlas. No se crean activos ni cambia el stock.</Alert><p>La reserva conserva el escenario y su procedencia. Abandonarla requiere registrar una cancelación con motivo; no se borra el comprobante.</p>{mutation.uncertain && <Alert variant="warning">No se pudo confirmar la reserva. Recupera exactamente el mismo intento; no edites la propuesta ni prepares otra clave.</Alert>}<Field label="Escribe RESERVAR" required disabled={mutation.locked || discard} error={reservationInvalid ? 'Escribe RESERVAR para confirmar la reserva.' : undefined}><input autoComplete="off" value={reservationConfirmation} onChange={(event) => { setReservationConfirmation(event.target.value); setReservationInvalid(false); }} /></Field></form>}
      {mutation.saved && <IdentityGroupReviewDetails review={mutation.saved} groupOrder={planGroupOrder} />}
    </div>
  </Dialog>;
}
