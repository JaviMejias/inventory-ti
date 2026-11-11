import { useCallback, useId, useState } from 'react';

import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, EmptyState, LoadingState, Pagination } from '../../ui';
import { readAssetImportedEvidence } from './history-evidence-api';
import { historyDay, historyKindLabels, type AssetHistoryEvidence, type AssetHistoryPage } from './history-evidence-model';
import { HistoryEvidenceDetails } from './HistoryEvidenceDetails';
import { useHistoryRead } from './useHistoryRead';

export function AssetImportedEvidence({ assetId }: { assetId: string }) {
  const [consulted, setConsulted] = useState(false);
  const contentId = useId();
  return <section aria-label="Evidencia histórica importada" className="space-y-3">
    <h3 className="font-semibold">Evidencia histórica importada</h3>
    <p className="inventory-metadata-hint">Documentos vinculados a este activo. No son movimientos operativos ni modifican su estado o stock.</p>
    <Button variant="secondary" aria-expanded={consulted} aria-controls={contentId} onClick={() => setConsulted((value) => !value)}>{consulted ? 'Ocultar evidencia histórica' : 'Consultar evidencia histórica'}</Button>
    <div id={contentId}>{consulted && <AssetEvidenceList assetId={assetId} />}</div>
  </section>;
}

function AssetEvidenceList({ assetId }: { assetId: string }) {
  const [offset, setOffset] = useState(0);
  const read = useCallback((signal: globalThis.AbortSignal) => readAssetImportedEvidence(assetId, offset, signal), [assetId, offset]);
  const query = useHistoryRead(read, 'No se pudo consultar la evidencia histórica del activo.');
  const data = query.data;
  const locked = query.reading || Boolean(query.error) || data?.offset !== offset;
  return <div className="space-y-3" aria-busy={query.reading}>
    <Button variant="secondary" size="sm" loading={query.reading} onClick={() => { if (offset) setOffset(0); else void query.refresh(); }}>Actualizar evidencia desde el inicio</Button>
    <p className="inventory-metadata-hint">Orden por captura en la aplicación, más reciente primero. Cada página consulta los vínculos y versiones vigentes; puede cambiar después de una revisión.</p>
    {query.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void query.refresh()}>Reintentar evidencia histórica</Button>}>{query.error}{data && ' Se conserva la última página consultada; no se confirmó su vigencia.'}</Alert>}
    {query.reading && data && <LoadingState label="Actualizando evidencia histórica…" />}
    {query.reading && !data && <LoadingState label="Consultando evidencia histórica…" />}
    {data && <AssetEvidenceResults page={data} locked={locked} failed={Boolean(query.error)} changePage={(page) => setOffset((page - 1) * 25)} />}
  </div>;
}

function AssetEvidenceResults({ page, locked, failed, changePage }: { page: AssetHistoryPage; locked: boolean; failed: boolean; changePage: (page: number) => void }) {
  if (page.evidence.length === 0) {
    if (failed) return null;
    if (page.offset > 0) return <Alert variant="warning">Esta página ya no contiene registros. Actualiza desde el inicio para consultar los vínculos vigentes.</Alert>;
    return <EmptyState title="Sin evidencia histórica vinculada" description="No hay documentos importados vinculados actualmente a este activo. Esto no significa que no tenga historial operativo." />;
  }
  return <>
    <ol className="space-y-3" aria-label="Documentos vinculados, por fecha de captura">{page.evidence.map((entry) => <li key={`${entry.id}:${entry.evidenceVersion}`} className="inventory-metadata-section">
      <strong className="block break-words">{historyKindLabels[entry.kind]} · {entry.snapshot.original.sheet} · fila {entry.snapshot.original.row}</strong>
      <div className="import-review-summary mt-3"><Badge variant={entry.effectiveDay ? 'info' : 'warning'}>Fecha indicada vigente: {historyDay(entry.effectiveDay)}</Badge><Badge variant={entry.evidenceVersion ? 'info' : 'neutral'}>{entry.evidenceVersion ? `Revisada · v${entry.evidenceVersion}` : 'Captura sin enmiendas'}</Badge></div>
      <p className="inventory-metadata-hint mt-3">Registro documental: {formatInventoryDateTime(entry.capturedAt)} · hora de Chile</p>
      <details className="mt-3"><summary>Ver evidencia y captura original</summary><AssetEvidenceDetails evidence={entry} /></details>
    </li>)}</ol>
    <p className="inventory-metadata-hint">{page.offset + 1}–{page.offset + page.evidence.length} de {page.total} documentos vinculados</p>
    <Pagination page={Math.floor(page.offset / 25) + 1} pageCount={Math.ceil(page.total / 25)} loading={locked} onPageChange={changePage} />
  </>;
}

function AssetEvidenceDetails({ evidence }: { evidence: AssetHistoryEvidence }) {
  const capture = evidence.capture;
  return <div className="space-y-4 mt-3">
    <dl className="inventory-metadata-detail">
      <div><dt>Evidencia</dt><dd className="break-words">{evidence.id}</dd></div>
      <div><dt>Origen vigente</dt><dd>Revisión {evidence.effectiveSourceRevision} · evidencia v{evidence.evidenceVersion}</dd></div>
      <div><dt>Vínculo vigente</dt><dd className="break-words">{evidence.assetId}</dd></div>
      {evidence.snapshot.linkBasis && <div><dt>Respaldo del vínculo vigente</dt><dd className="break-words">{evidence.snapshot.linkBasis.type === 'REVIEW_DECISION' ? 'Decisión de revisión' : 'Comprobante del piloto'}: {evidence.snapshot.linkBasis.id}</dd></div>}
      {evidence.amendmentId && evidence.amendedAt && <div><dt>Última enmienda (hora de Chile)</dt><dd className="break-words">{evidence.amendmentId} · {formatInventoryDateTime(evidence.amendedAt)}</dd></div>}
    </dl>
    <HistoryEvidenceDetails observation={evidence.snapshot} current />
    <details className="inventory-metadata-section"><summary>Datos de la captura original</summary>
      <p className="inventory-metadata-hint">Estos datos se conservan aunque cambie la evidencia vigente. Las celdas originales del archivo no son la interpretación completa del comprobante de captura.</p>
      <dl className="inventory-metadata-detail mt-3">
        <div><dt>Fecha indicada al capturar</dt><dd>{historyDay(evidence.capturedEffectiveDay)}</dd></div>
        <div><dt>Vínculo al capturar</dt><dd className="break-words">{evidence.capturedAssetId ?? 'Sin vínculo al capturar'}</dd></div>
        <div><dt>Origen al capturar</dt><dd>Lote v{capture.batchVersion} · origen r{evidence.capturedSourceRevision}</dd></div>
        <div><dt>Capturada en la aplicación (hora de Chile)</dt><dd>{formatInventoryDateTime(capture.capturedAt)}</dd></div>
        <div><dt>Responsable de la captura (no ejecutor histórico)</dt><dd className="break-words">{capture.capturedById}</dd></div>
        <div><dt>Comprobante original</dt><dd className="break-words">{capture.id}</dd></div>
        <div><dt>Lote de captura</dt><dd className="break-words">{capture.batchId}</dd></div>
        <div><dt>Motivo de la captura</dt><dd className="whitespace-pre-wrap break-words">{capture.note}</dd></div>
        <div><dt>Respaldo de la captura</dt><dd className="break-words">{capture.evidenceReference}</dd></div>
        <div><dt>Huella del archivo</dt><dd className="break-all">{capture.sourceHash}</dd></div>
      </dl>
    </details>
  </div>;
}
