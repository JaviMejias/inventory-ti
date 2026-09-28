import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { apiRequest, getApiErrorMessage } from '../../lib/api';
import { useToast, useRequestError } from '../../ui';
import { useAuth } from '../auth/auth-context';
import { AssignmentPanel } from './AssignmentPanel';

type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'RESERVED' | 'UNDER_REVIEW' | 'IN_REPAIR' | 'IN_WARRANTY' | 'LOST' | 'DECOMMISSIONED';
type Product = { id: string; name: string; sku: string | null; trackingMode: 'QUANTITY' | 'ASSET' };
type Asset = { id: string; productId: string; assetTag: string | null; serialNumber: string | null; status: AssetStatus; isActive: boolean; decommissionedAt: string | null; createdAt: string; updatedAt: string; product: Product };

const statusLabels: Record<AssetStatus, string> = {
  AVAILABLE: 'Disponible',
  ASSIGNED: 'Asignado',
  RESERVED: 'Reservado',
  UNDER_REVIEW: 'En revisión',
  IN_REPAIR: 'En reparación',
  IN_WARRANTY: 'En garantía',
  LOST: 'Perdido',
  DECOMMISSIONED: 'Dado de baja'
};

const operationalStatuses: AssetStatus[] = ['AVAILABLE', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR', 'IN_WARRANTY', 'LOST'];
const supportStatuses: AssetStatus[] = ['AVAILABLE', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR'];

const request = apiRequest;

async function mutate<T>(path: string, method: 'POST' | 'PATCH', body?: unknown): Promise<T> {
  const { csrfToken } = await request<{ csrfToken: string }>('/auth/csrf');
  return request<T>(path, { method, headers: { 'X-CSRF-Token': csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export function AssetsPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const reportError = useRequestError();
  const canManage = user?.role === 'JEFE' || user?.role === 'COORDINADOR';
  const canDecommission = user?.role === 'JEFE';
  const allowedStatuses = user?.role === 'SOPORTE' ? supportStatuses : operationalStatuses;
  const [assets, setAssets] = useState<Asset[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [filters, setFilters] = useState({ search: '', productId: '', status: '', isActive: 'true' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Asset | 'new' | null>(null);
  const [detail, setDetail] = useState<Asset | null>(null);
  const [statusAsset, setStatusAsset] = useState<Asset | null>(null);
  const [assignmentAsset, setAssignmentAsset] = useState<Asset | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new globalThis.URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => { if (value) query.set(key, value); });
      const [assetResult, productResult] = await Promise.all([
        request<{ assets: Asset[] }>(`/assets?${query}`),
        request<{ products: Product[] }>('/products?active=true&limit=100')
      ]);
      setAssets(assetResult.assets);
      setProducts(productResult.products.filter((product) => product.trackingMode === 'ASSET'));
    } catch (caughtError) {
      setError(getApiErrorMessage(caughtError, 'No se pudieron cargar los activos.'));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  async function decommission(asset: Asset) {
    if (!window.confirm(`¿Dar de baja el activo ${asset.assetTag ?? asset.serialNumber ?? asset.id}? Esta acción es terminal.`)) return;
    setError(null);
    try {
      await mutate(`/assets/${asset.id}/decommission`, 'POST');
      showToast({
        tone: 'success',
        title: 'Activo dado de baja',
        description: `${asset.assetTag ?? asset.serialNumber ?? asset.product.name} quedó fuera de operación.`
      });
      await load();
    } catch (caughtError) {
      setError(reportError(caughtError, 'No se pudo dar de baja el activo'));
    }
  }

  return (
    <section className="app-page app-page-fluid">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-600 dark:text-sky-400">Activos</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight">Equipos individuales</h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Unidades físicas rastreadas por producto, identificador y estado.</p>
        </div>
        {canManage && <button className="rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white transition hover:bg-sky-700" type="button" onClick={() => setEditor('new')}>Nuevo activo</button>}
      </div>

      <div className="mt-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5 dark:border-slate-800 dark:bg-slate-900">
        <Filter label="Buscar"><input aria-label="Buscar activos" className="field" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Tag, serial o producto" /></Filter>
        <Filter label="Producto"><select aria-label="Filtrar activos por producto" className="field" value={filters.productId} onChange={(event) => setFilters({ ...filters, productId: event.target.value })}><option value="">Todos</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></Filter>
        <Filter label="Estado"><select aria-label="Filtrar activos por estado" className="field" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Todos</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Filter>
        <Filter label="Actividad"><select aria-label="Filtrar activos por actividad" className="field" value={filters.isActive} onChange={(event) => setFilters({ ...filters, isActive: event.target.value })}><option value="true">Activos</option><option value="false">Inactivos</option><option value="">Todos</option></select></Filter>
      </div>

      {error && <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300" role="alert">{error}</p>}
      {loading ? <p className="mt-6 rounded-xl border border-dashed p-6 text-sm text-slate-500 dark:border-slate-700" role="status">Cargando activos…</p> : assets.length === 0 ? <p className="mt-6 rounded-xl border border-dashed p-6 text-sm text-slate-500 dark:border-slate-700">No hay activos para los filtros seleccionados.</p> : (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {assets.map((asset) => (
            <article className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900" key={asset.id}>
              <div className="flex items-start justify-between gap-3">
                <div><h3 className="font-semibold">{asset.assetTag ?? asset.serialNumber ?? 'Activo sin identificador'}</h3><p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{asset.product.name}</p></div>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold dark:bg-slate-800">{statusLabels[asset.status]}</span>
              </div>
              <p className="mt-3 text-sm text-slate-500">Serial: {asset.serialNumber ?? '—'} · Tag: {asset.assetTag ?? '—'}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Action onClick={() => setDetail(asset)}>Detalle</Action>
                {asset.isActive && (asset.status === 'AVAILABLE' || asset.status === 'ASSIGNED') && <Action onClick={() => setAssignmentAsset(asset)}>{asset.status === 'ASSIGNED' ? 'Asignación' : 'Asignar'}</Action>}
                {canManage && asset.isActive && <Action onClick={() => setEditor(asset)}>Editar</Action>}
                {asset.isActive && asset.status !== 'ASSIGNED' && <Action onClick={() => setStatusAsset(asset)}>Estado</Action>}
                {canDecommission && asset.isActive && asset.status !== 'ASSIGNED' && <Action danger onClick={() => void decommission(asset)}>Dar de baja</Action>}
              </div>
            </article>
          ))}
        </div>
      )}

      {editor && <AssetEditor asset={editor === 'new' ? null : editor} products={products} close={() => setEditor(null)} saved={() => { showToast({ tone: 'success', title: editor === 'new' ? 'Activo creado' : 'Activo actualizado', description: editor === 'new' ? 'La nueva unidad se agregó al registro de activos.' : `${editor.assetTag ?? editor.serialNumber ?? editor.product.name} se guardó correctamente.` }); setEditor(null); void load(); }} />}
      {detail && <AssetDetail asset={detail} close={() => setDetail(null)} />}
      {statusAsset && <StatusEditor asset={statusAsset} statuses={allowedStatuses} close={() => setStatusAsset(null)} saved={() => { showToast({ tone: 'success', title: 'Estado actualizado', description: `${statusAsset.assetTag ?? statusAsset.serialNumber ?? statusAsset.product.name} cambió de estado.` }); setStatusAsset(null); void load(); }} />}
      {assignmentAsset && <AssignmentPanel asset={assignmentAsset} close={() => setAssignmentAsset(null)} saved={() => { setAssignmentAsset(null); void load(); }} />}
    </section>
  );
}

function Filter({ label, children }: { label: string; children: ReactNode }) { return <label className="text-sm font-medium">{label}{children}</label>; }
function Action({ children, danger = false, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) { return <button className={`rounded-md border px-3 py-1.5 text-sm transition ${danger ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30' : 'border-slate-300 hover:border-sky-500 dark:border-slate-700'}`} type="button" onClick={onClick}>{children}</button>; }

function AssetEditor({ asset, products, close, saved }: { asset: Asset | null; products: Product[]; close: () => void; saved: () => void }) {
  const reportError = useRequestError();
  const [form, setForm] = useState({ productId: asset?.productId ?? products[0]?.id ?? '', assetTag: asset?.assetTag ?? '', serialNumber: asset?.serialNumber ?? '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const body = asset ? { assetTag: form.assetTag || null, serialNumber: form.serialNumber || null } : { ...form, assetTag: form.assetTag || null, serialNumber: form.serialNumber || null };
      await mutate(asset ? `/assets/${asset.id}` : '/assets', asset ? 'PATCH' : 'POST', body);
      saved();
    } catch (caughtError) { setError(reportError(caughtError, 'No se pudo guardar el activo')); }
    finally { setSaving(false); }
  }
  return <Dialog title={asset ? 'Editar activo' : 'Nuevo activo'} close={close}><form className="space-y-4" noValidate onSubmit={submit}>{!asset && <Field label="Producto"><select className="field" required value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></Field>}<Field label="Asset tag"><input className="field" maxLength={100} value={form.assetTag} onChange={(event) => setForm({ ...form, assetTag: event.target.value })} /></Field><Field label="Número de serie"><input className="field" maxLength={160} value={form.serialNumber} onChange={(event) => setForm({ ...form, serialNumber: event.target.value })} /></Field>{error && <p className="text-sm text-red-600 dark:text-red-300" role="alert">{error}</p>}<DialogActions close={close} saving={saving} /></form></Dialog>;
}

function StatusEditor({ asset, statuses, close, saved }: { asset: Asset; statuses: AssetStatus[]; close: () => void; saved: () => void }) {
  const reportError = useRequestError();
  const choices = statuses.filter((status) => status !== asset.status);
  const [status, setStatus] = useState<AssetStatus>(choices[0] ?? asset.status);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); try { await mutate(`/assets/${asset.id}/status`, 'POST', { status }); saved(); } catch (caughtError) { setError(reportError(caughtError, 'No se pudo cambiar el estado')); } }
  return <Dialog title="Cambiar estado" close={close}><form className="space-y-4" noValidate onSubmit={submit}><p className="text-sm text-slate-600 dark:text-slate-300">Estado actual: {statusLabels[asset.status]}</p><Field label="Nuevo estado"><select className="field" value={status} onChange={(event) => setStatus(event.target.value as AssetStatus)}>{choices.map((choice) => <option key={choice} value={choice}>{statusLabels[choice]}</option>)}</select></Field>{error && <p className="text-sm text-red-600" role="alert">{error}</p>}<DialogActions close={close} saving={false} /></form></Dialog>;
}

function AssetDetail({ asset, close }: { asset: Asset; close: () => void }) {
  return <Dialog title="Detalle del activo" close={close}><dl className="grid gap-4 text-sm sm:grid-cols-2"><Detail label="Producto" value={asset.product.name} /><Detail label="Asset tag" value={asset.assetTag ?? '—'} /><Detail label="Número de serie" value={asset.serialNumber ?? '—'} /><Detail label="Estado" value={statusLabels[asset.status]} /><Detail label="Actividad" value={asset.isActive ? 'Activo' : 'Inactivo'} /><Detail label="Actualizado" value={new Date(asset.updatedAt).toLocaleString('es-CL')} /></dl></Dialog>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block text-sm font-medium">{label}{children}</label>; }
function Detail({ label, value }: { label: string; value: string }) { return <div><dt className="font-medium text-slate-500">{label}</dt><dd className="mt-1">{value}</dd></div>; }
function DialogActions({ close, saving, disabled = false }: { close: () => void; saving: boolean; disabled?: boolean }) { return <div className="flex justify-end gap-2"><button className="rounded-lg border px-4 py-2" type="button" onClick={close}>Cancelar</button><button className="rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white disabled:opacity-50" type="submit" disabled={saving || disabled}>{saving ? 'Guardando…' : 'Guardar'}</button></div>; }

function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialogRef = useRef<globalThis.HTMLDialogElement>(null);
  useEffect(() => {
    const previous = globalThis.document.activeElement instanceof globalThis.HTMLElement ? globalThis.document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    return () => { if (dialog.open) dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialogRef} tabIndex={-1} className="m-auto w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl outline-none backdrop:bg-slate-950/60 dark:bg-slate-900" aria-labelledby="asset-dialog-title" onCancel={(event) => { event.preventDefault(); close(); }}><div className="mb-5 flex items-center justify-between gap-3"><h2 id="asset-dialog-title" className="text-xl font-bold">{title}</h2><button className="rounded px-2 text-2xl" type="button" aria-label="Cerrar" onClick={close}>×</button></div>{children}</dialog>;
}
