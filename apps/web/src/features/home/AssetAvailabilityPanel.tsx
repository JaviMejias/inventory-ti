import { useCallback, useEffect, useState } from 'react';

import { apiRequest, getApiErrorMessage } from '../../lib/api';
import { Alert, Badge, Button, DataTable, EmptyState, Field, ListFooter, ModuleFilters, Select, type DataTableColumn } from '../../ui';
import { productMetadataLabel, type AssetAvailability, type AvailabilityPage } from './inventory-metadata';

const PAGE_SIZE = 25;
const emptyPage: AvailabilityPage = { products: [], total: 0, limit: PAGE_SIZE, offset: 0, hasMore: false };

export function AssetAvailabilityPanel({ products = [], onInspect }: {
  products?: { id: string; name: string }[]; onInspect?: (product: { id: string; name: string }) => void;
}) {
  const [productId, setProductId] = useState('');
  const [page, setPage] = useState(emptyPage);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);

  const load = useCallback(async (offset: number, signal: globalThis.AbortSignal) => {
    if (offset === 0) setLoading(true); else setLoadingMore(true);
    setError(null);
    try {
      const query = new globalThis.URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (productId) query.set('productId', productId);
      const result = await apiRequest<AvailabilityPage>('/assets/availability?' + query, { signal });
      if (signal.aborted) return;
      setPage((current) => offset === 0 ? result : { ...result, products: [...current.products, ...result.products] });
    } catch (caught) {
      if (!signal.aborted) setError(getApiErrorMessage(caught, 'No se pudo cargar la disponibilidad de equipos.'));
    } finally {
      if (!signal.aborted) { setLoading(false); setLoadingMore(false); }
    }
  }, [productId]);

  useEffect(() => {
    const controller = new globalThis.AbortController();
    void load(nextOffset, controller.signal);
    return () => controller.abort();
  }, [load, nextOffset, retry]);

  const columns: DataTableColumn<AssetAvailability>[] = [
    { key: 'product', header: 'Producto', mobileRole: 'identity', mobileLabel: 'Producto', render: ({ product }) => <div className="catalog-name-copy"><strong>{product.name}</strong><small>{productMetadataLabel(product) || product.sku || 'Sin SKU'}</small></div> },
    { key: 'active', header: 'Operativos', mobileLabel: 'Operativos', render: (row) => row.activeCount },
    { key: 'available', header: 'Disponibles', mobileLabel: 'Disponibles', render: (row) => <Badge variant={row.availableCount === 0 ? 'danger' : row.lowStock ? 'warning' : 'success'}>{row.availableCount} disponibles</Badge> },
    { key: 'assigned', header: 'Asignados', mobileLabel: 'Asignados', render: (row) => row.statusCounts.ASSIGNED },
    { key: 'other', header: 'Otros estados', mobileLabel: 'Otros estados', render: (row) => row.activeCount - row.availableCount - row.statusCounts.ASSIGNED },
    { key: 'minimum', header: 'Mínimo disponible', mobileLabel: 'Mínimo disponible', render: (row) => row.product.lowStockThreshold > 0 ? row.product.lowStockThreshold : 'Sin alerta' },
    ...(onInspect ? [{ key: 'actions', header: 'Activos', mobileRole: 'actions' as const, mobileLabel: 'Activos', render: (row: AssetAvailability) => <Button variant="ghost" size="sm" onClick={() => onInspect(row.product)}>Ver equipos</Button> }] : [])
  ];
  return <section className="catalog-section catalog-section-product">
    <ModuleFilters className="catalog-toolbar inventory-toolbar" ariaLabel="Filtros de disponibilidad">
      <Field label="Producto"><Select className="catalog-filter-select" value={productId} searchable onChange={(value) => { setProductId(value); setNextOffset(0); setPage(emptyPage); }} options={[{ value: '', label: 'Todos los productos rastreables' }, ...products.map((item) => ({ value: item.id, label: item.name }))]} /></Field>
    </ModuleFilters>
    {error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>Reintentar</Button>}>{error}</Alert>}
    <DataTable className="catalog-data-table" rows={page.products} columns={columns} getRowKey={(row) => row.product.id} caption="Disponibilidad actual de equipos por producto" loading={loading} error={error && !page.products.length ? error : undefined} empty={<EmptyState title="No hay productos rastreables que coincidan" />} />
    <ListFooter loaded={page.products.length} total={page.total} hasMore={page.hasMore} loading={loadingMore} onLoadMore={() => setNextOffset(page.offset + page.limit)} />
    <p className="inventory-availability-note">Disponibles cuenta solo equipos en estado Disponible. Asignados, reservados, en revisión, reparación, garantía y extraviados siguen siendo operativos, pero no están disponibles. Las bajas quedan fuera de estos conteos.</p>
  </section>;
}
