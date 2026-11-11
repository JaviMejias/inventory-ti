import { useState } from 'react';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Icon, Pagination } from '../../ui';
import { assetStatusLabels } from '../home/asset-status';
import { historyDay, historyKindLabels } from './history-evidence-model';
import { importIssueLabels } from './import-issue-labels';
import { retirementBlockerLabel } from './retirement-labels';
import { retirementClassificationLabels, retirementCurrentStateLabels, retirementEvidenceStateLabels, retirementNextStepLabels, type RetirementReconciliation, type RetirementReconciliationReceipt } from './retirement-reconciliation-model';
import { IssueBadge, SourceFields } from './SourceEvidence';

export function RetirementReconciliationDetails({ assessment, fresh }: { assessment: RetirementReconciliation; fresh: boolean }) {
  const [diagnosticPage, setDiagnosticPage] = useState(1);
  const [warningPage, setWarningPage] = useState(1);
  const source = assessment.source;
  const danger = assessment.classification === 'CURRENT_STATE_REVIEW_REQUIRED' || assessment.classification === 'EVIDENCE_ALREADY_USED';
  const receiptClassification = assessment.classification === 'ALREADY_IMPORTED_RETIREMENT' || assessment.classification === 'EXISTING_IMPORTED_RETIREMENT';
  const dateUnconfirmed = assessment.diagnostics.some((entry) => entry.code === 'CURRENT_RETIREMENT_DATE_UNCONFIRMED');
  return <section className="space-y-4" aria-label="Resultado de conciliación de baja">
    <h3 className="font-semibold" tabIndex={-1} data-retirement-reconciliation-result>Diagnóstico de la baja</h3>
    {!fresh && <Alert variant="warning">La selección o la consulta cambió. Este diagnóstico es anterior: vuelve a consultar para confirmar su vigencia.</Alert>}
    <div className="import-review-summary"><Badge variant={danger ? 'danger' : receiptClassification ? 'info' : 'warning'}><Icon size="sm"><path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z" /><path d="M12 8v5m0 3h.01" /></Icon>{retirementClassificationLabels[assessment.classification]}</Badge><Badge variant="neutral">Solo consulta · sin cambios</Badge></div>
    <dl className="inventory-metadata-detail">
      <div><dt>Situación del activo</dt><dd>{retirementCurrentStateLabels[assessment.currentState]}</dd></div>
      <div><dt>Uso de la evidencia</dt><dd>{retirementEvidenceStateLabels[assessment.evidenceState]}</dd></div>
      <div><dt>Estado consultado</dt><dd>{assetStatusLabels[assessment.assetBefore.status as keyof typeof assetStatusLabels]} · {assessment.assetBefore.isActive ? 'Activo' : 'Inactivo'}</dd></div>
      <div><dt>Evaluado en Chile</dt><dd>{historyDay(assessment.checkedAsOf)} · consulta puntual, no aprobación</dd></div>
    </dl>
    <section className="inventory-metadata-section space-y-3" aria-label="Fechas de origen y baja existente">
      <h4 className="font-semibold">Origen y retiro registrado</h4>
      <dl className="inventory-metadata-detail">
        <div><dt>Retiro indicado por la evidencia</dt><dd>{assessment.sourceRetirement ? 'Fecha y ejecutor históricos desconocidos' : 'La observación seleccionada no corresponde a una baja'}</dd></div>
        <div><dt>Recepción indicada por el origen</dt><dd>{historyDay(source.sourceReceivedDay)} · no prueba el retiro</dd></div>
        <div><dt>Baja existente en la app</dt><dd>{assessment.existingRetirement ? assessment.existingRetirement.effectiveAt ? formatInventoryDateTime(assessment.existingRetirement.effectiveAt) + (dateUnconfirmed ? ' · fecha por revisar' : ' · hora de Chile') : 'Retiro previo sin fecha registrada' : 'Sin baja terminal registrada'}</dd></div>
        <div><dt>Procedencia de esa fecha</dt><dd>{assessment.existingRetirement ? assessment.existingRetirement.dateOrigin === 'VERIFIED_IMPORT_RECEIPT' ? 'Comprobante importado del activo' : 'Registro actual del activo' : 'No corresponde'}</dd></div>
      </dl>
      <p className="inventory-metadata-hint">Una fecha existente no confirma la fecha desconocida del archivo. Esta consulta no completa fechas ni cambia estado, custodia o stock.</p>
    </section>
    <section aria-label="Pasos de revisión" className="space-y-3"><h4 className="font-semibold">Qué revisar</h4><ol className="space-y-3">{assessment.nextSteps.map((code) => <li key={code} className="inventory-metadata-section"><p>{retirementNextStepLabels[code] ?? 'El servidor indica un paso adicional de revisión: ' + code}</p></li>)}</ol></section>
    {assessment.existingApplication && <ReceiptMetadata title={assessment.existingApplication.id === assessment.evidenceApplication?.id ? 'Comprobante del activo y de esta evidencia' : 'Comprobante del activo seleccionado'} receipt={assessment.existingApplication} />}
    {assessment.evidenceApplication && assessment.evidenceApplication.id !== assessment.existingApplication?.id && <ReceiptMetadata title="Comprobante que utilizó la evidencia" receipt={assessment.evidenceApplication} otherAsset={assessment.evidenceApplication.assetId !== assessment.assetBefore.id} />}
    {assessment.diagnostics.length > 0 && <section aria-label="Incidencias de la conciliación" className="space-y-3"><h4 className="font-semibold">Requisitos y conflictos · {assessment.diagnostics.length}</h4><ol className="space-y-3">{assessment.diagnostics.slice((diagnosticPage - 1) * 25, diagnosticPage * 25).map((entry, index) => <li key={diagnosticPage + ':' + index} className="inventory-metadata-section"><p>{retirementBlockerLabel(entry.code)}</p><small className="inventory-metadata-hint break-words">{entry.code}{entry.relatedId ? ' · Referencia: ' + entry.relatedId : ''}</small></li>)}</ol>{assessment.diagnostics.length > 25 && <Pagination page={diagnosticPage} pageCount={Math.ceil(assessment.diagnostics.length / 25)} onPageChange={setDiagnosticPage} />}</section>}
    {assessment.warnings.length > 0 && <section aria-label="Advertencias de la conciliación" className="space-y-3"><h4 className="font-semibold">Advertencias del origen · {assessment.warnings.length}</h4><p className="inventory-metadata-hint">Consultar no reconoce estas advertencias para una futura aplicación.</p>{assessment.warnings.slice((warningPage - 1) * 25, warningPage * 25).map((entry) => <div key={entry.id} className="inventory-metadata-section space-y-3"><IssueBadge issue={entry.issue} /><p>{importIssueLabels[entry.issue.code] ?? 'Advertencia del origen pendiente de revisión.'}</p><small className="inventory-metadata-hint break-words">{entry.id}</small></div>)}{assessment.warnings.length > 25 && <Pagination page={warningPage} pageCount={Math.ceil(assessment.warnings.length / 25)} onPageChange={setWarningPage} />}</section>}
    <details className="inventory-metadata-section"><summary>Procedencia y referencias de la consulta</summary><dl className="inventory-metadata-detail mt-3">
      <div><dt>Observación</dt><dd>{historyKindLabels[source.kind]} · {source.sheet} · fila {source.row}</dd></div>
      <div><dt>Versiones consultadas</dt><dd>Evidencia v{source.evidenceVersion} · origen r{source.sourceRevision} · captura r{source.capturedSourceRevision}</dd></div>
      <div><dt>Evidencia / captura / lote</dt><dd className="break-words">{source.evidenceId} / {source.captureId} / {source.batchId}</dd></div>
      <div><dt>Evaluación / reglas</dt><dd className="break-words">{assessment.assessmentId} / {assessment.rulesVersion}</dd></div>
    </dl><SourceFields fields={source.fields} /><p className="inventory-metadata-hint">La huella identifica esta consulta. No es un plan aplicable ni una clave de recuperación.</p></details>
  </section>;
}
function ReceiptMetadata({ title, receipt, otherAsset = false }: { title: string; receipt: RetirementReconciliationReceipt; otherAsset?: boolean }) {
  return <section className="inventory-metadata-section space-y-3" aria-label={title}><h4 className="font-semibold">{title}</h4>
    {otherAsset && <Alert variant="warning">Pertenece a otro activo. No se genera un enlace de comprobante con el activo seleccionado.</Alert>}
    <dl className="inventory-metadata-detail"><div><dt>Comprobante / activo</dt><dd className="break-words">{receipt.id} / {receipt.assetId}</dd></div><div><dt>Evidencia utilizada</dt><dd className="break-words">{receipt.evidenceId} · v{receipt.evidenceVersion} · origen r{receipt.sourceRevision}</dd></div><div><dt>Retiro histórico · hora de Chile</dt><dd>{formatInventoryDateTime(receipt.decommissionedAt)}</dd></div><div><dt>Captura en la app · hora de Chile</dt><dd>{formatInventoryDateTime(receipt.appliedAt)}</dd></div><div><dt>Registrado por (ID)</dt><dd className="break-words">{receipt.appliedById} · no es el ejecutor histórico</dd></div></dl>
  </section>;
}
