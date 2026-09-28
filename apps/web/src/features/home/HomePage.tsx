import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { es } from 'date-fns/locale/es';
import 'react-day-picker/style.css';
import { DayPicker, type CalendarMonth } from 'react-day-picker';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { apiRequest, getApiErrorMessage } from '../../lib/api';
import { Alert, Button, Dialog, Select } from '../../ui';
import { useAuth } from '../auth/auth-context';

type DashboardProduct = { id: string; name: string; trackingMode: 'QUANTITY' | 'ASSET'; lowStockThreshold: number; active: boolean };
type DashboardStock = { id: string; productId: string; quantity: number; product: { id: string; name: string; trackingMode: 'QUANTITY' | 'ASSET' }; };
type DashboardAsset = { id: string; status: AssetStatus; isActive: boolean; assetTag: string | null; serialNumber: string | null; product: { id: string; name: string; sku: string | null } };
type DashboardMovement = { id: string; movementType: 'INITIAL' | 'ENTRY' | 'EXIT' | 'RETURN' | 'ADJUSTMENT'; quantity: number; effectiveAt: string };
type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'RESERVED' | 'UNDER_REVIEW' | 'IN_REPAIR' | 'IN_WARRANTY' | 'LOST' | 'DECOMMISSIONED';
type DashboardCorrection = { id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; reason: string; delta: number; previousQuantity: number; correctedQuantity: number; createdAt: string; requestedBy: { id: string; displayName: string; role: 'JEFE' | 'COORDINADOR' | 'SOPORTE' }; originalMovement: { id: string; movementType: DashboardMovement['movementType']; quantity: number; effectiveAt: string; product: { id: string; name: string; sku: string | null } } };
type DashboardData = { products: DashboardProduct[]; stock: DashboardStock[]; assets: DashboardAsset[]; movements: DashboardMovement[]; corrections: DashboardCorrection[] };

const assetStatusLabels: Record<AssetStatus, string> = {
  AVAILABLE: 'Disponibles',
  ASSIGNED: 'Asignados',
  RESERVED: 'Reservados',
  UNDER_REVIEW: 'En revisión',
  IN_REPAIR: 'En reparación',
  IN_WARRANTY: 'En garantía',
  LOST: 'Perdidos',
  DECOMMISSIONED: 'Dados de baja'
};
const assetStatusDescriptions: Record<AssetStatus, string> = { AVAILABLE: "Listos para asignar", ASSIGNED: "En uso por una persona", RESERVED: "Apartados para entrega", UNDER_REVIEW: "Pendientes de revisión", IN_REPAIR: "En proceso de reparación", IN_WARRANTY: "Con cobertura de garantía", LOST: "Requieren localizarse", DECOMMISSIONED: "Fuera de operación" };

export function HomePage() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [period, setPeriod] = useState('current-month');
  const [fromDate, setFromDate] = useState(() => firstDayOfCurrentMonth());
  const [toDate, setToDate] = useState(() => todayIso());
  const [assetStatusDetail, setAssetStatusDetail] = useState<AssetStatus | null>(null);
  const [attentionDetailOpen, setAttentionDetailOpen] = useState(false);
  const [correctionsDetailOpen, setCorrectionsDetailOpen] = useState(false);
  const isCorrectionReviewer = user?.role === 'JEFE';

  useEffect(() => {
    let cancelled = false;
    async function loadDashboard() {
      setLoading(true);
      setError(null);
      try {
        const from = `${fromDate}T00:00:00.000Z`;
        const to = `${toDate}T23:59:59.999Z`;
        const [productResult, stockResult, assetResult, movementResult, correctionResult] = await Promise.all([
          apiRequest<{ products: DashboardProduct[] }>('/products?active=true&limit=100'),
          apiRequest<{ stock: DashboardStock[] }>('/inventory/stock'),
          apiRequest<{ assets: DashboardAsset[] }>('/assets?isActive=true'),
          apiRequest<{ movements: DashboardMovement[] }>(`/inventory/movements?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
          apiRequest<{ corrections: DashboardCorrection[] }>('/corrections?status=PENDING')
        ]);
        if (!cancelled) setData({ products: productResult.products, stock: stockResult.stock, assets: assetResult.assets, movements: movementResult.movements, corrections: correctionResult.corrections });
      } catch (caughtError) {
        if (!cancelled) setError(getApiErrorMessage(caughtError, 'No se pudo cargar el resumen operativo.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadDashboard();
    return () => { cancelled = true; };
  }, [fromDate, retry, toDate]);

  function handlePeriodChange(nextPeriod: string) {
    setPeriod(nextPeriod);
    if (nextPeriod === 'current-month') { setFromDate(firstDayOfCurrentMonth()); setToDate(todayIso()); }
    if (nextPeriod === 'last-30-days') { setFromDate(daysAgoIso(30)); setToDate(todayIso()); }
    if (nextPeriod === 'previous-month') { const previous = previousMonthRange(); setFromDate(previous.from); setToDate(previous.to); }
  }

  function handleDateChange(kind: 'from' | 'to', value: string) {
    setPeriod('custom');
    if (kind === 'from') setFromDate(value); else setToDate(value);
  }

  const summary = useMemo(() => buildSummary(data, fromDate, toDate), [data, fromDate, toDate]);

  return (
    <section className="dashboard-hero" aria-label="Dashboard de inventario">
      <div className="dashboard-grid-lines" aria-hidden="true" />
      <div className="dashboard-glow dashboard-glow-brand" aria-hidden="true" />
      <div className="dashboard-glow dashboard-glow-secondary" aria-hidden="true" />
      <div className="dashboard-dashboard-shell">
        <section className="dashboard-filter-bar" aria-label="Filtros del dashboard">
          <div className="dashboard-filter-title"><span className="dashboard-filter-icon" aria-hidden="true"><CalendarIcon /></span><div><strong>Periodo de análisis</strong><small>Filtra el flujo de inventario por fecha</small></div></div>
          <div className="dashboard-filter-control"><span>Rango</span><Select className="dashboard-filter-select" value={period} onChange={handlePeriodChange} options={[{ value: "current-month", label: "Mes actual" }, { value: "last-30-days", label: "Últimos 30 días" }, { value: "previous-month", label: "Mes anterior" }, { value: "custom", label: "Personalizado" }]} /></div>
          <DatePicker label="Desde" value={fromDate} maxDate={toDate} onChange={(value) => handleDateChange("from", value)} />
          <DatePicker label="Hasta" value={toDate} minDate={fromDate} maxDate={todayIso()} onChange={(value) => handleDateChange("to", value)} />
        </section>
        <section className="dashboard-intelligence dashboard-reveal" aria-label="Indicadores del dashboard">
          {error ? <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>Reintentar</Button>}>{error}</Alert> : <>
          <div className="dashboard-metric-grid">
            <MetricCard loading={loading} label="Productos activos" value={summary.productCount.toString()} hint="En el catálogo" accent="brand" />
            <MetricCard loading={loading} label="Stock disponible" value={formatNumber(summary.totalStock)} hint="Unidades cuantificables" accent="secondary" />
            <MetricCard loading={loading} label="Equipos rastreables" value={summary.assetCount.toString()} hint="Activos individuales" accent="soft" />
            <MetricCard loading={loading} label="Alertas de stock" value={summary.lowStockCount.toString()} hint={summary.lowStockCount > 0 ? "Requieren revisión" : "Sin alertas activas"} accent={summary.lowStockCount > 0 ? "warning" : "success"} />
          </div>
          <div className="dashboard-chart-grid dashboard-chart-grid-primary"><MovementTrend loading={loading} points={summary.movementTrend} /><MovementBreakdown loading={loading} totals={summary.movementTotals} /></div>
          <div className="dashboard-chart-grid"><AssetStatusChart loading={loading} statuses={summary.assetStatuses} total={summary.assetCount} onSelectStatus={setAssetStatusDetail} /><AttentionPanel loading={loading} products={summary.lowStockProducts} onOpenAll={() => setAttentionDetailOpen(true)} /></div>
          <CorrectionsPanel loading={loading} corrections={data?.corrections ?? []} reviewer={isCorrectionReviewer} onOpenAll={() => setCorrectionsDetailOpen(true)} />
          {assetStatusDetail && <AssetStatusDetailDialog status={assetStatusDetail} assets={data?.assets ?? []} onClose={() => setAssetStatusDetail(null)} />}
          <AttentionDetailDialog open={attentionDetailOpen} products={summary.lowStockProducts} onClose={() => setAttentionDetailOpen(false)} />
          <DashboardCorrectionsDialog open={correctionsDetailOpen} corrections={data?.corrections ?? []} reviewer={isCorrectionReviewer} onClose={() => setCorrectionsDetailOpen(false)} />
          </>}
        </section>
      </div>
    </section>
  );
}
function firstDayOfCurrentMonth() { const date = new Date(); date.setDate(1); return date.toISOString().slice(0, 10); }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function daysAgoIso(days: number) { const date = new Date(); date.setDate(date.getDate() - days); return date.toISOString().slice(0, 10); }
function previousMonthRange() { const date = new Date(); const first = new Date(date.getFullYear(), date.getMonth() - 1, 1); const last = new Date(date.getFullYear(), date.getMonth(), 0); return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) }; }
function CalendarIcon() { return <DashboardIcon><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></DashboardIcon>; }

export function DatePicker({ label, value, minDate, maxDate, onChange }: { label: string; value: string; minDate?: string; maxDate?: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<globalThis.HTMLDivElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const selectedDate = value ? parseIsoDate(value) : undefined;
  const initialDate = parseIsoDate(value || todayIso());
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1, 12));
  const disabledDates = [minDate ? { before: parseIsoDate(minDate) } : undefined, maxDate ? { after: parseIsoDate(maxDate) } : undefined].filter((matcher): matcher is { before: Date } | { after: Date } => Boolean(matcher));
  useEffect(() => {
    const nextDate = parseIsoDate(value || todayIso());
    setCalendarMonth(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1, 12));
  }, [value]);
  useEffect(() => {
    const closeOnOutsideClick = (event: globalThis.PointerEvent) => { if (!(event.target instanceof globalThis.Node)) return; const target = event.target; if (rootRef.current?.contains(target) || (target instanceof globalThis.Element && target.closest('.dashboard-picker-select'))) return; closePicker(); };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  // closePicker is intentionally kept local so the popover can animate before unmounting.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => { if (closeTimerRef.current !== undefined) globalThis.clearTimeout(closeTimerRef.current); }, []);
  function openPicker() {
    if (closeTimerRef.current !== undefined) globalThis.clearTimeout(closeTimerRef.current);
    setClosing(false);
    setOpen(true);
  }
  function closePicker() {
    if (!open || closing) return;
    setClosing(true);
    closeTimerRef.current = globalThis.window.setTimeout(() => { setOpen(false); setClosing(false); closeTimerRef.current = undefined; }, 140);
  }
  return <div className="dashboard-date-field" ref={rootRef}><span className="dashboard-date-label">{label}</span><button className="dashboard-date-trigger" type="button" aria-label={`${label}: ${formatDateValue(value)}`} aria-expanded={open} onClick={() => { if (open && !closing) closePicker(); else openPicker(); }}><span>{formatDateValue(value)}</span><CalendarIcon /></button>{open && <div className="dashboard-date-popover" data-state={closing ? 'closing' : 'open'}><DayPicker mode="single" selected={selectedDate} onSelect={(date) => { if (date) { onChange(toIsoDate(date)); closePicker(); } }} disabled={disabledDates} showOutsideDays fixedWeeks weekStartsOn={1} navLayout="around" month={calendarMonth} onMonthChange={setCalendarMonth} startMonth={new Date(2020, 0, 1)} endMonth={parseIsoDate(todayIso())} components={{ MonthCaption: ({ calendarMonth: month }) => <DashboardMonthCaption calendarMonth={month} onChange={setCalendarMonth} /> }} locale={es} /></div>}</div>;
}
function DashboardMonthCaption({ calendarMonth, onChange }: { calendarMonth: CalendarMonth; onChange: (month: Date) => void }) {
  const current = calendarMonth.date;
  const year = current.getFullYear();
  const month = current.getMonth();
  const yearOptions = Array.from({ length: new Date().getFullYear() - 2019 }, (_, index) => { const optionYear = 2020 + index; return { value: String(optionYear), label: String(optionYear) }; });
  const monthOptions = Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: new Intl.DateTimeFormat('es-CL', { month: 'long' }).format(new Date(2020, index, 1)) }));
  return <div className="rdp-month_caption dashboard-calendar-caption"><Select className="dashboard-picker-select" value={String(month)} onChange={(value) => onChange(new Date(year, Number(value), 1, 12))} options={monthOptions} /><Select className="dashboard-picker-select" value={String(year)} onChange={(value) => onChange(new Date(Number(value), month, 1, 12))} options={yearOptions} /></div>;
}

function parseIsoDate(value: string) { const [year, month, day] = value.split('-').map(Number); if (![year, month, day].every(Number.isFinite) || month < 1 || month > 12 || day < 1 || day > 31) return parseIsoDate(todayIso()); return new Date(year, month - 1, day, 12); }
function toIsoDate(value: Date) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function formatDateValue(value: string) { if (!value) return 'Seleccionar fecha'; return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }).format(parseIsoDate(value)).replaceAll('.', ''); }

function buildSummary(data: DashboardData | null, fromDate: string, toDate: string) {
  const productCount = data?.products.length ?? 0;
  const stockByProduct = new Map<string, number>();
  data?.stock.forEach((row) => {
    stockByProduct.set(row.productId, (stockByProduct.get(row.productId) ?? 0) + row.quantity);
  });
  const lowStockProducts = data?.products.filter((product) => product.trackingMode === 'QUANTITY' && product.lowStockThreshold > 0 && (stockByProduct.get(product.id) ?? 0) <= product.lowStockThreshold).map((product) => ({ id: product.id, name: product.name, current: stockByProduct.get(product.id) ?? 0, threshold: product.lowStockThreshold })) ?? [];
  const assetStatuses = new Map<AssetStatus, number>();
  data?.assets.forEach((asset) => assetStatuses.set(asset.status, (assetStatuses.get(asset.status) ?? 0) + 1));
  const movementByDay = new Map<string, { label: string; entradas: number; salidas: number; ajustes: number }>();
  const movementTotals = { entradas: 0, salidas: 0, ajustes: 0 };
  const rangeStart = new Date(`${fromDate}T12:00:00`);
  const rangeEnd = new Date(`${toDate}T12:00:00`);
  const rangeDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86400000) + 1);
  const chartDays = Math.min(rangeDays, 31);
  const chartStart = new Date(rangeEnd);
  chartStart.setDate(chartStart.getDate() - chartDays + 1);
  for (let offset = 0; offset < chartDays; offset += 1) {
    const date = new Date(chartStart);
    date.setDate(chartStart.getDate() + offset);
    const key = date.toISOString().slice(0, 10);
    movementByDay.set(key, { label: new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short' }).format(date).replace('.', ''), entradas: 0, salidas: 0, ajustes: 0 });
  }
  data?.movements.forEach((movement) => {
    const point = movementByDay.get(movement.effectiveAt.slice(0, 10));
    if (!point) return;
    if (movement.movementType === 'ENTRY' || movement.movementType === 'INITIAL' || movement.movementType === 'RETURN') { point.entradas += movement.quantity; movementTotals.entradas += movement.quantity; }
    else if (movement.movementType === 'EXIT') { point.salidas += movement.quantity; movementTotals.salidas += movement.quantity; }
    else { point.ajustes += Math.abs(movement.quantity); movementTotals.ajustes += Math.abs(movement.quantity); }
  });
  return {
    productCount,
    totalStock: data?.stock.reduce((total, row) => total + row.quantity, 0) ?? 0,
    assetCount: data?.assets.length ?? 0,
    lowStockCount: lowStockProducts.length,
    lowStockProducts,
    movementTotals,
    assetStatuses: [...assetStatuses.entries()].sort((a, b) => b[1] - a[1]),
    movementTrend: [...movementByDay.values()]
  };
}
function MetricCard({ label, value, hint, accent, loading = false }: { label: string; value: string; hint: string; accent: string; loading?: boolean }) { return <article className={`dashboard-metric-card dashboard-metric-${accent}${loading ? " dashboard-metric-card-calculating" : ""}`}><span>{label}</span>{loading ? <strong className="dashboard-metric-value-skeleton" aria-label="Calculando" /> : <strong>{value}</strong>}<small>{loading ? "Actualizando…" : hint}</small></article>; }
const chartAxisStyle = { fill: "var(--dashboard-muted)", fontSize: 11 };
function DashboardTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: number | string; color?: string }>; label?: string | number }) { if (!active || !payload?.length) return null; return <div className="dashboard-chart-tooltip"><strong className="dashboard-chart-tooltip-label">{label}</strong>{payload.map((entry) => <div className="dashboard-chart-tooltip-row" key={String(entry.name)}><span><i style={{ background: entry.color ?? "var(--dashboard-brand)" }} />{entry.name}</span><b>{formatNumber(Number(entry.value ?? 0))}</b></div>)}</div>; }
function MovementTrend({ loading, points }: { loading: boolean; points: Array<{ label: string; entradas: number; salidas: number; ajustes: number }> }) { return <article className="dashboard-chart dashboard-chart-large" aria-labelledby="dashboard-trend-title"><div className="dashboard-chart-heading"><div><p>Periodo seleccionado</p><h3 id="dashboard-trend-title">Flujo de inventario</h3></div><div className="dashboard-chart-legend"><span><i className="dashboard-legend-entry" /> Entradas</span><span><i className="dashboard-legend-exit" /> Salidas</span></div></div>{loading ? <ChartLoading /> : <><div className="dashboard-rechart"><ResponsiveContainer width="100%" height={232}><AreaChart data={points} margin={{ top: 12, right: 8, left: -20, bottom: 0 }}><defs><linearGradient id="dashboard-entry-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#FFD000" stopOpacity={0.32} /><stop offset="100%" stopColor="#FFD000" stopOpacity={0} /></linearGradient><linearGradient id="dashboard-exit-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f5b800" stopOpacity={0.2} /><stop offset="100%" stopColor="#f5b800" stopOpacity={0} /></linearGradient></defs><CartesianGrid vertical={false} stroke="var(--dashboard-chart-grid)" strokeDasharray="3 5" /><XAxis dataKey="label" tick={chartAxisStyle} tickLine={false} axisLine={false} interval="preserveStartEnd" /><YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} allowDecimals={false} /><Tooltip content={<DashboardTooltip />} cursor={{ stroke: "var(--dashboard-brand)", strokeDasharray: "4 4" }} /><Area type="monotone" dataKey="entradas" name="Entradas" stroke="#2563eb" strokeWidth={2.5} fill="url(#dashboard-entry-fill)" /><Area type="monotone" dataKey="salidas" name="Salidas" stroke="#dc2626" strokeWidth={2} fill="url(#dashboard-exit-fill)" /></AreaChart></ResponsiveContainer></div><p className="dashboard-chart-caption">Cantidad de unidades registradas por día. Los ajustes se reservan para la lectura de alertas.</p></>}</article>; }
function MovementBreakdown({ loading, totals }: { loading: boolean; totals: { entradas: number; salidas: number; ajustes: number } }) { const points = [{ name: "Entradas", value: totals.entradas, fill: "#2563eb" }, { name: "Salidas", value: totals.salidas, fill: "#dc2626" }, { name: "Ajustes", value: totals.ajustes, fill: "#d97706" }]; return <article className="dashboard-chart" aria-labelledby="dashboard-breakdown-title"><div className="dashboard-chart-heading"><div><p>Periodo seleccionado</p><h3 id="dashboard-breakdown-title">Movimientos registrados</h3></div><span>Unidades</span></div>{loading ? <ChartLoading /> : <div className="dashboard-rechart dashboard-rechart-bar"><ResponsiveContainer width="100%" height={232}><BarChart data={points} layout="vertical" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}><CartesianGrid horizontal={false} stroke="var(--dashboard-chart-grid)" strokeDasharray="3 5" /><XAxis type="number" hide allowDecimals={false} /><YAxis type="category" dataKey="name" width={72} tick={chartAxisStyle} tickLine={false} axisLine={false} /><Tooltip content={<DashboardTooltip />} cursor={{ fill: "color-mix(in srgb, var(--dashboard-text) 8%, transparent)" }} /><Bar dataKey="value" name="Unidades" radius={[0, 5, 5, 0]} barSize={22}>{points.map((point) => <Cell key={point.name} fill={point.fill} />)}</Bar></BarChart></ResponsiveContainer></div>}</article>; }
function AssetStatusChart({ loading, statuses, total, onSelectStatus }: { loading: boolean; statuses: Array<[AssetStatus, number]>; total: number; onSelectStatus: (status: AssetStatus) => void }) { const data = statuses.map(([status, value]) => ({ status, name: assetStatusLabels[status], description: assetStatusDescriptions[status], value, percentage: total > 0 ? Math.round((value / total) * 100) : 0, color: statusChartColors[status] })); return <article className="dashboard-chart dashboard-status-chart" aria-labelledby="dashboard-asset-chart-title"><div className="dashboard-chart-heading"><div><p>Activos rastreables</p><h3 id="dashboard-asset-chart-title">Distribución por estado</h3></div><span>{formatNumber(total)} activos</span></div>{loading ? <ChartLoading /> : statuses.length === 0 ? <ChartEmpty text="No hay activos rastreables." /> : <div className="dashboard-donut-layout"><div className="dashboard-rechart dashboard-donut"><ResponsiveContainer width="100%" height={250}><PieChart><Tooltip content={<DashboardTooltip />} allowEscapeViewBox={{ x: true, y: true }} /><Pie data={data} dataKey="value" nameKey="name" innerRadius={72} outerRadius={103} paddingAngle={3} stroke="none">{data.map((entry) => <Cell key={entry.name} fill={entry.color} className="dashboard-chart-clickable" onClick={() => onSelectStatus(entry.status)} />)}</Pie></PieChart></ResponsiveContainer><strong>{formatNumber(total)}<small>activos rastreables</small></strong></div><div className="dashboard-status-list dashboard-status-list-compact">{data.map((entry) => <button className="dashboard-status-row" type="button" key={entry.name} onClick={() => onSelectStatus(entry.status)}><span className="dashboard-status-dot" style={{ background: entry.color }} aria-hidden="true" /><span className="dashboard-status-copy"><strong>{entry.name}</strong><small>{entry.description}</small></span><span className="dashboard-status-count"><strong>{entry.value}</strong><small>{entry.percentage}%</small></span><ArrowIcon /></button>)}</div></div>}</article>; }
const statusChartColors: Record<AssetStatus, string> = { AVAILABLE: "#22c55e", ASSIGNED: "#FFD000", RESERVED: "#2563eb", UNDER_REVIEW: "#c2410c", IN_REPAIR: "#f97316", IN_WARRANTY: "#60a5fa", LOST: "#d95d6a", DECOMMISSIONED: "#73736e" };
function AttentionPanel({ loading, products, onOpenAll }: { loading: boolean; products: Array<{ name: string; current: number; threshold: number }>; onOpenAll: () => void }) { return <article className="dashboard-chart dashboard-attention-chart" aria-labelledby="dashboard-attention-title"><div className="dashboard-chart-heading"><div><p>Productos con stock bajo el mínimo configurado</p><h3 id="dashboard-attention-title">Atención requerida</h3></div><div className="dashboard-attention-heading-actions"><span className="dashboard-attention-count"><AlertTriangleIcon />{products.length} alertas</span>{products.length > 5 && <button type="button" className="dashboard-attention-view-all" onClick={onOpenAll}>Ver todas <ArrowIcon /></button>}</div></div>{loading ? <ChartLoading /> : products.length === 0 ? <div className="dashboard-attention-empty"><span aria-hidden="true">✓</span><strong>Todo bajo control</strong><p>No hay productos bajo su umbral mínimo.</p></div> : <div className="dashboard-alert-list">{products.slice(0, 5).map((product) => { const coverage = product.threshold > 0 ? Math.min(100, Math.round((product.current / product.threshold) * 100)) : 100; return <div className="dashboard-alert-row" key={product.name}><span className="dashboard-alert-icon" aria-hidden="true"><AlertTriangleIcon /></span><div className="dashboard-attention-product"><div className="dashboard-attention-product-heading"><strong>{product.name}</strong></div><div className="dashboard-attention-metrics"><StockMetric label="Disponible" value={formatNumber(product.current)} icon={<StockAvailableIcon />} /><StockMetric label="Mínimo" value={formatNumber(product.threshold)} icon={<StockMinimumIcon />} /><StockMetric label="Cobertura" value={`${coverage}%`} icon={<StockCoverageIcon />} /></div><div className="dashboard-alert-meter" aria-label={`${coverage}% del mínimo cubierto`}><span style={{ width: String(coverage) + "%" }} /></div></div><Link className="dashboard-detail-link" to={{ pathname: "/inventory", search: "?product=" + encodeURIComponent(product.name) }}><span>Revisar</span><ArrowIcon /></Link></div>; })}</div>}</article>; }
function CorrectionsPanel({ loading, corrections, reviewer, onOpenAll }: { loading: boolean; corrections: DashboardCorrection[]; reviewer: boolean; onOpenAll: () => void }) {
  return <article className="dashboard-chart dashboard-corrections-panel" aria-labelledby="dashboard-corrections-title"><div className="dashboard-chart-heading"><div><p>{reviewer ? 'Solicitudes que requieren una decisión' : 'Solicitudes enviadas por tu equipo'}</p><h3 id="dashboard-corrections-title">Correcciones pendientes</h3></div><div className="dashboard-corrections-heading-actions"><span className="dashboard-corrections-count"><CorrectionIcon />{corrections.length}</span>{corrections.length > 0 && <button type="button" className="dashboard-attention-view-all" onClick={onOpenAll}>Ver bandeja <ArrowIcon /></button>}</div></div>{loading ? <ChartLoading /> : corrections.length === 0 ? <div className="dashboard-corrections-empty"><span className="dashboard-corrections-empty-icon"><CheckIcon /></span><div><strong>No hay correcciones pendientes</strong><p>{reviewer ? 'La bandeja está al día.' : 'Tus solicitudes aparecerán aquí mientras esperan revisión.'}</p></div><Link className="dashboard-detail-link" to="/corrections">Abrir Correcciones <ArrowIcon /></Link></div> : <div className="dashboard-correction-list">{corrections.slice(0, 4).map((correction, index) => <article className="dashboard-correction-row" key={correction.id}><span className="dashboard-correction-index">{String(index + 1).padStart(2, '0')}</span><span className={`dashboard-correction-icon dashboard-correction-icon-${correction.delta > 0 ? 'increase' : 'decrease'}`}><CorrectionDirectionIcon delta={correction.delta} /></span><div className="dashboard-correction-copy"><strong>{correction.originalMovement.product.name}</strong><span>Antes {correction.previousQuantity > 0 ? '+' : ''}{correction.previousQuantity} → final {correction.correctedQuantity > 0 ? '+' : ''}{correction.correctedQuantity} · {correction.requestedBy.displayName}</span><small>{correction.reason}</small></div><span className={`dashboard-correction-delta ${correction.delta > 0 ? 'is-positive' : 'is-negative'}`}><CorrectionDirectionIcon delta={correction.delta} />{correction.delta > 0 ? '+' : ''}{correction.delta} unidades</span><span className="dashboard-correction-date">{formatDashboardDate(correction.createdAt)}</span><Link className="dashboard-correction-review" to={correctionRoute(correction)}><EyeIcon />{reviewer ? 'Revisar' : 'Ver solicitud'}</Link></article>)}</div>}{corrections.length > 4 && <p className="dashboard-corrections-more">Hay {corrections.length - 4} solicitudes más esperando revisión.</p>}</article>;
}
function DashboardCorrectionsDialog({ open, corrections, reviewer, onClose }: { open: boolean; corrections: DashboardCorrection[]; reviewer: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} title={<span className="dashboard-dialog-title"><span className="dashboard-dialog-title-icon"><CorrectionIcon /></span>{reviewer ? 'Bandeja de correcciones' : 'Mis correcciones pendientes'}</span>} description={reviewer ? 'Revisa cada solicitud antes de aplicar un ajuste al stock.' : 'Consulta el estado de las solicitudes que has enviado.'} className="dashboard-detail-dialog dashboard-corrections-dialog" actions={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}><div className="dashboard-corrections-dialog-list">{corrections.length === 0 ? <ChartEmpty text="No hay solicitudes pendientes." /> : corrections.map((correction) => <article className="dashboard-correction-dialog-row" key={correction.id}><div className="dashboard-correction-dialog-main"><span className={`dashboard-correction-icon dashboard-correction-icon-${correction.delta > 0 ? 'increase' : 'decrease'}`}><CorrectionDirectionIcon delta={correction.delta} /></span><div><strong>{correction.originalMovement.product.name}</strong><span>Antes {correction.previousQuantity > 0 ? '+' : ''}{correction.previousQuantity} → final {correction.correctedQuantity > 0 ? '+' : ''}{correction.correctedQuantity} · registrada el {formatDashboardDate(correction.createdAt)}</span><small>Solicitada por {correction.requestedBy.displayName} · {correction.reason}</small></div></div><div className="dashboard-correction-dialog-side"><span className={`dashboard-correction-delta ${correction.delta > 0 ? 'is-positive' : 'is-negative'}`}><CorrectionDirectionIcon delta={correction.delta} />{correction.delta > 0 ? '+' : ''}{correction.delta} unidades</span><Link className="dashboard-detail-link" to={correctionRoute(correction)} onClick={onClose}>{reviewer ? 'Revisar' : 'Ver solicitud'} <ArrowIcon /></Link></div></article>)}</div></Dialog>;
}
function correctionRoute(correction: DashboardCorrection) { return { pathname: '/corrections', search: '?search=' + encodeURIComponent(correction.originalMovement.product.name) + '&correctionId=' + encodeURIComponent(correction.id) }; }
function AssetStatusDetailDialog({ status, assets, onClose }: { status: AssetStatus; assets: DashboardAsset[]; onClose: () => void }) { const matching = assets.filter((asset) => asset.status === status); return <Dialog open onClose={onClose} title={<span className="dashboard-dialog-title"><span className="dashboard-dialog-title-icon"><EquipmentIcon /></span>{assetStatusLabels[status]}</span>} description={`${matching.length} activos en este estado. Selecciona un equipo para ver su producto.`} className="dashboard-detail-dialog"><div className="dashboard-detail-list">{matching.length === 0 ? <ChartEmpty text="No hay equipos para mostrar." /> : matching.map((asset) => <article className="dashboard-asset-detail-row" key={asset.id}><span className="dashboard-asset-detail-icon"><EquipmentIcon /></span><div><strong>{asset.product.name}</strong><small>{asset.assetTag ?? "Sin etiqueta"} · {asset.serialNumber ?? "Sin número de serie"}</small></div><Link className="dashboard-detail-link" to={{ pathname: "/catalog", search: "?product=" + encodeURIComponent(asset.product.name) }} onClick={onClose}>Ver producto <ArrowIcon /></Link></article>)}</div></Dialog>; }
function AttentionDetailDialog({ open, products, onClose }: { open: boolean; products: Array<{ name: string; current: number; threshold: number }>; onClose: () => void }) { return <Dialog open={open} onClose={onClose} title={<span className="dashboard-dialog-title"><span className="dashboard-dialog-title-icon"><AlertTriangleIcon /></span>Atención requerida</span>} description={`${products.length} productos requieren atención porque están bajo el stock mínimo configurado.`} className="dashboard-detail-dialog"><div className="dashboard-detail-list dashboard-attention-detail-list">{products.length === 0 ? <ChartEmpty text="No hay alertas activas." /> : products.map((product) => { const coverage = product.threshold > 0 ? Math.min(100, Math.round((product.current / product.threshold) * 100)) : 100; return <article className="dashboard-detail-alert-row" key={product.name}><span className="dashboard-alert-icon" aria-hidden="true"><AlertTriangleIcon /></span><div className="dashboard-attention-product"><div className="dashboard-attention-product-heading"><strong>{product.name}</strong></div><div className="dashboard-attention-metrics"><StockMetric label="Disponible" value={formatNumber(product.current)} icon={<StockAvailableIcon />} /><StockMetric label="Mínimo" value={formatNumber(product.threshold)} icon={<StockMinimumIcon />} /><StockMetric label="Cobertura" value={`${coverage}%`} icon={<StockCoverageIcon />} /></div><div className="dashboard-alert-meter dashboard-detail-alert-meter" aria-label={`${coverage}% del mínimo cubierto`}><span style={{ width: String(coverage) + "%" }} /></div></div><Link className="dashboard-detail-link" to={{ pathname: "/inventory", search: "?product=" + encodeURIComponent(product.name) }} onClick={onClose}>Ver inventario <ArrowIcon /></Link></article>; })}</div></Dialog>; }
function StockMetric({ label, value, icon }: { label: string; value: string; icon: ReactNode }) { return <span className="dashboard-stock-metric"><span className="dashboard-stock-metric-icon">{icon}</span><b>{label}:</b><strong>{value}</strong></span>; }
function StockAvailableIcon() { return <DashboardIcon><path d="M4 8h16v11H4z" /><path d="M8 8V5h8v3M8 13h8" /></DashboardIcon>; }
function StockMinimumIcon() { return <DashboardIcon><path d="M5 5h14v14H5z" /><path d="M8 12h8M12 8v8" /></DashboardIcon>; }
function StockCoverageIcon() { return <DashboardIcon><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 10 3 4" /><path d="M5 18h14" /></DashboardIcon>; }
function AlertTriangleIcon() { return <DashboardIcon><path d="m12 4 9 16H3L12 4Z" /><path d="M12 9v4M12 16h.01" /></DashboardIcon>; }
function ArrowIcon() { return <DashboardIcon><path d="M5 12h14M13 6l6 6-6 6" /></DashboardIcon>; }
function EyeIcon() { return <DashboardIcon><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2" /></DashboardIcon>; }
function CorrectionIcon() { return <DashboardIcon><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h5M8 16h4" /></DashboardIcon>; }
function CorrectionDirectionIcon({ delta }: { delta: number }) { return <DashboardIcon className="dashboard-correction-direction-icon">{delta > 0 ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}</DashboardIcon>; }
function CheckIcon() { return <DashboardIcon><path d="m5 12 4 4L19 6" /></DashboardIcon>; }
function EquipmentIcon() { return <DashboardIcon><rect x="4" y="4" width="16" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></DashboardIcon>; }
function ChartLoading() { return <div className="dashboard-chart-placeholder" role="status">Cargando indicadores…</div>; }
function ChartEmpty({ text }: { text: string }) { return <div className="dashboard-chart-placeholder">{text}</div>; }
function formatNumber(value: number) { return new Intl.NumberFormat("es-CL").format(value); }
function DashboardIcon({ children, className = "" }: { children: ReactNode; className?: string }) { return <svg className={`h-5 w-5 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>; }
function formatDashboardDate(value: string) { return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)).replaceAll('.', ''); }
