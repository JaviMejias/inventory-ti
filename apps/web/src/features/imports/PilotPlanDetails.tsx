import { useState } from 'react';
import { Alert, Badge, DataTable, ListFooter } from '../../ui';
import { formatInventoryDateTime } from '../../lib/date-range';
import { assetStatusLabels } from '../home/asset-status';
import { pilotIssueLabel } from './pilot-issue-labels';
import { PilotWarnings } from './PilotWarnings';
import { pilotFieldLabels, type ApplicationReceipt, type PilotPlan, type SourceCorrection } from './pilot-model';

export function SourceCorrections({ corrections }: { corrections: SourceCorrection[] }) {
  const [visible, setVisible] = useState(25);
  return <div className="space-y-3">{corrections.slice(0, visible).map((entry, index) => <section key={entry.recordId + entry.field + index} className="inventory-metadata-section">
    <h4 className="font-semibold">{entry.sheet} · fila {entry.row} · {pilotFieldLabels[entry.field] ?? entry.field}</h4>
    <p>Original: {entry.originalCell ? String(entry.originalCell.value) : 'Sin dato'}</p>
    <p>Interpretación vigente: {entry.afterCell ? String(entry.afterCell.value) : 'Sin dato'}</p>
    <p className="whitespace-pre-wrap break-words">Motivo: {entry.note}</p><p className="break-words">Respaldo: {entry.evidenceReference}</p>
    <p className="inventory-metadata-hint">Revisión {entry.revision} · Revisor {entry.reviewedById}</p>
  </section>)}<ListFooter loaded={Math.min(visible, corrections.length)} total={corrections.length} hasMore={visible < corrections.length} onLoadMore={() => setVisible((count) => count + 25)} /></div>;
}
export function PilotPlanDetails({ plan, applied = false, showWarnings = true }: { plan: PilotPlan; applied?: boolean; showWarnings?: boolean }) {
  return <section className="space-y-4" aria-label={applied ? 'Plan utilizado en la aplicación' : 'Resultado del plan'}>
    <Alert variant={plan.planValidationComplete ? 'info' : 'warning'}>{applied ? 'Este plan es la evidencia histórica del comprobante; sus valores no representan el inventario actual.' : 'Este análisis no está guardado como aprobación y todavía no modifica el inventario.'} {plan.omittedTargetCount} registros del lote fuera de esta selección.</Alert>
    <p className="inventory-metadata-hint">Versión {plan.batchVersion} · Revisión de origen {plan.sourceRevision} · Evaluado el {plan.checkedAsOf} (Chile).</p>
    {plan.operations.map((operation) => <details className="inventory-metadata-section" key={operation.candidateId} open>
      <summary>{operation.type === 'CREATE_ASSET' ? 'Crear activo' : 'Actualizar metadatos'} · {operation.product?.name ?? 'Producto no confirmado'} · {operation.valid ? 'Validado en este plan' : 'Bloqueado'}</summary>
      <p className="whitespace-pre-wrap break-words my-3">Motivo: {operation.note}</p>
      <p className="inventory-metadata-hint break-words">Decisión utilizada: {operation.decisionId ?? 'Sin decisión'}. Revisión de identidad: {operation.identityRevision ?? 'No informada'} · Origen de la decisión: {operation.decisionSourceRevision ?? 'No informado'}.</p>
      <p>Estado {applied ? 'evaluado' : 'propuesto'}: {(assetStatusLabels as Record<string, string>)[operation.resultingStatus ?? ''] ?? 'Sin confirmar'}</p>
      <p className="inventory-metadata-hint break-words">Origen: {operation.source.map((row) => row.sheet + ' · fila ' + row.row).join('; ')}</p>
      <DataTable rows={operation.changes.map((entry, index) => ({ ...entry, id: String(index) }))} getRowKey={(entry) => entry.id} caption="Cambios antes y después" columns={[
        { key: 'field', header: 'Campo', mobileRole: 'identity', render: (entry) => pilotFieldLabels[entry.field] ?? entry.field },
        { key: 'before', header: 'Antes', mobileRole: 'full', render: (entry) => entry.before == null ? 'Sin dato' : String(entry.before) },
        { key: 'after', header: 'Después', mobileRole: 'full', render: (entry) => entry.after == null ? 'Borrar valor' : String(entry.after) }
      ]} />
      <div className="space-y-2">{operation.blockers.map((entry, index) => <Alert variant="danger" key={entry.code + index}>{pilotIssueLabel(entry.code)} <small>{entry.code}</small></Alert>)}</div>
      {Boolean(operation.sourceCorrections.length) && <details><summary>Correcciones de origen utilizadas</summary><SourceCorrections corrections={operation.sourceCorrections} /></details>}
      {!operation.blockers.length && <Badge variant="success">Sin bloqueos en esta evaluación</Badge>}
    </details>)}
    {showWarnings && <PilotWarnings planned={plan.operations} operations={plan.operations} />}
  </section>;
}
export function ApplicationDetails({ receipt }: { receipt: ApplicationReceipt }) {
  return <section className="space-y-4" aria-label="Comprobante de aplicación">
    <Alert variant="success">Piloto aplicado y comprobante guardado. Corregir un resultado requiere los circuitos operativos habituales; no hay reversión automática.</Alert>
    <p className="break-words">Comprobante: {receipt.id}</p><p>Aplicado por: {receipt.appliedById} · {formatInventoryDateTime(receipt.createdAt)} (Chile).</p>
    <DataTable rows={receipt.items} getRowKey={(item) => item.id} caption="Activos confirmados en el comprobante" columns={[
      { key: 'asset', header: 'Activo', mobileRole: 'identity', render: (item) => item.assetId },
      { key: 'operation', header: 'Operación', render: (item) => item.operation.type === 'CREATE_ASSET' ? 'Creado' : 'Metadatos actualizados' },
      { key: 'identity', header: 'Identidad al aplicar', mobileRole: 'full', render: (item) => String(item.result.serialNumber ?? item.result.assetTag ?? 'Sin dato') },
      { key: 'status', header: 'Estado al aplicar', render: (item) => (assetStatusLabels as Record<string, string>)[String(item.result.status)] ?? String(item.result.status ?? 'Sin dato') }
    ]} />
    <PilotPlanDetails plan={receipt.plan} applied />
  </section>;
}
