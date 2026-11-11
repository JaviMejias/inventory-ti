import { useState } from 'react';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, Field, Pagination, Select } from '../../ui';
import { assetStatusLabels } from '../home/asset-status';
import { retirementBlockerLabel } from './retirement-labels';
import { historyDay } from './history-evidence-model';
import { importIssueLabels } from './import-issue-labels';
import { IssueBadge, SourceFields } from './SourceEvidence';
import type { RetirementPlan } from './retirement-plan-model';

export function RetirementPlanDetails({ plan, fresh, recognized, disabled, recognize, applied = false }: {
  plan: RetirementPlan; fresh: boolean; recognized: string[]; disabled: boolean; recognize: (ids: string[]) => void; applied?: boolean;
}) {
  const [blockPage, setBlockPage] = useState(1);
  const [warningPage, setWarningPage] = useState(1);
  const warningIds = new Set(plan.warnings.map((entry) => entry.id));
  const recognizedIds = new Set(recognized);
  const obsolete = recognized.filter((id) => !warningIds.has(id));
  const proposal = plan.proposedRetirement; const source = plan.source;
  return <section className="space-y-4" aria-label="Resultado de preparación de baja">
    <h3 className="font-semibold" tabIndex={-1} data-retirement-plan-result>{applied ? 'Revisión conservada al aplicar' : 'Revisión de la baja histórica'}</h3>
    <Alert variant={!applied && (!fresh || !plan.planValidationComplete) ? 'warning' : 'info'}>
      {applied ? 'Snapshot inmutable contrastado al aplicar. No es una consulta del estado actual ni permite editar la baja.' : !fresh ? 'El borrador o la consulta cambió. Este resultado es anterior: genera nuevamente el plan.' : plan.planValidationComplete ? 'Validación completa de esta propuesta. No se dio de baja el activo ni se guardó historia.' : 'La propuesta tiene bloqueos. Revisa los datos y genera otro plan; no se aplicó la baja.'}
    </Alert>
    <div className="import-review-summary"><Badge variant={applied ? 'success' : 'neutral'}>{applied ? 'Revisión aplicada' : 'No guardado'}</Badge><Badge variant={applied ? 'danger' : 'info'}>{applied ? 'Baja terminal registrada' : 'Sin cambios de estado o stock'}</Badge><Badge variant={plan.blockers.length ? 'danger' : 'neutral'}>{plan.blockers.length} {plan.blockers.length === 1 ? 'bloqueo' : 'bloqueos'}</Badge><Badge variant={plan.warnings.length ? 'warning' : 'neutral'}>{plan.warnings.length} {plan.warnings.length === 1 ? 'advertencia' : 'advertencias'}</Badge></div>
    <dl className="inventory-metadata-detail">
      <div><dt>{applied ? 'Estado anterior a la aplicación' : 'Estado consultado por el servidor'}</dt><dd>{assetStatusLabels[plan.assetBefore.status as keyof typeof assetStatusLabels]} · {plan.assetBefore.isActive ? 'Activo' : 'Archivado'}</dd></div>
      <div><dt>{applied ? 'Estado registrado al aplicar' : 'Estado propuesto, no aplicado'}</dt><dd>Dado de baja · inactivo</dd></div>
      <div><dt>Retiro confirmado (zona ingresada)</dt><dd className="break-words">{plan.request.confirmedAt ?? 'Sin confirmar'}</dd></div>
      <div><dt>Retiro propuesto en hora de Chile</dt><dd>{proposal.decommissionedAt ? formatInventoryDateTime(proposal.decommissionedAt) : 'Desconocido'}</dd></div>
      <div><dt>Recepción indicada por el origen</dt><dd>{historyDay(source.sourceReceivedDay)} · no es la fecha de baja</dd></div>
      <div><dt>Fecha de baja en la evidencia</dt><dd>Desconocida. La propuesta no reescribe la captura.</dd></div>
      <div><dt>Ejecutor histórico</dt><dd>Desconocido. No se atribuye al revisor actual.</dd></div>
      <div><dt>Motivo / respaldo del retiro</dt><dd className="whitespace-pre-wrap break-words">{plan.request.note} / {plan.request.evidenceReference}</dd></div>
      <div><dt>Respaldo del instante exacto</dt><dd className="break-words">{plan.request.dateEvidenceReference ?? 'Sin confirmar'}</dd></div>
    </dl>
    {plan.blockers.length > 0 && <section aria-label="Bloqueos de la baja" className="space-y-3"><h4 className="font-semibold">Bloqueos</h4><ol className="space-y-3">{plan.blockers.slice((blockPage - 1) * 25, blockPage * 25).map((entry, index) => <li key={blockPage + ':' + index} className="inventory-metadata-section"><p>{retirementBlockerLabel(entry.code)}</p><p className="inventory-metadata-hint break-words">{entry.code}{entry.relatedId ? ' · Referencia: ' + entry.relatedId : ''}</p></li>)}</ol>{plan.blockers.length > 25 && <Pagination page={blockPage} pageCount={Math.ceil(plan.blockers.length / 25)} onPageChange={setBlockPage} />}</section>}
    {(plan.warnings.length > 0 || obsolete.length > 0) && <section aria-label="Advertencias de la baja" className="space-y-3"><h4 className="font-semibold">Advertencias para revisión individual</h4>
      {obsolete.length > 0 && <Alert variant="warning" action={<Button variant="secondary" size="sm" disabled={disabled} onClick={() => recognize(recognized.filter((id) => warningIds.has(id)))}>Retirar reconocimientos anteriores</Button>}>{obsolete.length} reconocimientos no corresponden a este resultado. Retíralos expresamente.</Alert>}
      {plan.warnings.slice((warningPage - 1) * 25, warningPage * 25).map((entry) => <div key={entry.id} className="inventory-metadata-section space-y-3"><IssueBadge issue={entry.issue} /><p>{importIssueLabels[entry.issue.code] ?? 'Advertencia del origen pendiente de revisión.'}</p>{applied ? <Badge variant="neutral">Reconocida al aplicar</Badge> : <Field label="Reconocimiento de advertencia" disabled={disabled || (!recognizedIds.has(entry.id) && recognized.length >= 1000)} hint={(entry.issue.sheet ?? 'Origen') + ' · fila ' + (entry.issue.row ?? 'no indicada')}><Select value={recognizedIds.has(entry.id) ? 'yes' : ''} onChange={(value) => recognize(value === 'yes' ? [...new Set([...recognized, entry.id])] : recognized.filter((id) => id !== entry.id))} options={[{ value: '', label: 'Pendiente de revisar' }, { value: 'yes', label: 'Revisada y reconocida para esta baja' }]} /></Field>}<p className="inventory-metadata-hint break-all">{entry.issue.code} · {entry.id}</p></div>)}
      {plan.warnings.length > 25 && <Pagination page={warningPage} pageCount={Math.ceil(plan.warnings.length / 25)} loading={disabled && !applied} onPageChange={setWarningPage} />}
      <p className="inventory-metadata-hint">{applied ? 'Se conservan los reconocimientos de la aplicación; no son una nueva revisión del origen actual.' : 'Reconocer invalida el plan: confirma y genera nuevamente. No elimina bloqueos del origen ni autoriza aplicar.'}</p>
      {plan.warnings.length > 1000 && <Alert variant="warning">Se supera el límite de 1000 reconocimientos. Requiere revisar el origen; no se recortan las advertencias.</Alert>}
    </section>}
    <details className="inventory-metadata-section"><summary>Procedencia y versiones contrastadas</summary><div className="mt-3 space-y-3"><dl className="inventory-metadata-detail">
      <div><dt>Hoja / fila original</dt><dd>{source.sheet} / {source.row}</dd></div>
      <div><dt>Evidencia vigente / origen efectivo</dt><dd className="break-words">{source.evidenceId} · v{source.evidenceVersion} / r{source.sourceRevision}</dd></div>
      <div><dt>Origen al capturar / enmienda vigente</dt><dd className="break-words">r{source.capturedSourceRevision} / {source.amendmentId ?? 'Sin enmienda'}</dd></div>
      <div><dt>Lote / comprobante de captura</dt><dd className="break-words">{source.batchId} / {source.captureId}</dd></div>
      <div><dt>Huella de archivo / fila / candidato</dt><dd className="break-all">{source.sourceHash} / {source.recordId} / {source.candidateId}</dd></div>
      <div><dt>Huella de interpretación</dt><dd className="break-all">{source.snapshotDigest}</dd></div>
    </dl><SourceFields fields={source.fields} /><p className="inventory-metadata-hint break-all">Plan: {plan.planId} · {plan.planRulesVersion} · contrastado al {historyDay(plan.checkedAsOf)}</p></div></details>
    <p className="inventory-metadata-hint">{applied ? 'El comprobante conserva esta revisión sin editarla ni certificar todo el archivo.' : 'Este plan solo contrasta la observación elegida y la historia consultada. No certifica todo el archivo. Aplicar requiere una confirmación independiente si está habilitada.'}</p>
  </section>;
}
