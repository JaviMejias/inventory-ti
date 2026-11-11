import { formatInventoryDateTime } from '../../lib/date-range';
import { Badge } from '../../ui';
import { assetStatusLabels } from './asset-status';
import { assignmentRecipient, isImportedAssignment, type AssignmentRecord, type AssignmentSnapshot } from './assignment-model';

function historyDate(value?: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? formatInventoryDateTime(value) : 'Fecha no informada';
}

export function AssignmentHistoryProvenance({ record }: { record: AssignmentRecord }) {
  const imported = isImportedAssignment(record);
  const correction = record.historyCorrection;
  return <div className="grid min-w-0 gap-3 break-words">
    {imported && <Badge variant="info">Periodo histórico importado</Badge>}
    <AssignmentCapture record={record} />
    {imported && <ImportProvenance record={record} />}
    {correction && <AssignmentCorrectionProvenance correction={correction} />}
    {record.originalAssignment ? <details className="inventory-metadata-section">
      <summary>Valores originales y efectivos</summary>
      <AssignmentValues record={record.originalAssignment} label="Registro original" />
      <AssignmentValues record={record} label="Valores efectivos" />
    </details> : correction && <p className="ui-field-hint">Registro original no informado. Se muestran los valores efectivos recibidos.</p>}
    <p className="ui-field-hint">Fechas en hora de Chile (America/Santiago).</p>
  </div>;
}

export function AssignmentCorrectionProvenance({ correction }: { correction: NonNullable<AssignmentRecord['historyCorrection']> }) {
  return <section aria-label="Rectificación histórica">
    <Badge variant="info">Historia rectificada · versión {correction.version ?? 'no informada'}</Badge>
    <dl className="inventory-metadata-detail">
      <div><dt>Rectificación (ID)</dt><dd>{correction.id}</dd></div>
      <div><dt>Rectificada por (ID)</dt><dd>{correction.correctedById || 'No informado'}</dd></div>
      <div><dt>Captura de rectificación</dt><dd>{historyDate(correction.correctedAt)}</dd></div>
    </dl>
    <p className="ui-field-hint">La rectificación actualiza la lectura histórica. Su autor y fecha no representan una nueva entrega o devolución.</p>
  </section>;
}

function AssignmentCapture({ record }: { record: AssignmentSnapshot }) {
  const imported = isImportedAssignment(record);
  const unknownActor = imported ? 'Ejecutor histórico desconocido' : 'No informado';
  return <dl className="inventory-metadata-detail" aria-label="Hechos históricos y captura">
      <div><dt>{imported ? 'Ejecutor histórico de entrega' : 'Entrega realizada por'}</dt><dd>{record.createdBy?.displayName || unknownActor}</dd></div>
      <div><dt>Captura de entrega en la app</dt><dd>{historyDate(record.createdAt)}</dd></div>
      {record.endedAt && <>
        <div><dt>{imported ? 'Ejecutor histórico de devolución' : 'Devolución realizada por'}</dt><dd>{record.endedBy?.displayName || unknownActor}</dd></div>
        <div><dt>Captura de devolución en la app</dt><dd>{historyDate(record.returnRecordedAt)}</dd></div>
      </>}
  </dl>;
}

function ImportProvenance({ record }: { record: AssignmentSnapshot }) {
  const legacy = record.importHistory;
  const grouped = record.groupImportHistory;
  if (!legacy && !grouped) return <p className="ui-field-hint">Procedencia de importación no informada. Registrado por: no informado.</p>;
  return <details className="inventory-metadata-section">
      <summary>Procedencia de importación {legacy && grouped ? 'legacy y agrupada' : grouped ? 'agrupada' : 'legacy'}</summary>
      {legacy && <section aria-label="Importación legacy">
        <strong>Importación legacy</strong>
        <dl className="inventory-metadata-detail">
          <div><dt>Comprobante legacy</dt><dd>{legacy.applicationId}</dd></div>
          <div><dt>Ítem de asignación legacy</dt><dd>{legacy.id}</dd></div>
          <div><dt>Periodo de origen</dt><dd>{legacy.periodId}</dd></div>
          <div><dt>Registrado por (ID)</dt><dd>{legacy.application?.appliedById || 'No informado'}</dd></div>
          <div><dt>Captura de importación</dt><dd>{historyDate(legacy.application?.appliedAt)}</dd></div>
          <div><dt>Evidencia de entrega</dt><dd>{legacy.startEvidenceId}</dd></div>
          <div><dt>Evidencia de devolución</dt><dd>{legacy.endEvidenceId}</dd></div>
        </dl>
      </section>}
      {grouped && <section aria-label="Importación agrupada">
        <strong>Importación agrupada</strong>
        <dl className="inventory-metadata-detail">
          <div><dt>Comprobante agrupado</dt><dd>{grouped.applicationId}</dd></div>
          <div><dt>Ítem de asignación agrupada</dt><dd>{grouped.id}</dd></div>
          <div><dt>Ítem de grupo</dt><dd>{grouped.application?.itemId || 'No informado'}</dd></div>
          <div><dt>Periodo de origen</dt><dd>{grouped.periodId}</dd></div>
          <div><dt>Registrado por (ID)</dt><dd>{grouped.application?.appliedById || 'No informado'}</dd></div>
          <div><dt>Captura de importación</dt><dd>{historyDate(grouped.application?.appliedAt)}</dd></div>
          <div><dt>Vínculo de entrega</dt><dd>{grouped.startLinkId}</dd></div>
          <div><dt>Vínculo de devolución</dt><dd>{grouped.endLinkId}</dd></div>
        </dl>
        {grouped.evidenceUses?.length > 0 && <dl className="inventory-metadata-detail" aria-label="Evidencias agrupadas">
          {grouped.evidenceUses.map((use) => <div key={use.endpoint + ':' + use.linkId + ':' + use.evidenceId}>
            <dt>{use.endpoint === 'START' ? 'Evidencia de entrega' : use.endpoint === 'END' ? 'Evidencia de devolución' : 'Extremo no informado'}</dt>
            <dd>{use.evidenceId} · Vínculo: {use.linkId}</dd>
          </div>)}
        </dl>}
      </section>}
      <p className="ui-field-hint">La persona que registró la importación no identifica al ejecutor histórico.</p>
  </details>;
}

function AssignmentValues({ record, label }: { record: AssignmentSnapshot; label: string }) {
  return <section aria-label={label}>
    <strong>{label}</strong>
    <dl className="inventory-metadata-detail">
      <div><dt>Destinatario</dt><dd>{assignmentRecipient(record)}</dd></div>
      <div><dt>Tipo de destinatario</dt><dd>{record.recipientType === 'OFFICE' ? 'Oficina' : record.recipientType === 'PERSON' ? 'Persona' : 'No informado'}</dd></div>
      <div><dt>Tipo de entrega</dt><dd>{record.assignmentType === 'LOAN' ? 'Préstamo' : record.assignmentType === 'STANDARD' ? 'Entrega estándar' : 'No informado'}</dd></div>
      <div><dt>Entrega histórica</dt><dd>{historyDate(record.startedAt)}</dd></div>
      <div><dt>Devolución histórica</dt><dd>{historyDate(record.endedAt)}</dd></div>
      <div><dt>Devolución prevista</dt><dd>{historyDate(record.expectedReturnAt)}</dd></div>
      <div><dt>Estado al devolver</dt><dd>{record.returnStatus ? assetStatusLabels[record.returnStatus] : 'No informado'}</dd></div>
      <div><dt>Ticket de salida</dt><dd>{record.ticketReference || 'No informado'}</dd></div>
      <div><dt>OT de salida</dt><dd>{record.otReference || 'No informada'}</dd></div>
      <div><dt>Observaciones de entrega</dt><dd>{record.notes || 'No informadas'}</dd></div>
      <div><dt>Ticket de entrada</dt><dd>{record.returnTicketReference || 'No informado'}</dd></div>
      <div><dt>OT de entrada</dt><dd>{record.returnOtReference || 'No informada'}</dd></div>
      <div><dt>Observaciones de devolución</dt><dd>{record.returnNotes || 'No informadas'}</dd></div>
    </dl>
  </section>;
}
