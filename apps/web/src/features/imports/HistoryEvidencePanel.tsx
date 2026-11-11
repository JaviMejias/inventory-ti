import { useCallback, useRef, useState } from 'react';
import { environment } from '../../config/environment';
import { canReviewImports } from '../../lib/permissions';
import { useAuth } from '../auth/auth-context';
import { EvidenceAmendmentDialog } from './EvidenceAmendmentDialog';
import type { EvidenceOwner } from './evidence-amendment-model';
import { ApiRequestError } from '../../lib/api';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, LoadingState, ModuleFilters, Pagination } from '../../ui';
import { readHistoryCapture, readHistoryCaptures, readHistoryPreview } from './history-evidence-api';
import { historyDay, historyKey, historyKindLabels, type CaptureMetadata, type HistoryPreview, type HistorySelection } from './history-evidence-model';
import { HistoryCaptureDialog } from './HistoryCaptureDialog';
import { HistoryCaptureDetails, HistoryEvidenceDetails } from './HistoryEvidenceDetails';
import { useHistoryRead } from './useHistoryRead';

export function HistoryEvidencePanel({ batchId }: { batchId: string }) {
  const { user } = useAuth();
  const amendmentActor = environment.inventoryImportEvidenceAmendmentsV12 && user && canReviewImports(user.role) ? user.id : null;
  const [view, setView] = useState<'preview' | 'receipts' | null>(null);
  const [visited, setVisited] = useState({ preview: false, receipts: false });
  const [receiptRevision, setReceiptRevision] = useState(0);
  function consult(next: 'preview' | 'receipts') { setVisited((current) => ({ ...current, [next]: true })); setView(next); }
  return <section aria-label="Evidencia histórica del lote">
    <ModuleFilters className="catalog-toolbar" ariaLabel="Consulta de evidencia histórica">
      <Button variant="secondary" onClick={() => consult('preview')}>Consultar evidencia histórica</Button>
      <Button variant="secondary" onClick={() => consult('receipts')}>Consultar comprobantes históricos</Button>
    </ModuleFilters>
    {visited.preview && <div hidden={view !== 'preview'}><HistoricalPreview batchId={batchId} amendmentActor={amendmentActor} saved={() => setReceiptRevision((value) => value + 1)} /></div>}
    {visited.receipts && <div hidden={view !== 'receipts'}><CaptureList key={receiptRevision} batchId={batchId} amendmentActor={amendmentActor} /></div>}
  </section>;
}
function HistoricalPreview({ batchId, saved, amendmentActor }: { batchId: string; saved: () => void; amendmentActor: string | null }) {
  const [amendment, setAmendment] = useState<EvidenceOwner | null>(null);
  const [amendmentOpen, setAmendmentOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<HistorySelection[]>([]);
  const [selectionContext, setSelectionContext] = useState<HistoryPreview | null>(null);
  const [pendingPage, setPendingPage] = useState<number | null>(null);
  const [capture, setCapture] = useState<{ context: HistoryPreview; selected: HistorySelection[] } | null>(null);
  const [open, setOpen] = useState(false);
  const read = useCallback((signal: globalThis.AbortSignal) => readHistoryPreview(batchId, offset, signal), [batchId, offset]);
  const query = useHistoryRead(read, 'No se pudo consultar la evidencia histórica.');
  const data = query.data;
  const selectionChanged = Boolean(selected.length && selectionContext?.historyPreviewId !== data?.historyPreviewId);
  const locked = query.reading || Boolean(query.error) || data?.offset !== offset;
  const keys = new Set(selected.map(historyKey));
  function clearSelection() { setSelected([]); setSelectionContext(null); setPendingPage(null); }
  function changePage(page: number) { const next = (page - 1) * 25; if (selected.length) setPendingPage(next); else setOffset(next); }
  return <div className="space-y-3">
    <ModuleFilters className="catalog-toolbar" ariaLabel="Selección de observaciones históricas" actions={<Button loading={query.reading} variant="secondary" size="sm" onClick={() => void query.refresh()}>Actualizar consulta histórica</Button>}>
      <p className="inventory-metadata-hint">Observaciones del archivo, no acontecimientos operativos confirmados. Selecciona hasta 25 de esta página.</p>
      <Button disabled={locked || !selected.length} onClick={() => { if (selectionContext) { setCapture({ context: selectionContext, selected: globalThis.structuredClone(selected) }); setOpen(true); } }}>Preparar captura ({selected.length})</Button>
      {selected.length > 0 && <Button variant="ghost" size="sm" onClick={clearSelection}>Limpiar selección</Button>}
    </ModuleFilters>
    {query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar consulta histórica</Button>}>{query.error}</Alert>}
    {selectionChanged && <Alert variant="warning">La consulta cambió; la selección se conserva. Abre Preparar captura para revisar los vínculos y confirmar la evidencia vigente, o limpia la selección antes de añadir filas.</Alert>}
    {pendingPage !== null && <Alert variant="warning" action={<><Button variant="secondary" size="sm" onClick={() => setPendingPage(null)}>Conservar esta página</Button><Button size="sm" onClick={() => { const next = pendingPage; clearSelection(); setOffset(next); }}>Cambiar página y descartar selección</Button></>}>La selección pertenece a esta página. Cambiarla descartará las observaciones que aún no preparaste.</Alert>}
    {query.reading && data && <LoadingState label="Actualizando consulta histórica…" />}
    <DataTable className="catalog-data-table" caption="Observaciones históricas del archivo" rows={data?.observations ?? []} getRowKey={historyKey} loading={query.reading && !data}
      empty={query.error ? <></> : <EmptyState title="Sin observaciones históricas reconocidas" description="El servidor no encontró evidencia física de recepción, uso, préstamo o baja. No se interpretan resúmenes manuales como movimientos." />} columns={[
        { key: 'origin', header: 'Origen', mobileRole: 'identity', render: (entry) => <strong>{entry.original.sheet} · fila {entry.original.row}</strong> },
        { key: 'kind', header: 'Observación', mobileRole: 'full', render: (entry) => historyKindLabels[entry.kind] },
        { key: 'day', header: 'Fecha indicada', render: (entry) => <Badge variant={entry.effectiveDay ? 'info' : 'warning'}>{historyDay(entry.effectiveDay)}</Badge> },
        { key: 'state', header: 'Captura', mobileRole: 'full', render: (entry) => entry.stored ? <><Badge variant="success">Ya capturada</Badge><small className="block break-words">Comprobante: {entry.stored.captureId}. Puede pertenecer a otro lote del mismo archivo.</small>{amendmentActor && <Button variant="secondary" size="sm" disabled={locked} onClick={() => { setAmendment({ id: entry.stored!.id, captureId: entry.stored!.captureId, recordId: entry.recordId, candidateId: entry.candidateId, kind: entry.kind }); setAmendmentOpen(true); }}>Revisar versiones de evidencia</Button>}</> : <Badge variant="neutral">Sin capturar</Badge> },
        { key: 'detail', header: 'Evidencia', mobileRole: 'full', render: (entry) => <details className="inventory-metadata-section"><summary>Origen e incidencias · {entry.issues.length}</summary><HistoryEvidenceDetails observation={entry} /></details> },
        { key: 'select', header: 'Selección de esta página', mobileRole: 'actions', render: (entry) => <Button variant={keys.has(historyKey(entry)) ? 'primary' : 'secondary'} size="sm" aria-pressed={keys.has(historyKey(entry))} disabled={locked || Boolean(entry.stored) || selectionChanged} onClick={() => {
          setSelectionContext(data);
          setSelected((current) => current.some((item) => historyKey(item) === historyKey(entry)) ? current.filter((item) => historyKey(item) !== historyKey(entry)) : [...current, { recordId: entry.recordId, kind: entry.kind, assetId: null }]);
        }}>{keys.has(historyKey(entry)) ? 'Quitar de captura' : 'Seleccionar observación'}</Button> }
      ]} />
    {data && data.total > 0 && <Pagination page={Math.floor(data.offset / 25) + 1} pageCount={Math.max(1, Math.ceil(data.total / 25))} loading={locked} onPageChange={changePage} />}
    {capture && <HistoryCaptureDialog batchId={batchId} context={capture.context} initial={capture.selected} open={open} close={() => setOpen(false)} exited={() => setCapture(null)} changed={() => { clearSelection(); saved(); void query.refresh(); }} />}
    {amendment && amendmentActor && <EvidenceAmendmentDialog key={amendment.id + amendmentActor} owner={amendment} actorId={amendmentActor} open={amendmentOpen} close={() => setAmendmentOpen(false)} exited={() => setAmendment(null)} />}
  </div>;
}
function CaptureList({ batchId, amendmentActor }: { batchId: string; amendmentActor: string | null }) {
  const [amendment, setAmendment] = useState<EvidenceOwner | null>(null);
  const [amendmentOpen, setAmendmentOpen] = useState(false);
  const pendingAmendment = useRef<EvidenceOwner | null>(null);
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<CaptureMetadata | null>(null);
  const [open, setOpen] = useState(false);
  const total = useRef<number | null>(null);
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    const value = await readHistoryCaptures(batchId, offset, signal);
    if (offset && total.current !== null && total.current !== value.total) throw new ApiRequestError('Capture list changed', 409, 'HISTORY_LIST_CHANGED');
    if (!signal.aborted) total.current = value.total;
    return { ...value, offset };
  }, [batchId, offset]);
  const query = useHistoryRead(read, 'No se pudieron consultar los comprobantes históricos.');
  const data = query.data;
  return <div className="space-y-3">
    <ModuleFilters className="catalog-toolbar" ariaLabel="Comprobantes de captura histórica"><Button variant="secondary" size="sm" loading={query.reading} onClick={() => { if (offset) setOffset(0); else void query.refresh(); }}>Actualizar comprobantes desde el inicio</Button></ModuleFilters>
    {query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar comprobantes</Button>}>{query.error}</Alert>}
    {query.reading && data && <LoadingState label="Actualizando comprobantes históricos…" />}
    <DataTable className="catalog-data-table" caption="Comprobantes históricos, del más reciente al más antiguo" rows={data?.items ?? []} getRowKey={(entry) => entry.id} loading={query.reading && !data}
      empty={query.error ? <></> : <EmptyState title="Sin capturas históricas en este lote" description="Guardar evidencia conservará su comprobante aquí. Capturas de otro lote del mismo archivo no se duplican." />} columns={[
        { key: 'date', header: 'Capturada en la app', mobileRole: 'identity', render: (entry) => formatInventoryDateTime(entry.capturedAt) },
        { key: 'source', header: 'Origen al capturar', render: (entry) => `Lote v${entry.batchVersion} · origen r${entry.sourceRevision}` },
        { key: 'note', header: 'Motivo', mobileRole: 'full', render: (entry) => <span className="whitespace-pre-wrap break-words">{entry.note}</span> },
        { key: 'reference', header: 'Respaldo', mobileRole: 'full', render: (entry) => <span className="break-words">{entry.evidenceReference}</span> },
        { key: 'actions', header: 'Acciones', mobileRole: 'actions', render: (entry) => <Button variant="secondary" size="sm" onClick={() => { setTarget(entry); setOpen(true); }}>Ver comprobante histórico</Button> }
      ]} />
    {data && data.total > 0 && <Pagination page={Math.floor(data.offset / 25) + 1} pageCount={Math.max(1, Math.ceil(data.total / 25))} loading={query.reading || Boolean(query.error)} onPageChange={(page) => setOffset((page - 1) * 25)} />}
    {target && <CaptureReceiptDialog batchId={batchId} captureId={target.id} open={open} close={() => setOpen(false)} amend={amendmentActor ? (owner) => { pendingAmendment.current = owner; setOpen(false); } : undefined} exited={() => { setTarget(null); if (pendingAmendment.current && amendmentActor) { setAmendment(pendingAmendment.current); setAmendmentOpen(true); } pendingAmendment.current = null; }} />}
    {amendment && amendmentActor && <EvidenceAmendmentDialog key={amendment.id + amendmentActor} owner={amendment} actorId={amendmentActor} open={amendmentOpen} close={() => setAmendmentOpen(false)} exited={() => setAmendment(null)} />}
  </div>;
}
function CaptureReceiptDialog({ batchId, captureId, open, close, exited, amend }: { batchId: string; captureId: string; open: boolean; close: () => void; exited: () => void; amend?: (owner: EvidenceOwner) => void }) {
  const read = useCallback((signal: globalThis.AbortSignal) => readHistoryCapture(batchId, captureId, signal), [batchId, captureId]);
  const query = useHistoryRead(read, 'No se pudo consultar el comprobante histórico.');
  return <Dialog className="catalog-editor-dialog import-review-dialog" open={open} onClose={close} onExited={exited} title="Comprobante histórico original" description="Documentación guardada. No acredita el estado actual del inventario." actions={<Button variant="secondary" onClick={close}>Cerrar</Button>}>
    <div className="space-y-4">{query.reading && <LoadingState label="Consultando comprobante histórico…" />}
      {query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar comprobante</Button>}>{query.error}</Alert>}
      {query.data && <HistoryCaptureDetails capture={query.data} />}
      {query.data && amend && <section className="space-y-3" aria-label="Revisión de versiones de las observaciones capturadas"><p className="inventory-metadata-hint">Consultar una observación cierra este comprobante antes de abrir sus versiones. También permite revisar evidencia sin vínculo o que ya no aparece en la interpretación del lote.</p>{query.data.items.map((item) => <Button key={item.id} variant="secondary" size="sm" onClick={() => amend({ id: item.id, captureId: item.captureId, recordId: item.recordId, candidateId: item.candidateId, kind: item.kind })}>Revisar versiones · {historyKindLabels[item.kind]} · fila {item.snapshot.original.row}</Button>)}</section>}
    </div>
  </Dialog>;
}
