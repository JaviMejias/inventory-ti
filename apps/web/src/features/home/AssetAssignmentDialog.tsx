import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { environment } from '../../config/environment';
import { ApiRequestError, apiRequest, getApiFieldErrors, getApiErrorMessage, getCsrfToken } from '../../lib/api';
import type { AppRole } from '../../lib/permissions';
import { formatInventoryDateTime, inventoryDate } from '../../lib/date-range';
import { Alert, Badge, Button, DatePicker, Dialog, EmptyState, Field, Icon, ListFooter, Select, TableSkeleton, useRequestError, useToast } from '../../ui';
import { useAuth } from '../auth/auth-context';
import { assetStatusLabels, type AssetStatus } from './asset-status';
import { assignmentPayload, assignmentRecipient, assignmentReturnPayload, canSetAssignmentDate, emptyAssignmentForm, validateAssignment, type AssignmentErrors, type AssignmentForm, type AssignmentRecord } from './assignment-model';
import { AssignmentHistoryProvenance } from './AssignmentHistoryProvenance';

type AssignmentAsset = { id: string; assetTag: string | null; serialNumber: string | null; status: AssetStatus; isActive?: boolean; product: { name: string } };
type AssignmentPage = { assignments: AssignmentRecord[]; currentAssignment: AssignmentRecord | null; total?: number; hasMore?: boolean };
const fieldMap: Record<string, keyof AssignmentForm> = { personName: 'personName', recipientType: 'recipientType', officeName: 'officeName', assignmentType: 'assignmentType', expectedReturnAt: 'expectedDate', effectiveAt: 'effectiveDate', returnStatus: 'returnStatus', ticketReference: 'ticketReference', otReference: 'otReference', notes: 'notes' };

export function AssetAssignmentDialog({ asset, onClose, onSaved }: { asset: AssignmentAsset; onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const reportError = useRequestError();
  const v2 = environment.inventoryAssignmentsV2;
  const [open, setOpen] = useState(true);
  const [current, setCurrent] = useState<AssignmentRecord | null>(null);
  const [history, setHistory] = useState<AssignmentRecord[]>([]);
  const [total, setTotal] = useState<number | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const nextOffset = useRef(0);
  const [failedOffset, setFailedOffset] = useState(0);
  const currentId = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [known, setKnown] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<AssignmentErrors>({});
  const [form, setForm] = useState(emptyAssignmentForm);
  const [returnForm, setReturnForm] = useState(emptyAssignmentForm);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  const controllerRef = useRef<globalThis.AbortController | null>(null);
  const pagePending = useRef(false);

  const load = useCallback(async (offset = 0) => {
    if (offset && pagePending.current) return;
    controllerRef.current?.abort();
    const controller = new globalThis.AbortController();
    controllerRef.current = controller;
    pagePending.current = true;
    if (offset) setLoadingMore(true); else { setLoading(true); setLoadingMore(false); }
    setLoadError(null);
    setFailedOffset(offset);
    try {
      const result = await apiRequest<AssignmentPage>(`/assets/${asset.id}/assignments?limit=25&offset=${offset}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setHistory((previous) => offset ? [...previous, ...result.assignments.filter((item) => !previous.some((record) => record.id === item.id))] : result.assignments);
      setTotal(result.total);
      nextOffset.current = offset + result.assignments.length;
      setHasMore(result.hasMore ?? (result.total !== undefined && offset + result.assignments.length < result.total));
      if (!offset) {
        if (currentId.current !== (result.currentAssignment?.id ?? null)) {
          setConfirmReturn(false);
          setReturnForm(emptyAssignmentForm());
          setErrors({});
        }
        currentId.current = result.currentAssignment?.id ?? null;
        setCurrent(result.currentAssignment);
        setKnown(true);
        setUncertain(false);
        setError(null);
      }
    } catch (caught) {
      if (!controller.signal.aborted) setLoadError(getApiErrorMessage(caught, 'No se pudo cargar el historial de entregas.'));
    } finally {
      if (!controller.signal.aborted) { pagePending.current = false; setLoading(false); setLoadingMore(false); }
    }
  }, [asset.id]);

  useEffect(() => { void load(); return () => controllerRef.current?.abort(); }, [load]);
  const active = asset.isActive !== false && asset.status !== 'DECOMMISSIONED';
  const showAssignmentForm = Boolean(user) && active && known && !loading && !current && asset.status === 'AVAILABLE';
  const canAssign = showAssignmentForm && !uncertain;
  const canReturn = Boolean(user) && active && known && !loading && !uncertain && Boolean(current);
  const draft = confirmReturn ? returnForm : form;
  const busy = saving || loading;
  function change(key: keyof AssignmentForm, value: string) {
    const update = (previous: AssignmentForm) => ({ ...previous, [key]: value });
    if (confirmReturn) setReturnForm(update); else setForm(update);
    setErrors((previous) => ({ ...previous, [key]: undefined }));
  }
  function clearDate(expected = false) {
    const fields = expected ? { expectedDate: '', expectedTime: '' } : { effectiveDate: '', effectiveTime: '' };
    if (confirmReturn) setReturnForm((previous) => ({ ...previous, ...fields }));
    else setForm((previous) => ({ ...previous, ...fields }));
    setErrors((previous) => ({ ...previous, ...Object.fromEntries(Object.keys(fields).map((key) => [key, undefined])) }));
  }
  const loadFeedback = loadError && <Alert variant="danger" title="No se pudo cargar el historial" action={<Button variant="secondary" size="sm" disabled={saving || loadingMore} onClick={() => void load(failedOffset)}>Reintentar</Button>}>{loadError}</Alert>;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || (confirmReturn ? !canReturn : !canAssign)) return;
    const validation = validateAssignment(draft, { v2, role: user?.role, returning: confirmReturn ? current ?? undefined : undefined });
    setErrors(validation);
    setError(null);
    if (Object.keys(validation).length) {
      globalThis.requestAnimationFrame(() => globalThis.document.querySelector<globalThis.HTMLElement>('#inventory-assignment-form [aria-invalid="true"]')?.focus());
      return;
    }
    submitting.current = true;
    setSaving(true);
    controllerRef.current?.abort();
    pagePending.current = false;
    setLoadingMore(false);
    try {
      const token = await getCsrfToken();
      const body = confirmReturn ? assignmentReturnPayload(draft, v2, user?.role) : assignmentPayload(draft, v2, user?.role);
      await apiRequest(confirmReturn ? `/assets/${asset.id}/assignments/${current!.id}/return` : `/assets/${asset.id}/assignments`, {
        method: 'POST', headers: { 'X-CSRF-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      showToast({ tone: 'success', title: confirmReturn ? 'Devolución registrada' : 'Entrega registrada', description: confirmReturn ? `El equipo quedó ${assetStatusLabels[v2 ? draft.returnStatus : 'AVAILABLE'].toLocaleLowerCase('es-CL')}.` : `Entregado a ${draft.recipientType === 'OFFICE' && v2 ? draft.officeName.trim() : draft.personName.trim()}.` });
      setOpen(false);
      onSaved();
    } catch (caught) {
      setError(reportError(caught, confirmReturn ? 'No se pudo registrar la devolución' : 'No se pudo registrar la entrega'));
      setErrors(getApiFieldErrors(caught, fieldMap));
      if (caught instanceof ApiRequestError) {
        if (caught.code === 'ASSIGNMENT_DATE_CONFLICT') setErrors({ effectiveDate: getApiErrorMessage(caught, 'Revisa la fecha efectiva.') });
        if (['NETWORK_ERROR', 'INVALID_RESPONSE', 'ASSIGNMENT_ALREADY_CLOSED', 'ASSET_ALREADY_ASSIGNED'].includes(caught.code ?? '')) setUncertain(true);
      }
    } finally { submitting.current = false; setSaving(false); }
  }
  return <Dialog open={open} onClose={() => setOpen(false)} onExited={onClose} busy={saving} className="catalog-editor-dialog inventory-assignment-dialog" title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon catalog-dialog-icon-product"><Icon><path d="M4 7h16M4 12h10M4 17h16" /></Icon></span>{confirmReturn ? 'Registrar devolución' : current ? 'Entrega actual' : active && asset.status === 'AVAILABLE' ? 'Entregar activo' : 'Historial de entregas'}</span>} description={asset.product.name + ' · ' + (asset.assetTag || asset.serialNumber || 'Sin identificador')} actions={<>
    <Button variant="secondary" disabled={saving} onClick={() => setOpen(false)}>Cerrar</Button>
    {confirmReturn && <Button variant="secondary" disabled={busy} onClick={() => { setConfirmReturn(false); setErrors({}); setError(null); }}>Volver</Button>}
    {canAssign && <Button type="submit" form="inventory-assignment-form" loading={saving}>Registrar entrega</Button>}
    {canReturn && !confirmReturn && <Button disabled={saving} onClick={() => { setConfirmReturn(true); setErrors({}); setError(null); }}>Registrar devolución</Button>}
    {canReturn && confirmReturn && <Button type="submit" form="inventory-assignment-form" loading={saving}>Confirmar devolución</Button>}
  </>}>
    <div className="inventory-assignment-content">
      {(!known || failedOffset === 0) && loadFeedback}
      {error && <Alert variant="danger" action={<Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>Actualizar entrega</Button>}>{error}</Alert>}
      {loading ? <TableSkeleton columns={2} rows={3} /> : <>
        {current && <section className="inventory-assignment-current">
          <div className="inventory-assignment-current-heading"><div><span className="inventory-assignment-kicker">{current.recipientType === 'OFFICE' ? 'Oficina destinataria' : 'Persona destinataria'}</span><strong>{assignmentRecipient(current)}</strong></div><Badge variant={current.assignmentType === 'LOAN' ? 'warning' : 'info'}>{current.assignmentType === 'LOAN' ? 'Préstamo' : 'Entrega activa'}</Badge></div>
          <div className="inventory-assignment-meta"><span>Entregado el {formatInventoryDateTime(current.startedAt)}</span>{current.expectedReturnAt && <span>Devolución prevista: {formatInventoryDateTime(current.expectedReturnAt)}</span>}</div>
          <AssignmentReferences record={current} />
        </section>}
        {(showAssignmentForm || (confirmReturn && current)) && <form id="inventory-assignment-form" className="inventory-dialog-form" noValidate onSubmit={submit}>
          <AssignmentFields draft={draft} errors={errors} busy={busy} v2={v2} confirmReturn={confirmReturn} role={user?.role} change={change} clearDate={clearDate} />
        </form>}
        {known && !current && !canAssign && !uncertain && <EmptyState title="Equipo no disponible para entrega" description={assetStatusLabels[asset.status]} />}
        {known && !confirmReturn && <section className="inventory-assignment-history">
          <div className="inventory-assignment-section-heading"><strong>Historial de entregas</strong></div>
          {history.length === 0 ? <EmptyState title="Sin entregas registradas" /> : <div className="inventory-assignment-history-list">{history.map((record) => <article key={record.id}>
            <span className="inventory-assignment-history-marker" aria-hidden="true"><Icon size="sm"><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="9" /></Icon></span>
            <div><strong>{assignmentRecipient(record)}</strong><span>{record.assignmentType === 'LOAN' ? 'Préstamo' : record.assignmentType === 'STANDARD' ? 'Entrega estándar' : 'Tipo de entrega no informado'} · {record.recipientType === 'OFFICE' ? 'Oficina' : record.recipientType === 'PERSON' ? 'Persona' : 'Tipo de destinatario no informado'}</span>
              <span>{record.historyCorrection ? 'Entrega efectiva' : 'Entrega'}: {formatInventoryDateTime(record.startedAt)}</span>
              {record.expectedReturnAt && <span>Prevista: {formatInventoryDateTime(record.expectedReturnAt)}</span>}
              <AssignmentReferences record={record} />
              {record.endedAt ? <><span>{record.historyCorrection ? 'Devolución efectiva' : 'Devolución'}: {formatInventoryDateTime(record.endedAt)} · {record.returnStatus ? assetStatusLabels[record.returnStatus] : 'Estado de retorno no registrado'}</span><AssignmentReferences record={record} returning /></> : <Badge variant="info">Entrega activa</Badge>}
              <AssignmentHistoryProvenance record={record} />
            </div>
          </article>)}</div>}
          {failedOffset > 0 && loadFeedback}
          <ListFooter loaded={history.length} total={total} hasMore={hasMore && !saving} loading={loadingMore} onLoadMore={() => void load(nextOffset.current)} />
        </section>}
      </>}
    </div>
  </Dialog>;
}
function AssignmentReferences({ record, returning = false }: { record: AssignmentRecord; returning?: boolean }) {
  const ticket = returning ? record.returnTicketReference : record.ticketReference;
  const ot = returning ? record.returnOtReference : record.otReference;
  const notes = returning ? record.returnNotes : record.notes;
  if (!ticket && !ot && !notes) return null;
  return <dl className="inventory-metadata-detail">{ticket && <div><dt>Ticket de {returning ? 'entrada' : 'salida'}</dt><dd>{ticket}</dd></div>}{ot && <div><dt>OT de {returning ? 'entrada' : 'salida'}</dt><dd>{ot}</dd></div>}{notes && <div><dt>Observaciones de {returning ? 'retorno' : 'entrega'}</dt><dd>{notes}</dd></div>}</dl>;
}

function AssignmentFields({ draft, errors, busy, v2, confirmReturn, role, change, clearDate }: {
  draft: AssignmentForm; errors: AssignmentErrors; busy: boolean; v2: boolean; confirmReturn: boolean; role?: AppRole;
  change: (key: keyof AssignmentForm, value: string) => void; clearDate: (expected?: boolean) => void;
}) {
  return <>    {!confirmReturn ? <>
            {v2 && <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Destinatario" error={errors.recipientType} disabled={busy}><Select value={draft.recipientType} onChange={(value) => change('recipientType', value)} options={[{ value: 'PERSON', label: 'Persona' }, { value: 'OFFICE', label: 'Oficina' }]} /></Field>
              <Field label="Tipo de entrega" error={errors.assignmentType} disabled={busy}><Select value={draft.assignmentType} onChange={(value) => change('assignmentType', value)} options={[{ value: 'STANDARD', label: 'Entrega estándar' }, { value: 'LOAN', label: 'Préstamo' }]} /></Field>
            </div>}
            {v2 && draft.recipientType === 'OFFICE' ? <Field label="Nombre de la oficina" required error={errors.officeName} disabled={busy}><input maxLength={160} value={draft.officeName} onChange={(event) => change('officeName', event.target.value)} placeholder="Ej. Sucursal Pucón" /></Field> : <Field label="Nombre y apellido" required error={errors.personName} disabled={busy}><input maxLength={150} value={draft.personName} onChange={(event) => change('personName', event.target.value)} placeholder="Ej. Daniela González" /></Field>}
            {v2 && draft.assignmentType === 'LOAN' && <section className="inventory-metadata-section">
              <p className="ui-field-hint">La fecha prevista es opcional. No genera alertas ni devoluciones automáticas.</p>
              <DatePicker inline allowFuture label="Devolución prevista" value={draft.expectedDate} error={errors.expectedDate} disabled={busy} onChange={(value) => change('expectedDate', value)} />
              <Field label="Hora prevista en Chile (HH:MM)" error={errors.expectedTime} disabled={busy}><input inputMode="numeric" maxLength={5} value={draft.expectedTime} onChange={(event) => change('expectedTime', event.target.value)} placeholder="Ej. 18:00" /></Field>
              {(draft.expectedDate || draft.expectedTime) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => clearDate(true)}>Quitar fecha prevista</Button>}
            </section>}
          </> : v2 ? <Field label="Estado del equipo al devolver" required error={errors.returnStatus} disabled={busy} hint="Solo Disponible permite una nueva entrega."><Select value={draft.returnStatus} onChange={(value) => change('returnStatus', value)} options={[{ value: 'AVAILABLE', label: 'Disponible' }, { value: 'UNDER_REVIEW', label: 'En revisión' }, { value: 'IN_REPAIR', label: 'En reparación' }]} /></Field> : <p>La devolución cerrará la entrega y dejará el equipo disponible.</p>}
          {v2 && <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={confirmReturn ? 'Ticket de entrada' : 'Ticket de salida'} error={errors.ticketReference} disabled={busy}><input maxLength={160} value={draft.ticketReference} onChange={(event) => change('ticketReference', event.target.value)} placeholder="Ej. 1258508" /></Field>
              <Field label={confirmReturn ? 'OT de entrada' : 'OT de salida'} error={errors.otReference} disabled={busy}><input maxLength={160} value={draft.otReference} onChange={(event) => change('otReference', event.target.value)} placeholder="Ej. OT-20" /></Field>
            </div>
            <Field label={confirmReturn ? 'Observaciones de devolución' : 'Observaciones de entrega'} error={errors.notes} disabled={busy}><textarea className="resize-none" rows={2} maxLength={10000} value={draft.notes} onChange={(event) => change('notes', event.target.value)} placeholder="Información relevante de esta operación" /></Field>
            {canSetAssignmentDate(role) && <details className="inventory-metadata-section" open={Boolean(draft.effectiveDate || draft.effectiveTime || errors.effectiveDate || errors.effectiveTime)}>
              <summary>Fecha efectiva manual (opcional)</summary>
              <p className="ui-field-hint">Sin fecha manual se usará el momento del servidor. La captura queda registrada por separado.</p>
              <DatePicker inline maxDate={inventoryDate()} label={confirmReturn ? 'Fecha de devolución' : 'Fecha de entrega'} value={draft.effectiveDate} error={errors.effectiveDate} disabled={busy} onChange={(value) => change('effectiveDate', value)} />
              <Field label="Hora efectiva en Chile (HH:MM)" error={errors.effectiveTime} disabled={busy}><input inputMode="numeric" maxLength={5} value={draft.effectiveTime} onChange={(event) => change('effectiveTime', event.target.value)} placeholder="Ej. 09:30" /></Field>
              {(draft.effectiveDate || draft.effectiveTime) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => clearDate()}>Usar fecha del servidor</Button>}
            </details>}
          </>}

  </>;
}
