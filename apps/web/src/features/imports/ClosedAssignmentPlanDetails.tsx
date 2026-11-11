import { useState } from 'react';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Field, Pagination, Select } from '../../ui';
import { assetStatusLabels } from '../home/asset-status';
import { closedBlockerLabel } from './closed-assignment-labels';
import type { ClosedPlan, ClosedPlanPeriod } from './closed-assignment-model';
import { historyDay, historyKindLabels } from './history-evidence-model';
import { importIssueLabels } from './import-issue-labels';
import { IssueBadge, SourceFields } from './SourceEvidence';

export function ClosedAssignmentPlanDetails({ plan, fresh, recognized, disabled, recognize, applied = false, periodId }: {
  plan: ClosedPlan; fresh: boolean; recognized: string[]; disabled: boolean; recognize: (ids: string[]) => void; applied?: boolean; periodId?: string;
}) {
  const period = plan.periods.find((entry) => entry.periodId === periodId) ?? plan.periods[0];
  const proposal = period.proposedAssignment;
  return <section className="space-y-4" aria-label={applied ? 'Snapshot del periodo aplicado' : 'Resultado de preparación'}>
    {!applied && <>
    <h3 className="font-semibold" tabIndex={-1} data-closed-plan-result>Revisión del periodo cerrado</h3>
    <Alert variant={fresh ? plan.planValidationComplete ? 'info' : 'warning' : 'warning'}>
      {!fresh ? 'El borrador o la consulta cambió. Este resultado es anterior: vuelve a generar el plan.' : plan.periods.length > 1 ? period.valid ? 'Este periodo no tiene bloqueos. La aplicación exige que todos los periodos del conjunto estén completos; no se guardó historia.' : 'Este periodo tiene bloqueos. Revisa su borrador y genera nuevamente el conjunto.' : plan.planValidationComplete ? 'Validación completa para este plan. No se guardó ninguna entrega ni devolución.' : 'El servidor encontró bloqueos. Revisa el borrador y genera otro plan; no se guardó historia.'}
    </Alert>
    <div className="import-review-summary"><Badge variant="neutral">No guardado</Badge><Badge variant="info">Sin cambios de estado o stock</Badge><Badge variant={period.blockers.length ? 'danger' : 'neutral'}>{period.blockers.length} bloqueos</Badge><Badge variant={period.warnings.length ? 'warning' : 'neutral'}>{period.warnings.length} advertencias</Badge></div>
    </>}
    <dl className="inventory-metadata-detail">
      <div><dt>Destinatario histórico confirmado</dt><dd>{proposal.officeName ?? proposal.personName ?? 'Sin confirmar'} · {proposal.recipientType === 'OFFICE' ? 'Oficina' : proposal.recipientType === 'PERSON' ? 'Persona' : 'Tipo sin confirmar'}</dd></div>
      <div><dt>Tipo de entrega</dt><dd>{proposal.assignmentType === 'LOAN' ? 'Préstamo' : 'Estándar'}</dd></div>
      <div><dt>Inicio confirmado (zona ingresada)</dt><dd className="break-words">{period.start.confirmedAt ?? 'Sin fecha exacta'}</dd></div>
      <div><dt>Cierre confirmado (zona ingresada)</dt><dd className="break-words">{period.end.confirmedAt ?? 'Sin fecha exacta'}</dd></div>
      <div><dt>Inicio / cierre en hora de Chile</dt><dd>{proposal.startedAt ? formatInventoryDateTime(proposal.startedAt) : 'Desconocido'} / {proposal.endedAt ? formatInventoryDateTime(proposal.endedAt) : 'Desconocido'}</dd></div>
      <div><dt>Estado histórico de devolución</dt><dd>{proposal.returnStatus ? assetStatusLabels[proposal.returnStatus] : 'Sin confirmar'}</dd></div>
      <div><dt>{applied ? 'Estado del activo contrastado al aplicar (no consulta actual)' : 'Estado actual consultado por el servidor'}</dt><dd>{assetStatusLabels[plan.assetBefore.status as keyof typeof assetStatusLabels]} · {plan.assetBefore.isActive ? 'Activo' : 'Archivado'}. No fue modificado por este periodo.</dd></div>
      <div><dt>Ejecutores históricos</dt><dd>Desconocidos. No se atribuye esta entrega al revisor actual.</dd></div>
      <div><dt>Motivo / respaldo del periodo</dt><dd className="whitespace-pre-wrap break-words">{period.note} / {period.evidenceReference}</dd></div>
      <div><dt>Respaldo de la hora exacta de inicio / cierre</dt><dd className="break-words">{period.start.dateEvidenceReference ?? 'Sin confirmar'} / {period.end.dateEvidenceReference ?? 'Sin confirmar'}</dd></div>
      <div><dt>Ticket / OT de salida</dt><dd>{proposal.ticketReference ?? 'Sin dato'} / {proposal.otReference ?? 'Sin dato'}</dd></div>
      <div><dt>Ticket / OT de devolución</dt><dd>{proposal.returnTicketReference ?? 'Sin dato'} / {proposal.returnOtReference ?? 'Sin dato'}</dd></div>
    </dl>
    <ClosedBlockers key={'blockers:' + plan.planId + ':' + period.periodId} period={period} />
    <ClosedWarnings key={'warnings:' + plan.planId + ':' + period.periodId} period={period} recognized={recognized} disabled={disabled} recognize={recognize} applied={applied} />
    <details className="inventory-metadata-section"><summary>Procedencia y versiones contrastadas por el plan</summary><div className="space-y-4 mt-3">
      <p className="inventory-metadata-hint">{applied ? 'Interpretación y versiones conservadas al aplicar. No sustituyen una consulta vigente del origen.' : 'Estos son los datos que contrastó el servidor, no un comprobante aplicado ni garantía de vigencia futura.'}</p>
      {period.sources.map((source) => <section key={source.endpoint} className="space-y-3"><dl className="inventory-metadata-detail">
        <div><dt>{source.endpoint === 'start' ? 'Inicio' : 'Cierre'}</dt><dd>{historyKindLabels[source.kind]} · {source.sheet} · fila {source.row} · {historyDay(source.effectiveDay)}</dd></div>
        <div><dt>Evidencia y versión</dt><dd className="break-words">{source.evidenceId} · v{source.evidenceVersion} · origen r{source.sourceRevision}</dd></div>
        <div><dt>Origen al capturar / enmienda vigente</dt><dd className="break-words">r{source.capturedSourceRevision} / {source.amendmentId ?? 'Sin enmienda'}</dd></div>
        <div><dt>Lote / comprobante documental</dt><dd className="break-words">{source.batchId} / {source.captureId}</dd></div>
        <div><dt>Fila original / huella del archivo</dt><dd className="break-all">{source.recordId} / {source.sourceHash}</dd></div>
        <div><dt>Huella de interpretación</dt><dd className="break-all">{source.snapshotDigest}</dd></div>
      </dl><details><summary>Interpretación que contrastó el plan · {source.endpoint === 'start' ? 'inicio' : 'cierre'}</summary><SourceFields fields={source.fields} /></details></section>)}
      <p className="break-all inventory-metadata-hint">Plan: {plan.planId} · {plan.planRulesVersion} · contrastado al {historyDay(plan.checkedAsOf)}</p>
    </div></details>
    {!applied && <p className="inventory-metadata-hint">Preparar no guarda historia. La aplicación permanente requiere una confirmación independiente.</p>}
  </section>;
}

function ClosedBlockers({ period }: { period: ClosedPlanPeriod }) {
  const [page, setPage] = useState(1);
  if (!period.blockers.length) return null;
  return <section aria-label="Bloqueos del periodo" className="space-y-3"><h4 className="font-semibold">Bloqueos</h4>
    <ol className="space-y-3">{period.blockers.slice((page - 1) * 25, page * 25).map((entry, index) => <li key={page + ':' + index} className="inventory-metadata-section">
      <p>{entry.endpoint ? (entry.endpoint === 'start' ? 'Inicio: ' : 'Cierre: ') : ''}{closedBlockerLabel(entry.code)}</p>
      <p className="inventory-metadata-hint break-words">{entry.code}{entry.relatedId ? ' · Referencia: ' + entry.relatedId : ''}</p>
    </li>)}</ol>{period.blockers.length > 25 && <Pagination page={page} pageCount={Math.ceil(period.blockers.length / 25)} onPageChange={setPage} />}
  </section>;
}
function ClosedWarnings({ period, recognized, disabled, recognize, applied = false }: { period: ClosedPlanPeriod; recognized: string[]; disabled: boolean; recognize: (ids: string[]) => void; applied?: boolean }) {
  const [page, setPage] = useState(1);
  if (!period.warnings.length && !recognized.length) return null;
  if (applied) return <section aria-label="Advertencias conservadas al aplicar" className="space-y-3"><h4 className="font-semibold">Advertencias reconocidas al aplicar</h4>
    <ol className="space-y-3">{period.warnings.slice((page - 1) * 25, page * 25).map((warning, index) => <li key={warning.id + ':' + index} className="inventory-metadata-section"><IssueBadge issue={warning.issue} />{warning.contextualOnly && <Badge variant="info">Contexto; no elimina la incidencia</Badge>}<p className="break-all">{warning.id}</p><p>{warning.evidenceId === period.start.evidenceId ? 'Inicio' : 'Cierre'} · {warning.issue.sheet ?? 'Análisis general'} · fila {warning.issue.row ?? 'no indicada'}</p></li>)}</ol>
    {period.warnings.length > 25 && <Pagination page={page} pageCount={Math.ceil(period.warnings.length / 25)} onPageChange={setPage} />}
  </section>;
  const recognizedIds = new Set(recognized);
  const warningIds = new Set(period.warnings.map((warning) => warning.id));
  const obsolete = recognized.filter((id) => !warningIds.has(id));
  const obsoleteIds = new Set(obsolete);
  return <section aria-label="Advertencias del periodo" className="space-y-3"><h4 className="font-semibold">Advertencias para revisión individual</h4>
    {obsolete.length > 0 && <Field label="Reconocimientos anteriores" disabled={disabled} hint="Ya no corresponden a las advertencias de este resultado."><Select value="" onChange={(value) => { if (value === 'clear') recognize(recognized.filter((id) => !obsoleteIds.has(id))); }} options={[{ value: '', label: obsolete.length + ' reconocimientos fuera del plan actual' }, { value: 'clear', label: 'Retirar expresamente los reconocimientos anteriores' }]} /></Field>}
    {period.warnings.slice((page - 1) * 25, page * 25).map((warning, index) => <div key={warning.id + ':' + index} className="inventory-metadata-section space-y-3">
      <IssueBadge issue={warning.issue} />{warning.contextualOnly && <Badge variant="info">Contexto del estado actual; no se elimina la incidencia</Badge>}
      <Field label={importIssueLabels[warning.issue.code] ?? 'Advertencia del origen'} disabled={disabled || (!recognizedIds.has(warning.id) && recognized.length >= 1000)} hint={(warning.evidenceId === period.start.evidenceId ? 'Inicio' : 'Cierre') + ' · ' + (warning.issue.sheet ?? 'Análisis general') + (warning.issue.row ? ' · fila ' + warning.issue.row : '')}>
        <Select value={recognizedIds.has(warning.id) ? 'yes' : ''} onChange={(value) => recognize(value === 'yes' ? [...new Set([...recognized, warning.id])] : recognized.filter((id) => id !== warning.id))} options={[{ value: '', label: 'Pendiente de revisar' }, { value: 'yes', label: 'Revisada y reconocida para este periodo' }]} />
      </Field><p className="inventory-metadata-hint break-all">{warning.issue.code} · {warning.id}</p>
    </div>)}
    {period.warnings.length > 25 && <Pagination page={page} pageCount={Math.ceil(period.warnings.length / 25)} loading={disabled} onPageChange={setPage} />}
    <p className="inventory-metadata-hint">Reconocer advertencias invalida el plan: confirma y genera nuevamente. No permite ignorar bloqueos.</p>
    {warningIds.size > 1000 && <Alert variant="warning">El plan supera el límite de 1000 reconocimientos. Requiere revisar el origen; no se recorta la lista ni se ofrece aplicar.</Alert>}
  </section>;
}
