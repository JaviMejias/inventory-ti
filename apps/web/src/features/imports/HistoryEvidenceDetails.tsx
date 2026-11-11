import { Badge } from '../../ui';
import { formatInventoryDateTime } from '../../lib/date-range';
import { SourceEvidence, OriginalCells } from './SourceEvidence';
import { historyDay, historyKey, historyKindLabels, historyUncertaintyLabels, type HistoricalObservation, type HistoryCapture } from './history-evidence-model';
import { sourceFieldLabels } from './source-review-model';

export function HistoryEvidenceDetails({ observation, current = false }: { observation: HistoricalObservation; current?: boolean }) {
  const target = { id: observation.candidateId, type: 'CANDIDATE' as const, label: 'Evidencia histórica', kind: observation.kind, records: [observation.effective], issues: observation.issues };
  return <div className="space-y-4">
    <div className="import-review-summary"><Badge variant={observation.effectiveDay ? 'info' : 'warning'}>{historyDay(observation.effectiveDay)}</Badge><Badge variant="neutral">Ejecutor histórico desconocido</Badge></div>
    {observation.dateUncertainty && <p className="inventory-metadata-hint">{historyUncertaintyLabels[observation.dateUncertainty]}{observation.sourceDateText !== null && ` Texto de origen: ${observation.sourceDateText}`}</p>}
    <details className="inventory-metadata-section"><summary>{current ? 'Interpretación vigente de la evidencia' : 'Interpretación al consultar o capturar'}</summary><SourceEvidence target={target} interpreted /></details>
    <details className="inventory-metadata-section"><summary>Evidencia original sin modificar</summary><SourceEvidence target={{ ...target, records: [observation.original], issues: [] }} /></details>
    {observation.sourceCorrections.length > 0 && <details className="inventory-metadata-section"><summary>Correcciones de origen · {observation.sourceCorrections.length}</summary><div className="space-y-3">{observation.sourceCorrections.map((entry) => <section key={`${entry.revisionId}:${entry.field}`} className="inventory-metadata-section">
      <h4 className="font-semibold">{sourceFieldLabels[entry.field] ?? entry.field} · origen r{entry.revision}</h4>
      <p className="whitespace-pre-wrap break-words">{entry.note}</p><p className="break-words">Respaldo: {entry.evidenceReference} · Revisor: {entry.reviewedById}</p>
      <p>Antes</p><OriginalCells cells={entry.beforeCell ? { [entry.column]: entry.beforeCell } : {}} row={entry.row} interpreted />
      <p>Después</p><OriginalCells cells={entry.afterCell ? { [entry.column]: entry.afterCell } : {}} row={entry.row} interpreted />
    </section>)}</div></details>}
  </div>;
}
export function HistoryCaptureDetails({ capture }: { capture: HistoryCapture }) {
  return <div className="space-y-4">
    <div className="import-review-summary"><Badge variant="success">Evidencia guardada</Badge><Badge variant="neutral">Sin efecto en inventario actual</Badge><Badge variant="info">Lote v{capture.batchVersion} · origen r{capture.sourceRevision}</Badge></div>
    <dl className="inventory-metadata-detail">
      <div><dt>Comprobante</dt><dd className="break-words">{capture.id}</dd></div>
      <div><dt>Capturada en la aplicación</dt><dd>{formatInventoryDateTime(capture.capturedAt)}</dd></div>
      <div><dt>Responsable de la captura (no ejecutor histórico)</dt><dd className="break-words">{capture.capturedById}</dd></div>
      <div><dt>Motivo</dt><dd className="whitespace-pre-wrap break-words">{capture.note}</dd></div>
      <div><dt>Referencia de evidencia</dt><dd className="break-words">{capture.evidenceReference}</dd></div>
      <div><dt>Huella del archivo</dt><dd className="break-all">{capture.sourceHash}</dd></div>
    </dl>
    <p className="inventory-metadata-hint">Comprobante original e inmutable de esta captura, no la interpretación vigente ni una entrega, devolución o baja aplicada.</p>
    {capture.items.map((item) => <details className="inventory-metadata-section" key={historyKey(item)}>
      <summary>{historyKindLabels[item.kind]} · {item.snapshot.original.sheet} · fila {item.snapshot.original.row}</summary>
      <dl className="inventory-metadata-detail mt-3"><div><dt>Evidencia</dt><dd className="break-words">{item.id}</dd></div><div><dt>Vínculo documentado al capturar</dt><dd className="break-words">{item.assetId ?? 'Sin vincular'}{item.snapshot.linkBasis && <small className="block">{item.snapshot.linkBasis.type === 'REVIEW_DECISION' ? 'Decisión de revisión' : 'Comprobante del piloto'}: {item.snapshot.linkBasis.id}</small>}</dd></div></dl>
      <HistoryEvidenceDetails observation={item.snapshot} />
    </details>)}
  </div>;
}
