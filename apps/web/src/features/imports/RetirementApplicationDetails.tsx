import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Icon } from '../../ui';
import type { RetirementApplication } from './retirement-application-model';
import { RetirementPlanDetails } from './RetirementPlanDetails';

export function RetirementApplicationDetails({ application }: { application: RetirementApplication }) {
  return <section className="space-y-4" aria-label="Comprobante de baja histórica">
    <h3 tabIndex={-1} data-retirement-application-result className="font-semibold">Comprobante de baja histórica</h3>
    <Alert variant="success">La baja fue confirmada por el servidor. Este comprobante es permanente: consultarlo no ejecuta otra baja ni permite reactivar el activo.</Alert>
    <div className="import-review-summary"><Badge variant="success"><Icon size="sm"><path d="m5 12 4 4L19 6" /></Icon> Aplicación confirmada</Badge><Badge variant="danger">Retiro definitivo</Badge></div>
    <dl className="inventory-metadata-detail">
      <div><dt>Retiro histórico · hora de Chile</dt><dd>{formatInventoryDateTime(application.decommissionedAt)}</dd></div>
      <div><dt>Registrado en la app · hora de Chile</dt><dd>{formatInventoryDateTime(application.appliedAt)}</dd></div>
      <div><dt>Usuario que registró la baja (ID)</dt><dd className="break-words">{application.appliedById}</dd></div>
      <div><dt>Ejecutor del retiro histórico</dt><dd>Desconocido. No es el usuario que registró el comprobante.</dd></div>
      <div><dt>Comprobante / activo</dt><dd className="break-words">{application.id} / {application.assetId}</dd></div>
      <div><dt>Clave del intento</dt><dd className="break-words">{application.requestId}</dd></div>
    </dl>
    <p className="inventory-metadata-hint">No se modificó el stock por cantidad ni se cerraron entregas. La fecha de retiro confirmada no reemplaza la fecha desconocida del archivo original.</p>
    <details className="inventory-metadata-section"><summary>Revisión y evidencia conservadas al aplicar</summary>
      <div className="mt-3"><RetirementPlanDetails key={application.id} plan={application.plan} fresh recognized={application.plan.request.acknowledgedWarnings} disabled recognize={() => {}} applied /></div>
    </details>
  </section>;
}
