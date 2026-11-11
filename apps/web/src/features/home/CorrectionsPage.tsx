import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiRequestError, apiRequest, getApiErrorMessage, getApiFieldErrors } from '../../lib/api';
import { inventoryDateRange } from '../../lib/date-range';
import { mergeRecords } from '../../lib/pagination';
import { Alert, Button, DataTable, Dialog, EmptyState, Field, Icon, ModuleFilters, ModuleHeader, OverflowText, PageContainer, Select, Switch, useToast, useRequestError, type DataTableColumn } from '../../ui';
import { useAuth } from '../auth/auth-context';
import { DatePicker } from '../../ui/primitives/DatePicker';
import { getCorrectedQuantity, getCorrectionFeedback } from './correction-model';

type Status = 'PENDING' | 'APPROVED' | 'REJECTED';
type MovementType = 'INITIAL' | 'ENTRY' | 'EXIT' | 'RETURN' | 'ADJUSTMENT';
type User = { id: string; username: string; displayName: string; role: 'JEFE' | 'COORDINADOR' | 'SOPORTE' };
type MovementDetails = { id: string; movementType: MovementType; quantity: number; reason: string | null; effectiveAt: string; product: { id: string; name: string; sku: string | null; trackingMode: 'QUANTITY' | 'ASSET' }; performedBy: User | null; assetId?: string | null };
type Movement = MovementDetails & { originalQuantity: number; effectiveQuantity: number; canCorrect: boolean };
type Correction = { id: string; status: Status; reason: string; delta: number; previousQuantity: number; correctedQuantity: number; createdAt: string; reviewedAt: string | null; originalMovement: MovementDetails; compensatingMovement: MovementDetails | null; requestedBy: User; reviewedBy: User | null };
type FormState = { movementId: string; quantity: string; reason: string; direction: 'add' | 'subtract' };
type FormErrors = Partial<Record<keyof FormState, string>>;
const movementLabels: Record<MovementType, string> = { INITIAL: 'Stock inicial', ENTRY: 'Entrada', EXIT: 'Salida', RETURN: 'Devolución', ADJUSTMENT: 'Ajuste' };
const statusLabels: Record<Status, string> = { PENDING: 'Pendiente', APPROVED: 'Aprobada', REJECTED: 'Rechazada' };
const request = apiRequest;
async function csrf() { return (await request<{ csrfToken: string }>('/auth/csrf')).csrfToken; }
function date(value: string) { return new Date(value).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }); }
function dateTime(value: string) { return new Date(value).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' }); }
function signed(value: number) { return (value > 0 ? '+' : '') + value; }
function correctedEffect(correction: Correction) { return correction.correctedQuantity; }

export function CorrectionsPage() {
  const { user } = useAuth(); const { showToast } = useToast(); const reportError = useRequestError(); const reviewer = user?.role === 'JEFE';
  const [searchParams, setSearchParams] = useSearchParams();
  const correctionIdFromUrl = searchParams.get('correctionId');
  const [items, setItems] = useState<Correction[]>([]); const [movements, setMovements] = useState<Movement[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState(''); const [type, setType] = useState(''); const [search, setSearch] = useState(() => searchParams.get('search') ?? ''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false); const [error, setError] = useState<string | null>(null); const [selected, setSelected] = useState<Correction | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false); const [detailOpen, setDetailOpen] = useState(false); const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null); const [busy, setBusy] = useState(false); const [form, setForm] = useState<FormState>({ movementId: '', quantity: '', reason: '', direction: 'add' });
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [movementsLoading, setMovementsLoading] = useState(true);
  const [movementsError, setMovementsError] = useState<string | null>(null);
  const pageRequestId = useRef(0);
  const nextOffset = useRef(0);
  const pageLoading = useRef(false);
  useEffect(() => {
    if (!createOpen) return;
    setDialogError(null);
    setFormErrors({});
  }, [createOpen]);
  const loadPage = useCallback(async (offset = 0, append = false, signal?: globalThis.AbortSignal) => {
    if (append && pageLoading.current) return;
    const requestId = ++pageRequestId.current;
    pageLoading.current = true;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const query = new globalThis.URLSearchParams({ limit: '25', offset: String(offset) });
      if (status) query.set('status', status);
      if (type) query.set('movementType', type);
      if (search.trim()) query.set('search', search.trim());
      const range = inventoryDateRange(from, to);
      if (range.from) query.set('from', range.from);
      if (range.to) query.set('to', range.to);
      const result = await request<{ corrections: Correction[]; total: number; pendingTotal: number; hasMore: boolean }>('/corrections?' + query.toString(), { signal });
      if (signal?.aborted || requestId !== pageRequestId.current) return;
      nextOffset.current = offset + result.corrections.length;
      setItems((current) => append ? mergeRecords(current, result.corrections) : result.corrections);
      setHasMore(result.hasMore);
      if (!append) setSelected((old) => old ? result.corrections.find((x) => x.id === old.id) ?? null : null);
    } catch (e) { if (!signal?.aborted && requestId === pageRequestId.current) setError(getApiErrorMessage(e, 'No se pudieron cargar las correcciones.')); }
    finally { if (!signal?.aborted && requestId === pageRequestId.current) { pageLoading.current = false; setLoadingMore(false); setLoading(false); } }
  }, [from, search, status, to, type]);
  useEffect(() => {
    pageRequestId.current++;
    pageLoading.current = false;
    nextOffset.current = 0;
    setLoading(true);
    const controller = new globalThis.AbortController();
    const timer = globalThis.setTimeout(() => { void loadPage(0, false, controller.signal); }, 300);
    return () => { globalThis.clearTimeout(timer); controller.abort(); };
  }, [loadPage]);
  useEffect(() => {
    if (!correctionIdFromUrl || loading) return;
    let cancelled = false;
    const clearDeepLink = () => {
      const nextParams = new globalThis.URLSearchParams(searchParams);
      nextParams.delete('correctionId');
      setSearchParams(nextParams, { replace: true });
    };
    const current = items.find((item) => item.id === correctionIdFromUrl);
    if (current) {
      setSelected(current);
      setDetailOpen(true);
      clearDeepLink();
      return;
    }
    void request<{ correction: Correction }>('/corrections/' + encodeURIComponent(correctionIdFromUrl)).then((result) => {
      if (cancelled) return;
      setItems((current) => current.some((item) => item.id === result.correction.id) ? current : [result.correction, ...current]);
      setSelected(result.correction);
      setDetailOpen(true);
      clearDeepLink();
    }).catch((caughtError) => {
      if (cancelled) return;
      setError(reportError(caughtError, 'No se pudo abrir la corrección solicitada'));
      clearDeepLink();
    });
    return () => { cancelled = true; };
  }, [correctionIdFromUrl, items, loading, reportError, searchParams, setSearchParams]);
  useEffect(() => {
    const onScroll = () => {
      if (error || loading || !hasMore || loadingMore || globalThis.innerHeight + globalThis.scrollY < document.documentElement.scrollHeight - 500) return;
      void loadPage(nextOffset.current, true);
    };
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    return () => globalThis.removeEventListener('scroll', onScroll);
  }, [error, hasMore, items.length, loadPage, loading, loadingMore]);
  const loadMovements = useCallback(async (signal?: globalThis.AbortSignal) => {
    setMovementsLoading(true);
    setMovementsError(null);
    setMovements([]);
    try {
      const result = await request<{ movements: Movement[] }>('/inventory/movements', { signal });
      if (!signal?.aborted) setMovements(result.movements);
    } catch (e) {
      if (!signal?.aborted) setMovementsError(reportError(e, 'No se pudieron cargar los movimientos'));
    } finally {
      if (!signal?.aborted) setMovementsLoading(false);
    }
  }, [reportError]);
  useEffect(() => {
    if (!createOpen) return;
    const controller = new globalThis.AbortController();
    void loadMovements(controller.signal);
    return () => controller.abort();
  }, [createOpen, loadMovements]);
  const filtered = useMemo(() => { const q = search.trim().toLocaleLowerCase('es-CL'); const range = inventoryDateRange(from, to); const start = range.from ? new Date(range.from) : null; const end = range.to ? new Date(range.to) : null; return items.filter((x) => { const m = x.originalMovement; const text = (m.product.name + ' ' + (m.product.sku ?? '') + ' ' + x.requestedBy.displayName + ' ' + x.reason).toLocaleLowerCase('es-CL'); const d = new Date(m.effectiveAt); return (!status || x.status === status) && (!type || m.movementType === type) && (!q || text.includes(q)) && (!start || d >= start) && (!end || d <= end); }); }, [from, items, search, status, to, type]);
  const available = useMemo(() => movements.filter((movement) => movement.canCorrect), [movements]);
  const chosenMovement = available.find((movement) => movement.id === form.movementId);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersMounted, setFiltersMounted] = useState(false);
  const filterCloseTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const filterDrawerRef = useRef<globalThis.HTMLDivElement | null>(null);
  const [filterDrawerHeight, setFilterDrawerHeight] = useState(0);
  const activeFilterCount = [status, type, from, to].filter(Boolean).length;
  function openFilters() {
    if (filterCloseTimer.current !== null) globalThis.clearTimeout(filterCloseTimer.current);
    setFiltersMounted(true);
    globalThis.requestAnimationFrame(() => setFiltersOpen(true));
  }
  function closeFilters() {
    if (filterCloseTimer.current !== null) globalThis.clearTimeout(filterCloseTimer.current);
    setFiltersOpen(false);
    filterCloseTimer.current = globalThis.setTimeout(() => { setFiltersMounted(false); filterCloseTimer.current = null; }, 320);
  }
  function toggleFilters() { if (filtersOpen) closeFilters(); else openFilters(); }
  useEffect(() => () => { if (filterCloseTimer.current !== null) globalThis.clearTimeout(filterCloseTimer.current); }, []);
  useLayoutEffect(() => {
    if (!filtersMounted || !filterDrawerRef.current) return;
    const drawer = filterDrawerRef.current;
    if (!filtersOpen) {
      const frame = globalThis.requestAnimationFrame(() => setFilterDrawerHeight(0));
      return () => globalThis.cancelAnimationFrame(frame);
    }
    setFilterDrawerHeight(0);
    const content = drawer.firstElementChild;
    if (!(content instanceof globalThis.HTMLElement)) return;
    const measure = () => setFilterDrawerHeight(Math.ceil(content.getBoundingClientRect().height));
    const observer = new globalThis.ResizeObserver(measure);
    const frame = globalThis.requestAnimationFrame(() => {
      measure();
      observer.observe(content);
    });
    return () => {
      globalThis.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [filtersMounted, filtersOpen]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || movementsLoading) return;
    const quantity = Number(form.quantity);
    const correctedQuantity = chosenMovement ? getCorrectedQuantity(chosenMovement.movementType, quantity, form.direction) : 0;
    const errors: FormErrors = {};
    if (!chosenMovement) errors.movementId = 'Selecciona un movimiento disponible para corregir.';
    if (!form.quantity.trim() || !Number.isInteger(quantity) || quantity < 0 || correctedQuantity < -2_147_483_648 || correctedQuantity > 2_147_483_647) errors.quantity = 'Ingresa una cantidad entera desde cero, dentro del rango permitido.';
    else if (chosenMovement && correctedQuantity === chosenMovement.effectiveQuantity) errors.quantity = 'La cantidad final debe ser distinta de la cantidad vigente.';
    if (!form.reason.trim()) errors.reason = 'Explica por qué debe corregirse el movimiento.';
    setFormErrors(errors);
    if (Object.keys(errors).length || !chosenMovement) {
      const field = errors.movementId ? 'movement' : errors.quantity ? 'quantity' : 'reason';
      globalThis.document.getElementById('correction-' + field)?.focus();
      return;
    }
    setDialogError(null);
    setBusy(true);
    try {
      const token = await csrf();
      const result = await request<{ correction: Correction }>('/inventory/movements/' + form.movementId + '/corrections', { method: 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify({ correctedQuantity, reason: form.reason.trim() }) });
      showToast(getCorrectionFeedback(result.correction.status));
      setCreateOpen(false);
      setForm({ movementId: '', quantity: '', reason: '', direction: 'add' });
      await loadPage();
    } catch (caughtError) {
      reportError(caughtError, 'No se pudo solicitar la corrección');
      if (caughtError instanceof ApiRequestError) {
        if (caughtError.code === 'CORRECTION_NO_CHANGE' || caughtError.code === 'CORRECTION_INVALID_QUANTITY' || caughtError.code === 'STOCK_LIMIT_EXCEEDED') setFormErrors({ quantity: getApiErrorMessage(caughtError, 'Revisa la cantidad final.') });
        else if (caughtError.code?.startsWith('CORRECTION_')) setFormErrors({ movementId: getApiErrorMessage(caughtError, 'Selecciona otro movimiento o actualiza la información.') });
        else if (caughtError.code === 'VALIDATION_ERROR') setFormErrors(getApiFieldErrors(caughtError, { correctedQuantity: 'quantity', reason: 'reason' }));
      }
    } finally { setBusy(false); }
  }
  async function review() {
    if (busy || !selected || !confirm) return;
    setDialogError(null);
    setBusy(true);
    try {
      const token = await csrf();
      await request('/corrections/' + selected.id + '/' + confirm, { method: 'POST', headers: { 'X-CSRF-Token': token } });
      showToast({ tone: confirm === 'approve' ? 'success' : 'info', title: confirm === 'approve' ? 'Corrección aprobada' : 'Corrección rechazada', description: 'La solicitud fue procesada correctamente.' });
      setConfirm(null);
      setDetailOpen(false);
      await loadPage();
    } catch (caughtError) {
      setDialogError(reportError(caughtError, 'No se pudo revisar la corrección'));
    } finally { setBusy(false); }
  }
  const columns: Array<DataTableColumn<Correction>> = [
    { key: 'movement', mobileRole: 'full', header: <TableHeader icon={<MovementIcon type="ENTRY" />}>Movimiento</TableHeader>, mobileLabel: 'Movimiento', className: 'corrections-col-movement', render: (x: Correction) => <MovementCell movement={x.originalMovement} /> },
    { key: 'product', mobileRole: 'identity', header: <TableHeader icon={<ProductIcon />}>Producto</TableHeader>, mobileLabel: 'Producto', className: 'corrections-col-product', render: (x: Correction) => <ProductCell product={x.originalMovement.product} /> },
    { key: 'original', mobileRole: 'context', header: <TableHeader icon={<NumberHeaderIcon />}>Antes</TableHeader>, mobileLabel: 'Antes', className: 'corrections-col-original', render: (x: Correction) => <NumberCell label="Vigente al solicitar" value={x.previousQuantity} /> },
    { key: 'delta', mobileRole: 'full', header: <TableHeader icon={<NumberHeaderIcon />}><span className="sr-only">Cantidad final</span><span className="corrections-header-compact" aria-hidden="true">Final</span></TableHeader>, mobileLabel: 'Cantidad final', className: 'corrections-col-delta', render: (x: Correction) => <div className="corrections-adjustment-overview"><NumberCell label={x.status === 'APPROVED' ? 'Aplicada' : x.status === 'REJECTED' ? 'No aplicada' : 'Propuesta'} value={x.correctedQuantity} emphasis /><div className="corrections-adjustment-context"><span><small>Antes</small><strong>{signed(x.previousQuantity)}</strong></span><span><small>Diferencia</small><strong className={'corrections-number ' + (x.delta > 0 ? 'is-positive' : x.delta < 0 ? 'is-negative' : '')}>{signed(x.delta)}</strong></span></div></div> },
    { key: 'result', mobileRole: 'context', header: <TableHeader icon={<NumberHeaderIcon />}>Stock</TableHeader>, mobileLabel: 'Diferencia de stock', className: 'corrections-col-result', render: (x: Correction) => <NumberCell label={x.status === 'APPROVED' ? 'Diferencia aplicada' : 'Diferencia propuesta'} value={x.delta} /> },
    { key: 'requester', mobileRole: 'full', header: <TableHeader icon={<PersonIcon />}>Solicitante</TableHeader>, mobileLabel: 'Solicitante', className: 'corrections-col-requester', render: (x: Correction) => <RequesterCell user={x.requestedBy} /> },
    { key: 'status', header: <TableHeader icon={<StatusIcon status="PENDING" />}>Estado</TableHeader>, mobileLabel: 'Estado', className: 'corrections-col-status', render: (x: Correction) => <StatusChip status={x.status} /> },
    { key: 'date', mobileRole: 'full', header: <TableHeader icon={<CalendarIcon />}>Fecha</TableHeader>, mobileLabel: 'Fecha', className: 'corrections-col-date', render: (x: Correction) => <time className="corrections-date-cell"><CalendarIcon />{date(x.createdAt)}</time> },
    { key: 'action', mobileRole: 'actions', header: <TableHeader icon={<EyeIcon />}>Acción</TableHeader>, mobileLabel: 'Acción', className: 'corrections-col-action', render: (x: Correction) => <Button className="corrections-row-action" size="sm" variant="primary" onClick={() => { setSelected(x); setDetailOpen(true); }}><EyeIcon />{reviewer && x.status === 'PENDING' ? 'Revisar' : 'Ver'}</Button> }
  ];
  return <PageContainer fluid className="corrections-page"><ModuleHeader className="corrections-module-header" title="Correcciones" description="Gestiona y revisa solicitudes para corregir movimientos de inventario." action={<Button onClick={() => { setDialogError(null); setCreateOpen(true); }}><PlusIcon /> Nueva corrección</Button>} />{error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void loadPage()}>Reintentar</Button>}>{error}</Alert>}<ModuleFilters className="corrections-toolbar" ariaLabel="Filtros de correcciones" actions={<Button variant="secondary" size="sm" className="corrections-clear-filters" onClick={() => { setSearch(''); setStatus(''); setType(''); setFrom(''); setTo(''); }}><ResetIcon /> Limpiar filtros</Button>}><div className="corrections-search"><label className="sr-only" htmlFor="corrections-search-input">Buscar</label><SearchIcon /><input id="corrections-search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar producto, SKU o solicitante" aria-label="Buscar correcciones" /></div><Button variant="secondary" size="sm" className="corrections-filter-toggle" aria-expanded={filtersOpen} onClick={toggleFilters}><FilterIcon /> Filtros{activeFilterCount > 0 && <span className="corrections-filter-count">{activeFilterCount}</span>}<ChevronIcon open={filtersOpen} /></Button></ModuleFilters>{filtersMounted && <div ref={filterDrawerRef} className="corrections-filter-drawer" data-state={filtersOpen ? 'open' : 'closing'} style={{ height: `${filterDrawerHeight}px` }}><div className="corrections-filter-drawer-content"><div className="corrections-filter-grid"><Select className="corrections-filter-select" value={status} onChange={setStatus} placeholder="Todos los estados" options={[{ value: '', label: 'Todos los estados' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} /><Select className="corrections-filter-select" value={type} onChange={setType} placeholder="Todos los movimientos" options={[{ value: '', label: 'Todos los movimientos' }, ...Object.entries(movementLabels).map(([value, label]) => ({ value, label }))]} /><DateFilter label="Desde" value={from} onChange={setFrom} /><DateFilter label="Hasta" value={to} onChange={setTo} /></div></div></div>}<section className="corrections-panel"><div className="corrections-panel-heading"><div><span>Solicitudes</span><h2>Historial de correcciones</h2></div><strong>{filtered.length} visibles</strong></div><DataTable className="corrections-data-table" rows={filtered} columns={columns} getRowKey={(x) => x.id} getRowClassName={(x) => x.delta >= 0 ? 'corrections-row-increase' : 'corrections-row-decrease'} caption="Solicitudes de corrección" loading={loading} error={filtered.length === 0 ? error ?? undefined : undefined} empty={<EmptyState title="No hay correcciones" description="Prueba con otros filtros o crea una nueva solicitud." icon={<ClipboardIcon />} />} /></section><CreateDialog formErrors={formErrors} loading={movementsLoading} loadError={movementsError} applyDirectly={Boolean(reviewer)} onRetry={() => void loadMovements()} error={dialogError} open={createOpen} busy={busy} form={form} movements={available} chosen={chosenMovement} onClose={() => setCreateOpen(false)} onChange={(next) => { setDialogError(null); setFormErrors({}); setForm(next); }} onSubmit={create} /><DetailDialog open={detailOpen} correction={selected} canReview={Boolean(reviewer && selected?.status === 'PENDING' && selected.requestedBy.id !== user?.id)} selfRequested={Boolean(reviewer && selected?.status === 'PENDING' && selected.requestedBy.id === user?.id)} onClose={() => setDetailOpen(false)} onApprove={() => { setDialogError(null); setConfirm('approve'); }} onReject={() => { setDialogError(null); setConfirm('reject'); }} /><ConfirmReview error={dialogError} open={Boolean(confirm)} action={confirm} correction={selected} busy={busy} onClose={() => setConfirm(null)} onConfirm={() => void review()} /></PageContainer>;
}
function MovementCell({ movement }: { movement: MovementDetails }) { return <div className="corrections-movement-cell"><span className={`corrections-movement-icon corrections-movement-${movement.movementType.toLowerCase()}`}><MovementIcon type={movement.movementType} /></span><div className="corrections-primary-cell"><OverflowText as="strong" text={movementLabels[movement.movementType]} /><span>{dateTime(movement.effectiveAt)}</span></div></div>; }
function TableHeader({ icon, children }: { icon: ReactNode; children: ReactNode }) { return <span className="corrections-header-label">{icon}{children}</span>; }
function ProductCell({ product }: { product: Movement['product'] }) { return <div className="catalog-name-cell corrections-product-identity"><span className="catalog-row-icon catalog-row-icon-secondary"><ProductIcon /></span><span className="catalog-name-copy"><OverflowText as="strong" text={product.name} /><OverflowText as="small" text={product.sku ? 'SKU ' + product.sku : 'Sin SKU'} /></span></div>; }
function NumberCell({ label, value, emphasis = false }: { label: string; value: number; emphasis?: boolean }) { return <span className={`corrections-number-cell ${value > 0 ? 'is-positive' : value < 0 ? 'is-negative' : 'is-neutral'} ${emphasis ? 'is-emphasis' : ''}`}><small>{label}</small><strong>{signed(value)}</strong></span>; }
function roleLabel(role: User['role']) { return role === 'JEFE' ? 'Jefe' : role === 'COORDINADOR' ? 'Coordinador' : 'Soporte'; }
function userInitials(displayName: string) { return displayName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U'; }
function UserIdentity({ user, className = '' }: { user: User; className?: string }) { return <span className={`corrections-user-identity ${className}`.trim()}><span className="corrections-user-avatar" aria-hidden="true">{userInitials(user.displayName)}</span><span><OverflowText as="strong" text={user.displayName} /><OverflowText as="small" text={roleLabel(user.role)} /></span></span>; }
function RequesterCell({ user }: { user: User }) { return <UserIdentity user={user} className="corrections-requester-cell" />; }
function StatusChip({ status }: { status: Status }) { return <span className={`corrections-status-chip corrections-status-${status.toLowerCase()}`}><StatusIcon status={status} /><OverflowText text={statusLabels[status]} /></span>; }
function DateFilter({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <DatePicker label={label} value={value} onChange={onChange} />; }
function CreateDialog({ open, busy, formErrors, loading, loadError, applyDirectly, form, movements, chosen, onRetry, onClose, onChange, onSubmit }: { open: boolean; busy: boolean; error?: string | null; formErrors: FormErrors; loading: boolean; loadError: string | null; applyDirectly: boolean; form: FormState; movements: Movement[]; chosen?: Movement; onRetry: () => void; onClose: () => void; onChange: (value: FormState) => void; onSubmit: (event: FormEvent) => void }) {
  const options = movements.map((x) => ({ value: x.id, label: x.product.name + ' · ' + movementLabels[x.movementType] + ' · ' + date(x.effectiveAt) }));
  const quantity = Number(form.quantity);
  const target = chosen && form.quantity.trim() && Number.isInteger(quantity) && quantity >= 0 ? getCorrectedQuantity(chosen.movementType, quantity, form.direction) : null;
  return <Dialog open={open} onClose={onClose} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon"><CorrectionDialogIcon /></span>Nueva corrección de inventario</span>} description={applyDirectly ? 'Como JEFE, aplicarás la corrección directamente al stock.' : 'La solicitud deberá ser revisada por un JEFE antes de cambiar el stock.'} busy={busy} className="catalog-editor-dialog corrections-dialog" actions={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button type="submit" form="correction-form" loading={busy} disabled={loading || Boolean(loadError) || movements.length === 0}>{applyDirectly ? 'Aplicar corrección' : 'Solicitar corrección'}</Button></>}>
    <form id="correction-form" className="corrections-form" noValidate onSubmit={onSubmit}>
      {loading && <p role="status">Cargando movimientos disponibles…</p>}
      {loadError && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={onRetry}>Reintentar</Button>}>{loadError}</Alert>}
      {!loading && !loadError && movements.length === 0 && <Alert variant="info">No hay movimientos disponibles para corregir. Los movimientos con solicitudes pendientes y los ajustes compensatorios no aparecen aquí.</Alert>}
      <section className="corrections-form-section">
        <div className="corrections-form-section-heading"><span>01</span><strong>Selecciona el producto</strong></div>
        <Field id="correction-movement" label="Producto y movimiento" required disabled={busy || loading || Boolean(loadError)} error={formErrors.movementId}>
          <Select className="catalog-editor-select" value={form.movementId} onChange={(movementId) => { const selected = movements.find((movement) => movement.id === movementId); onChange({ ...form, movementId, quantity: selected ? String(Math.abs(selected.effectiveQuantity)) : '', direction: selected && selected.effectiveQuantity < 0 ? 'subtract' : 'add' }); }} searchable resultLimit={8} searchPlaceholder="Buscar producto o movimiento…" placeholder="Selecciona un movimiento" options={options} />
        </Field>
      </section>
      {chosen && <div className="corrections-movement-summary"><div className="corrections-summary-product"><span>Producto seleccionado</span><strong>{chosen.product.name}</strong><small>{chosen.product.sku ?? 'Sin SKU'}</small></div><Detail label="Movimiento" value={movementLabels[chosen.movementType]} /><Detail label="Cantidad vigente" value={signed(chosen.effectiveQuantity)} /><Detail label="Fecha y actor" value={date(chosen.effectiveAt) + ' · ' + (chosen.performedBy?.displayName ?? 'Sistema')} /></div>}
      <section className="corrections-form-section">
        <div className="corrections-form-section-heading"><span>02</span><strong>Define la cantidad final</strong></div>
        {chosen?.movementType === 'ADJUSTMENT' && <span className="catalog-switch-action catalog-switch-action-active"><span>{form.direction === 'add' ? 'El ajuste suma unidades' : 'El ajuste descuenta unidades'}</span><Switch checked={form.direction === 'add'} disabled={busy} onCheckedChange={(checked) => onChange({ ...form, direction: checked ? 'add' : 'subtract' })} aria-label="El ajuste corregido suma unidades" /></span>}
        <Field id="correction-quantity" label="Cantidad final del movimiento" required disabled={busy || !chosen} error={formErrors.quantity} hint={chosen?.movementType === 'EXIT' ? 'Indica cuántas unidades debió descontar esta salida. No es una cantidad adicional. Usa 0 para anular su efecto.' : 'Indica la cantidad que debe quedar en este movimiento, no el stock total del producto. Usa 0 para anular su efecto.'}><input type="number" min="0" max={chosen?.movementType === 'EXIT' || (chosen?.movementType === 'ADJUSTMENT' && form.direction === 'subtract') ? 2_147_483_648 : 2_147_483_647} step="1" required value={form.quantity} onChange={(event) => onChange({ ...form, quantity: event.target.value })} placeholder="Ej. 2" /></Field>
        {chosen && target !== null && <div className="corrections-confirm-values" aria-label="Vista previa de la corrección"><Detail label="Antes" value={signed(chosen.effectiveQuantity)} /><Detail label="Cantidad final" value={signed(target)} /><Detail label="Diferencia de stock" value={signed(target - chosen.effectiveQuantity)} /></div>}
      </section>
      <section className="corrections-form-section">
        <div className="corrections-form-section-heading"><span>03</span><strong>Explica el motivo</strong></div>
        <Field id="correction-reason" label="Motivo de la corrección" required disabled={busy} error={formErrors.reason}><textarea className="resize-none" required maxLength={10_000} rows={4} value={form.reason} onChange={(e) => onChange({ ...form, reason: e.target.value })} placeholder="Ej. Se entregaron 2 unidades, no 3." /></Field>
      </section>
    </form>
  </Dialog>;
}

function Detail({ label, value }: { label: string; value: ReactNode }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function DetailStep({ icon, tone, label, value, meta }: { icon: ReactNode; tone: string; label: string; value: ReactNode; meta: string }) { return <article className={`corrections-detail-step corrections-detail-step-${tone}`}><span className="corrections-detail-step-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><span>{meta}</span></div></article>; }
function DetailDialog({ open, correction, canReview, selfRequested, onClose, onApprove, onReject }: { open: boolean; correction: Correction | null; canReview: boolean; selfRequested: boolean; onClose: () => void; onApprove: () => void; onReject: () => void }) {
  if (!correction) return null;
  const movement = correction.originalMovement;
  const targetEffect = correctedEffect(correction);
  const changeTone = correction.delta >= 0 ? 'increase' : 'decrease';
  return <Dialog open={open} onClose={onClose} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon catalog-dialog-icon-product"><CorrectionDialogIcon /></span>Detalle de corrección</span>} description="Resumen visual del ajuste solicitado para este producto." className="catalog-editor-dialog corrections-dialog corrections-detail-dialog" actions={canReview ? <><Button variant="danger" onClick={onReject}>Rechazar</Button><Button variant="primary" onClick={onApprove}>Aprobar corrección</Button></> : <Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
    <div className="corrections-detail-layout">
      <section className={`corrections-detail-hero corrections-detail-${changeTone}`}>
        <div className="corrections-detail-request">
          <span className="corrections-detail-kicker">Solicitud de ajuste</span>
          <UserIdentity user={correction.requestedBy} />
          <ProductCell product={movement.product} />
          <div className="corrections-detail-reason"><span>Motivo informado</span><p>{correction.reason}</p></div>
        </div>
        <div className={`corrections-detail-status corrections-status-${correction.status.toLowerCase()}`}><StatusIcon status={correction.status} /><span><small>Estado</small><strong>{statusLabels[correction.status]}</strong></span></div>
        <span className={`corrections-detail-delta corrections-detail-delta-${changeTone}`}><small>Valor corregido</small>{signed(targetEffect)} unidades</span>
      </section>
      <div className="corrections-detail-section-heading"><span>Flujo del inventario</span><strong>Antes, diferencia y cantidad final</strong></div>
      <div className="corrections-detail-timeline"><DetailStep tone="original" icon={<MovementIcon type={movement.movementType} />} label="Cantidad anterior" value={`${signed(correction.previousQuantity)} unidades`} meta={`${movementLabels[movement.movementType]} · ${dateTime(movement.effectiveAt)}`} /><DetailStep tone={changeTone} icon={<CorrectionDialogIcon />} label="Diferencia de stock" value={`${signed(correction.delta)} unidades`} meta={correction.status === 'APPROVED' ? 'Diferencia aplicada una sola vez' : correction.status === 'REJECTED' ? 'No aplicada al stock' : 'Se aplicará al aprobar'} /><DetailStep tone="result" icon={<NumberHeaderIcon />} label={correction.status === 'APPROVED' ? 'Cantidad final aplicada' : correction.status === 'REJECTED' ? 'Cantidad propuesta, no aplicada' : 'Cantidad final propuesta'} value={`${signed(targetEffect)} unidades`} meta="Reemplaza la cantidad anterior; no se suma a ella" /></div>
      {selfRequested && <Alert variant="warning" title="Revisión pendiente">Esta solicitud fue creada por tu usuario. Por separación de funciones, otro JEFE debe aprobarla o rechazarla.</Alert>}
      {correction.compensatingMovement && <Alert variant="success">Se creó el movimiento compensatorio. El movimiento original se conserva sin cambios.</Alert>}
      {correction.reviewedBy && correction.reviewedAt && <p>{correction.status === 'APPROVED' ? 'Aplicada' : 'Rechazada'} por {correction.reviewedBy.displayName} · {dateTime(correction.reviewedAt)}</p>}
    </div>
  </Dialog>;
}
function ConfirmReview({ open, action, correction, busy, error, onClose, onConfirm }: { open: boolean; action: 'approve' | 'reject' | null; correction: Correction | null; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) { if (!correction || !action) return null; return <Dialog open={open} onClose={onClose} title={action === 'approve' ? 'Aprobar corrección' : 'Rechazar corrección'} description={action === 'approve' ? 'Confirma la aplicación de la compensación.' : 'Confirma que esta solicitud no será aplicada.'} busy={busy} actions={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button variant={action === 'approve' ? 'primary' : 'danger'} onClick={onConfirm} loading={busy}>{action === 'approve' ? 'Aprobar corrección' : 'Rechazar corrección'}</Button></>}>{error && <Alert variant="danger">{error}</Alert>}<div className="corrections-confirm-values"><Detail label="Antes" value={signed(correction.previousQuantity)} /><Detail label="Cantidad final" value={signed(correction.correctedQuantity)} /><Detail label="Diferencia de stock" value={signed(correction.delta)} /></div><p className="corrections-confirm-note">{action === 'approve' ? 'Esta acción creará un movimiento compensatorio y no modificará el movimiento original.' : 'La solicitud quedará cerrada como rechazada y el movimiento original permanecerá intacto.'}</p></Dialog>; }
function MovementIcon({ type }: { type: MovementType }) { if (type === 'EXIT') return <Icon size="sm"><path d="M5 12h14M13 6l6 6-6 6" /></Icon>; if (type === 'RETURN') return <Icon size="sm"><path d="M19 12H5M11 6l-6 6 6 6" /></Icon>; if (type === 'ADJUSTMENT') return <Icon size="sm"><path d="M5 12h14M12 5v14" /></Icon>; return <Icon size="sm"><path d="M12 19V5M6 11l6-6 6 6" /></Icon>; }
function ProductIcon() { return <Icon size="sm"><path d="m4 7 8-4 8 4-8 4-8-4Z" /><path d="M4 7v10l8 4 8-4V7M12 11v10" /></Icon>; }
function PersonIcon() { return <Icon size="sm"><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></Icon>; }
function EyeIcon() { return <Icon size="sm"><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2" /></Icon>; }
function CalendarIcon() { return <Icon size="sm"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Icon>; }
function StatusIcon({ status }: { status: Status }) { if (status === 'APPROVED') return <Icon size="sm"><path d="m5 12 4 4L19 6" /></Icon>; if (status === 'REJECTED') return <Icon size="sm"><path d="m7 7 10 10M17 7 7 17" /></Icon>; return <Icon size="sm"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 1.5" /></Icon>; }
function SearchIcon() { return <Icon size="sm"><circle cx="10.8" cy="10.8" r="6.2" /><path d="m16 16 4 4" /></Icon>; }
function PlusIcon() { return <Icon size="sm"><path d="M12 5v14M5 12h14" /></Icon>; }
function FilterIcon() { return <Icon size="sm"><path d="M4 6h16M7 12h10M10 18h4" /></Icon>; }
function ChevronIcon({ open }: { open: boolean }) { return <Icon size="sm" className={open ? "corrections-chevron corrections-chevron-open" : "corrections-chevron"}><path d="m6 9 6 6 6-6" /></Icon>; }
function ResetIcon() { return <Icon size="sm"><path d="M4 5v5h5" /><path d="M5.5 15a7 7 0 1 0 1-8.5L4 10" /></Icon>; }
function CorrectionDialogIcon() { return <Icon size="sm"><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h5M8 16h4" /></Icon>; }
function NumberHeaderIcon() { return <Icon size="sm"><path d="M7 5v14M17 5v14M4 9h16M4 15h16" /></Icon>; }
function ClipboardIcon() { return <Icon size="lg"><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5V3h6v1.5M8.5 10h7M8.5 14h7M8.5 18h4" /></Icon>; }
