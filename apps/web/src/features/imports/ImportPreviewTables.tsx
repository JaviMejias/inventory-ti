import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, DataTable, Field, ListFooter, ModuleFilters, Select } from '../../ui';
import { buildReviewTargets, proposalLabels, recordKindLabels, type ImportPreview, type ReviewTarget } from './import-review-model';
import { IssueBadge, OriginalCells } from './SourceEvidence';
import { importIssueLabels } from './import-issue-labels';

export function ImportPreviewTables({ snapshot, canReview = false, onReview, local = false }: { snapshot: ImportPreview; canReview?: boolean; onReview?: (target: ReviewTarget) => void; local?: boolean }) {
  const [params, setParams] = useSearchParams();
  const [localFilter, setLocalFilter] = useState({ view: 'targets', sheet: '' });
  const requestedView = local ? localFilter.view : params.get('view');
  const view = ['targets', 'issues', 'sheets', 'excluded'].includes(requestedView ?? '') ? requestedView! : 'targets';
  const requestedSheet = local ? localFilter.sheet : params.get('sheet') ?? '';
  const sheet = snapshot.sheets.some((item) => item.name === requestedSheet) ? requestedSheet : '';
  const [visible, setVisible] = useState(25);
  const targets = useMemo(() => buildReviewTargets(snapshot), [snapshot]);
  const filteredTargets = targets.filter((target) => !sheet || target.records.some((record) => record.sheet === sheet));
  const issues = snapshot.issues.filter((issue) => !sheet || issue.sheet === sheet || issue.sheet === null).map((issue, index) => ({ ...issue, id: String(index) }));
  const sheets = snapshot.sheets.filter((item) => !sheet || item.name === sheet);
  const excluded = snapshot.excluded.filter((record) => !sheet || record.sheet === sheet).map((record) => ({ ...record, id: `${record.sheet}:${record.row}` }));
  const total = view === 'targets' ? filteredTargets.length : view === 'issues' ? issues.length : view === 'sheets' ? sheets.length : excluded.length;
  function filter(key: string, value: string) { if (local) { setLocalFilter((current) => ({ ...current, [key]: value })); setVisible(25); return; } const next = new globalThis.URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); setParams(next); setVisible(25); }
  return <section aria-label={local ? "Previsualización sin guardar" : "Previsualización guardada"}>
    <ModuleFilters className="catalog-toolbar" ariaLabel="Filtros de previsualización">
      <Field label="Contenido"><Select className="catalog-filter-select" value={view} onChange={(value) => filter('view', value)} options={[{ value: 'targets', label: 'Registros para revisión' }, { value: 'issues', label: 'Incidencias' }, { value: 'sheets', label: 'Hojas de origen' }, { value: 'excluded', label: 'Filas excluidas del análisis' }]} /></Field>
      <Field label="Hoja de origen"><Select className="catalog-filter-select" value={sheet} onChange={(value) => filter('sheet', value)} options={[{ value: '', label: 'Todas las hojas' }, ...snapshot.sheets.map((item) => ({ value: item.name, label: item.name }))]} /></Field>
    </ModuleFilters>
    {view === 'targets' && <DataTable className="catalog-data-table" rows={filteredTargets.slice(0, visible)} getRowKey={(item) => `${item.type}:${item.id}`} caption="Registros agrupados para revisión" columns={[
      { key: 'identity', header: 'Registro', mobileRole: 'identity', render: (item) => <strong className="break-words">{item.label}</strong> },
      { key: 'proposal', header: 'Análisis', mobileRole: 'full', render: (item) => proposalLabels[item.kind] ?? recordKindLabels[item.kind] ?? item.kind },
      { key: 'source', header: 'Origen', mobileRole: 'full', render: (item) => `${[...new Set(item.records.map((record) => record.sheet))].join(' · ')} (${item.records.length} ${item.records.length === 1 ? 'fila' : 'filas'})` },
      { key: 'issues', header: 'Incidencias', render: (item) => <Badge variant={item.issues.some((issue) => issue.severity === 'BLOCKING') ? 'danger' : item.issues.length ? 'warning' : 'neutral'}>{item.issues.length} {item.issues.length === 1 ? 'incidencia' : 'incidencias'}</Badge> },
      ...(onReview ? [{ key: 'action', header: 'Acciones', mobileRole: 'actions' as const, render: (item: ReviewTarget) => <Button variant="secondary" size="sm" disabled={!canReview} onClick={() => onReview(item)}>Revisar registro</Button> }] : [])
    ]} />}
    {view === 'issues' && <DataTable className="catalog-data-table" rows={issues.slice(0, visible)} getRowKey={(item) => item.id} caption="Incidencias de la previsualización" columns={[
      { key: 'code', header: 'Incidencia', mobileRole: 'identity', render: (item) => <span className="break-words">{importIssueLabels[item.code] ?? 'Incidencia pendiente de revisión'}<small className="block">{item.code}</small></span> },
      { key: 'severity', header: 'Nivel', render: (item) => <IssueBadge issue={item} /> },
      { key: 'source', header: 'Origen', mobileRole: 'full', render: (item) => `${item.sheet ?? 'Análisis general'}${item.cell ? ' · ' + item.cell : item.row !== null ? ' · fila ' + item.row : ''}` }
    ]} />}
    {view === 'sheets' && <DataTable className="catalog-data-table" rows={sheets.slice(0, visible)} getRowKey={(item) => item.name} caption="Hojas de origen" columns={[
      { key: 'name', header: 'Hoja', mobileRole: 'identity', render: (item) => item.name },
      { key: 'kind', header: 'Interpretación', mobileRole: 'full', render: (item) => recordKindLabels[item.kind] ?? item.kind },
      { key: 'header', header: 'Encabezado', render: (item) => <Badge variant={item.headerValid ? 'info' : 'danger'}>{item.headerValid ? 'Reconocido' : 'Requiere revisión'}</Badge> },
      { key: 'records', header: 'Filas', render: (item) => `${item.recordCount} registros · ${item.excludedCount} excluidas` },
      { key: 'hidden', header: 'Visibilidad', render: (item) => item.hidden ? 'Oculta en Excel (incluida)' : 'Visible en Excel' }
    ]} />}
    {view === 'excluded' && <DataTable className="catalog-data-table" rows={excluded.slice(0, visible)} getRowKey={(item) => item.id} caption="Filas excluidas del análisis" columns={[
      { key: 'source', header: 'Origen', mobileRole: 'identity', render: (item) => `${item.sheet} · fila ${item.row}` },
      { key: 'reason', header: 'Motivo', render: (item) => ({ HEADER_OR_TITLE: 'Encabezado o título', REPEATED_HEADER: 'Encabezado repetido', EMPTY: 'Fila vacía' })[item.reason] ?? item.reason },
      { key: 'cells', header: 'Evidencia', mobileRole: 'full', render: (item) => <details className="inventory-metadata-section"><summary>Ver celdas originales</summary><OriginalCells row={item.row} cells={item.originalCells} /></details> }
    ]} />}
    <ListFooter loaded={Math.min(visible, total)} total={total} hasMore={visible < total} onLoadMore={() => setVisible((count) => count + 25)} />
  </section>;
}
