import { inventoryDate, shiftDate } from '../../lib/date-range';
import type { AssetStatus } from './asset-status';
import type { AssetAvailability } from './inventory-metadata';

type SummaryData = {
  products: { id: string; name: string; trackingMode: 'QUANTITY' | 'ASSET'; lowStockThreshold: number }[];
  stock: { productId: string; quantity: number }[];
  assets: { status: AssetStatus; isActive?: boolean }[];
  availability?: AssetAvailability[];
  movements: { movementType: string; quantity: number; effectiveAt: string }[];
};
type MovementPoint = { label: string; entradas: number; salidas: number; ajustes: number };
const dateLabel = new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', timeZone: 'UTC' });

export function buildSummary(data: SummaryData | null, fromDate: string, toDate: string) {
  const stockByProduct = new Map<string, number>();
  data?.stock.forEach((row) => stockByProduct.set(row.productId, (stockByProduct.get(row.productId) ?? 0) + row.quantity));
  const lowStockProducts = data?.products.filter((product) => product.trackingMode === 'QUANTITY' && product.lowStockThreshold > 0 && (stockByProduct.get(product.id) ?? 0) <= product.lowStockThreshold).map((product) => ({ id: product.id, name: product.name, current: stockByProduct.get(product.id) ?? 0, threshold: product.lowStockThreshold, trackingMode: product.trackingMode })) ?? [];
  for (const row of data?.availability ?? []) {
    if (row.lowStock) lowStockProducts.push({ id: row.product.id, name: row.product.name, current: row.availableCount, threshold: row.product.lowStockThreshold, trackingMode: 'ASSET' });
  }
  const operationalAssets = data?.assets.filter((asset) => asset.isActive !== false && asset.status !== 'DECOMMISSIONED') ?? [];
  const assetStatuses = new Map<AssetStatus, number>();
  operationalAssets.forEach((asset) => assetStatuses.set(asset.status, (assetStatuses.get(asset.status) ?? 0) + 1));
  const rangeStart = Date.parse(`${fromDate}T12:00:00Z`);
  const rangeDays = Math.max(1, Math.round((Date.parse(`${toDate}T12:00:00Z`) - rangeStart) / 86400000) + 1);
  const bucketDays = rangeDays <= 31 ? 1 : 7;
  const monthly = rangeDays > 217;
  const keyFor = (day: string) => monthly ? day.slice(0, 7) : String(Math.floor((Date.parse(`${day}T12:00:00Z`) - rangeStart) / 86400000 / bucketDays));
  const movementByPeriod = new Map<string, MovementPoint>();
  for (let day = fromDate; day <= toDate;) {
    const start = new Date(`${day}T12:00:00Z`);
    const next = monthly ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 12)).toISOString().slice(0, 10) : shiftDate(day, bucketDays);
    const end = shiftDate(next, -1) < toDate ? shiftDate(next, -1) : toDate;
    const label = dateLabel.format(start).replaceAll('.', '') + (day === end ? '' : ' — ' + dateLabel.format(new Date(`${end}T12:00:00Z`)).replaceAll('.', ''));
    movementByPeriod.set(keyFor(day), { label, entradas: 0, salidas: 0, ajustes: 0 });
    day = next;
  }
  const movementTotals = { entradas: 0, salidas: 0, ajustes: 0 };
  data?.movements.forEach((movement) => {
    const day = inventoryDate(new Date(movement.effectiveAt));
    if (day < fromDate || day > toDate) return;
    const point = movementByPeriod.get(keyFor(day));
    if (!point) return;
    const kind = ['ENTRY', 'INITIAL', 'RETURN'].includes(movement.movementType) ? 'entradas' : movement.movementType === 'EXIT' ? 'salidas' : 'ajustes';
    const quantity = Math.abs(movement.quantity);
    point[kind] += quantity;
    movementTotals[kind] += quantity;
  });
  return {
    productCount: data?.products.length ?? 0,
    totalStock: data?.stock.reduce((total, row) => total + row.quantity, 0) ?? 0,
    assetCount: operationalAssets.length,
    lowStockCount: lowStockProducts.length,
    lowStockProducts,
    movementTotals,
    trendInterval: monthly ? 'mes' : bucketDays === 7 ? 'semana' : 'día',
    assetStatuses: [...assetStatuses.entries()].sort((a, b) => b[1] - a[1]),
    movementTrend: [...movementByPeriod.values()]
  };
}
