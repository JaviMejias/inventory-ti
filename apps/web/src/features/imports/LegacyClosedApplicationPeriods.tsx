import { useState } from 'react';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Pagination } from '../../ui';
import { assetStatusLabels } from '../home/asset-status';
import { historyDay, historyKindLabels } from './history-evidence-model';
import type { LegacyClosedApplication, LegacyClosedPlanPeriod } from './legacy-closed-application-model';
import { IssueBadge, SourceFields } from './SourceEvidence';

export function LegacyClosedApplicationPeriods({ application }: { application: LegacyClosedApplication }) {
  return <div className="space-y-4">
    <Badge variant="neutral">Comprobante anterior · Solo lectura</Badge>
    <Alert variant="info">Se conserva el comprobante original. Sus fuentes no registraban versiones de evidencia ni enmiendas; esos datos son desconocidos en este comprobante. La procedencia y el estado contrastados corresponden al momento de aplicación.</Alert>
    {application.items.map((item) => {
      const period = item.snapshot; const proposal = period.proposedAssignment;
      return <details key={item.id} className="inventory-metadata-section"><summary>Periodo aplicado · {formatInventoryDateTime(proposal.startedAt!)} → {formatInventoryDateTime(proposal.endedAt!)}</summary>
        <section className="space-y-4 mt-3" aria-label="Snapshot original del periodo aplicado">
          <dl className="inventory-metadata-detail">
            <div><dt>Entrega histórica / periodo</dt><dd className="break-words">{item.assignmentId} / {item.periodId}</dd></div>
            <div><dt>Evidencia de inicio / cierre</dt><dd className="break-words">{item.startEvidenceId} / {item.endEvidenceId}</dd></div>
            <div><dt>Destinatario histórico confirmado</dt><dd className="break-words">{proposal.officeName ?? proposal.personName} · {proposal.recipientType === 'OFFICE' ? 'Oficina' : 'Persona'}</dd></div>
            <div><dt>Tipo de entrega</dt><dd>{proposal.assignmentType === 'LOAN' ? 'Préstamo' : 'Estándar'}</dd></div>
            <div><dt>Inicio confirmado (zona ingresada)</dt><dd className="break-words">{period.start.confirmedAt}</dd></div>
            <div><dt>Cierre confirmado (zona ingresada)</dt><dd className="break-words">{period.end.confirmedAt}</dd></div>
            <div><dt>Inicio / cierre en hora de Chile</dt><dd>{formatInventoryDateTime(proposal.startedAt!)} / {formatInventoryDateTime(proposal.endedAt!)}</dd></div>
            <div><dt>Estado histórico de devolución</dt><dd>{period.returnStatus ? assetStatusLabels[period.returnStatus] : 'Sin confirmar'}</dd></div>
            <div><dt>Estado del activo contrastado al aplicar (no consulta actual)</dt><dd>{assetStatusLabels[application.plan.assetBefore.status as keyof typeof assetStatusLabels]} · {application.plan.assetBefore.isActive ? 'Activo' : 'Archivado'}. No fue modificado por este periodo.</dd></div>
            <div><dt>Motivo / respaldo del periodo</dt><dd className="whitespace-pre-wrap break-words">{period.note} / {period.evidenceReference}</dd></div>
            <div><dt>Respaldo de la hora exacta de inicio / cierre</dt><dd className="break-words">{period.start.dateEvidenceReference} / {period.end.dateEvidenceReference}</dd></div>
            <div><dt>Ticket / OT de salida</dt><dd className="break-words">{proposal.ticketReference ?? 'Sin dato'} / {proposal.otReference ?? 'Sin dato'}</dd></div>
            <div><dt>Ticket / OT de devolución</dt><dd className="break-words">{proposal.returnTicketReference ?? 'Sin dato'} / {proposal.returnOtReference ?? 'Sin dato'}</dd></div>
          </dl>
          <LegacyWarnings key={application.planId + ':' + item.id} period={period} />
          <details className="inventory-metadata-section"><summary>Procedencia original conservada al aplicar</summary><div className="space-y-4 mt-3">
            {period.sources.map((source) => <section key={source.endpoint} className="space-y-3"><dl className="inventory-metadata-detail">
              <div><dt>{source.endpoint === 'start' ? 'Inicio' : 'Cierre'}</dt><dd className="break-words">{historyKindLabels[source.kind]} · {source.sheet} · fila {source.row} · {historyDay(source.effectiveDay)}</dd></div>
              <div><dt>Evidencia / revisión de origen al capturar</dt><dd className="break-words">{source.evidenceId} / r{source.sourceRevision}</dd></div>
              <div><dt>Lote / comprobante documental</dt><dd className="break-words">{source.batchId} / {source.captureId}</dd></div>
              <div><dt>Fila original / candidato</dt><dd className="break-all">{source.recordId} / {source.candidateId}</dd></div>
              <div><dt>Huella del archivo / interpretación</dt><dd className="break-all">{source.sourceHash} / {source.snapshotDigest}</dd></div>
            </dl><details><summary>Interpretación que contrastó el plan · {source.endpoint === 'start' ? 'inicio' : 'cierre'}</summary><SourceFields fields={source.fields} /></details></section>)}
            <p className="inventory-metadata-hint break-all">Plan: {application.planId} · {application.rulesVersion} · contrastado al {historyDay(application.plan.checkedAsOf)}</p>
          </div></details>
        </section>
      </details>;
    })}
  </div>;
}

function LegacyWarnings({ period }: { period: LegacyClosedPlanPeriod }) {
  const [page, setPage] = useState(1);
  if (!period.warnings.length) return null;
  return <section aria-label="Advertencias conservadas al aplicar" className="space-y-3"><h4 className="font-semibold">Advertencias reconocidas al aplicar</h4>
    <ol className="space-y-3">{period.warnings.slice((page - 1) * 25, page * 25).map((warning, index) => <li key={warning.id + ':' + index} className="inventory-metadata-section space-y-3">
      <IssueBadge issue={warning.issue} />{warning.contextualOnly && <Badge variant="info">Contexto; no elimina la incidencia</Badge>}
      <p className="break-all">{warning.id} · {warning.issue.code}</p>
      <p className="break-words">{warning.evidenceId === period.start.evidenceId ? 'Inicio' : 'Cierre'} · {warning.issue.sheet ?? 'Análisis general'} · fila {warning.issue.row ?? 'no indicada'} · {warning.issue.cell ?? 'Celda no indicada'}</p>
    </li>)}</ol>
    {period.warnings.length > 25 && <Pagination page={page} pageCount={Math.ceil(period.warnings.length / 25)} onPageChange={setPage} />}
  </section>;
}
