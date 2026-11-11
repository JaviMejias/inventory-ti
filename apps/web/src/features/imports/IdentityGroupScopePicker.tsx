import { useMemo, useRef, useState } from 'react';
import { Badge, Button, DataTable, EmptyState, Field, Icon, ModuleFilters, Pagination } from '../../ui';
import type { Candidate, ImportPreview } from './import-review-model';
import { identityGroupScope, physicalGroupCandidates } from './identity-group-model';

export function IdentityGroupScopePicker({ original, selected, disabled, toggle }: { original: ImportPreview; selected: string[]; disabled: boolean; toggle: (candidate: Candidate) => void }) {
  const [query, setQuery] = useState(''); const [page, setPage] = useState(1);
  const input = useRef<globalThis.HTMLInputElement>(null);
  const candidates = useMemo(() => physicalGroupCandidates(original), [original]);
  const normalized = query.trim().toLocaleLowerCase('es-CL');
  const rows = candidates.filter((candidate) => [...candidate.serials, ...candidate.tags, candidate.id].join(' ').toLocaleLowerCase('es-CL').includes(normalized));
  const chosen = new Set(selected); const scope = identityGroupScope(original, selected);
  function clear() { setQuery(''); setPage(1); input.current?.focus(); }
  return <section className="space-y-4" aria-label="Seleccionar candidatos originales">
    <ModuleFilters className="catalog-toolbar" ariaLabel="Buscar candidatos para agrupar"><Field label="Buscar candidatos"><input ref={input} type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Serie, activo fijo o identificador original" /></Field>{query && <Button variant="ghost" size="sm" onClick={clear} aria-label="Limpiar búsqueda de candidatos"><Icon size="sm"><path d="m6 6 12 12M6 18 18 6" /></Icon>Limpiar</Button>}</ModuleFilters>
    <div className="import-review-summary"><Badge variant="neutral">{selected.length} candidatos seleccionados</Badge><Badge variant={scope.records.length > 25 ? 'danger' : 'info'}>{scope.records.length} de 25 filas máximas</Badge></div>
    <p className="inventory-metadata-hint">Se incluyen todas las filas de cada candidato seleccionado. La selección conserva sus identificadores originales.</p>
    <DataTable className="catalog-data-table" rows={rows.slice((page - 1) * 25, page * 25)} getRowKey={(candidate) => candidate.id} caption="Candidatos físicos originales del lote" empty={<EmptyState title={query ? 'Sin candidatos coincidentes' : 'Sin candidatos físicos'} description={query ? 'Prueba con otra serie o activo fijo.' : 'Este lote no contiene candidatos físicos compatibles con una agrupación.'} action={query ? <Button variant="secondary" size="sm" onClick={clear}>Limpiar búsqueda</Button> : undefined} />} columns={[
      { key: 'identity', header: 'Candidato original', mobileRole: 'identity', render: (candidate) => <strong className="min-w-0 w-full break-words">{candidate.serials.join(' / ') || candidate.tags.join(' / ') || 'Equipo sin identidad confirmada'}</strong> },
      { key: 'records', header: 'Alcance completo', mobileRole: 'full', render: (candidate) => <><Badge variant={candidate.recordIds.length > 25 ? 'danger' : 'neutral'}>{candidate.recordIds.length} filas</Badge>{candidate.recordIds.length > 25 && <small className="block">Supera el límite de esta simulación; no se recortan sus filas.</small>}</> },
      { key: 'select', header: 'Selección', mobileRole: 'actions', render: (candidate) => <Button size="sm" variant={chosen.has(candidate.id) ? 'primary' : 'secondary'} aria-pressed={chosen.has(candidate.id)} disabled={disabled || !chosen.has(candidate.id) && (scope.records.length + candidate.recordIds.length > 25 || selected.length >= 25)} onClick={() => toggle(candidate)}>{chosen.has(candidate.id) ? 'Quitar del alcance' : 'Añadir al alcance'}</Button> }
    ]} />
    {rows.length > 25 && <Pagination page={page} pageCount={Math.ceil(rows.length / 25)} onPageChange={setPage} />}
  </section>;
}
