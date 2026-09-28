import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { ApiRequestError, apiRequest, getApiErrorMessage, getApiFieldErrors } from '../../lib/api';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Icon, ListFooter, OverflowText, PageContainer, Select, TableSkeleton, useToast, useRequestError } from '../../ui';
import { useAuth } from '../auth/auth-context';
import { assetStatusDescriptions, assetStatusLabels as statusLabels, getAssetStatusOptions, type AssetStatus } from './asset-status';

type Mode = 'QUANTITY' | 'ASSET';
type MovementType = 'INITIAL' | 'ENTRY' | 'EXIT' | 'RETURN' | 'ADJUSTMENT';
type Product = { id: string; name: string; sku: string | null; trackingMode: Mode; lowStockThreshold?: number | null };
type Stock = { id: string; productId: string; quantity: number };
type Asset = { id: string; assetTag: string | null; serialNumber: string | null; status: AssetStatus; isActive?: boolean; product: Product };
type AssignmentRecord = { id: string; personName: string; startedAt: string; endedAt: string | null; createdBy?: { displayName: string } | null; endedBy?: { displayName: string } | null };
type Movement = { id: string; movementType: MovementType; quantity: number; effectiveAt: string; performedBy?: { displayName: string } | null; reason?: string | null };
type CorrectedMovement = Movement & { originalQuantity: number; effectiveQuantity: number; balanceBefore: number; balanceAfter: number; correctionDelta: number };
type QuantityHistory = { stockQuantity: number; historyQuantity: number; isConsistent: boolean; hasNegativeBalance: boolean; movements: CorrectedMovement[]; compensatingMovements: Movement[] };
type HistoryEvent = { id: string; kind: "movement" | "status" | "assignment"; movementType?: MovementType; quantity?: number; originalQuantity?: number; balanceBefore?: number; balanceAfter?: number; correctionDelta?: number; effectiveAt: string; actor?: string | null; reason?: string | null; action?: string; person?: string; metadata?: unknown };

async function request<T>(path: string, options: globalThis.RequestInit = {}): Promise<T> {
  return apiRequest<T>(path, options);
}
async function csrf() { return (await request<{ csrfToken: string }>('/auth/csrf')).csrfToken; }

const movementLabels: Record<MovementType, string> = { INITIAL: 'Stock inicial', ENTRY: 'Entrada', EXIT: 'Salida', RETURN: 'Devolución', ADJUSTMENT: 'Ajuste' };

export function InventoryPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const reportError = useRequestError();
  const canAdjust = user?.role === 'JEFE' || user?.role === 'COORDINADOR';
  const [tab, setTab] = useState<'quantity' | 'assets'>('quantity');
  const [products, setProducts] = useState<Product[]>([]);
  const [stock, setStock] = useState<Stock[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [searchParams] = useSearchParams();
  const focusedProduct = searchParams.get('product') ?? '';
  const [search, setSearch] = useState(focusedProduct);
  const [assetStatus, setAssetStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [movementOpen, setMovementOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [movement, setMovement] = useState({ type: 'ENTRY' as MovementType, productId: '', quantity: '1', reason: '' });
  const [movementErrors, setMovementErrors] = useState<Partial<Record<'type' | 'productId' | 'quantity', string>>>({});
  const [assetErrors, setAssetErrors] = useState<Partial<Record<'productId' | 'assetTag' | 'serialNumber', string>>>({});
  const [quantityVisible, setQuantityVisible] = useState(25);
  const [assetsVisible, setAssetsVisible] = useState(25);
  const [traceProduct, setTraceProduct] = useState<{ id: string; name: string; assetId?: string } | null>(null);
  const [assignmentAsset, setAssignmentAsset] = useState<Asset | null>(null);
  const [assetEditTarget, setAssetEditTarget] = useState<Asset | null>(null);
  const [statusTarget, setStatusTarget] = useState<Asset | null>(null);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [asset, setAsset] = useState({ productId: '', assetTag: '', serialNumber: '' });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [productResult, stockResult, assetResult] = await Promise.all([
        request<{ products: Product[] }>('/products?active=true&limit=100'),
        request<{ stock: Stock[] }>('/inventory/stock'),
        request<{ assets: Asset[] }>('/assets?isActive=true'),
      ]);
      setProducts(productResult.products); setStock(stockResult.stock); setAssets(assetResult.assets);
      setMovement((current) => {
        const productId = current.productId || productResult.products.find((item) => item.trackingMode === 'QUANTITY')?.id || '';
        return { ...current, productId };
      });
      setAsset((current) => ({ ...current, productId: current.productId || productResult.products.find((item) => item.trackingMode === 'ASSET')?.id || '' }));
    } catch (caughtError) { setError(getApiErrorMessage(caughtError, 'No se pudo cargar el inventario.')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setQuantityVisible(25); setAssetsVisible(25); }, [search, assetStatus]);
  useEffect(() => { if (focusedProduct) { setTab('quantity'); setSearch(focusedProduct); } }, [focusedProduct]);

  const quantityProducts = useMemo(() => products.filter((item) => item.trackingMode === 'QUANTITY'), [products]);
  const assetProducts = useMemo(() => products.filter((item) => item.trackingMode === 'ASSET'), [products]);
  const rows = useMemo(() => {
    const byProduct = new Map<string, number>();
    for (const item of stock) byProduct.set(item.productId, (byProduct.get(item.productId) ?? 0) + item.quantity);
    const query = search.trim().toLocaleLowerCase('es-CL');
    return quantityProducts.map((product) => ({ product, quantity: byProduct.get(product.id) ?? 0 })).filter(({ product }) => `${product.name} ${product.sku ?? ''}`.toLocaleLowerCase('es-CL').includes(query));
  }, [quantityProducts, search, stock]);
  const filteredAssets = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('es-CL');
    return assets.filter((item) => (!assetStatus || item.status === assetStatus) && `${item.product.name} ${item.assetTag ?? ''} ${item.serialNumber ?? ''}`.toLocaleLowerCase('es-CL').includes(query));
  }, [assetStatus, assets, search]);
  const visibleRows = rows.slice(0, quantityVisible);
  const visibleAssets = filteredAssets.slice(0, assetsVisible);
  const totalUnits = rows.reduce((total, row) => total + row.quantity, 0);
  const lowStock = rows.filter(({ product, quantity }) => (product.lowStockThreshold ?? 0) > 0 && quantity <= (product.lowStockThreshold ?? 0)).length;

  function updateMovement(next: typeof movement) {
    setMovementErrors((current) => ({ ...current, ...(next.type !== movement.type ? { type: undefined, quantity: undefined } : {}), ...(next.productId !== movement.productId ? { productId: undefined } : {}), ...(next.quantity !== movement.quantity ? { quantity: undefined } : {}) }));
    setMovement(next);
  }

  async function saveMovement(event: FormEvent) {
    event.preventDefault();
    const validation: typeof movementErrors = {};
    if (!movement.productId) validation.productId = 'Selecciona un producto.';
    const quantity = Number(movement.quantity);
    if (!Number.isInteger(quantity) || (movement.type === 'ADJUSTMENT' ? quantity === 0 : quantity < 1)) validation.quantity = movement.type === 'ADJUSTMENT' ? 'Ingresa un ajuste entero distinto de cero.' : 'Ingresa una cantidad entera mayor que cero.';
    setMovementErrors(validation);
    if (Object.keys(validation).length) return;
    setSaving(true);
    try {
      const token = await csrf();
      await request(`/inventory/movements/${movement.type.toLowerCase()}`, { method: 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify({ productId: movement.productId, quantity: Number(movement.quantity), reason: movement.reason || null }) });
      showToast({ tone: 'success', title: 'Movimiento registrado', description: `${movementLabels[movement.type]} añadido al inventario.` });
      setMovementErrors({}); setMovementOpen(false); setMovement((current) => ({ ...current, quantity: '1', reason: '' })); await load();
    } catch (caughtError) {
      reportError(caughtError, 'No se pudo registrar el movimiento');
      if (caughtError instanceof ApiRequestError) {
        if (caughtError.code === 'INSUFFICIENT_STOCK') setMovementErrors({ quantity: getApiErrorMessage(caughtError, 'No hay stock suficiente para esta cantidad.') });
        else if (caughtError.code === 'PRODUCT_INACTIVE' || caughtError.code === 'ASSET_PRODUCT_UNSUPPORTED') setMovementErrors({ productId: getApiErrorMessage(caughtError, 'Selecciona un producto disponible.') });
        else if (caughtError.code === 'INITIAL_ALREADY_EXISTS') setMovementErrors({ type: 'Este producto ya tiene stock inicial. Cambia el tipo a Entrada.' });
        else if (caughtError.code === 'VALIDATION_ERROR') setMovementErrors(getApiFieldErrors(caughtError, { productId: 'productId', quantity: 'quantity', reason: 'reason' }));
      }
    }
    finally { setSaving(false); }
  }

  async function saveAsset(event: FormEvent) {
    event.preventDefault();
    const validation: typeof assetErrors = {};
    if (!assetEditTarget && !asset.productId) validation.productId = 'Selecciona un producto.';
    setAssetErrors(validation);
    if (Object.keys(validation).length) return;
    setSaving(true);
    try {
      const token = await csrf();
      const editing = assetEditTarget;
      const body = editing
        ? { assetTag: asset.assetTag.trim() || null, serialNumber: asset.serialNumber.trim() || null }
        : { productId: asset.productId, assetTag: asset.assetTag.trim() || null, serialNumber: asset.serialNumber.trim() || null };
      await request(editing ? `/assets/${editing.id}` : '/assets', { method: editing ? 'PATCH' : 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify(body) });
      showToast({ tone: 'success', title: editing ? 'Activo actualizado' : 'Activo añadido', description: editing ? 'Los identificadores del activo se actualizaron correctamente.' : 'El activo quedó disponible para seguimiento.' });
      setAssetErrors({}); setAssetOpen(false); setAssetEditTarget(null); setAsset((current) => ({ ...current, assetTag: '', serialNumber: '' })); await load();
    } catch (caughtError) {
      reportError(caughtError, 'No se pudo guardar el activo');
      if (caughtError instanceof ApiRequestError && caughtError.code === 'ASSET_IDENTIFIER_CONFLICT') {
        const details = caughtError.details;
        const field = typeof details === 'object' && details !== null && 'field' in details && (details.field === 'assetTag' || details.field === 'serialNumber') ? details.field : undefined;
        const message = 'Este identificador ya pertenece a otro activo.';
        setAssetErrors(field ? { [field]: message } : { assetTag: message, serialNumber: message });
      }
      else if (caughtError instanceof ApiRequestError && caughtError.code === 'PRODUCT_NOT_ASSET') setAssetErrors({ productId: getApiErrorMessage(caughtError, 'Selecciona un producto rastreable.') });
      else setAssetErrors(getApiFieldErrors(caughtError, { productId: 'productId', assetTag: 'assetTag', serialNumber: 'serialNumber' }));
    }
    finally { setSaving(false); }
  }

  return <PageContainer fluid className="catalog-page inventory-page">
    <div className="catalog-surface inventory-catalog-surface">
      <header className="catalog-command-deck catalog-command-deck-products inventory-command-deck">
        <div className="catalog-command-main">
          <span className="catalog-command-mark"><InventoryIcon /></span>
          <div className="catalog-command-copy">
            <span className="catalog-command-eyebrow">Inventario / Vista activa</span>
            <div className="catalog-command-title"><h1>{tab === 'quantity' ? 'Stock actual' : 'Activos rastreables'}</h1></div>
            <p>{tab === 'quantity' ? 'Consulta las existencias disponibles y detecta faltantes a tiempo.' : 'Controla cada equipo identificado durante todo su ciclo de vida.'}</p>
          </div>
        </div>
        <div className="catalog-page-stats inventory-page-stats">
          <span className="catalog-page-stat-primary"><small>{tab === 'quantity' ? 'Unidades disponibles' : 'Activos registrados'}</small><strong>{tab === 'quantity' ? totalUnits : assets.length}</strong></span>
          <span className="catalog-page-stat-accent"><small>{tab === 'quantity' ? 'Bajo stock' : 'Productos rastreables'}</small><strong>{tab === 'quantity' ? lowStock : assetProducts.length}</strong></span>
        </div>
        <div className="catalog-command-tabs inventory-command-tabs">
          <div className="catalog-tabs" role="tablist" aria-label="Secciones del inventario">
            <button className={tab === 'quantity' ? 'catalog-tab catalog-tab-product catalog-tab-active' : 'catalog-tab catalog-tab-product'} type="button" role="tab" aria-selected={tab === 'quantity'} onClick={() => { setTab('quantity'); setSearch(''); }}><InventoryIcon /><span>Stock por cantidad</span><b>{quantityProducts.length}</b></button>
            <button className={tab === 'assets' ? 'catalog-tab catalog-tab-assets catalog-tab-active' : 'catalog-tab catalog-tab-assets'} type="button" role="tab" aria-selected={tab === 'assets'} onClick={() => { setTab('assets'); setSearch(''); }}><AssetIcon /><span>Activos rastreables</span><b>{assets.length}</b></button>
          </div>
        </div>
      </header>
      {error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void load()}>Reintentar</Button>}>{error}</Alert>}
      <div className="catalog-tab-panel inventory-tab-panel">
        <div className="catalog-section catalog-section-product">
          <div className="catalog-toolbar inventory-toolbar">
            <label className="catalog-search inventory-catalog-search"><span>Buscar</span><span className="catalog-search-control"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === 'quantity' ? 'Nombre o SKU' : 'Activo, serie o producto'} aria-label="Buscar en inventario" /></span></label>
            <div className="catalog-filters">
              {tab === 'assets' && <label className="catalog-filter inventory-status-filter"><span>Estado</span><Select className="catalog-filter-select" value={assetStatus} onChange={setAssetStatus} placeholder="Todos los estados" options={[{ value: '', label: 'Todos los estados' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} /></label>}
              {tab === 'assets' && <Button onClick={() => { setAssetEditTarget(null); setAsset((current) => ({ ...current, assetTag: '', serialNumber: '' })); setAssetErrors({}); setAssetOpen(true); }} disabled={!assetProducts.length}><PlusIcon /> Añadir activo</Button>}
              {tab === 'quantity' && <Button onClick={() => { setMovementErrors({}); setMovementOpen(true); }} disabled={!quantityProducts.length}><MovementIcon /> Registrar movimiento</Button>}
            </div>
          </div>
          {tab === 'quantity' ? <QuantityTable loadFailed={Boolean(error)} rows={visibleRows} focusedProduct={focusedProduct} total={rows.length} loading={loading} hasMore={visibleRows.length < rows.length} onLoadMore={() => setQuantityVisible((value) => value + 25)} onOpen={(product) => setTraceProduct({ id: product.id, name: product.name })} /> : <AssetTable loadFailed={Boolean(error)} assets={visibleAssets} total={filteredAssets.length} loading={loading} hasMore={visibleAssets.length < filteredAssets.length} onLoadMore={() => setAssetsVisible((value) => value + 25)} onOpen={(product, assetId) => setTraceProduct({ id: product.id, name: product.name, assetId })} onAssignment={setAssignmentAsset} onStatusChange={user ? (item) => { if (!getAssetStatusOptions(user.role, item.status, item.isActive !== false).length) return; setStatusTarget(item); setStatusDialogOpen(true); } : undefined} onEdit={canAdjust ? (item) => { setAssetEditTarget(item); setAsset({ productId: item.product.id, assetTag: item.assetTag ?? '', serialNumber: item.serialNumber ?? '' }); setAssetErrors({}); setAssetOpen(true); } : undefined} />}
        </div>
      </div>
    </div>
    <MovementDialog open={movementOpen} busy={saving} products={quantityProducts} form={movement} errors={movementErrors} canAdjust={canAdjust} onClose={() => { setMovementErrors({}); setMovementOpen(false); }} onChange={updateMovement} onSubmit={saveMovement} />
    <MovementDetailDialog product={traceProduct} onClose={() => setTraceProduct(null)} />
    <AssetDialog errors={assetErrors} open={assetOpen} busy={saving} products={assetProducts} editing={assetEditTarget} form={asset} onClose={() => { setAssetOpen(false); setAssetEditTarget(null); setAssetErrors({}); }} onChange={(next) => { setAsset(next); setAssetErrors((current) => ({ ...current, ...(next.productId !== asset.productId ? { productId: undefined } : {}), ...(next.assetTag !== asset.assetTag ? { assetTag: undefined } : {}), ...(next.serialNumber !== asset.serialNumber ? { serialNumber: undefined } : {}) })); }} onSubmit={saveAsset} />
    <AssignmentDialog asset={assignmentAsset} onClose={() => setAssignmentAsset(null)} onSaved={() => { setAssignmentAsset(null); void load(); }} />
    {statusTarget && <AssetStatusDialog asset={statusTarget} open={statusDialogOpen} onClose={() => setStatusDialogOpen(false)} onExited={() => setStatusTarget(null)} onSaved={(updated) => { setAssets((current) => current.map((item) => item.id === updated.id ? updated : item)); setStatusDialogOpen(false); }} />}
  </PageContainer>;
}

function QuantityStatusBadge({ quantity, minimum }: { quantity: number; minimum: number }) {
  const status = quantity === 0 ? "out" : minimum > 0 && quantity <= minimum ? "low" : "available";
  const content = status === "out" ? { label: "Sin stock", variant: "danger" as const, icon: <path d="M5 5l14 14M9 4h6l4 4v8l-4 4H9l-4-4V8l4-4Z" /> } : status === "low" ? { label: "Bajo stock", variant: "warning" as const, icon: <><path d="m12 4 8 15H4L12 4Z" /><path d="M12 9v4M12 16h.01" /></> } : { label: "Disponible", variant: "success" as const, icon: <path d="m5 12 4 4L19 6" /> };
  return <Badge variant={content.variant} className={"inventory-stock-status inventory-stock-status-" + status}><Icon size="sm">{content.icon}</Icon><span>{content.label}</span></Badge>;
}
function Loading({ columns = 6 }: { columns?: number }) { return <TableSkeleton columns={columns} rows={6} label="Cargando inventario" />; }
function Empty({ text }: { text: string }) { return <EmptyState title={text} icon={<InventoryIcon />} />; }

function QuantityTable({ rows, loadFailed = false, focusedProduct, total, loading, hasMore, onLoadMore, onOpen }: { rows: Array<{ product: Product; quantity: number }>; focusedProduct?: string; loadFailed?: boolean; total: number; loading: boolean; hasMore: boolean; onLoadMore: () => void; onOpen: (product: Product) => void }) { return <section className="inventory-panel">{loading ? <Loading /> : loadFailed && rows.length === 0 ? null : rows.length === 0 ? <Empty text="No hay productos por cantidad para mostrar." /> : <><div className="inventory-table-wrap ui-record-table-shell ui-data-table-responsive"><table className="inventory-table ui-record-table"><thead><tr><th><InventoryTableHeader icon={<InventoryIcon />}>Producto</InventoryTableHeader></th><th><InventoryTableHeader icon={<TagIcon />}>SKU</InventoryTableHeader></th><th className="text-right"><InventoryTableHeader icon={<QuantityIcon />}>Disponible</InventoryTableHeader></th><th className="text-right"><InventoryTableHeader icon={<ThresholdIcon />}>Mínimo</InventoryTableHeader></th><th><InventoryTableHeader icon={<StatusTableIcon />}>Estado</InventoryTableHeader></th><th><InventoryTableHeader icon={<HistoryIcon />}>Historial</InventoryTableHeader></th></tr></thead><tbody>{rows.map(({ product, quantity }) => { const minimum = product.lowStockThreshold ?? 0; return <tr className={product.name === focusedProduct ? "inventory-row-focused" : undefined} key={product.id}><td data-label="Producto" data-card-role="identity"><ProductIdentity product={product} /></td><td data-label="SKU" data-card-role="full" className="inventory-muted"><OverflowText text={product.sku ?? "—"} /></td><td data-label="Disponible" data-card-role="field" className="text-right inventory-number">{quantity}</td><td data-label="Mínimo" data-card-role="field" className="text-right"><span className={minimum === 0 ? "inventory-threshold inventory-threshold-neutral" : "inventory-threshold inventory-threshold-warning"}>{minimum || "—"}</span></td><td data-label="Estado" data-card-role="full"><QuantityStatusBadge quantity={quantity} minimum={minimum} /></td><td data-label="Historial" data-card-role="actions"><button type="button" className="inventory-history-action" onClick={() => onOpen(product)}><HistoryIcon /> Ver historial</button></td></tr>; })}</tbody></table></div><LoadMore loaded={rows.length} total={total} hasMore={hasMore} onLoadMore={onLoadMore} /></>}</section>; }

function AssetStatusBadge({ status }: { status: AssetStatus }) { const content = status === "AVAILABLE" ? { label: "Disponible", variant: "success" as const, tone: "available", icon: <path d="m5 12 4 4L19 6" /> } : status === "ASSIGNED" ? { label: "Asignado", variant: "info" as const, tone: "assigned", icon: <><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></> } : status === "RESERVED" ? { label: "Reservado", variant: "info" as const, tone: "reserved", icon: <path d="M6 4h12v16l-6-3-6 3V4Z" /> } : status === "UNDER_REVIEW" ? { label: "En revisión", variant: "warning" as const, tone: "review", icon: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2.5" /></> } : status === "IN_REPAIR" ? { label: "En reparación", variant: "warning" as const, tone: "repair", icon: <><path d="m14.5 6.5 3-3 3 3-3 3" /><path d="m17.5 6.5-7 7M6 18h.01M4 20h4" /></> } : status === "IN_WARRANTY" ? { label: "En garantía", variant: "info" as const, tone: "warranty", icon: <path d="m12 3 7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4Z" /> } : status === "LOST" ? { label: "Extraviado", variant: "danger" as const, tone: "lost", icon: <><path d="M12 4 3.5 19h17L12 4Z" /><path d="M12 9v4M12 16h.01" /></> } : { label: "Dado de baja", variant: "neutral" as const, tone: "decommissioned", icon: <path d="M5 7h14M8 7V5h8v2M7 7l1 13h8l1-13M10 11v5M14 11v5" /> }; return <Badge variant={content.variant} className={"inventory-stock-status inventory-asset-status inventory-asset-status-" + content.tone}><Icon size="sm">{content.icon}</Icon><OverflowText text={content.label} /></Badge>; }

function AssetTable({ assets, loadFailed = false, total, loading, hasMore, onLoadMore, onOpen, onAssignment, onEdit, onStatusChange }: { assets: Asset[]; loadFailed?: boolean; total: number; loading: boolean; hasMore: boolean; onLoadMore: () => void; onOpen: (product: Product, assetId: string) => void; onAssignment: (asset: Asset) => void; onEdit?: (asset: Asset) => void; onStatusChange?: (asset: Asset) => void }) { return <section className="inventory-panel">{loading ? <Loading columns={5} /> : loadFailed && assets.length === 0 ? null : assets.length === 0 ? <Empty text="No hay activos que coincidan con los filtros." /> : <><div className="inventory-table-wrap ui-record-table-shell ui-data-table-responsive"><table className="inventory-table ui-record-table"><thead><tr><th><InventoryTableHeader icon={<AssetIcon />}>Activo</InventoryTableHeader></th><th><InventoryTableHeader icon={<InventoryIcon />}>Producto</InventoryTableHeader></th><th><InventoryTableHeader icon={<TagIcon />}>Número de serie</InventoryTableHeader></th><th><InventoryTableHeader icon={<StatusTableIcon />}>Estado</InventoryTableHeader></th><th><InventoryTableHeader icon={<AssignmentIcon />}>Acciones</InventoryTableHeader></th></tr></thead><tbody>{assets.map((item) => <tr key={item.id}><td data-label="Activo" data-card-role="full"><OverflowText as="strong" text={item.assetTag ?? "Sin etiqueta"} /></td><td data-label="Producto" data-card-role="identity"><ProductIdentity product={item.product} accent /></td><td data-label="Número de serie" data-card-role="full" className="inventory-muted"><OverflowText text={item.serialNumber ?? "—"} /></td><td data-label="Estado" data-card-role="full"><AssetStatusBadge status={item.status} /></td><td data-label="Acciones" data-card-role="actions"><div className="inventory-row-actions">{onEdit && <button type="button" className="inventory-edit-action" onClick={() => onEdit(item)}><EditIcon /> Editar</button>}{onStatusChange && item.isActive !== false && item.status !== 'ASSIGNED' && item.status !== 'DECOMMISSIONED' && <Button variant="secondary" size="sm" className="inventory-edit-action" onClick={() => onStatusChange(item)}><StatusChangeIcon /> Cambiar estado</Button>}{(item.status === "AVAILABLE" || item.status === "ASSIGNED") && <button type="button" className="inventory-assignment-action" onClick={() => onAssignment(item)}>{item.status === "AVAILABLE" ? <><AssignmentIcon /> Asignar</> : <><PersonIcon /> Ver asignación</>}</button>}<button type="button" className="inventory-history-action" onClick={() => onOpen(item.product, item.id)}><HistoryIcon /> Historial</button></div></td></tr>)}</tbody></table></div><LoadMore loaded={assets.length} total={total} hasMore={hasMore} onLoadMore={onLoadMore} /></>}</section>; }

function AssetStatusDialog({ asset, open, onClose, onExited, onSaved }: { asset: Asset; open: boolean; onClose: () => void; onExited: () => void; onSaved: (asset: Asset) => void }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const reportError = useRequestError();
  const [selectedStatus, setSelectedStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const submitting = useRef(false);
  const options = getAssetStatusOptions(user?.role, asset.status, asset.isActive !== false);
  const selected = options.find((option) => option.value === selectedStatus);
  const assetName = asset.assetTag ?? asset.serialNumber ?? asset.product.name;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    if (!selected) {
      setSelectionError('Selecciona un nuevo estado permitido.');
      document.getElementById('inventory-next-status')?.focus({ preventScroll: true });
      return;
    }
    submitting.current = true;
    setSaving(true);
    setSelectionError(null);
    try {
      const token = await csrf();
      const result = await request<{ asset: Asset }>(`/assets/${asset.id}/status`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: JSON.stringify({ status: selected.value })
      });
      showToast({ tone: 'success', title: 'Estado del activo actualizado', description: `${assetName}: ${statusLabels[asset.status]} → ${statusLabels[result.asset.status]}.` });
      onSaved(result.asset);
    } catch (caughtError) {
      setSelectionError(reportError(caughtError, 'No se pudo cambiar el estado del activo'));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return <Dialog open={open} onClose={onClose} onExited={onExited} busy={saving} className="catalog-editor-dialog inventory-dialog inventory-status-dialog" title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon"><StatusChangeIcon /></span>Cambiar estado del activo</span>} actions={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button><Button type="submit" form="inventory-status-form" loading={saving} disabled={!selected}><StatusChangeIcon /> Guardar estado</Button></>}>
    <form id="inventory-status-form" className="inventory-dialog-form" noValidate onSubmit={submit}>
      <div className="inventory-asset-editor-summary"><span className="inventory-asset-editor-summary-icon"><AssetIcon /></span><div><strong>{asset.product.name}</strong><small>{assetName}{asset.assetTag && asset.serialNumber ? ' · Serie ' + asset.serialNumber : ''}</small></div></div>
      <Field id="inventory-next-status" label="Nuevo estado" required disabled={saving} error={selectionError}><Select className="catalog-editor-select" value={selectedStatus} placeholder="Selecciona el nuevo estado" options={options} onChange={(value) => { setSelectedStatus(value); setSelectionError(null); }} /></Field>
      <section className="inventory-status-preview" aria-label="Cambio de estado" aria-live="polite">
        <div><span className="inventory-assignment-kicker">Actual</span><AssetStatusBadge status={asset.status} /></div>
        <span className="inventory-status-preview-arrow" aria-hidden="true"><StatusChangeIcon /></span>
        <div><span className="inventory-assignment-kicker">Nuevo</span>{selected ? <AssetStatusBadge status={selected.value} /> : <span className="inventory-status-placeholder">Por seleccionar</span>}</div>
      </section>
      {selected && <p className="inventory-status-description">{assetStatusDescriptions[selected.value]}</p>}
      <p className="inventory-status-audit"><HistoryIcon /> El cambio quedará registrado en el historial.</p>
    </form>
  </Dialog>;
}

function AssignmentDialog({ asset, onClose, onSaved }: { asset: Asset | null; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast();
  const reportError = useRequestError();
  const [current, setCurrent] = useState<AssignmentRecord | null>(null);
  const [history, setHistory] = useState<AssignmentRecord[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [assignmentRetry, setAssignmentRetry] = useState(0);
  const [personName, setPersonName] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!asset) return;
    let cancelled = false;
    setCurrent(null);
    setHistory([]);
    setLoadFailed(false);
    setLoading(true);
    setError(null);
    setPersonName('');
    setConfirmReturn(false);
    void request<{ assignments: AssignmentRecord[]; currentAssignment: AssignmentRecord | null }>(`/assets/${asset.id}/assignments?limit=50`).then((result) => {
      if (cancelled) return;
      setHistory(result.assignments);
      setCurrent(result.currentAssignment);
    }).catch((caughtError) => {
      if (cancelled) return;
      setLoadFailed(true);
      setError(reportError(caughtError, 'No se pudo cargar la asignación'));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [asset, assignmentRetry, reportError]);

  if (!asset) return null;

  const selectedAsset = asset;
  const canAssign = !loading && !loadFailed && asset.status === 'AVAILABLE' && !current;
  const assetName = asset.assetTag ?? asset.serialNumber ?? asset.product.name;

  async function assign(event: FormEvent) {
    event.preventDefault();
    const cleanName = personName.trim();
    if (!cleanName || cleanName.split(/\s+/).length < 2) {
      setError('Escribe el nombre y apellido de la persona.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const token = await csrf();
      await request(`/assets/${selectedAsset.id}/assignments`, { method: 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify({ personName: cleanName }) });
      showToast({ tone: 'success', title: 'Activo asignado', description: `${assetName} quedó asignado a ${cleanName}.` });
      onSaved();
    } catch (caughtError) { setError(reportError(caughtError, 'No se pudo asignar el activo')); }
    finally { setSaving(false); }
  }

  async function returnAsset() {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      const token = await csrf();
      await request(`/assets/${selectedAsset.id}/assignments/${current.id}/return`, { method: 'POST', headers: { 'X-CSRF-Token': token } });
      showToast({ tone: 'success', title: 'Activo devuelto', description: `${assetName} volvió a estar disponible.` });
      onSaved();
    } catch (caughtError) { setError(reportError(caughtError, 'No se pudo registrar la devolución')); }
    finally { setSaving(false); }
  }


  return <Dialog open={Boolean(asset)} onClose={onClose} title={<span className="catalog-dialog-title"><span className={'catalog-dialog-icon ' + (current ? 'inventory-dialog-icon-assigned' : 'inventory-dialog-icon-assignment')}>{current ? <PersonIcon /> : <AssignmentIcon />}</span>{current ? 'Ver asignación' : 'Asignar activo'}</span>} description={current ? 'Consulta quién tiene el activo y su recorrido de entregas.' : 'Registra quién recibió este activo para mantener trazabilidad.'} busy={saving} className="catalog-editor-dialog inventory-assignment-dialog" actions={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cerrar</Button>{canAssign && <Button type="submit" form="inventory-assignment-form" loading={saving}><AssignmentIcon /> Asignar activo</Button>}{current && !confirmReturn && <Button variant="secondary" onClick={() => setConfirmReturn(true)} disabled={saving}><ReturnIcon /> Registrar devolución</Button>}{current && confirmReturn && <Button variant="danger" onClick={() => void returnAsset()} loading={saving}>Confirmar devolución</Button>}</>}>
    {loading ? <Loading /> : <div className="inventory-assignment-content">{error && <Alert variant="danger" action={loadFailed ? <Button variant="secondary" size="sm" onClick={() => setAssignmentRetry((value) => value + 1)}>Reintentar</Button> : undefined}>{error}</Alert>}
      <section className="inventory-assignment-hero">
        <span className="inventory-assignment-hero-icon"><AssetIcon /></span>
        <div className="inventory-assignment-hero-copy"><span className="inventory-assignment-kicker">Activo rastreable</span><strong>{asset.product.name}</strong><div className="inventory-assignment-identity"><span><TagIcon /> {assetName}</span><AssetStatusBadge status={asset.status} /></div></div>
        <span className="inventory-assignment-hero-orbit" aria-hidden="true" />
      </section>
      {current ? <section className="inventory-assignment-current"><div className="inventory-assignment-current-heading"><span className="inventory-assignment-current-icon"><PersonIcon /></span><div><span className="inventory-assignment-kicker">Responsable actual</span><strong>{current.personName}</strong></div><span className="inventory-assignment-live"><span /> Activa</span></div><div className="inventory-assignment-meta"><span><HistoryIcon /> Desde {new Date(current.startedAt).toLocaleString('es-CL')}</span>{confirmReturn && <p className="inventory-assignment-confirmation">La devolución cerrará esta asignación y dejará el activo disponible.</p>}</div></section> : canAssign ? <form id="inventory-assignment-form" className="inventory-assignment-form" noValidate onSubmit={assign}><div className="inventory-assignment-form-heading"><span className="inventory-assignment-form-icon"><PersonIcon /></span><div><strong>¿A quién se entrega?</strong><span>Guarda el nombre como registro de entrega.</span></div></div><Field label="Nombre y apellido de la persona" required><input autoFocus required minLength={2} maxLength={150} value={personName} onChange={(event) => setPersonName(event.target.value)} placeholder="Ej. Daniela González" /></Field></form> : loadFailed ? null : <Empty text="Este activo no está disponible para asignación." />}
      {history.length > 0 && <section className="inventory-assignment-history"><div className="inventory-assignment-section-heading"><div><span className="inventory-assignment-section-icon"><HistoryIcon /></span><strong>Recorrido de entregas</strong></div><span>{history.length}</span></div><div className="inventory-assignment-history-list">{history.map((assignment, index) => <article key={assignment.id} style={{ '--assignment-delay': index * 60 + 'ms' } as CSSProperties}><span className="inventory-assignment-history-marker"><PersonIcon /></span><div><strong>{assignment.personName}</strong><span>{new Date(assignment.startedAt).toLocaleDateString('es-CL')} — {assignment.endedAt ? new Date(assignment.endedAt).toLocaleDateString('es-CL') : 'Activa'}</span>{assignment.endedAt && <small>Devuelta</small>}</div></article>)}</div></section>}
    </div>}
  </Dialog>;
}

function LoadMore({ loaded, total, hasMore, onLoadMore }: { loaded: number; total: number; hasMore: boolean; onLoadMore: () => void }) { const ref = useRef<globalThis.HTMLDivElement>(null); useEffect(() => { const element = ref.current; if (!element || !hasMore || !('IntersectionObserver' in globalThis)) return; const observer = new globalThis.IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) onLoadMore(); }, { rootMargin: '280px' }); observer.observe(element); return () => observer.disconnect(); }, [hasMore, onLoadMore]); return <><div ref={ref} className="inventory-scroll-sentinel" aria-hidden="true" /><ListFooter loaded={loaded} total={total} hasMore={hasMore} onLoadMore={onLoadMore} /></>; }
function MovementTimelineIcon({ type }: { type: MovementType }) { const icon = type === "ENTRY" || type === "INITIAL" ? <path d="M12 19V5M6 11l6-6 6 6" /> : type === "EXIT" ? <path d="M12 5v14M6 13l6 6 6-6" /> : type === "RETURN" ? <path d="M19 12H5M11 6l-6 6 6 6M14 5h4v4" /> : <path d="M6 6h12M6 12h12M6 18h12" />; return <Icon className={"inventory-timeline-arrow inventory-timeline-arrow-" + type.toLowerCase()} size="sm">{icon}</Icon>; }
function HistoryEventIcon({ event }: { event: HistoryEvent }) { if (event.kind === "movement") return <MovementTimelineIcon type={event.movementType ?? "ADJUSTMENT"} />; if (event.action === "ASSET_ASSIGNED") return <Icon size="sm"><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></Icon>; if (event.action === "ASSET_RETURNED") return <Icon size="sm"><path d="M19 12H5M11 6l-6 6 6 6" /></Icon>; return <Icon size="sm"><path d="M12 3v18M3 12h18" /></Icon>; }
function eventStatus(event: HistoryEvent, key: "from" | "to") { if (!event.metadata || typeof event.metadata !== "object") return null; const value = (event.metadata as Record<string, unknown>)[key]; return typeof value === "string" && value in statusLabels ? statusLabels[value as AssetStatus] : typeof value === "string" ? value : null; }
function historyEventCopy(event: HistoryEvent) { if (event.kind === "movement") { const quantity = Math.abs(event.quantity ?? 0); const label = movementLabels[event.movementType ?? "ADJUSTMENT"]; return { label, detail: label + " de " + quantity + " unidades" }; } if (event.action === "ASSET_ASSIGNED") return { label: "Activo asignado", detail: "Asignado a " + (event.person ?? "una persona") }; if (event.action === "ASSET_RETURNED") return { label: "Activo devuelto", detail: "Devuelto por " + (event.person ?? "la persona asignada") }; if (event.action === "ASSET_STATUS_CHANGED") { const from = eventStatus(event, "from"); const to = eventStatus(event, "to"); return { label: "Estado actualizado", detail: from && to ? from + " → " + to : "Cambio de estado" }; } if (event.action === "ASSET_CREATED") return { label: "Activo creado", detail: "Registrado en el inventario" }; if (event.action === "ASSET_DECOMMISSIONED") return { label: "Activo dado de baja", detail: "El activo dejó de estar operativo" }; return { label: "Actividad registrada", detail: event.action ?? "Actualización del activo" }; }
function MovementDetailDialog({ product, onClose }: { product: { id: string; name: string; assetId?: string } | null; onClose: () => void }) {
  const reportError = useRequestError();
  const [items, setItems] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(12);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [quantityHistory, setQuantityHistory] = useState<QuantityHistory | null>(null);
  const [compensationsVisible, setCompensationsVisible] = useState(12);
  useEffect(() => {
    if (!product) return;
    let cancelled = false;
    setVisible(12);
    setItems([]);
    setQuantityHistory(null);
    setCompensationsVisible(12);
    setError(null);
    setLoading(true);
    const controller = new globalThis.AbortController();
    async function loadHistory() {
      if (!product) return;
      if (product.assetId) {
        const result = await request<{ events: HistoryEvent[] }>('/assets/' + encodeURIComponent(product.assetId) + '/history', { signal: controller.signal });
        if (!cancelled) setItems(result.events);
        return;
      }
      const result = await request<QuantityHistory>('/inventory/products/' + encodeURIComponent(product.id) + '/history', { signal: controller.signal });
      if (cancelled) return;
      setQuantityHistory(result);
      setItems(result.movements.map((movement) => ({ id: movement.id, kind: 'movement', movementType: movement.movementType, quantity: movement.effectiveQuantity, originalQuantity: movement.originalQuantity, balanceBefore: movement.balanceBefore, balanceAfter: movement.balanceAfter, correctionDelta: movement.correctionDelta, effectiveAt: movement.effectiveAt, actor: movement.performedBy?.displayName ?? null, reason: movement.reason })));
    }
    void loadHistory().catch((caughtError) => {
      if (!cancelled) setError(reportError(caughtError, 'No se pudo cargar el historial'));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [product, reportError, retry]);
  if (!product) return null;
  const shown = items.slice(0, visible);
  return <Dialog open={Boolean(product)} onClose={onClose} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon catalog-dialog-icon-product"><HistoryIcon /></span>{product.assetId ? 'Historial del activo' : 'Historial del producto'}</span>} description={product.assetId ? 'Una bitácora visual de cada cambio registrado.' : 'Movimientos y saldos vigentes, incluyendo las correcciones aplicadas.'} className="catalog-editor-dialog inventory-history-dialog">
    <div className="inventory-history-content">
      <header className="inventory-history-hero"><span className="inventory-history-hero-icon"><AssetIcon /></span><div><span className="inventory-assignment-kicker">Bitácora de actividad</span><strong>{product.name}</strong><small>{product.assetId ? 'Activo rastreable · ciclo de vida' : 'Stock por cantidad · historial corregido'}</small></div><span className="inventory-history-count"><b>{loading || error ? '—' : items.length}</b><small>eventos</small></span></header>
      {!loading && !error && quantityHistory && <>
        <div className="corrections-confirm-values"><div><span>Stock actual</span><strong>{quantityHistory.stockQuantity} unidades</strong></div><div><span>Saldo del historial</span><strong>{quantityHistory.historyQuantity} unidades</strong></div></div>
        {!quantityHistory.isConsistent && <Alert variant="warning">El saldo del historial no coincide con el stock actual. Solicita una revisión del inventario antes de hacer nuevos cambios.</Alert>}
        {quantityHistory.hasNegativeBalance && <Alert variant="warning">Hay saldos históricos negativos. Revisa las fechas y cantidades de los movimientos.</Alert>}
      </>}
      <div className="inventory-timeline">
        {loading ? <Loading /> : error ? <Alert variant="danger" title="No se pudo cargar el historial" action={<Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>Reintentar</Button>}>{error}</Alert> : shown.length === 0 ? <Empty text="Todavía no hay eventos registrados para este elemento." /> : shown.map((event, index) => {
          const copy = historyEventCopy(event);
          const direction = event.kind === 'movement' ? (event.quantity ?? 0) > 0 ? 'positive' : (event.quantity ?? 0) < 0 ? 'negative' : 'neutral' : event.action === 'ASSET_RETURNED' ? 'positive' : event.action === 'ASSET_ASSIGNED' ? 'negative' : 'neutral';
          return <article className="inventory-timeline-item" key={event.id} style={{ '--timeline-delay': index * 45 + 'ms' } as CSSProperties}>
            <div className={'inventory-timeline-marker inventory-timeline-marker-' + direction}><HistoryEventIcon event={event} /></div>
            <div className="inventory-timeline-content">
              <div className="inventory-timeline-topline"><span className={'inventory-timeline-type inventory-timeline-type-' + (event.kind === 'movement' ? (event.movementType ?? 'ADJUSTMENT').toLowerCase() : (event.action ?? 'status').toLowerCase().replaceAll('_', '-'))}>{copy.label}</span><time>{new Date(event.effectiveAt).toLocaleString('es-CL')}</time></div>
              <strong>{copy.detail}</strong>
              {event.balanceAfter !== undefined && <span>Saldo: {event.balanceBefore} → {event.balanceAfter} unidades</span>}
              {event.correctionDelta !== undefined && event.correctionDelta !== 0 && <small>Movimiento corregido: {event.originalQuantity} → {event.quantity} unidades. El ajuste ya está incluido en este saldo.</small>}
              <span>{event.actor ? 'Registrado por ' + event.actor : 'Registro del sistema'}</span>
              {event.reason && <small className="inventory-timeline-reason">{event.reason}</small>}
            </div>
          </article>;
        })}
        {!loading && items.length > shown.length && <LoadMore loaded={shown.length} total={items.length} hasMore={shown.length < items.length} onLoadMore={() => setVisible((value) => value + 12)} />}
      </div>
      {!loading && !error && quantityHistory && quantityHistory.compensatingMovements.length > 0 && <details>
        <summary className="inventory-history-action">Ver ajustes compensatorios ({quantityHistory.compensatingMovements.length})</summary>
        <p>Estos registros respaldan las correcciones. No se suman otra vez a los saldos mostrados arriba.</p>
        <ul>{quantityHistory.compensatingMovements.slice(0, compensationsVisible).map((movement) => <li key={movement.id}><strong>{movement.quantity > 0 ? '+' : ''}{movement.quantity} unidades</strong> · {new Date(movement.effectiveAt).toLocaleString('es-CL')} · {movement.performedBy?.displayName ?? 'Sistema'}{movement.reason && <p>{movement.reason.startsWith('Correction: ') ? 'Corrección: ' + movement.reason.slice('Correction: '.length) : movement.reason}</p>}</li>)}</ul>
        <ListFooter loaded={Math.min(compensationsVisible, quantityHistory.compensatingMovements.length)} total={quantityHistory.compensatingMovements.length} hasMore={compensationsVisible < quantityHistory.compensatingMovements.length} onLoadMore={() => setCompensationsVisible((value) => value + 12)} />
      </details>}
    </div>
  </Dialog>;
}

function MovementDialog({ open, busy, products, form, errors, canAdjust, onClose, onChange, onSubmit }: { open: boolean; busy: boolean; products: Product[]; form: { type: MovementType; productId: string; quantity: string; reason: string }; errors: Partial<Record<'type' | 'productId' | 'quantity', string>>; canAdjust: boolean; onClose: () => void; onChange: (form: { type: MovementType; productId: string; quantity: string; reason: string }) => void; onSubmit: (event: FormEvent) => void }) {
  const options = [{ value: 'ENTRY', label: 'Entrada' }, { value: 'EXIT', label: 'Salida' }, { value: 'RETURN', label: 'Devolución' }, ...(canAdjust ? [{ value: 'ADJUSTMENT', label: 'Ajuste' }] : []), ...(canAdjust ? [{ value: 'INITIAL', label: 'Stock inicial' }] : [])];
  return <Dialog open={open} onClose={onClose} title="Registrar movimiento" description="Actualiza las existencias dejando un registro trazable." busy={busy} className="catalog-editor-dialog inventory-dialog" actions={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button type="submit" form="inventory-movement-form" loading={busy}>Guardar movimiento</Button></>}><form id="inventory-movement-form" className="inventory-dialog-form" noValidate onSubmit={onSubmit}><div className="grid gap-4 sm:grid-cols-2"><Field label="Tipo de movimiento" required error={errors.type}><Select value={form.type} onChange={(value) => onChange({ ...form, type: value as MovementType })} options={options} /></Field><Field label="Producto" required error={errors.productId}><Select value={form.productId} onChange={(productId) => onChange({ ...form, productId })} searchable searchPlaceholder="Buscar producto…" options={products.map((item) => ({ value: item.id, label: item.name }))} /></Field><Field label="Cantidad" required error={errors.quantity}><input type="number" min={form.type === 'ADJUSTMENT' ? undefined : 1} required value={form.quantity} onChange={(event) => onChange({ ...form, quantity: event.target.value })} /></Field><Field label="Motivo"><input value={form.reason} onChange={(event) => onChange({ ...form, reason: event.target.value })} placeholder="Ej. recepción de compra" /></Field></div></form></Dialog>;
}
function AssetDialog({ open, busy, products, editing, form, errors, onClose, onChange, onSubmit }: { open: boolean; busy: boolean; products: Product[]; editing: Asset | null; errors: Partial<Record<'productId' | 'assetTag' | 'serialNumber', string>>; form: { productId: string; assetTag: string; serialNumber: string }; onClose: () => void; onChange: (form: { productId: string; assetTag: string; serialNumber: string }) => void; onSubmit: (event: FormEvent) => void }) { return <Dialog open={open} onClose={onClose} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon catalog-dialog-icon-product"><EditIcon /></span>{editing ? 'Editar activo' : 'Añadir activo'}</span>} description={editing ? 'Actualiza los identificadores del activo sin perder su historial.' : 'Registra un equipo para poder seguir su ciclo de vida.'} busy={busy} className="catalog-editor-dialog inventory-dialog inventory-asset-editor-dialog" actions={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button type="submit" form="inventory-asset-form" loading={busy}>{editing ? 'Guardar cambios' : 'Guardar activo'}</Button></>}><form id="inventory-asset-form" className="inventory-dialog-form" noValidate onSubmit={onSubmit}>{editing ? <div className="inventory-asset-editor-summary"><span className="inventory-asset-editor-summary-icon"><AssetIcon /></span><div><span>Producto asociado</span><strong>{editing.product.name}</strong><small>{editing.product.sku ? 'SKU ' + editing.product.sku : 'Sin SKU'}</small></div></div> : <Field label="Producto" required error={errors.productId}><Select value={form.productId} onChange={(productId) => onChange({ ...form, productId })} searchable searchPlaceholder="Buscar producto…" options={products.map((item) => ({ value: item.id, label: item.name }))} /></Field>}<div className="grid gap-4 sm:grid-cols-2"><Field label="Etiqueta del activo" error={errors.assetTag}><input value={form.assetTag} onChange={(event) => onChange({ ...form, assetTag: event.target.value })} placeholder="Ej. TI-NB-001" /></Field><Field label="Número de serie" error={errors.serialNumber}><input value={form.serialNumber} onChange={(event) => onChange({ ...form, serialNumber: event.target.value })} placeholder="Ej. PF4ABC123" /></Field></div></form></Dialog>; }
function InventoryTableHeader({ icon, children }: { icon: ReactNode; children: ReactNode }) { return <span className="inventory-table-header">{icon}{children}</span>; }
function TagIcon() { return <Icon size="sm"><path d="M4 5v6l9 9 7-7-9-9H4Z" /><path d="M8 8h.01" /></Icon>; }
function QuantityIcon() { return <Icon size="sm"><path d="M5 19h14M7 16V9M12 16V5M17 16v-4" /></Icon>; }
function ThresholdIcon() { return <Icon size="sm"><path d="m12 4 8 15H4L12 4Z" /><path d="M12 9v4M12 16h.01" /></Icon>; }
function StatusTableIcon() { return <Icon size="sm"><circle cx="12" cy="12" r="8" /><path d="m8 12 2.5 2.5L16 9" /></Icon>; }
function StatusChangeIcon() { return <Icon size="sm"><path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" /></Icon>; }

function ProductIdentity({ product, accent = false }: { product: Product; accent?: boolean }) { return <div className="catalog-name-cell inventory-product-identity"><span className={`catalog-row-icon ${accent ? 'catalog-row-icon-secondary' : ''}`}><InventoryIcon /></span><span className="catalog-name-copy"><OverflowText as="strong" text={product.name} /><OverflowText as="small" text={product.sku ? 'SKU ' + product.sku : 'Sin SKU'} /></span></div>; }
function InventoryIcon() { return <Icon size="sm"><path d="m4 8 8-4 8 4v8l-8 4-8-4V8Z" /><path d="m4 8 8 4 8-4M12 12v8" /></Icon>; }
function SearchIcon() { return <Icon className="catalog-icon-svg" size="sm"><circle cx="10.8" cy="10.8" r="6.2" /><path d="m16 16 4 4" /></Icon>; }
function PlusIcon() { return <Icon size="sm"><path d="M12 5v14M5 12h14" /></Icon>; }
function MovementIcon() { return <Icon size="sm"><path d="M5 7h14M5 12h9M5 17h14" /><path d="m15 9 3-2-3-2" /></Icon>; }
function AssignmentIcon() { return <Icon size="sm"><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M15 8h5M17.5 5.5v5" /></Icon>; }
function PersonIcon() { return <Icon size="sm"><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></Icon>; }
function ReturnIcon() { return <Icon size="sm"><path d="M19 12H5M11 6l-6 6 6 6M14 5h4v4" /></Icon>; }
function AssetIcon() { return <Icon size="sm"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 9h8M8 13h5" /></Icon>; }
function HistoryIcon() { return <Icon size="sm"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></Icon>; }
function EditIcon() { return <Icon size="sm"><path d="m4 16.5-.8 3.3 3.3-.8L18 7.5 15.5 5 4 16.5Z" /><path d="m14.5 6 2.5 2.5" /></Icon>; }
