import { useCallback, useEffect, useRef, useState } from 'react';
import { environment } from '../../config/environment';
import { getApiErrorMessage } from '../../lib/api';
import { Alert, Button, DataTable, EmptyState, ListFooter, ModuleFilters } from '../../ui';
import { appendServerPage, type ImportPreview, type ServerPage } from './import-review-model';
import { readSourceEvents } from './source-review-api';
import type { SourceEvent } from './source-review-model';
import { SourceRevisionDialog } from './SourceRevisionDialog';
import { SourceEventDetails } from './SourceEventDetails';

export function SourceReviewPanel({ batchId, original, changed }: { batchId: string; original: ImportPreview; changed: () => void }) {
  const [mode, setMode] = useState<'source' | 'identity' | null>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  return <section aria-label="Revisión del origen">
    <ModuleFilters className="catalog-toolbar" ariaLabel="Controles de corrección del origen">
      {environment.inventoryImportSourceV7 && <Button variant="secondary" onClick={() => { setMode('source'); setOpen(true); }}>Corregir origen descriptivo</Button>}
      {environment.inventoryImportIdentityV8 && <Button variant="secondary" onClick={() => { setMode('identity'); setOpen(true); }}>Verificar identidad física</Button>}
      <Button variant="secondary" onClick={() => setHistory((value) => !value)}>{history ? 'Ocultar revisiones de origen' : 'Consultar revisiones de origen'}</Button>
    </ModuleFilters>
    {history && <SourceEventList key={historyRevision} batchId={batchId} />}
    {mode && <SourceRevisionDialog key={mode} batchId={batchId} original={original} mode={mode} open={open} close={() => setOpen(false)} exited={() => setMode(null)} changed={() => { setHistoryRevision((value) => value + 1); changed(); }} />}
  </section>;
}
const empty: ServerPage<SourceEvent> = { items: [], total: 0, nextOffset: 0, hasMore: false };
function SourceEventList({ batchId }: { batchId: string }) {
  const [page, setPage] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const retryOffset = useRef(0);
  const controller = useRef<globalThis.AbortController | null>(null);
  const revision = useRef<number | null>(null);
  const pending = useRef(false);
  const [headChanged, setHeadChanged] = useState(false);
  const load = useCallback(async (offset = 0) => {
    controller.current?.abort();
    const current = new globalThis.AbortController();
    controller.current = current; pending.current = true;
    setLoading(true); setError(null); retryOffset.current = offset;
    try {
      const result = await readSourceEvents(batchId, offset, current.signal);
      if (current.signal.aborted) return;
      if (offset && revision.current !== result.revision) {
        setHeadChanged(true);
        setError('El historial cambió durante la consulta. Las filas cargadas se conservan; actualiza el historial completo para continuar.');
        return;
      }
      revision.current = result.revision; setHeadChanged(false);
      setPage((previous) => appendServerPage(previous, result.rows, result.total, result.hasMore, offset));
    } catch (caughtError) { if (!current.signal.aborted) setError(getApiErrorMessage(caughtError, 'No se pudo consultar el historial del origen.')); }
    finally { if (!current.signal.aborted) { pending.current = false; setLoading(false); } }
  }, [batchId]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load]);
  return <div className="space-y-3">
    <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>Actualizar historial del origen</Button>
    {error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void load(headChanged ? 0 : retryOffset.current)}>{headChanged ? 'Actualizar historial completo' : 'Reintentar historial'}</Button>}>{error}</Alert>}
    <DataTable rows={page.items} getRowKey={(item) => item.id} caption="Revisiones del origen, de más reciente a más antigua" loading={loading && !page.items.length} empty={error ? <></> : <EmptyState title="Sin revisiones de origen" description="El archivo original se conserva. Las correcciones verificadas aparecerán aquí." />} columns={[
      { key: 'revision', header: 'Revisión', mobileRole: 'identity', render: (item) => <strong>Origen r{item.revision}</strong> },
      { key: 'note', header: 'Motivo', mobileRole: 'full', render: (item) => <span className="whitespace-pre-wrap break-words">{item.note}</span> },
      { key: 'detail', header: 'Evidencia y cambios', mobileRole: 'full', render: (item) => <details className="inventory-metadata-section"><summary>Ver {item.changes.length} cambios</summary><SourceEventDetails event={item} /></details> }
    ]} />
    {!error && <ListFooter loaded={page.items.length} total={page.total} hasMore={page.hasMore} loading={loading} onLoadMore={() => { if (!pending.current) void load(page.nextOffset); }} />}
  </div>;
}
