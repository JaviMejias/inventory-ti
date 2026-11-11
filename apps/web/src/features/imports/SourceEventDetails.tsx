import { formatInventoryDateTime } from '../../lib/date-range';
import { OriginalCells } from './SourceEvidence';
import { sourceFieldLabels, type SourceEvent } from './source-review-model';

export function SourceEventDetails({ event }: { event: SourceEvent }) {
  return <div className="space-y-3 mt-3">
    <p className="whitespace-pre-wrap break-words">{event.note}</p>
    <p className="inventory-metadata-hint break-words">Evidencia: {event.evidenceReference} · Revisor: {event.reviewedById} · {formatInventoryDateTime(event.createdAt)} · Lote v{event.expectedBatchVersion} · Origen r{event.revision}</p>
    {event.changes.map((change) => <section className="inventory-metadata-section" key={change.recordId + ':' + change.field}>
      <h4 className="font-semibold break-words">{change.sheet} · {change.column}{change.row} · {sourceFieldLabels[change.field]} · {change.action === 'RESTORE' ? 'Restauración' : 'Corrección'}</h4>
      {([['Original (sin modificar)', change.originalCell], ['Antes de esta revisión', change.beforeCell], ['Después de esta revisión', change.afterCell]] as const).map(([label, cell]) => <div key={label}><p className="font-semibold mt-3">{label}</p>{cell ? <OriginalCells cells={{ [change.column]: cell }} row={change.row} interpreted={label !== 'Original (sin modificar)'} /> : <p className="inventory-metadata-hint">Celda ausente</p>}</div>)}
    </section>)}
    <p className="inventory-metadata-hint break-all">Solicitud: {event.requestId}. Este evento es histórico; consulta el origen para conocer la revisión vigente.</p>
  </div>;
}
