import { useState } from 'react';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, DataTable, ListFooter } from '../../ui';
import { assetStatusLabels } from '../home/asset-status';
import { ApplicationDetails } from './PilotPlanDetails';
import { PilotWarnings } from './PilotWarnings';
import { isLegacyPilotReceipt, pilotFieldLabels, type LegacyPilotOperation, type LegacyPilotReceipt, type PilotReadReceipt } from './pilot-model';

export function PilotApplicationReader({ receipt }: { receipt: PilotReadReceipt }) {
  return isLegacyPilotReceipt(receipt) ? <LegacyPilotDetails receipt={receipt} /> : <ApplicationDetails receipt={receipt} />;
}

function LegacyPilotDetails({ receipt }: { receipt: LegacyPilotReceipt }) {
  return <section className="space-y-4" aria-label="Comprobante original del piloto V6">
    <Alert variant="info">Comprobante histórico V6 · solo lectura. Conserva el plan y los resultados originales; no representa el inventario actual ni permite volver a aplicar el piloto.</Alert>
    <Badge variant="neutral">{receipt.plan.planRulesVersion}</Badge>
    <dl className="inventory-metadata-detail">
      <div><dt>Comprobante / lote</dt><dd>{receipt.id} / {receipt.batchId}</dd></div>
      <div><dt>Aplicado en la app · hora de Chile</dt><dd>{formatInventoryDateTime(receipt.createdAt)}</dd></div>
      <div><dt>Operador de aplicación (ID)</dt><dd>{receipt.appliedById}</dd></div>
      <div><dt>Versión del lote utilizada</dt><dd>{receipt.batchVersion}</dd></div>
      <div><dt>Día de evaluación del plan en Chile</dt><dd>{receipt.plan.checkedAsOf}</dd></div>
      <div><dt>Archivo de origen · SHA-256</dt><dd>{receipt.sourceHash}</dd></div>
      <div><dt>Plan original / solicitud</dt><dd>{receipt.planId} / {receipt.requestId}</dd></div>
      <div><dt>Registros fuera de la selección</dt><dd>{receipt.plan.omittedTargetCount}</dd></div>
    </dl>
    <p className="inventory-metadata-hint">Este comprobante es anterior a las revisiones de origen V7. No incluye una revisión ni correcciones de ese contrato. La fecha y el operador corresponden a la aplicación en la app.</p>
    <DataTable rows={receipt.items} getRowKey={(item) => item.id} caption="Resultados originales del piloto" columns={[
      { key: 'asset', header: 'Activo', mobileRole: 'identity', render: (item) => <strong className="break-words">{item.assetId}</strong> },
      { key: 'operation', header: 'Operación aplicada', render: (item) => item.operation.type === 'CREATE_ASSET' ? 'Creación' : 'Actualización de metadatos' },
      { key: 'identity', header: 'Serie / activo fijo al aplicar', mobileRole: 'full', render: (item) => <span className="break-words">{String(item.result.serialNumber ?? 'Sin serie')} / {String(item.result.assetTag ?? 'Sin activo fijo')}</span> },
      { key: 'status', header: 'Estado al aplicar', render: (item) => assetStatusLabels[item.result.status as keyof typeof assetStatusLabels] }
    ]} />
    {receipt.plan.operations.map((operation) => <details key={operation.candidateId} className="inventory-metadata-section">
      <summary>{operation.product!.name} · {operation.type === 'CREATE_ASSET' ? 'Crear activo' : 'Actualizar metadatos'}</summary>
      <p className="whitespace-pre-wrap break-words">Motivo: {operation.note}</p>
      <p className="inventory-metadata-hint break-words">Candidato original: {operation.candidateId} · Decisión utilizada: {operation.decisionId}</p>
      <DataTable rows={operation.changes} getRowKey={(change) => change.field} caption="Cambios conservados en el plan original" columns={[
        { key: 'field', header: 'Campo', mobileRole: 'identity', render: (change) => pilotFieldLabels[change.field] ?? change.field },
        { key: 'before', header: 'Antes', mobileRole: 'full', render: (change) => change.before == null ? 'Sin dato' : String(change.before) },
        { key: 'after', header: 'Después', mobileRole: 'full', render: (change) => change.after == null ? 'Sin dato' : String(change.after) }
      ]} />
      <LegacyPilotSources sources={operation.source} />
    </details>)}
    <PilotWarnings planned={receipt.plan.operations} operations={receipt.plan.operations} />
  </section>;
}

function LegacyPilotSources({ sources }: { sources: LegacyPilotOperation['source'] }) {
  const [visible, setVisible] = useState(25);
  return <section className="space-y-3" aria-label="Filas de origen del plan original">
    <h4 className="font-semibold">Procedencia conservada</h4>
    <ol className="space-y-2">{sources.slice(0, visible).map((source) => <li key={source.recordId} className="break-words">{source.sheet} · fila {source.row} · {source.recordId}</li>)}</ol>
    <ListFooter loaded={Math.min(visible, sources.length)} total={sources.length} hasMore={visible < sources.length} onLoadMore={() => setVisible((count) => count + 25)} />
  </section>;
}
