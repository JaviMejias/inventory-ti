import { useEffect, useState } from 'react';
import { getApiErrorMessage } from '../../lib/api';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Button, DataTable, Dialog, EmptyState, ListFooter, LoadingState, ModuleFilters } from '../../ui';
import { importReviewPath } from './import-review-api';
import { readPilotApplication } from './pilot-receipt-api';
import type { ApplicationMetadata, PilotReadReceipt } from './pilot-model';
import { PilotApplicationReader } from './PilotApplicationReader';
import { PilotDialog } from './PilotDialog';
import { useReviewPage } from './useReviewPage';

export function PilotPanel({ batchId, fileName, changed }: { batchId: string; fileName: string; changed: () => void }) {
  const [pilot, setPilot] = useState(false);
  const [pilotMounted, setPilotMounted] = useState(false);
  const [applications, setApplications] = useState(false);
  const [selected, setSelected] = useState<ApplicationMetadata | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [applicationRevision, setApplicationRevision] = useState(0);
  return <section aria-label="Piloto de activos">
    <ModuleFilters className="catalog-toolbar" ariaLabel="Controles del piloto">
      <Button variant="secondary" onClick={() => { setPilotMounted(true); setPilot(true); }}>Preparar piloto</Button>
      <Button variant="secondary" onClick={() => setApplications((visible) => !visible)}>{applications ? 'Ocultar comprobantes' : 'Consultar comprobantes'}</Button>
    </ModuleFilters>
    {applications && <ApplicationList key={applicationRevision} batchId={batchId} select={(item) => { setSelected(item); setReceiptOpen(true); }} />}
    {pilotMounted && <PilotDialog batchId={batchId} fileName={fileName} open={pilot} close={() => setPilot(false)} exited={() => setPilotMounted(false)} changed={() => { setApplicationRevision((count) => count + 1); changed(); }} />}
    {selected && <ReceiptDialog batchId={selected.batchId} applicationId={selected.id} open={receiptOpen} close={() => setReceiptOpen(false)} exited={() => setSelected(null)} />}
  </section>;
}
function ApplicationList({ batchId, select }: { batchId: string; select: (item: ApplicationMetadata) => void }) {
  const list = useReviewPage<ApplicationMetadata>(`${importReviewPath}/${batchId}/applications`, 'applications');
  return <>
    {list.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void list.retry()}>Reintentar comprobantes</Button>}>{list.error}</Alert>}
    <DataTable rows={list.page.items} getRowKey={(item) => item.id} caption="Aplicaciones confirmadas del lote" loading={list.loading && !list.page.items.length} empty={list.error ? <></> : <EmptyState title="Sin aplicaciones confirmadas" description="Los planes y decisiones no son comprobantes de aplicación." />} columns={[
      { key: 'id', header: 'Comprobante', mobileRole: 'identity', render: (item) => item.id },
      { key: 'date', header: 'Aplicado', render: (item) => formatInventoryDateTime(item.createdAt) },
      { key: 'author', header: 'Responsable', mobileRole: 'full', render: (item) => item.appliedById },
      { key: 'action', header: 'Acciones', mobileRole: 'actions', render: (item) => <Button variant="secondary" size="sm" onClick={() => select(item)}>Ver comprobante</Button> }
    ]} />
    {!list.error && <ListFooter loaded={list.page.items.length} total={list.page.total} hasMore={list.page.hasMore} loading={list.loading} onLoadMore={list.more} />}
  </>;
}
function ReceiptDialog({ batchId, applicationId, open, close, exited }: { batchId: string; applicationId: string; open: boolean; close: () => void; exited: () => void }) {
  const [receipt, setReceipt] = useState<PilotReadReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new globalThis.AbortController();
    setError(null); setReceipt(null);
    readPilotApplication(batchId, applicationId, controller.signal).then((value) => { if (!controller.signal.aborted) setReceipt(value); }).catch((caughtError) => { if (!controller.signal.aborted) setError(getApiErrorMessage(caughtError, 'No se pudo consultar el comprobante.')); });
    return () => controller.abort();
  }, [batchId, applicationId, attempt]);
  return <Dialog className="catalog-editor-dialog import-review-dialog" title="Comprobante de aplicación" description="Resultado histórico guardado por el servidor" open={open} onClose={close} onExited={exited} actions={<Button variant="secondary" onClick={close}>Cerrar</Button>}>
    {error ? <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>Reintentar</Button>}>{error}</Alert> : receipt ? <PilotApplicationReader receipt={receipt} /> : <LoadingState label="Consultando comprobante…" />}
  </Dialog>;
}
