import { Badge } from '../../ui';
import { formatInventoryDateTime } from '../../lib/date-range';
import type { IdentityGroupReview } from './identity-group-review-model';
import { IdentityGroupPlanDetails } from './IdentityGroupPlanDetails';

export function IdentityGroupReviewDetails({ review, groupOrder }: { review: IdentityGroupReview; groupOrder?: readonly string[] }) {
  return <section className="space-y-4" aria-label="Comprobante de revisión de agrupación">
    <h3 className="font-semibold scroll-mt-6" tabIndex={-1} data-group-review-receipt>Comprobante de agrupación</h3>
    <div className="import-review-summary"><Badge variant={review.release ? 'neutral' : 'warning'}>{review.release ? 'Reserva cancelada' : 'Reserva activa'}</Badge><Badge variant="info">Revisión guardada · sin aplicar al inventario</Badge></div>
    <dl className="inventory-metadata-detail"><div><dt>Registro administrativo</dt><dd>{formatInventoryDateTime(review.createdAt)} · hora de Chile</dd></div><div><dt>Revisado por (ID)</dt><dd>{review.reviewedById}</dd></div><div><dt>Comprobante</dt><dd>{review.id}</dd></div><div><dt>Procedencia reservada</dt><dd>{review.rows.length} filas · lote v{review.batchVersion} · origen r{review.sourceRevision}</dd></div></dl>
    {review.release ? <section className="inventory-metadata-section space-y-3" aria-label="Cancelación registrada"><h4 className="font-semibold">Cancelación registrada</h4><p className="break-words whitespace-pre-wrap">{review.release.note}</p><dl className="inventory-metadata-detail"><div><dt>Registrada el</dt><dd>{formatInventoryDateTime(review.release.createdAt)} · hora de Chile</dd></div><div><dt>Cancelada por (ID)</dt><dd>{review.release.releasedById}</dd></div><div><dt>Evento de cancelación</dt><dd>{review.release.id}</dd></div></dl><p>Las filas están liberadas. El comprobante y su escenario se conservan; los grupos abandonados no sustituyen al origen.</p></section> : <p className="inventory-metadata-hint">Estas filas están reservadas en los lotes del mismo archivo. La reserva no crea activos ni autoriza una importación.</p>}
    <IdentityGroupPlanDetails plan={review.plan} fresh archived groupOrder={groupOrder} />
  </section>;
}
