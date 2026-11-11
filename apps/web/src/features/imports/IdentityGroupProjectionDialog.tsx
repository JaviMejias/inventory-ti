import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Dialog, LoadingState } from '../../ui';
import { IdentityGroupProjectionDetails } from './IdentityGroupProjectionDetails';
import type { useIdentityGroupProjection } from './useIdentityGroupProjection';
import { environment } from '../../config/environment';
import type { IdentityGroupReview } from './identity-group-review-model';
import type { IdentityGroupProjection } from './identity-group-projection-model';
import { GroupDecisionEditorDialog } from './GroupDecisionEditorDialog';

export function IdentityGroupProjectionDialog({ query, review, actorId, open, close, exited, back }: { query: ReturnType<typeof useIdentityGroupProjection>; review: IdentityGroupReview; actorId: string; open: boolean; close: () => void; exited: () => void; back: (refresh?: boolean) => void }) {
  const [selectedGroupKey, setSelectedGroupKey] = useState('');
  const [decision, setDecision] = useState<{ projection: IdentityGroupProjection; groupKey: string } | null>(null);
  const decisionReturn = useRef(false);
  const content = useRef<globalThis.HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLElement>(query.error ? '[data-group-projection-error]' : '[data-group-projection-result]')?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [query.data, query.error, open]);
  if (decision && environment.inventoryImportIdentityGroupDecisionsV19) return <GroupDecisionEditorDialog review={review} actorId={actorId} initial={decision.projection} groupKey={decision.groupKey} open={open} close={close} exited={exited} back={(refresh) => { decisionReturn.current = true; setDecision(null); if (refresh) void query.refresh(); }} />;
  return <Dialog className="catalog-editor-dialog import-review-dialog" title="Grupos actuales" description="Origen, evidencia e inventario. Consulta sin guardar cambios." open={open} onClose={close} onExited={exited} initialFocus={() => { if (!decisionReturn.current) return null; decisionReturn.current = false; return content.current?.querySelector<globalThis.HTMLButtonElement>('[data-open-group-decision]:not(:disabled)') ?? null; }} actions={<><Button variant="secondary" onClick={() => back()}>Volver al comprobante</Button><Button variant="secondary" onClick={close}>Cerrar</Button></>}>
    <div ref={content} className="space-y-4" aria-busy={query.reading}>
      <Button variant="secondary" loading={query.reading} onClick={() => void query.refresh()}>Actualizar consulta</Button>
      {environment.inventoryImportIdentityGroupDecisionsV19 && query.data && <Button data-open-group-decision disabled={!query.fresh || query.reading || Boolean(query.error)} onClick={() => { const projection = query.data; if (!projection || !query.fresh || query.reading) return; const group = projection.groups.find((row) => row.groupKey === selectedGroupKey) ?? projection.groups[0]; setDecision({ projection, groupKey: group.groupKey }); }}>Revisar decisión del grupo seleccionado</Button>}
      {query.error && <div data-group-projection-error tabIndex={-1}><Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => back(true)}>Consultar comprobante guardado</Button>}>{query.error}{query.data && ' Se conserva la consulta anterior sin confirmar su vigencia.'}</Alert></div>}
      {query.reading && <LoadingState label="Contrastando los grupos con su contexto actual…" />}
      {query.data && <IdentityGroupProjectionDetails key={query.data.projectionId} projection={query.data} fresh={query.fresh} selectedGroupKey={selectedGroupKey} selectGroup={setSelectedGroupKey} />}
    </div>
  </Dialog>;
}
