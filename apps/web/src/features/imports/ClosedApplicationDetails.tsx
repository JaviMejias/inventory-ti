import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge } from '../../ui';
import type { ClosedApplication } from './closed-application-model';
import { ClosedAssignmentPlanDetails } from './ClosedAssignmentPlanDetails';
import { LegacyClosedApplicationPeriods } from './LegacyClosedApplicationPeriods';

export function ClosedApplicationDetails({ application }: { application: ClosedApplication }) {
  return <section className="space-y-4" aria-label="Comprobante de periodo histórico">
    <h3 tabIndex={-1} data-closed-application-result className="font-semibold">Comprobante de historia aplicada</h3>
    <Alert variant="success">Historia cerrada guardada. No cambió el estado actual, la asignación vigente ni el stock. Este comprobante no permite editar ni eliminar los periodos.</Alert>
    <Badge variant="success">Aplicación confirmada</Badge>
    <dl className="inventory-metadata-detail">
      <div><dt>Comprobante / activo</dt><dd className="break-words">{application.id} / {application.assetId}</dd></div>
      <div><dt>Registrado en la app</dt><dd>{formatInventoryDateTime(application.appliedAt)} · hora de Chile</dd></div>
      <div><dt>Usuario que registró la historia</dt><dd className="break-words">{application.appliedById}</dd></div>
      <div><dt>Ejecutores de entrega y devolución antiguas</dt><dd>Desconocidos; no son el usuario que registró este comprobante.</dd></div>
      <div><dt>Clave del intento</dt><dd className="break-words">{application.requestId}</dd></div>
      <div><dt>Huella / reglas al aplicar</dt><dd className="break-all">{application.planId} · {application.rulesVersion}</dd></div>
    </dl>
    {application.rulesVersion === 'mda-closed-assignment-plan-1' ? <LegacyClosedApplicationPeriods application={application} /> : application.items.map((item) => <details key={item.id} className="inventory-metadata-section"><summary>Periodo aplicado · {formatInventoryDateTime(item.snapshot.proposedAssignment.startedAt!)} → {formatInventoryDateTime(item.snapshot.proposedAssignment.endedAt!)}</summary>
      <dl className="inventory-metadata-detail"><div><dt>Entrega histórica / periodo</dt><dd className="break-words">{item.assignmentId} / {item.periodId}</dd></div><div><dt>Evidencia de inicio / cierre</dt><dd className="break-words">{item.startEvidenceId} / {item.endEvidenceId}</dd></div></dl>
      <ClosedAssignmentPlanDetails plan={{ ...application.plan, periods: [item.snapshot] }} fresh recognized={item.snapshot.acknowledgedWarnings} disabled recognize={() => {}} applied />
    </details>)}
  </section>;
}
