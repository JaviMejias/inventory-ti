import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../../lib/api';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, DataTable, EmptyState, Icon, LoadingState, Pagination, useRequestError } from '../../ui';
import { readRetirementApplication, readRetirementApplications } from './retirement-application-api';
import { RetirementApplicationDetails } from './RetirementApplicationDetails';
import { useHistoryRead } from './useHistoryRead';

export function AssetRetirementApplications({ assetId }: { assetId: string }) {
  const [consult, setConsult] = useState(false);
  return <section className="space-y-4" aria-label="Bajas históricas aplicadas">
    <Button variant="secondary" aria-expanded={consult} onClick={() => setConsult((value) => !value)}><Icon size="sm"><path d="M6 3h12v18l-6-3-6 3V3Z" /><path d="M9 8h6M9 12h4" /></Icon>{consult ? 'Ocultar comprobantes de baja' : 'Consultar comprobantes de baja'}</Button>
    {consult && <RetirementApplicationList key={assetId} assetId={assetId} />}
  </section>;
}
function RetirementApplicationList({ assetId }: { assetId: string }) {
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<string | null>(null);
  const total = useRef<number | null>(null);
  const trigger = useRef<globalThis.HTMLButtonElement | null>(null);
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    const page = await readRetirementApplications(assetId, offset, signal);
    if (offset && total.current !== null && total.current !== page.total) throw new ApiRequestError('Retirement list changed', 409, 'RETIREMENT_APPLICATION_LIST_CHANGED');
    if (!signal.aborted) total.current = page.total;
    return page;
  }, [assetId, offset]);
  const query = useHistoryRead(read, 'No se pudieron consultar los comprobantes de baja.');
  const data = query.data;
  return <div className="space-y-4">
    <Button variant="secondary" size="sm" loading={query.reading} onClick={() => { setTarget(null); if (offset) setOffset(0); else void query.refresh(); }}>Actualizar bajas desde el inicio</Button>
    {query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar comprobantes de baja</Button>}>{query.error}{data && ' Se conserva la página anterior sin confirmar su vigencia.'}</Alert>}
    {query.reading && data && <LoadingState label="Actualizando comprobantes de baja…" />}
    <DataTable className="catalog-data-table" caption="Comprobantes de baja histórica, por fecha de registro" rows={data ? [...data.items] : []} loading={query.reading && !data} getRowKey={(entry) => entry.id}
      empty={query.error ? <></> : data?.offset ? <Alert variant="warning">Esta página ya no contiene comprobantes. Actualiza desde el inicio.</Alert> : <EmptyState title="Sin bajas históricas aplicadas" description="Preparar una baja no crea un comprobante. Las bajas ordinarias o agrupadas tienen su propia procedencia." />} columns={[
        { key: 'time', header: 'Retiro histórico', mobileRole: 'identity', render: (entry) => formatInventoryDateTime(entry.decommissionedAt) },
        { key: 'status', header: 'Registro', mobileRole: 'full', render: () => <Badge variant="danger">Baja definitiva</Badge> },
        { key: 'capture', header: 'Captura en la app', mobileRole: 'full', render: (entry) => formatInventoryDateTime(entry.appliedAt) },
        { key: 'actor', header: 'Registrado por (ID)', mobileRole: 'full', render: (entry) => <span className="break-words">{entry.appliedById}</span> },
        { key: 'actions', header: 'Acciones', mobileRole: 'actions', render: (entry) => <Button variant="secondary" size="sm" onClick={(event) => { trigger.current = event.currentTarget; setTarget(entry.id); }}>Ver comprobante de baja</Button> }
      ]} />
    {data && data.total > 0 && <><p className="inventory-metadata-hint">{data.offset + 1}–{data.offset + data.items.length} de {data.total} comprobantes · hora de Chile</p><Pagination page={Math.floor(data.offset / 25) + 1} pageCount={Math.max(1, Math.ceil(data.total / 25))} loading={query.reading || Boolean(query.error)} onPageChange={(page) => { setTarget(null); setOffset((page - 1) * 25); }} /></>}
    {target && <RetirementReceipt key={target} assetId={assetId} id={target} close={() => { setTarget(null); trigger.current?.focus({ preventScroll: true }); }} />}
  </div>;
}
export function RetirementReceipt({ assetId, id, close }: { assetId: string; id: string; close: () => void }) {
  const section = useRef<globalThis.HTMLElement>(null);
  const reportError = useRequestError();
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    try { return await readRetirementApplication(assetId, id, signal); }
    catch (error) { if (!signal.aborted) reportError(error, 'No se pudo consultar este comprobante de baja.'); throw error; }
  }, [assetId, id, reportError]);
  const query = useHistoryRead(read, 'No se pudo consultar este comprobante de baja.');
  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => section.current?.querySelector<globalThis.HTMLElement>('[data-retirement-application-result], [data-retirement-receipt-error]')?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [query.data, query.error]);
  return <section ref={section} className="inventory-metadata-section space-y-4" aria-label="Detalle del comprobante de baja seleccionado">
    <Button variant="secondary" size="sm" onClick={close}>Cerrar detalle de baja</Button>
    {query.reading && <LoadingState label="Consultando comprobante de baja…" />}
    {query.error && <div tabIndex={-1} data-retirement-receipt-error><Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar detalle de baja</Button>}>{query.error}</Alert></div>}
    {query.data && <RetirementApplicationDetails application={query.data} />}
  </section>;
}
