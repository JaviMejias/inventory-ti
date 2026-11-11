import { useState } from 'react';
import { Badge, DataTable, ListFooter } from '../../ui';
import { assetStatusLabels } from '../home/asset-status';
import { recordKindLabels, type PreviewIssue, type ReviewTarget, type SourceCell } from './import-review-model';
import { importIssueLabels } from './import-issue-labels';

const fieldLabels: Record<string, string> = {
  equipmentType: 'Tipo de equipo', brand: 'Marca', model: 'Modelo', serialNumber: 'Serie', assetTag: 'Activo fijo',
  receivedDate: 'Fecha de recepción', usedDate: 'Fecha de utilización', loanDate: 'Fecha de préstamo', availability: 'Disponibilidad indicada',
  mixedState: 'Estado en origen', technicalCondition: 'Condición técnica', usagePurpose: 'Finalidad', location: 'Ubicación indicada', sector: 'Sector',
  incomingTicket: 'Ticket entrante', incomingOt: 'OT entrante', outgoingTicket: 'Ticket saliente', outgoingOt: 'OT saliente', notes: 'Observaciones', details: 'Detalles',
  recipientText: 'Destinatario indicado', officeText: 'Oficina indicada', agentText: 'Agente indicado', description: 'Descripción', ipAddress: 'IP', networkPrefix: 'Prefijo de red',
  hostname: 'Nombre de equipo', loanCode: 'Código de préstamo', printerSerial: 'Serie de impresora', guideReference: 'Guía', color: 'Color',
  newCount: 'Alta (conteo manual)', replacementCount: 'Reposición (conteo manual)', usedCount: 'Usado (conteo manual)', purchaseOrder: 'Orden de compra', obsolescenceText: 'Obsolescencia indicada'
};
export function IssueBadge({ issue }: { issue: PreviewIssue }) {
  return <Badge variant={issue.severity === 'BLOCKING' ? 'danger' : issue.severity === 'WARNING' ? 'warning' : 'info'}>{issue.severity === 'BLOCKING' ? 'Bloqueante' : issue.severity === 'WARNING' ? 'Advertencia' : 'Información'}</Badge>;
}
export function SourceFields({ fields }: { fields: Record<string, string | null> }) {
  return <dl className="inventory-metadata-detail mt-3">{Object.entries(fields).map(([key, value]) => <div key={key}><dt>{fieldLabels[key] ?? key}</dt><dd className="break-words">{value ?? 'Sin dato'}</dd></div>)}</dl>;
}
export function OriginalCells({ cells, row, interpreted = false, showRowAddress = true }: { cells: Record<string, SourceCell>; row: number; interpreted?: boolean; showRowAddress?: boolean }) {
  return <dl className="inventory-metadata-detail mt-3">{Object.entries(cells).map(([column, cell]) => <div key={column}><dt>{column}{showRowAddress ? row : ''} · {({ formula: 'Fórmula sin ejecutar', text: 'Texto', number: 'Número', date: 'Fecha sin zona horaria', boolean: 'Valor lógico', error: 'Error de Excel' })[cell.type] ?? cell.type}</dt><dd>{String(cell.value)}{cell.numberFormat && <small className="block">Formato: {cell.numberFormat}</small>}{cell.rawValue !== undefined && <small className="block">{interpreted ? 'Valor usado por la interpretación' : 'Valor original'}: {cell.rawValue}</small>}{cell.cachedValue !== undefined && <small className="block">Cache (no verificado): {String(cell.cachedValue)}</small>}</dd></div>)}</dl>;
}
export function SourceEvidence({ target, interpreted = false }: { target: ReviewTarget; interpreted?: boolean }) {
  const [visible, setVisible] = useState(25);
  const [issueVisible, setIssueVisible] = useState(25);
  const [matchVisible, setMatchVisible] = useState(25);
  const matches = target.candidate?.existingAssets ?? [];
  return <>
    {Boolean(matches.length) && <section aria-label="Coincidencias en inventario"><h3 className="font-semibold mb-3">Coincidencias en inventario</h3><DataTable rows={matches.slice(0, matchVisible)} getRowKey={(asset) => asset.id} caption="Activos sugeridos por el análisis" columns={[
      { key: 'product', header: 'Producto', mobileRole: 'identity', render: (asset) => asset.product.name },
      { key: 'serial', header: 'Serie', mobileRole: 'full', render: (asset) => asset.serialNumber ?? 'Sin serie' },
      { key: 'tag', header: 'Activo fijo', mobileRole: 'full', render: (asset) => asset.assetTag ?? 'Sin etiqueta' },
      { key: 'status', header: interpreted ? 'Estado en el análisis vigente' : 'Estado en el snapshot', render: (asset) => `${(assetStatusLabels as Record<string, string>)[asset.status] ?? asset.status}${asset.isActive ? '' : ' · Inactivo'}` }
    ]} /><ListFooter loaded={Math.min(matchVisible, matches.length)} total={matches.length} hasMore={matchVisible < matches.length} onLoadMore={() => setMatchVisible((count) => count + 25)} /></section>}
    <section aria-label="Incidencias del registro"><h3 className="font-semibold mb-3">Incidencias · {target.issues.length}</h3>
      <DataTable rows={target.issues.slice(0, issueVisible).map((issue, index) => ({ ...issue, id: String(index) }))} getRowKey={(issue) => issue.id} caption="Incidencias del registro" columns={[
        { key: 'code', header: 'Incidencia', mobileRole: 'identity', render: (issue) => <span className="break-words">{importIssueLabels[issue.code] ?? 'Incidencia pendiente de revisión'}<small className="block">{issue.code}</small></span> },
        { key: 'severity', header: 'Nivel', render: (issue) => <IssueBadge issue={issue} /> },
        { key: 'origin', header: 'Origen', mobileRole: 'full', render: (issue) => `${issue.sheet ?? 'Análisis general'}${issue.cell ? ' · ' + issue.cell : issue.row !== null ? ' · fila ' + issue.row : ''}` }
      ]} />
      <ListFooter loaded={Math.min(issueVisible, target.issues.length)} total={target.issues.length} hasMore={issueVisible < target.issues.length} onLoadMore={() => setIssueVisible((count) => count + 25)} />
    </section>
    <section aria-label="Filas de origen"><h3 className="font-semibold mb-3">Filas de origen · {target.records.length}</h3>
      <div className="space-y-3">{target.records.slice(0, visible).map((record) => <details className="inventory-metadata-section" key={record.id}>
        <summary>{record.sheet} · fila {record.row}{record.hidden ? ' · Oculta en Excel' : ''}</summary>
        <p className="inventory-metadata-hint">{recordKindLabels[record.kind] ?? record.kind} · Evidencia: {record.statusEvidence === 'AVAILABLE' ? 'Disponible' : record.statusEvidence === 'DECOMMISSIONED' ? 'Baja' : 'Estado no confirmado'}. No acredita el estado actual.</p>
        <SourceFields fields={record.fields} />
        <details><summary>{interpreted ? 'Celdas usadas por la interpretación vigente' : 'Celdas originales'}</summary><OriginalCells cells={record.originalCells} row={record.row} interpreted={interpreted} /></details>
      </details>)}</div>
      <ListFooter loaded={Math.min(visible, target.records.length)} total={target.records.length} hasMore={visible < target.records.length} onLoadMore={() => setVisible((count) => count + 25)} />
    </section>
  </>;
}
