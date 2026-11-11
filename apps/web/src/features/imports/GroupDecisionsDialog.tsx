import { useCallback, useEffect, useRef, useState } from 'react';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, Field, LoadingState, Pagination, Select, useRequestError } from '../../ui';
import { readGroupDecision, readGroupDecisions } from './identity-group-decision-api';
import { groupDecisionLabels, validateGroupDecisionPageContinuation, type GroupDecisionPage } from './identity-group-decision-model';
import type { IdentityGroupReview } from './identity-group-review-model';
import { GroupDecisionDetails } from './GroupDecisionDetails';
import { useHistoryRead } from './useHistoryRead';

export function GroupDecisionsDialog({ review, open, close, exited, back }: {
  review: IdentityGroupReview; open: boolean; close: () => void; exited: () => void; back: () => void;
}) {
  const [filter, setFilter] = useState<{ mode: 'latest' | 'history'; groupKey: string; offset: number }>({ mode: 'latest', groupKey: '', offset: 0 });
  const [target, setTarget] = useState<string | null>(null);
  const groups = useRef(new Map<string, string>()); const previous = useRef<GroupDecisionPage | null>(null);
  const content = useRef<globalThis.HTMLDivElement>(null); const scroll = useRef(0); const returnRow = useRef<string | null>(null);
  const report = useRequestError();
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    try {
      const page = await readGroupDecisions(review, filter.mode, filter.groupKey, filter.offset, signal);
      validateGroupDecisionPageContinuation(previous.current, page);
      if (!signal.aborted) { previous.current = page; for (const row of page.items) groups.current.set(row.groupKey, row.groupId); }
      return page;
    } catch (caught) { if (!signal.aborted) report(caught, 'No se pudieron consultar las decisiones'); throw caught; }
  }, [review, filter, report]);
  const query = useHistoryRead(read, 'No se pudieron consultar las decisiones.');
  useEffect(() => {
    if (target || !query.error) return;
    const frame = globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLElement>('[data-decisions-error]')?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [query.error, target]);
  function change(patch: Partial<typeof filter>) {
    if (query.reading) return;
    returnRow.current = null; scroll.current = 0; previous.current = null;
    setFilter((current) => ({ ...current, ...patch, offset: 0 }));
  }
  function restart() {
    if (query.reading) return;
    returnRow.current = null; scroll.current = 0; previous.current = null;
    if (filter.offset) setFilter((current) => ({ ...current, offset: 0 })); else void query.refresh();
  }
  if (target) return <GroupDecisionReceiptDialog key={target} review={review} id={target} open={open} close={close} exited={exited} back={() => setTarget(null)} />;
  const data = query.data;
  const matching = data?.mode === filter.mode && data.groupKey === filter.groupKey;
  const labels = new Map(review.plan.request.groups.map((row, index) => [row.groupId, 'Grupo ' + (index + 1)]));
  return <Dialog className="catalog-editor-dialog import-review-dialog" title="Decisiones de agrupación" description="Intenciones administrativas y sus comprobantes. No aplican inventario." open={open} onClose={close} onExited={exited} initialFocus={() => {
    const body = content.current?.closest('.ui-dialog-body'); if (body) body.scrollTop = scroll.current;
    return returnRow.current ? content.current?.querySelector<globalThis.HTMLButtonElement>(`[data-group-decision="${returnRow.current}"]`) ?? null : null;
  }} actions={<><Button variant="secondary" onClick={back}>Volver al comprobante</Button><Button variant="secondary" onClick={close}>Cerrar</Button></>}>
    <div ref={content} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Consulta" disabled={query.reading}><Select value={filter.mode} onChange={(mode) => change({ mode: mode as typeof filter.mode })} options={[{ value: 'latest', label: 'Últimas por grupo' }, { value: 'history', label: 'Historial completo' }]} /></Field>
        <Field label="Grupo con decisiones" disabled={query.reading}><Select searchable={groups.current.size > 8} value={filter.groupKey} onChange={(groupKey) => change({ groupKey })} options={[{ value: '', label: 'Todos los grupos' }, ...[...groups.current].map(([value, id]) => ({ value, label: labels.get(id) ?? 'Grupo de la revisión' }))]} /></Field>
      </div>
      <Button variant="secondary" size="sm" loading={query.reading} onClick={restart}>Actualizar decisiones desde el inicio</Button>
      {query.error && <div data-decisions-error tabIndex={-1}><Alert variant="danger">{query.error}{data && ' La página conservada no confirma vigencia.'}</Alert></div>}
      {query.reading && data && <LoadingState label="Consultando decisiones…" />}
      {data && matching && <div className="import-review-summary"><Badge variant="info">Versión global: {data.decisionVersion}</Badge><Badge variant={data.reviewActive ? 'warning' : 'neutral'}>{data.reviewActive ? 'Reserva activa' : 'Reserva cancelada · solo consulta'}</Badge></div>}
      <DataTable className="catalog-data-table" rows={matching ? data.items : []} getRowKey={(row) => row.id} caption={filter.mode === 'latest' ? 'Última intención registrada por grupo' : 'Historial de decisiones, de más reciente a más antigua'} loading={query.reading && !matching} empty={query.error ? <></> : <EmptyState title="Sin decisiones registradas" description="Consultar o simular grupos no registra una decisión." />} columns={[
        { key: 'group', header: 'Grupo', mobileRole: 'identity', render: (row) => <div className="min-w-0 w-full"><strong>{labels.get(row.groupId)}</strong><small className="block">v{row.version} · {formatInventoryDateTime(row.createdAt)}</small></div> },
        { key: 'action', header: 'Decisión', mobileRole: 'full', render: (row) => <Badge variant={row.action === 'HOLD' ? 'warning' : row.action === 'EXCLUDE' ? 'neutral' : 'info'}>{groupDecisionLabels[row.action]}</Badge> },
        { key: 'reason', header: 'Motivo', mobileRole: 'full', render: (row) => <span className="break-words whitespace-pre-wrap">{row.note}</span> },
        { key: 'context', header: 'Proyección consultada', mobileRole: 'full', render: (row) => <Badge variant={row.projectionCurrent ? 'info' : 'neutral'}>{row.projectionCurrent ? 'Coincide con la actual' : 'Anterior o reserva cancelada'}</Badge> },
        { key: 'actions', header: 'Acciones', mobileRole: 'actions', render: (row) => <Button variant="secondary" size="sm" data-group-decision={row.id} onClick={() => { returnRow.current = row.id; scroll.current = content.current?.closest('.ui-dialog-body')?.scrollTop ?? 0; setTarget(row.id); }}>Ver decisión</Button> }
      ]} />
      {data && matching && data.total > 0 && <><p className="inventory-metadata-hint">{data.offset + 1}–{data.offset + data.items.length} de {data.total} decisiones · hora de Chile</p><Pagination page={Math.floor(data.offset / 25) + 1} pageCount={Math.max(1, Math.ceil(data.total / 25))} loading={query.reading || Boolean(query.error)} onPageChange={(page) => { returnRow.current = null; scroll.current = 0; setFilter((current) => ({ ...current, offset: (page - 1) * 25 })); }} /></>}
      <p className="inventory-metadata-hint">Una proyección coincidente no indica que la decisión histórica sea la última del grupo. «Últimas por grupo» muestra esa intención. Cada guardado incrementa la versión de toda la revisión.</p>
    </div>
  </Dialog>;
}

function GroupDecisionReceiptDialog({ review, id, open, close, exited, back }: {
  review: IdentityGroupReview; id: string; open: boolean; close: () => void; exited: () => void; back: () => void;
}) {
  const report = useRequestError(); const content = useRef<globalThis.HTMLDivElement>(null);
  const read = useCallback(async (signal: globalThis.AbortSignal) => {
    try { return await readGroupDecision(review, id, signal); }
    catch (caught) { if (!signal.aborted) report(caught, 'No se pudo consultar la decisión'); throw caught; }
  }, [review, id, report]);
  const query = useHistoryRead(read, 'No se pudo consultar la decisión.');
  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLElement>(query.error ? '[data-decision-detail-error]' : '[data-group-decision-receipt]')?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [query.error, query.data]);
  return <Dialog className="catalog-editor-dialog import-review-dialog" title="Detalle de decisión" description="Comprobante guardado y proyección utilizada al decidir." open={open} onClose={close} onExited={exited} actions={<><Button variant="secondary" onClick={back}>Volver a decisiones</Button><Button variant="secondary" onClick={close}>Cerrar</Button></>}>
    <div ref={content} className="space-y-4">
      <Button variant="secondary" size="sm" loading={query.reading} onClick={() => void query.refresh()}>Consultar vigencia</Button>
      {query.error && <div data-decision-detail-error tabIndex={-1}><Alert variant="danger">{query.error}{query.data && ' Se conserva el comprobante anterior sin confirmar vigencia.'}</Alert></div>}
      {query.reading && <LoadingState label="Consultando comprobante de decisión…" />}
      {query.data && <GroupDecisionDetails key={query.data.decision.id} decision={query.data.decision} current={query.error || query.reading ? undefined : query.data} />}
    </div>
  </Dialog>;
}
