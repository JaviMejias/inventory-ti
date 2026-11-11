import { formatInventoryDateTime } from '../../lib/date-range';
import { Badge } from '../../ui';
import { AssignmentCorrectionProvenance } from './AssignmentHistoryProvenance';
import { assetStatusLabels, type AssetStatus } from './asset-status';
import { assignmentRecipient, type AssignmentRecord } from './assignment-model';

export type AssignmentEventDetails = Pick<AssignmentRecord, 'historyCorrection' | 'originalAssignment'> & {
  action?: string; effectiveAt: string; person?: string | null; recipientName?: string | null; recipientType?: 'PERSON' | 'OFFICE';
  officeName?: string | null; assignmentType?: 'STANDARD' | 'LOAN'; expectedReturnAt?: string | null;
  ticketReference?: string | null; otReference?: string | null; notes?: string | null; returnStatus?: AssetStatus | null;
  source?: 'IMPORTED_HISTORY'; importScope?: 'GROUP_CLOSED_ASSIGNMENT_HISTORY'; importGroupItemId?: string | null;
};
function date(value?: string | null) { return value && Number.isFinite(Date.parse(value)) ? formatInventoryDateTime(value) : 'Fecha no informada'; }

export function AssignmentEventProvenance({ event }: { event: AssignmentEventDetails }) {
  const original = event.originalAssignment;
  const returned = event.action === 'ASSET_RETURNED';
  return <div className="grid min-w-0 gap-3 break-words">
    {event.source === 'IMPORTED_HISTORY' && <Badge variant="info">{event.importScope === 'GROUP_CLOSED_ASSIGNMENT_HISTORY' ? 'Historia de identidad agrupada' : 'Historia importada de activo'}</Badge>}
    {event.importScope === 'GROUP_CLOSED_ASSIGNMENT_HISTORY' && <small>Ítem de grupo: {event.importGroupItemId || 'No informado'}</small>}
    {event.historyCorrection && <AssignmentCorrectionProvenance correction={event.historyCorrection} />}
    {original ? <details className="inventory-metadata-section">
      <summary>Valores originales y efectivos de esta {returned ? 'devolución' : 'entrega'}</summary>
      {(['original', 'effective'] as const).map((version) => {
        const previous = version === 'original';
        const recipient = previous ? assignmentRecipient(original) : event.recipientType === 'OFFICE' ? event.officeName : event.recipientName || event.person;
        const type = previous ? original.assignmentType : event.assignmentType;
        const status = previous ? original.returnStatus : event.returnStatus;
        return <section key={version} aria-label={previous ? 'Evento original' : 'Evento efectivo'}>
          <strong>{previous ? 'Evento original' : 'Evento efectivo'}</strong>
          <dl className="inventory-metadata-detail">
            <div><dt>Destinatario</dt><dd>{recipient || 'No informado'}</dd></div>
            <div><dt>Tipo de entrega</dt><dd>{type === 'LOAN' ? 'Préstamo' : type === 'STANDARD' ? 'Entrega estándar' : 'No informado'}</dd></div>
            <div><dt>{returned ? 'Devolución histórica' : 'Entrega histórica'}</dt><dd>{date(previous ? returned ? original.endedAt : original.startedAt : event.effectiveAt)}</dd></div>
            <div><dt>Devolución prevista</dt><dd>{date(previous ? original.expectedReturnAt : event.expectedReturnAt)}</dd></div>
            {returned && <div><dt>Estado al devolver</dt><dd>{status ? assetStatusLabels[status] : 'No informado'}</dd></div>}
            <div><dt>Ticket</dt><dd>{(previous ? returned ? original.returnTicketReference : original.ticketReference : event.ticketReference) || 'No informado'}</dd></div>
            <div><dt>OT</dt><dd>{(previous ? returned ? original.returnOtReference : original.otReference : event.otReference) || 'No informada'}</dd></div>
            <div><dt>Observaciones</dt><dd>{(previous ? returned ? original.returnNotes : original.notes : event.notes) || 'No informadas'}</dd></div>
          </dl>
        </section>;
      })}
    </details> : event.historyCorrection && <p className="ui-field-hint">Registro original no informado. Se muestran los valores efectivos recibidos.</p>}
  </div>;
}
