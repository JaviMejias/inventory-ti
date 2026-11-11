import { useState } from 'react';
import { environment } from '../../config/environment';
import { Alert, Button, DataTable, Dialog, Field, LoadingState } from '../../ui';
import { canConfirmPilot } from './pilot-model';
import { ApplicationDetails, PilotPlanDetails, SourceCorrections } from './PilotPlanDetails';
import { PilotApplicationReader } from './PilotApplicationReader';
import { PilotWarnings } from './PilotWarnings';
import { PilotOperationEditor } from './PilotOperationEditor';
import { usePilotWorkflow } from './usePilotWorkflow';

export function PilotDialog({ batchId, fileName, open, close, exited, changed }: {
  batchId: string; fileName: string; open: boolean; close: () => void; exited: () => void; changed: () => void;
}) {
  const flow = usePilotWorkflow(batchId, changed);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [discard, setDiscard] = useState(false);
  const locked = flow.busy || flow.recovery || flow.reading || Boolean(flow.readError) || flow.needsRefresh;
  function requestClose() { if (flow.busy) return; if (!flow.receipt && (flow.dirty || flow.recovery)) setDiscard(true); else close(); }
  const eligible = canConfirmPilot(flow.evaluated, environment.inventoryImportApplyV6) && !locked;
  const actions = discard ? <>
    <Button key="keep-pilot" autoFocus variant="secondary" onClick={() => setDiscard(false)}>Seguir preparando</Button>
    <Button onClick={close}>Descartar y cerrar</Button>
  </> : flow.originalReceipt ? <Button variant="secondary" onClick={flow.closeOriginal}>Volver a la preparación</Button> : flow.receipt ? <Button variant="secondary" onClick={close}>Cerrar comprobante</Button> : flow.recovery ? <>
    <Button variant="secondary" disabled={flow.busy} onClick={requestClose}>Cerrar</Button>
    <Button loading={flow.busy} onClick={() => void flow.apply()}>Recuperar aplicación</Button>
  </> : confirming ? <>
    <Button key="cancel-application" autoFocus variant="secondary" disabled={flow.busy} onClick={() => { setConfirming(false); setConfirmation(''); }}>Volver al plan</Button>
    <Button variant="danger" loading={flow.busy} disabled={!eligible || confirmation !== 'APLICAR PILOTO'} onClick={() => void flow.apply()}>Aplicar piloto</Button>
  </> : <>
    <Button variant="secondary" disabled={flow.busy} onClick={requestClose}>Cerrar</Button>
    <Button loading={flow.busy} disabled={locked || !flow.operations.length} onClick={() => void flow.generate()}>Generar plan</Button>
    {environment.inventoryImportApplyV6 && <Button disabled={!eligible} onClick={() => { setConfirmation(''); setConfirming(true); }}>Revisar aplicación</Button>}
  </>;
  return <Dialog className="catalog-editor-dialog import-review-dialog" title={flow.receipt ? 'Comprobante del piloto' : confirming ? 'Confirmar aplicación del piloto' : 'Preparar piloto'} description={fileName} open={open} onClose={requestClose} onExited={exited} busy={flow.busy} actions={actions}>
    <div className="space-y-5">
      {discard && <Alert variant="warning">{flow.recovery ? 'Cerrar no cancela una aplicación que pudo haberse confirmado. Conserva la referencia y consulta los comprobantes al volver.' : 'El borrador y el plan no se guardan. Si cierras, perderás esta preparación.'}</Alert>}
      {flow.originalReceipt ? <>
        <Alert variant="info">Este es el comprobante original, del lote {flow.originalReceipt.batchId}. Consultarlo no aplica tu selección ni descarta el borrador.</Alert>
        <PilotApplicationReader receipt={flow.originalReceipt} />
      </> : flow.receipt ? <ApplicationDetails receipt={flow.receipt} /> : <>
        {flow.reading && <LoadingState label="Comprobando origen, decisiones y catálogo…" />}
        {flow.readError && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void flow.refresh()}>Reintentar contexto</Button>}>{flow.readError}</Alert>}
        {flow.error && <Alert variant="danger">{flow.error}</Alert>}
        {flow.originalReference && <Button variant="secondary" loading={flow.busy} onClick={() => void flow.consultOriginal()}>Consultar comprobante original</Button>}
        {flow.needsRefresh && <Alert variant="warning" action={<Button variant="secondary" size="sm" onClick={() => { setConfirming(false); setConfirmation(''); void flow.refresh(); }}>Actualizar contexto</Button>}>El plan o la revisión cambió. Actualiza, comprueba origen y decisiones y genera un plan nuevo; tus operaciones se conservan.</Alert>}
        {flow.recovery && <Alert variant="warning">El resultado no está confirmado o el inventario está ocupado. Recuperar aplicación reutiliza el mismo plan, intención y clave; no prepara una aplicación distinta.</Alert>}
        {flow.recovery && <p className="inventory-metadata-hint break-words">Solicitud de recuperación: {flow.requestId}. Conserva esta referencia si cierras y consulta los comprobantes del lote.</p>}
        {confirming ? <>
          <Alert variant="warning">Se aplicarán {flow.evaluated?.request.operations.length ?? 0} operaciones al inventario real en una sola transacción. No se importan Tintas, bajas, entregas ni historia. No hay reversión automática.</Alert>
          <Field label="Confirmación de aplicación" disabled={flow.busy || flow.recovery} hint="Escribe APLICAR PILOTO después de revisar los cambios y el destino de despliegue.">
            <input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </Field>
        </> : <>
          <Alert variant="info">Piloto de hasta 25 equipos. Generar el plan solo consulta; no crea activos ni guarda una aprobación.</Alert>
          {!environment.inventoryImportApplyV6 && <Alert variant="info">Aplicación desactivada en este despliegue. Puedes preparar y consultar el plan, pero no cambiar el inventario.</Alert>}
          {flow.context && <>
            <p className="inventory-metadata-hint">Revisión del lote {flow.context.source.batchVersion} · Interpretación de origen {flow.context.source.sourceContext.revision}. Se muestra la interpretación vigente, distinta del snapshot original del lote.</p>
            {Boolean(flow.context.source.sourceContext.corrections.length) && <details className="inventory-metadata-section"><summary>Correcciones de origen vigentes</summary><SourceCorrections corrections={flow.context.source.sourceContext.corrections} /></details>}
            <form noValidate onSubmit={(event) => event.preventDefault()}>
              <PilotOperationEditor context={flow.context} busy={locked} queued={flow.operations.map((operation) => operation.candidateId)} edited={flow.invalidate} refreshContext={() => void flow.refresh()} add={(operation) => flow.updateOperations([...flow.operations, operation])} />
            </form>
          </>}
          <DataTable rows={flow.operations} getRowKey={(operation) => operation.candidateId} caption="Operaciones seleccionadas para el piloto" columns={[
            { key: 'identity', header: 'Equipo', mobileRole: 'identity', render: (operation) => operation.values.serialNumber || operation.values.assetTag || operation.assetId || operation.candidateId },
            { key: 'type', header: 'Operación', render: (operation) => operation.type === 'CREATE_ASSET' ? 'Crear disponible' : 'Actualizar metadatos' },
            { key: 'note', header: 'Motivo', mobileRole: 'full', render: (operation) => operation.note },
            { key: 'remove', header: 'Acciones', mobileRole: 'actions', render: (operation) => <Button size="sm" variant="secondary" disabled={locked} onClick={() => flow.updateOperations(flow.operations.filter((entry) => entry.candidateId !== operation.candidateId))}>Quitar del piloto</Button> }
          ]} />
          <p role="status">{flow.operations.length} de 25 operaciones seleccionadas</p>
        </>}
        {flow.evaluated && <>
          <PilotPlanDetails plan={flow.evaluated.plan} showWarnings={confirming} />
        </>}
        {!confirming && <PilotWarnings planned={flow.warningOperations.filter((operation) => flow.operations.some((entry) => entry.candidateId === operation.candidateId))} operations={flow.operations} disabled={locked} update={flow.updateOperations} />}
      </>}
    </div>
  </Dialog>;
}
