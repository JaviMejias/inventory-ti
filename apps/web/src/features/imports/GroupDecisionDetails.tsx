import { useState } from 'react';
import { Alert, Badge } from '../../ui';
import { formatInventoryDateTime } from '../../lib/date-range';
import { IdentityGroupProjectionDetails } from './IdentityGroupProjectionDetails';
import { IdentityGroupResultTable } from './IdentityGroupPlanDetails';
import { groupDecisionLabels, groupEvidenceLabels, type GroupDecision, type GroupDecisionRead } from './identity-group-decision-model';

export function GroupDecisionDetails({ decision, current }: { decision: GroupDecision; current?: Omit<GroupDecisionRead, 'decision'> }) {
  const [selected, setSelected] = useState('');
  const group = decision.projection.groups.find((row) => row.groupKey === decision.groupKey)!;
  return <section className="space-y-4" aria-label="Comprobante de decisión de grupo">
    <h3 className="font-semibold scroll-mt-6" tabIndex={-1} data-group-decision-receipt>Decisión administrativa guardada</h3>
    <div className="import-review-summary"><Badge variant="success">Guardada · v{decision.version}</Badge><Badge variant={decision.action === 'HOLD' ? 'warning' : decision.action === 'EXCLUDE' ? 'neutral' : 'info'}>{groupDecisionLabels[decision.action]}</Badge>{current && <Badge variant={!current.reviewActive ? 'neutral' : current.projectionCurrent ? 'info' : 'warning'}>{!current.reviewActive ? 'Reserva cancelada' : current.projectionCurrent ? 'Coincide con la proyección consultada' : 'Proyección anterior'}</Badge>}</div>
    <div className="inventory-asset-editor-summary"><div><strong>{group.serialNumber ?? group.assetTag}</strong><small>{group.recordIds.length} observaciones · decisión sobre este grupo</small></div></div>
    <p className="break-words whitespace-pre-wrap"><strong>Motivo: </strong>{decision.note}</p><p className="break-words whitespace-pre-wrap"><strong>Respaldo: </strong>{decision.evidenceReference}</p>
    <Alert variant="info">Se guardó una decisión para el futuro piloto. No se aplicó inventario, liberaron reservas ni trasladaron vínculos de evidencia. Coincidir con una proyección no indica que esta sea la última decisión del grupo; consulta «Últimas por grupo» para ver esa intención.</Alert>
    <dl className="inventory-metadata-detail"><div><dt>Registrada por (ID)</dt><dd>{decision.reviewedById}</dd></div><div><dt>Registrada el · hora de Chile</dt><dd>{formatInventoryDateTime(decision.createdAt)}</dd></div><div><dt>Contexto utilizado</dt><dd>Lote v{decision.batchVersion} · origen r{decision.sourceRevision}</dd></div>{current && <div><dt>Versión global de decisiones consultada</dt><dd>{current.decisionVersion} · pertenece a toda la revisión</dd></div>}{decision.linkedAssetId && <div><dt>Activo propuesto · sin aplicar vínculo</dt><dd>{decision.linkedAssetId}</dd></div>}</dl>
    <IdentityGroupResultTable rows={decision.evidenceReviews} caption="Decisiones de pertenencia de evidencia" rowKey={(row) => row.evidenceId} columns={[
      { key: 'evidence', header: 'Evidencia', mobileRole: 'identity', render: (row) => <span className="break-words">{row.evidenceId}<small className="block">Versión revisada: {row.expectedEvidenceVersion}</small></span> },
      { key: 'disposition', header: 'Decisión administrativa', mobileRole: 'full', render: (row) => <Badge variant={row.disposition === 'CONFIRM_GROUP_MEMBERSHIP' ? 'info' : 'neutral'}>{groupEvidenceLabels[row.disposition]}</Badge> },
      { key: 'proof', header: 'Motivo y respaldo', mobileRole: 'full', render: (row) => <span className="whitespace-pre-wrap break-words">{row.note}<small className="block">{row.evidenceReference}</small></span> }
    ]} />
    {decision.evidenceReviews.length === 0 && <p className="inventory-metadata-hint">No se guardaron revisiones de pertenencia de evidencia en esta decisión.</p>}
    <details className="inventory-metadata-section"><summary>Proyección completa utilizada al decidir</summary><IdentityGroupProjectionDetails key={decision.id} projection={decision.projection} fresh={false} archived selectedGroupKey={selected || decision.groupKey} selectGroup={setSelected} /></details>
    <details className="inventory-metadata-section"><summary>Referencias del comprobante</summary><dl className="inventory-metadata-detail mt-3">{[['Decisión', decision.id], ['Revisión', decision.reviewId], ['Grupo', decision.groupId], ['Clave estable del grupo', decision.groupKey], ['Solicitud', decision.requestId], ['Huella de la solicitud', decision.requestDigest], ['Proyección utilizada', decision.projectionId]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>
  </section>;
}
