import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../../lib/api';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Button, DataTable, EmptyState, LoadingState, Pagination } from '../../ui';
import { readClosedApplication, readClosedApplications } from './closed-application-api';
import { ClosedApplicationDetails } from './ClosedApplicationDetails';
import { useHistoryRead } from './useHistoryRead';

export function AssetClosedApplications({ assetId }: { assetId: string }) {
  const [consult, setConsult] = useState(false);
  return <section className="space-y-4" aria-label="Historia cerrada aplicada">
    <Button variant="secondary" aria-expanded={consult} onClick={() => setConsult((value) => !value)}>{consult ? 'Ocultar comprobantes de periodos' : 'Consultar comprobantes de periodos'}</Button>
    {consult && <ClosedApplicationList assetId={assetId} />}
  </section>;
}
function ClosedApplicationList({ assetId }: { assetId: string }) {
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<string | null>(null);
  const total = useRef<number | null>(null);
  const trigger = useRef<globalThis.HTMLButtonElement | null>(null);
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    const page = await readClosedApplications(assetId, offset, signal);
    if (offset && total.current !== null && total.current !== page.total) throw new ApiRequestError('Historical application list changed', 409, 'CLOSED_APPLICATION_LIST_CHANGED');
    if (!signal.aborted) total.current = page.total;
    return page;
  }, [assetId, offset]);
  const query = useHistoryRead(read, 'No se pudieron consultar los comprobantes de periodos.');
  const data = query.data;
  return <div className="space-y-4">
    <Button variant="secondary" size="sm" loading={query.reading} onClick={() => { setTarget(null); if (offset) setOffset(0); else void query.refresh(); }}>Actualizar periodos desde el inicio</Button>
    {query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar comprobantes de periodos</Button>}>{query.error}{data && ' Se conserva la página anterior.'}</Alert>}
    {query.reading && data && <LoadingState label="Actualizando comprobantes de periodos…" />}
    <DataTable className="catalog-data-table" caption="Periodos aplicados, del comprobante más reciente al más antiguo" rows={data?.items ?? []} loading={query.reading && !data} getRowKey={(entry) => entry.id}
      empty={query.error ? <></> : data?.offset ? <Alert variant="warning">Esta página ya no contiene comprobantes. Actualiza desde el inicio.</Alert> : <EmptyState title="Sin periodos históricos aplicados" description="La preparación de un plan no crea un comprobante de aplicación." />} columns={[
        { key: 'time', header: 'Registrado en la app', mobileRole: 'identity', render: (entry) => formatInventoryDateTime(entry.appliedAt) },
        { key: 'actor', header: 'Registrado por (ID)', mobileRole: 'full', render: (entry) => <span className="break-words">{entry.appliedById}</span> },
        { key: 'request', header: 'Clave del intento', mobileRole: 'full', render: (entry) => <span className="break-words">{entry.requestId}</span> },
        { key: 'actions', header: 'Acciones', mobileRole: 'actions', render: (entry) => <Button variant="secondary" size="sm" onClick={(event) => { trigger.current = event.currentTarget; setTarget(entry.id); }}>Ver comprobante del periodo</Button> }
      ]} />
    {data && data.total > 0 && <><p className="inventory-metadata-hint">{data.offset + 1}–{data.offset + data.items.length} de {data.total} comprobantes</p><Pagination page={Math.floor(data.offset / 25) + 1} pageCount={Math.max(1, Math.ceil(data.total / 25))} loading={query.reading || Boolean(query.error)} onPageChange={(page) => { setTarget(null); setOffset((page - 1) * 25); }} /></>}
    {target && <ClosedReceipt key={target} assetId={assetId} id={target} close={() => { setTarget(null); trigger.current?.focus({ preventScroll: true }); }} />}
  </div>;
}
function ClosedReceipt({ assetId, id, close }: { assetId: string; id: string; close: () => void }) {
  const section = useRef<globalThis.HTMLElement>(null);
  const read = useCallback((signal: globalThis.AbortSignal) => readClosedApplication(assetId, id, signal), [assetId, id]);
  const query = useHistoryRead(read, 'No se pudo consultar este comprobante de periodo.');
  useEffect(() => {
    if (!query.data) return;
    const frame = globalThis.requestAnimationFrame(() => section.current?.querySelector<globalThis.HTMLElement>('[data-closed-application-result]')?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [query.data]);
  return <section ref={section} className="inventory-metadata-section space-y-4" aria-label="Detalle del comprobante seleccionado">
    <Button variant="secondary" size="sm" onClick={close}>Cerrar detalle del periodo</Button>
    {query.reading && <LoadingState label="Consultando comprobante del periodo…" />}
    {query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar detalle del periodo</Button>}>{query.error}</Alert>}
    {query.data && <ClosedApplicationDetails application={query.data} />}
  </section>;
}
