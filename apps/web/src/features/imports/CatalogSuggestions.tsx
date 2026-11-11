import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, getApiErrorMessage } from '../../lib/api';
import { Alert, Button, DataTable, LoadingState } from '../../ui';
import { readCatalogSuggestion, type CatalogSuggestion } from './catalog-review-api';
import type { PilotContext } from './pilot-model';

export function CatalogSuggestions({ context, candidateId, selected, disabled, choose, refreshContext }: {
  context: PilotContext; candidateId: string; selected: string; disabled: boolean; choose: (productId: string) => void; refreshContext: () => void;
}) {
  const [result, setResult] = useState<CatalogSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const controller = useRef<globalThis.AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function consult() {
    if (disabled || controller.current || stale) return;
    const current = new globalThis.AbortController(); controller.current = current;
    setLoading(true); setError(null);
    const candidates = context.source.preview.candidates;
    const candidate = candidates.find((entry) => entry.id === candidateId);
    const recordIds = new Set(candidate?.recordIds);
    const source = context.source.preview.records.filter((row) => recordIds.has(row.id)).map((row) => ({ recordId: row.id, sheet: row.sheet, row: row.row }));
    try {
      const response = await readCatalogSuggestion(context.source.batchId, {
        candidateId, revision: context.source.sourceContext.revision, offset: candidates.findIndex((entry) => entry.id === candidateId), total: candidates.length, source
      }, current.signal);
      if (!current.signal.aborted) setResult(response);
    } catch (caughtError) {
      if (!current.signal.aborted) {
        setError(caughtError instanceof Error && caughtError.name === 'TimeoutError' ? 'La consulta tardó demasiado. Reintenta las sugerencias.' : getApiErrorMessage(caughtError, 'No se pudieron consultar las sugerencias.'));
        setStale(caughtError instanceof ApiRequestError && caughtError.code === 'SOURCE_REVISION_CONFLICT');
      }
    } finally { if (!current.signal.aborted) { controller.current = null; setLoading(false); } }
  }
  const usable = !disabled && !loading && !error;
  const available = new Set(context.products.filter((product) => product.isActive && product.trackingMode === 'ASSET').map((product) => product.id));
  return <section className="inventory-metadata-section space-y-3" aria-label="Sugerencias de catálogo">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">Sugerencias de catálogo</h3>
      <Button size="sm" variant="secondary" loading={loading} disabled={disabled || stale} onClick={() => void consult()}>{result ? 'Actualizar sugerencias' : error ? 'Reintentar sugerencias' : 'Consultar sugerencias'}</Button>
    </div>
    <p className="inventory-metadata-hint">Coincidencias de tipo, marca y modelo interpretados. Debes elegir el producto; una sugerencia no confirma identidad ni autoriza la aplicación.</p>
    {loading && <LoadingState label="Consultando sugerencias del equipo…" />}
    {error && <Alert variant={stale ? 'warning' : 'danger'} action={stale ? <Button size="sm" variant="secondary" disabled={disabled} onClick={refreshContext}>Actualizar contexto del piloto</Button> : undefined}>{error} Tu borrador se conserva.</Alert>}
    {result && <>
      <dl className="grid gap-2 sm:grid-cols-3">{(['equipmentType', 'brand', 'model'] as const).map((field) => <div key={field} className="min-w-0"><dt className="inventory-metadata-hint">{field === 'equipmentType' ? 'Tipo interpretado' : field === 'brand' ? 'Marca interpretada' : 'Modelo interpretado'}</dt><dd className="break-words">{result.attributes[field].join(' / ') || 'Sin dato'}</dd></div>)}</dl>
      <CatalogSuggestionResults result={result} selected={selected} usable={usable} available={available} choose={choose} />
      {result.matchCount > 0 && <>
        <p role="status">{result.suggestedProducts.length} de {result.matchCount} coincidencias · revisión del origen {context.source.sourceContext.revision}{loading || error ? ' · pendientes de actualizar' : ''}</p>
        {result.hasMoreSuggestions && <p className="inventory-metadata-hint">Hay más de diez coincidencias. Usa el selector Producto para buscar entre todos los productos activos; esta lista no es el catálogo completo.</p>}
        {result.suggestedProducts.some((product) => !available.has(product.id)) && <Alert variant="warning" action={<Button size="sm" variant="secondary" disabled={disabled} onClick={refreshContext}>Actualizar contexto del piloto</Button>}>El catálogo cambió desde la preparación. Actualiza el contexto para elegir productos nuevos; el plan volverá a validar disponibilidad y atributos.</Alert>}
      </>}
    </>}
  </section>;
}

function CatalogSuggestionResults({ result, selected, usable, available, choose }: {
  result: CatalogSuggestion; selected: string; usable: boolean; available: ReadonlySet<string>; choose: (productId: string) => void;
}) {
  if (result.conflict) return <Alert variant="warning">Hay atributos contradictorios entre observaciones. Revisa las correcciones de origen; no hay sugerencias automáticas.</Alert>;
  if (!result.hasEvidence) return <Alert variant="info">No hay tipo, marca ni modelo utilizable. Verifica el equipo y selecciona el producto manualmente.</Alert>;
  if (!result.matchCount) return <Alert variant="info">No hay coincidencias exactas. Verifica el catálogo y usa el selector Producto; no se creará un producto automáticamente.</Alert>;
  return <DataTable caption="Productos sugeridos para este equipo" rows={result.suggestedProducts} getRowKey={(product) => product.id} columns={[
    { key: 'name', header: 'Producto', mobileRole: 'identity', render: (product) => <><strong className="break-words">{product.name}</strong><p className="inventory-metadata-hint break-words">SKU: {product.sku || 'Sin SKU'}</p></> },
    { key: 'attributes', header: 'Tipo · marca · modelo', mobileRole: 'full', render: (product) => <span className="break-words">{[product.equipmentType, product.brand, product.model].filter(Boolean).join(' · ') || 'Sin atributos'}</span> },
    { key: 'choose', header: 'Elección', mobileRole: 'actions', render: (product) => <Button size="sm" variant="secondary" aria-pressed={selected === product.id} aria-label={`Elegir ${product.name}`} disabled={!usable || !available.has(product.id)} onClick={() => { if (usable && available.has(product.id)) choose(product.id); }}>{selected === product.id ? 'Seleccionado' : 'Elegir producto'}</Button> }
  ]} />;
}
