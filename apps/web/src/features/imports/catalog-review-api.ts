import { ApiRequestError, apiRequest } from '../../lib/api';
import { importReviewPath } from './import-review-api';

export type CatalogProductSuggestion = {
  id: string; name: string; sku: string | null; equipmentType: string | null; brand: string | null; model: string | null; updatedAt: string;
};
export type CatalogSuggestion = {
  candidateId: string; attributes: Record<'equipmentType' | 'brand' | 'model', string[]>;
  conflict: boolean; hasEvidence: boolean; suggestedProducts: CatalogProductSuggestion[];
  matchCount: number; hasMoreSuggestions: boolean; requiresExplicitChoice: true;
  source: { recordId: string; sheet: string; row: number }[];
};
type CatalogTarget = { candidateId: string; revision: number; offset: number; total: number; source: CatalogSuggestion['source'] };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function text(value: unknown): boolean { return typeof value === 'string' && value.trim().length > 0; }
function invalid(): never { throw new ApiRequestError('Unexpected catalog review response', 200, 'INVALID_RESPONSE'); }
function product(value: unknown): value is CatalogProductSuggestion {
  return object(value) && text(value.id) && text(value.name) && ['sku', 'equipmentType', 'brand', 'model'].every((key) => value[key] === null || typeof value[key] === 'string') &&
    typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt));
}
function suggestion(value: unknown): value is CatalogSuggestion {
  if (!object(value) || !text(value.candidateId) || value.requiresExplicitChoice !== true || !object(value.attributes) || Object.keys(value.attributes).length !== 3 ||
    !['equipmentType', 'brand', 'model'].every((key) => object(value.attributes) && Array.isArray(value.attributes[key]) && value.attributes[key].every(text) && new Set(value.attributes[key]).size === value.attributes[key].length) ||
    !integer(value.matchCount) || Number(value.matchCount) > 5000 || !Array.isArray(value.suggestedProducts) || !value.suggestedProducts.every(product) ||
    value.suggestedProducts.length !== Math.min(10, Number(value.matchCount)) || new Set(value.suggestedProducts.map((entry) => entry.id)).size !== value.suggestedProducts.length ||
    value.hasMoreSuggestions !== (Number(value.matchCount) > 10) || !Array.isArray(value.source) || !value.source.length ||
    !value.source.every((row) => object(row) && text(row.recordId) && text(row.sheet) && integer(row.row) && Number(row.row) > 0) ||
    new Set(value.source.map((row) => row.recordId)).size !== value.source.length) return false;
  const attributes = value.attributes as CatalogSuggestion['attributes'];
  return value.conflict === Object.values(attributes).some((entries) => entries.length > 1) &&
    value.hasEvidence === Object.values(attributes).some((entries) => entries.length > 0) &&
    (!(value.conflict || !value.hasEvidence) || value.matchCount === 0);
}
export async function readCatalogSuggestion(batchId: string, target: CatalogTarget, signal: globalThis.AbortSignal): Promise<CatalogSuggestion> {
  // Both backend previews keep the same source grouping/order; still verify identity and provenance, not just the ordinal.
  const value = await apiRequest<unknown>(`${importReviewPath}/${batchId}/catalog-review?limit=1&offset=${target.offset}`, {
    signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)])
  });
  if (!object(value) || value.batchId !== batchId || value.canApply !== false || !integer(value.sourceRevision)) invalid();
  if (value.sourceRevision !== target.revision) throw new ApiRequestError('Source revision changed', 409, 'SOURCE_REVISION_CONFLICT');
  if (value.limit !== 1 || value.offset !== target.offset || value.total !== target.total || !Array.isArray(value.candidates) || value.candidates.length !== 1 ||
    value.hasMore !== (target.offset + 1 < target.total) || !suggestion(value.candidates[0])) invalid();
  const result = value.candidates[0];
  if (result.candidateId !== target.candidateId || result.source.length !== target.source.length || result.source.some((row) =>
    !target.source.some((entry) => entry.recordId === row.recordId && entry.sheet === row.sheet && entry.row === row.row))) invalid();
  return result;
}
