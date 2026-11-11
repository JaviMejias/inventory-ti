import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { environment } from '../../config/environment';
import { getApiErrorMessage } from '../../lib/api';
import { formatInventoryDateTime } from '../../lib/date-range';
import { canReviewImports } from '../../lib/permissions';
import { Alert, Badge, Button, DataTable, EmptyState, ListFooter, LoadingState, ModuleFilters, ModuleHeader, PageContainer } from '../../ui';
import { useAuth } from '../auth/auth-context';
import { importReviewPath, readBatch, readFreshness, readSnapshot } from './import-review-api';
import type { BatchDetail, Freshness, ImportBatch, ImportPreview, ReviewTarget } from './import-review-model';
import { ReviewDecisionDialog } from './ReviewDecisionDialog';
import { useReviewPage } from './useReviewPage';
import { ImportPreviewTables } from './ImportPreviewTables';
import { PilotPanel } from './PilotPanel';
import { SourceReviewPanel } from './SourceReviewPanel';
import { HistoryEvidencePanel } from './HistoryEvidencePanel';
import { IdentityGroupPanel } from './IdentityGroupPanel';
import { WorkbookIntakeDialog } from './WorkbookIntakeDialog';

export function ImportReviewPage() {
  const { user } = useAuth();
  if (!user || !canReviewImports(user.role)) return <PageContainer fluid><EmptyState title="Acceso restringido" description="La revisión de importaciones está disponible solo para Jefe." action={<Link className="ui-button ui-button-secondary ui-button-md" to="/inventory">Volver a Inventario</Link>} /></PageContainer>;
  if (!environment.inventoryImportReviewV4) return <PageContainer fluid><EmptyState title="Revisión de importaciones desactivada" description="Activa esta vista únicamente después de desplegar la API y las migraciones de revisión." action={<Link className="ui-button ui-button-secondary ui-button-md" to="/inventory">Volver a Inventario</Link>} /></PageContainer>;
  return <ImportReviewWorkspace actorId={user.id} />;
}

function ImportReviewWorkspace({ actorId }: { actorId: string }) {
  const [params, setParams] = useSearchParams();
  const [intake, setIntake] = useState(false); const [intakeMounted, setIntakeMounted] = useState(false);
  const batchId = params.get('batch') ?? '';
  const list = useReviewPage<ImportBatch>(importReviewPath, 'batches');
  const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(batchId);
  function openBatch(id: string) { setParams({ batch: id }); }
  return <PageContainer fluid className="catalog-page import-review-page">
    <div className="catalog-surface">
      <ModuleHeader className="catalog-module-header" title="Revisión de importaciones" description="Consulta el origen y revisa propuestas antes de modificar el inventario." action={<div className="flex flex-wrap gap-3">{!batchId && <Button onClick={() => { setIntakeMounted(true); setIntake(true); }}>Nuevo lote</Button>}<Link className="ui-button ui-button-secondary ui-button-md" to="/inventory">Volver a Inventario</Link></div>} />
      {batchId ? validId ? <BatchWorkspace key={batchId} id={batchId} back={() => setParams({})} /> : <Alert variant="danger" action={<Button variant="secondary" onClick={() => setParams({})}>Ver lotes</Button>}>La dirección del lote no es válida.</Alert> : <>
        <ModuleFilters className="catalog-toolbar" ariaLabel="Lotes de revisión" actions={<Button variant="secondary" size="sm" loading={list.loading} onClick={() => void list.reload()}>Actualizar lotes</Button>}><p className="inventory-metadata-hint">Los lotes conservan el origen y sus decisiones. Guardarlos no aplica cambios al inventario.</p></ModuleFilters>
        {list.error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void list.retry()}>Reintentar</Button>}>{list.error}</Alert>}
        <DataTable className="catalog-data-table" rows={list.page.items} getRowKey={(batch) => batch.id} caption="Lotes de revisión" loading={list.loading && !list.page.items.length} empty={list.error ? <></> : <EmptyState title="Todavía no hay lotes de revisión" description="Selecciona Nuevo lote para previsualizar el JSON del extractor y guardar su origen para revisión." />} columns={[
          { key: 'file', header: 'Archivo de origen', mobileRole: 'identity', render: (batch) => <strong className="break-words">{batch.sourceFileName}</strong> },
          { key: 'targets', header: 'Registros agrupados', render: (batch) => batch.targetCount },
          { key: 'version', header: 'Versión', render: (batch) => <Badge variant="neutral">v{batch.version}</Badge> },
          { key: 'created', header: 'Guardado', mobileRole: 'full', render: (batch) => formatInventoryDateTime(batch.createdAt) },
          { key: 'actions', header: 'Acciones', mobileRole: 'actions', render: (batch) => <Button variant="secondary" size="sm" onClick={() => openBatch(batch.id)}>Revisar lote</Button> }
        ]} />
        {!list.error && <ListFooter loaded={list.page.items.length} total={list.page.total} hasMore={list.page.hasMore} loading={list.loading} onLoadMore={list.more} />}
      </>}
      {intakeMounted && <WorkbookIntakeDialog key={actorId} open={intake} close={() => setIntake(false)} exited={() => setIntakeMounted(false)} reviewBatch={openBatch} changed={() => void list.reload()} />}
    </div>
  </PageContainer>;
}

function BatchWorkspace({ id, back }: { id: string; back: () => void }) {
  const [data, setData] = useState<{ detail: BatchDetail; snapshot: ImportPreview; freshness: Freshness } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<ReviewTarget | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const controller = useRef<globalThis.AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new globalThis.AbortController();
    controller.current = current;
    setLoading(true);
    setError(null);
    try {
      const [detail, snapshot, freshness] = await Promise.all([readBatch(id, current.signal), readSnapshot(id, current.signal), readFreshness(id, current.signal)]);
      if (snapshot.previewId !== detail.batch.previewId) throw new Error('Mismatched snapshot');
      if (!current.signal.aborted) setData({ detail, snapshot, freshness });
    } catch (caughtError) {
      if (!current.signal.aborted) setError(getApiErrorMessage(caughtError, 'No se pudo confirmar la información del lote.'));
    } finally { if (!current.signal.aborted) setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load]);
  return <>
    <ModuleFilters className="catalog-toolbar" ariaLabel="Controles del lote" actions={<Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>Actualizar lote</Button>}><Button variant="ghost" size="sm" onClick={back}>← Todos los lotes</Button>{data && <span className="break-words font-semibold">{data.detail.batch.sourceFileName}</span>}</ModuleFilters>
    {error && <Alert variant="danger" action={<Button variant="secondary" size="sm" onClick={() => void load()}>Reintentar</Button>}>{error}</Alert>}
    {loading && <LoadingState label="Comprobando lote y vigencia…" />}
    {data && <>
      <div className="import-review-summary" aria-label="Resumen de revisión">
        <Badge variant="neutral">Versión {data.detail.batch.version}</Badge>
        <Badge variant="info">{data.detail.reviewSummary.reviewedTargetCount} con decisión</Badge>
        <Badge variant="warning">{data.detail.reviewSummary.pendingTargetCount} pendientes</Badge>
        <Badge variant="neutral">{data.detail.reviewSummary.excludedCount} excluidos de propuesta</Badge>
        <Badge variant="danger">{data.snapshot.summary.blockingIssueCount} {data.snapshot.summary.blockingIssueCount === 1 ? 'incidencia bloqueante' : 'incidencias bloqueantes'}</Badge>
      </div>
      <div className="import-review-notices space-y-3">
        <Alert variant={data.freshness.stale ? 'warning' : 'info'}>{data.freshness.stale ? 'El inventario o las reglas cambiaron. El origen se conserva, pero no permite vincular ni proponer equipos hasta generar un lote vigente.' : `Vigencia comprobada para el día ${data.freshness.checkedAsOf} (Chile). Los conteos son del análisis, no stock confirmado.`}{data.freshness.reviewDateChanged && ' Cambió el día respecto de la previsualización original.'}</Alert>
        {data.detail.reviewSummary.decisionCoverageComplete && <Alert variant="info">Todos los registros tienen una decisión, pero esto no significa que los conflictos estén resueltos ni que el lote esté aprobado para aplicar.</Alert>}
      </div>
      <ImportPreviewTables snapshot={data.snapshot} canReview={!loading && !error} onReview={(item) => { setTarget(item); setDialogOpen(true); }} />
      {(environment.inventoryImportIdentityGroupsV16 || environment.inventoryImportIdentityGroupReviewsV17) && <IdentityGroupPanel batchId={id} original={data.snapshot} disabled={loading || Boolean(error)} />}
      {(environment.inventoryImportSourceV7 || environment.inventoryImportIdentityV8) && <SourceReviewPanel batchId={id} original={data.snapshot} changed={() => void load()} />}
      {environment.inventoryImportHistoryV9 && <HistoryEvidencePanel batchId={id} />}
      {environment.inventoryImportPlanV5 && <PilotPanel batchId={id} fileName={data.detail.batch.sourceFileName} changed={() => void load()} />}
    </>}
    {target && <ReviewDecisionDialog key={`${id}:${target.type}:${target.id}`} batchId={id} target={target} open={dialogOpen} close={() => setDialogOpen(false)} exited={() => setTarget(null)} changed={() => void load()} />}
  </>;
}

