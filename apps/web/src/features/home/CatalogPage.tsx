import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { environment } from '../../config/environment';
import { productMetadataLabel, type ProductMetadata } from './inventory-metadata';
import { ApiRequestError, apiRequest, getApiErrorMessage, getApiFieldErrors, getCsrfToken } from '../../lib/api';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Icon,
  ListFooter,
  ModuleFilters,
  ModuleHeader,
  PageContainer,
  OverflowText,
  Select,
  Switch,
  useToast,
  useRequestError,
  type DataTableColumn
} from '../../ui';
import { useAuth } from '../auth/auth-context';

const PAGE_SIZE = 25;
const COMPACT_DATE_FORMATTER = new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });

type Product = { id: string; name: string; sku: string | null; trackingMode: 'QUANTITY' | 'ASSET'; lowStockThreshold: number; active: boolean; updatedAt: string } & ProductMetadata;
type Page<T> = { items: T[]; total: number; limit: number; offset: number; hasMore: boolean };

const emptyPage: Page<never> = { items: [], total: 0, limit: PAGE_SIZE, offset: 0, hasMore: false };

export function CatalogPage() {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const canManage = user?.role === 'JEFE';
  const { showToast } = useToast();
  const reportError = useRequestError();
  const [products, setProducts] = useState<Page<Product>>(emptyPage);
  const [productSearch, setProductSearch] = useState('');
  const [productSearchInput, setProductSearchInput] = useState('');
  const [activeFilter, setActiveFilter] = useState('true');
  const [productLoading, setProductLoading] = useState(true);
  const [productLoadingMore, setProductLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productForm, setProductForm] = useState<Product | null>(null);
  const [productEditorOpen, setProductEditorOpen] = useState(false);
  const [toggleTarget, setToggleTarget] = useState<Product | null>(null);
  const [toggleOpen, setToggleOpen] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const productRequestId = useRef(0);

  useEffect(() => {
    const productQuery = searchParams.get('product');
    if (productQuery) setProductSearchInput(productQuery);
  }, [searchParams]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => setProductSearch(productSearchInput.trim()), 300);
    return () => globalThis.clearTimeout(timeout);
  }, [productSearchInput]);

  const loadProducts = useCallback(async (offset = 0) => {
    const requestId = ++productRequestId.current;
    if (offset === 0) setProductLoading(true); else setProductLoadingMore(true);
    setError(null);
    try {
      const query = new globalThis.URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (activeFilter) query.set('active', activeFilter);
      if (productSearch) query.set('search', productSearch);
      const result = await apiRequest<{ products: Product[]; total: number; limit: number; offset: number; hasMore: boolean }>(`/products?${query.toString()}`);
      if (requestId !== productRequestId.current) return;
      setProducts((current) => offset === 0
        ? { items: result.products, total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore }
        : { ...result, items: [...current.items, ...result.products] });
    } catch (caughtError) {
      if (requestId === productRequestId.current) setError(getApiErrorMessage(caughtError, 'No se pudieron cargar los productos.'));
    } finally {
      if (requestId === productRequestId.current) { setProductLoading(false); setProductLoadingMore(false); }
    }
  }, [activeFilter, productSearch]);

  useEffect(() => { setProducts(emptyPage); void loadProducts(); }, [loadProducts]);

  async function toggle(item: Product) {
    setToggleBusy(true);
    setToggleError(null);
    try {
      const token = await getCsrfToken();
      await apiRequest(`/products/${item.id}/${item.active ? 'deactivate' : 'activate'}`, { method: 'POST', headers: { 'X-CSRF-Token': token } });
      const nextActive = !item.active;
      showToast({
        tone: 'success',
        title: `Producto ${nextActive ? 'activado' : 'inactivado'}`,
        description: `${item.name} ${nextActive ? 'volvió a estar disponible en el catálogo.' : 'dejó de estar disponible para nuevas operaciones.'}`
      });
      setToggleOpen(false);
      await loadProducts();
    } catch (caughtError) {
      setToggleError(reportError(caughtError, 'No se pudo cambiar el estado'));
    } finally {
      setToggleBusy(false);
    }
  }

  return <PageContainer fluid className="catalog-page">
    <div className="catalog-surface catalog-surface-products">
      <ModuleHeader className="catalog-module-header" title="Productos" description="Administra los productos que alimentan tus operaciones de inventario." action={canManage && <Button onClick={() => { setProductForm({ id: '', name: '', sku: null, trackingMode: 'QUANTITY', lowStockThreshold: 0, active: true, updatedAt: '' }); setProductEditorOpen(true); }}><PlusIcon />Nuevo producto</Button>} />
      {error && <Alert variant="danger" icon={<AlertIcon />} className="mt-5" action={<Button variant="secondary" size="sm" onClick={() => void loadProducts()}>Reintentar</Button>}>{error}</Alert>}
      <div className="catalog-tab-panel" id="catalog-panel" role="region" aria-label="Productos del catálogo">
        <ProductList
          page={products}
          search={productSearchInput}
          loading={productLoading}
          loadingMore={productLoadingMore}
          loadError={error ?? undefined}
          canManage={canManage}
          activeFilter={activeFilter}
          onSearch={setProductSearchInput}
          onResetSearch={() => setProductSearchInput('')}
          onActiveFilterChange={setActiveFilter}
          onLoadMore={() => void loadProducts(products.offset + products.limit)}
          onCreate={() => { setProductForm({ id: '', name: '', sku: null, trackingMode: 'QUANTITY', lowStockThreshold: 0, active: true, updatedAt: '' }); setProductEditorOpen(true); }}
          onEdit={(product) => { setProductForm(product); setProductEditorOpen(true); }}
          onToggle={(product) => { setToggleTarget(product); setToggleOpen(true); }}
        />
      </div>
    </div>
    {productForm && <ProductEditor key={productForm.id} open={productEditorOpen} product={productForm} close={() => setProductEditorOpen(false)} exited={() => setProductForm(null)} saved={(name) => { setProductEditorOpen(false); showToast({ tone: 'success', title: productForm.id ? 'Producto actualizado' : 'Producto creado', description: `${name} se guardó correctamente.` }); void loadProducts(); }} />}
    {toggleTarget && <ConfirmDialog className="catalog-editor-dialog" error={toggleError} open={toggleOpen} loading={toggleBusy} onClose={() => setToggleOpen(false)} onExited={() => { setToggleTarget(null); setToggleError(null); }} onConfirm={() => void toggle(toggleTarget)} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon catalog-dialog-icon-product"><ProductIcon /></span>{toggleTarget.active ? 'Inactivar producto' : 'Activar producto'}</span>} description={toggleTarget.active ? `${toggleTarget.name} dejará de estar disponible para nuevas operaciones. Su historial y existencias se conservarán.` : `${toggleTarget.name} volverá a estar disponible para nuevas operaciones.`} confirmLabel={toggleTarget.active ? 'Inactivar' : 'Activar'} danger={toggleTarget.active} />}
  </PageContainer>;
}

function CatalogTableHeader({ icon, children }: { icon: ReactNode; children: ReactNode }) { return <span className="catalog-table-header">{icon}{children}</span>; }

function ProductList({ page, search, loading, loadingMore, loadError, canManage, activeFilter, onSearch, onResetSearch, onActiveFilterChange, onLoadMore, onCreate, onEdit, onToggle }: { page: Page<Product>; search: string; loading: boolean; loadingMore: boolean; loadError?: string; canManage: boolean; activeFilter: string; onSearch: (value: string) => void; onResetSearch: () => void; onActiveFilterChange: (value: string) => void; onLoadMore: () => void; onCreate: () => void; onEdit: (product: Product) => void; onToggle: (product: Product) => void }) {
  const columns: Array<DataTableColumn<Product>> = [
    { key: 'name', mobileRole: 'identity', mobileLabel: 'Producto', header: <CatalogTableHeader icon={<ProductIcon />}>Producto</CatalogTableHeader>, className: 'catalog-col-identity', render: (product) => <div><CatalogIdentity icon={<ProductIcon />} name={product.name} updatedAt={product.updatedAt} secondary />{environment.inventoryMetadataV1 && productMetadataLabel(product) && <small className="inventory-product-metadata">{productMetadataLabel(product)}</small>}</div> },
    { key: 'tracking', mobileLabel: 'Seguimiento', header: <CatalogTableHeader icon={<QuantityTableIcon />}>Seguimiento</CatalogTableHeader>, className: 'catalog-col-tracking', render: (product) => <TrackingBadge mode={product.trackingMode} /> },
    { key: 'sku', mobileRole: 'full', mobileLabel: 'SKU', header: <CatalogTableHeader icon={<TagIcon />}>SKU</CatalogTableHeader>, className: 'catalog-col-sku', render: (product) => <OverflowText className="catalog-mono" text={product.sku || '—'} /> },
    { key: 'threshold', mobileLabel: 'Umbral de stock', header: <CatalogTableHeader icon={<AlertIcon />}>Umbral</CatalogTableHeader>, className: 'catalog-col-threshold', render: (product) => product.lowStockThreshold > 0 ? <span className="catalog-threshold-value">{product.lowStockThreshold} uds.</span> : <span className="catalog-threshold-value catalog-threshold-empty">Sin alerta</span> },
    { key: 'status', mobileLabel: 'Estado', header: <CatalogTableHeader icon={<CheckIcon />}>Estado</CatalogTableHeader>, className: 'catalog-col-status', render: (product) => <StatusBadge active={product.active} /> },
    { key: 'actions', mobileRole: 'actions', mobileLabel: 'Acciones', header: <CatalogTableHeader icon={<EditIcon />}>Acciones</CatalogTableHeader>, className: 'catalog-table-actions catalog-col-actions', render: (product) => <RowActions active={product.active} canManage={canManage} name={product.name} onEdit={() => onEdit(product)} onToggle={() => onToggle(product)} /> }
  ];
  return <CatalogList search={search} onSearch={onSearch} onResetSearch={onResetSearch} onClearEmpty={onResetSearch} canManage={canManage} onCreate={onCreate} filters={<StatusFilter value={activeFilter} onChange={onActiveFilterChange} />} page={page} loading={loading} loadingMore={loadingMore} loadError={loadError} columns={columns} onLoadMore={onLoadMore} caption="Productos del catálogo" emptySearch={Boolean(search)} />;
}

function CatalogList<Row extends { id: string }>({ search, onSearch, onResetSearch, onClearEmpty, canManage, onCreate, filters, page, loading, loadingMore, loadError, columns, onLoadMore, caption, emptySearch }: { search: string; onSearch: (value: string) => void; onResetSearch: () => void; onClearEmpty: () => void; canManage: boolean; onCreate: () => void; filters: ReactNode; page: Page<Row>; loading: boolean; loadingMore: boolean; loadError?: string; columns: Array<DataTableColumn<Row>>; onLoadMore: () => void; caption: string; emptySearch: boolean }) {
  const searchInputId = useId();
  const inputRef = useRef<globalThis.HTMLInputElement>(null);
  const empty = <EmptyState icon={<SearchIcon />} title={emptySearch ? 'No encontramos coincidencias' : 'Todavía no hay productos'} description={emptySearch ? 'Prueba con otro nombre o SKU.' : 'Cuando se cree el primer producto aparecerá aquí.'} action={emptySearch ? <Button variant="secondary" size="sm" onClick={onClearEmpty}>Limpiar búsqueda</Button> : undefined} />;
  return <section className="catalog-section catalog-section-product"><ModuleFilters className="catalog-toolbar" ariaLabel="Filtros de productos"><div className="catalog-search"><label htmlFor={searchInputId}>Buscar productos</label><span className="catalog-search-control"><SearchIcon /><input id={searchInputId} ref={inputRef} value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Nombre o SKU" /><Button variant="ghost" size="sm" iconOnly className={`catalog-clear ${search ? 'catalog-clear-visible' : ''}`} aria-label="Limpiar búsqueda" tabIndex={search ? 0 : -1} onClick={() => { onResetSearch(); inputRef.current?.focus({ preventScroll: true }); }}><CloseIcon /></Button></span></div><div className="catalog-filters">{filters}</div></ModuleFilters><DataTable className="catalog-data-table" rows={page.items} columns={columns} getRowKey={(row) => row.id} caption={caption} error={page.items.length === 0 ? loadError : undefined} loading={loading} loadingRows={6} empty={empty} density="comfortable" /><LoadMore page={page} error={loadError} loading={loadingMore} onLoadMore={onLoadMore} /></section>;
}

function StatusFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <FilterSelect label="Estado" value={value} onChange={onChange} options={[{ value: 'true', label: 'Activos' }, { value: 'false', label: 'Inactivos' }]} emptyLabel="Todos" />; }
function FilterSelect({ label, value, onChange, options, emptyLabel }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; emptyLabel: string }) { const labelId = useId(); return <div className="catalog-filter"><span id={labelId}>{label}</span><Select className="catalog-filter-select" aria-labelledby={labelId} value={value} onChange={onChange} options={[{ value: '', label: emptyLabel }, ...options]} /></div>; }
function StatusBadge({ active }: { active: boolean }) { return <Badge className={active ? 'catalog-status-badge catalog-status-badge-active' : 'catalog-status-badge catalog-status-badge-inactive'} variant={active ? 'success' : 'neutral'}><span className="catalog-status-icon" aria-hidden="true">{active ? <CheckIcon /> : <CloseIcon />}</span>{active ? 'Activo' : 'Inactivo'}</Badge>; }
function TrackingBadge({ mode }: { mode: Product['trackingMode'] }) { return <Badge className={`catalog-tracking-badge ${mode === 'ASSET' ? 'catalog-tracking-badge-asset' : 'catalog-tracking-badge-quantity'}`} variant={mode === 'ASSET' ? 'info' : 'default'}><span className="catalog-tracking-icon" aria-hidden="true">{mode === 'ASSET' ? <AssetTableIcon /> : <QuantityTableIcon />}</span>{mode === 'ASSET' ? 'Por activo' : 'Por cantidad'}</Badge>; }
function CatalogIdentity({ icon, name, updatedAt, secondary = false }: { icon: ReactNode; name: string; updatedAt: string; secondary?: boolean }) { return <div className="catalog-name-cell"><span className={`catalog-row-icon ${secondary ? 'catalog-row-icon-secondary' : ''}`}>{icon}</span><span className="catalog-name-copy"><OverflowText as="strong" text={name} /><small>Actualizado {formatCompactDate(updatedAt)}</small></span></div>; }
function RowActions({ active, canManage, name, onEdit, onToggle }: { active: boolean; canManage: boolean; name: string; onEdit: () => void; onToggle: () => void }) { if (!canManage) return <span className="catalog-muted catalog-read-only">Solo lectura</span>; return <div className="catalog-row-actions"><Button className="catalog-edit-action" variant="ghost" size="sm" onClick={onEdit}><EditIcon />Editar</Button><span className="catalog-switch-action"><Switch checked={active} onCheckedChange={onToggle} aria-label={`${active ? 'Inactivar' : 'Activar'} ${name}`} title={`${active ? 'Inactivar' : 'Activar'} ${name}`} /></span></div>; }

function formatCompactDate(value: string) { if (!value) return '—'; return COMPACT_DATE_FORMATTER.format(new Date(value)); }

function LoadMore({ page, loading, error, onLoadMore }: { page: Page<unknown>; loading: boolean; error?: string; onLoadMore: () => void }) {
  return <ListFooter loaded={page.items.length} total={page.total} hasMore={page.hasMore} loading={loading} onLoadMore={onLoadMore} />;
}

function ProductEditor({ open, product, close, exited, saved }: { open: boolean; product: Product; close: () => void; exited: () => void; saved: (name: string) => void }) {
  const reportError = useRequestError();
  const [form, setForm] = useState(() => ({ name: product.name, sku: product.sku ?? '', trackingMode: product.trackingMode, lowStockThreshold: String(product.lowStockThreshold), equipmentType: product.equipmentType ?? '', brand: product.brand ?? '', model: product.model ?? '' }));
  const [errors, setErrors] = useState<Partial<Record<'name' | 'sku' | 'trackingMode' | 'lowStockThreshold' | 'equipmentType' | 'brand' | 'model', string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError(null);
    const validation: typeof errors = {};
    if (!form.name.trim()) validation.name = 'Escribe un nombre para el producto.';
    if (!form.lowStockThreshold.trim() || !Number.isInteger(Number(form.lowStockThreshold)) || Number(form.lowStockThreshold) < 0 || Number(form.lowStockThreshold) > 2147483647) validation.lowStockThreshold = 'Ingresa un entero entre 0 y 2.147.483.647.';
    setErrors(validation);
    if (Object.keys(validation).length) {
      globalThis.requestAnimationFrame(() => globalThis.document.querySelector<globalThis.HTMLElement>('#product-editor-form [aria-invalid="true"]')?.focus());
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const token = await getCsrfToken();
      const body = { name: form.name.trim(), sku: form.sku.trim() || null, trackingMode: form.trackingMode, lowStockThreshold: Number(form.lowStockThreshold), ...(environment.inventoryMetadataV1 ? { equipmentType: form.equipmentType.trim() || null, brand: form.brand.trim() || null, model: form.model.trim() || null } : {}) };
      await apiRequest(product.id ? `/products/${product.id}` : '/products', { method: product.id ? 'PATCH' : 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify(body) });
      saved(form.name.trim());
    } catch (caughtError) {
      setError(reportError(caughtError, 'No se pudo guardar el producto'));
      if (caughtError instanceof ApiRequestError && caughtError.code === 'CONFLICT') {
        const field = caughtError.message.toLowerCase().includes('sku') ? 'sku' : 'name';
        setErrors({ [field]: field === 'sku' ? 'Este SKU ya está registrado.' : 'Ya existe un producto con este nombre.' });
      } else setErrors(getApiFieldErrors(caughtError, { name: 'name', sku: 'sku', lowStockThreshold: 'lowStockThreshold', trackingMode: 'trackingMode', equipmentType: 'equipmentType', brand: 'brand', model: 'model' }));
    } finally { submitting.current = false; setBusy(false); }
  }
  return <Dialog className="catalog-editor-dialog" open={open} onClose={close} onExited={exited} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon catalog-dialog-icon-product"><ProductIcon /></span>{product.id ? 'Editar producto' : 'Nuevo producto'}</span>} description="Define la identidad del producto y cómo se controlará dentro de Inventory TI." busy={busy} actions={<EditorActions formId="product-editor-form" close={close} busy={busy} />}>
    <form id="product-editor-form" noValidate onSubmit={submit}>
      {error && <Alert variant="danger">{error}</Alert>}
      <div className="space-y-5">
        <Field label="Nombre" required error={errors.name} disabled={busy}><input maxLength={160} value={form.name} onChange={(event) => { setForm({ ...form, name: event.target.value }); setErrors((current) => ({ ...current, name: undefined })); }} placeholder="Ej. Monitor 24 pulgadas" /></Field>
        {environment.inventoryMetadataV1 && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo de equipo" hint="Opcional" error={errors.equipmentType} disabled={busy}><input maxLength={100} value={form.equipmentType} onChange={(event) => { setForm({ ...form, equipmentType: event.target.value }); setErrors((current) => ({ ...current, equipmentType: undefined })); }} placeholder="Ej. Notebook" /></Field>
          <Field label="Marca" hint="Opcional" error={errors.brand} disabled={busy}><input maxLength={100} value={form.brand} onChange={(event) => { setForm({ ...form, brand: event.target.value }); setErrors((current) => ({ ...current, brand: undefined })); }} placeholder="Ej. HP" /></Field>
          <Field label="Modelo" hint="Opcional" error={errors.model} disabled={busy}><input maxLength={160} value={form.model} onChange={(event) => { setForm({ ...form, model: event.target.value }); setErrors((current) => ({ ...current, model: undefined })); }} placeholder="Ej. EliteBook 840 G8" /></Field>
        </div>}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="SKU" hint="Opcional" error={errors.sku} disabled={busy}><input maxLength={100} value={form.sku} onChange={(event) => { setForm({ ...form, sku: event.target.value }); setErrors((current) => ({ ...current, sku: undefined })); }} placeholder="Ej. MON-24-001" /></Field>
          <Field label={form.trackingMode === 'ASSET' ? 'Mínimo de equipos disponibles' : 'Umbral de stock'} required error={errors.lowStockThreshold} disabled={busy} hint={form.trackingMode === 'ASSET' ? (environment.inventoryMetadataV1 ? 'Solo cuenta equipos en estado Disponible. Cero desactiva la alerta.' : 'La alerta de activos requiere habilitar la disponibilidad V1.') : 'Cero desactiva la alerta.'}><input type="number" min="0" max={2147483647} step="1" value={form.lowStockThreshold} onChange={(event) => { setForm({ ...form, lowStockThreshold: event.target.value }); setErrors((current) => ({ ...current, lowStockThreshold: undefined })); }} /></Field>
        </div>
        <Field label="Seguimiento" required error={errors.trackingMode} disabled={busy}><Select className="catalog-editor-select" value={form.trackingMode} onChange={(trackingMode) => setForm({ ...form, trackingMode: trackingMode as Product['trackingMode'] })} options={[{ value: 'QUANTITY', label: 'Por cantidad' }, { value: 'ASSET', label: 'Por activo individual' }]} /></Field>
      </div>
    </form>
  </Dialog>;
}

function EditorActions({ formId, close, busy }: { formId: string; close: () => void; busy: boolean }) { return <><Button variant="secondary" onClick={close} disabled={busy}>Cancelar</Button><Button form={formId} type="submit" loading={busy}><CheckIcon />{busy ? 'Guardando…' : 'Guardar'}</Button></>; }

function LineIcon({ children, className = '' }: { children: ReactNode; className?: string }) { return <Icon className={`catalog-icon-svg ${className}`}>{children}</Icon>; }
function ProductIcon() { return <LineIcon><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></LineIcon>; }
function AssetTableIcon() { return <LineIcon><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 9h8M8 13h5" /></LineIcon>; }
function QuantityTableIcon() { return <LineIcon><path d="M5 19h14M7 16V9M12 16V5M17 16v-4" /></LineIcon>; }
function TagIcon() { return <LineIcon><path d="M4 5v6l9 9 7-7-9-9H4Z" /><path d="M8 8h.01" /></LineIcon>; }
function SearchIcon() { return <LineIcon><circle cx="10.8" cy="10.8" r="6.2" /><path d="m16 16 4 4" /></LineIcon>; }
function PlusIcon() { return <LineIcon><path d="M12 5v14M5 12h14" /></LineIcon>; }
function EditIcon() { return <LineIcon><path d="m4 16.5-.8 3.3 3.3-.8L18 7.5 15.5 5 4 16.5Z" /><path d="m14.5 6 2.5 2.5" /></LineIcon>; }
function AlertIcon() { return <LineIcon><path d="m12 4 9 16H3L12 4Z" /><path d="M12 9v5M12 17h.01" /></LineIcon>; }
function CheckIcon() { return <LineIcon><path d="m5 12 4 4L19 6" /></LineIcon>; }
function CloseIcon() { return <LineIcon><path d="m6 6 12 12M18 6 6 18" /></LineIcon>; }
