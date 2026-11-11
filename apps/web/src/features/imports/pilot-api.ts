import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { fetchAllPages } from '../../lib/pagination';
import { applicationMetadata, importReviewPath, readReviewPage } from './import-review-api';
import { readResolvedReviewSource } from './source-review-api';
import type { ReviewDecision } from './import-review-model';
import type { ApplicationReceipt, ApplyIntent, PilotCatalogProduct, PilotContext, PilotPlan, PilotRequest } from './pilot-model';

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(): never { throw new ApiRequestError('Unexpected pilot response', 200, 'INVALID_RESPONSE'); }
function nullableText(value: unknown): boolean { return value === null || typeof value === 'string'; }
function corrections(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => object(entry) &&
    ['candidateId', 'recordId', 'sheet', 'field', 'reviewedById', 'note', 'evidenceReference'].every((key) => typeof entry[key] === 'string') &&
    Number.isInteger(entry.row) && Number.isInteger(entry.revision) &&
    [entry.originalCell, entry.afterCell].every((cell) => cell === null || (object(cell) && 'value' in cell)));
}
function planned(value: unknown): value is PilotPlan {
  return object(value) && value.mode === 'PILOT_PLAN' && value.scope === 'ASSET_PILOT' && value.persisted === false && value.canApply === false &&
    (value.planRulesVersion === undefined || ['mda-pilot-2', 'mda-pilot-3'].includes(String(value.planRulesVersion))) &&
    typeof value.batchId === 'string' && typeof value.planId === 'string' && /^[a-f0-9]{64}$/.test(value.planId) &&
    Number.isInteger(value.batchVersion) && Number.isInteger(value.sourceRevision) && typeof value.checkedAsOf === 'string' &&
    Number.isInteger(value.omittedTargetCount) && Number(value.omittedTargetCount) >= 0 &&
    typeof value.planValidationComplete === 'boolean' && object(value.freshness) && typeof value.freshness.stale === 'boolean' && object(value.summary) &&
    ['operationCount', 'validCount', 'blockedCount', 'createCount', 'updateCount'].every((key) => object(value.summary) && Number.isInteger(value.summary[key]) && Number(value.summary[key]) >= 0) &&
    Array.isArray(value.operations) && value.operations.length > 0 && value.operations.length <= 25 && value.operations.every((operation) =>
      object(operation) && typeof operation.candidateId === 'string' && ['CREATE_ASSET', 'UPDATE_METADATA'].includes(String(operation.type)) &&
      typeof operation.valid === 'boolean' && typeof operation.note === 'string' && object(operation.values) && Object.values(operation.values).every(nullableText) &&
      Array.isArray(operation.acknowledgedWarnings) && operation.acknowledgedWarnings.every((id) => typeof id === 'string') &&
      (operation.product === null || (object(operation.product) && typeof operation.product.id === 'string' && typeof operation.product.name === 'string')) &&
      (operation.before === null || object(operation.before)) && nullableText(operation.resultingStatus) &&
      Array.isArray(operation.changes) && operation.changes.every((change) => object(change) && typeof change.field === 'string') &&
      Array.isArray(operation.source) && operation.source.every((row) => object(row) && typeof row.sheet === 'string' && Number.isInteger(row.row)) &&
      corrections(operation.sourceCorrections) && Array.isArray(operation.blockers) && operation.blockers.every((blocker) => object(blocker) && typeof blocker.code === 'string') &&
      Array.isArray(operation.warnings) && operation.warnings.every((warning) => object(warning) && typeof warning.id === 'string' && typeof warning.code === 'string' && nullableText(warning.sheet) && (warning.row === null || Number.isInteger(warning.row)))) &&
    new Set(value.operations.map((operation) => operation.candidateId)).size === value.operations.length && value.summary.operationCount === value.operations.length;
}
function receipt(value: unknown): value is ApplicationReceipt {
  if (!object(value) || !planned(value.plan) || !Array.isArray(value.items)) return false;
  const plan = value.plan;
  if (value.items.length !== plan.operations.length || new Set(value.items.map((item) => object(item) ? item.candidateId : null)).size !== value.items.length) return false;
  const validItems = value.items.every((item) => {
    if (!object(item) || typeof item.id !== 'string' || typeof item.candidateId !== 'string' || typeof item.assetId !== 'string' || !object(item.operation) || !object(item.result)) return false;
    const operation = item.operation;
    return operation.candidateId === item.candidateId && item.result.id === item.assetId && typeof item.result.status === 'string' &&
      plan.operations.some((entry) => entry.candidateId === item.candidateId && entry.type === operation.type);
  });
  return validItems && plan.batchId === value.batchId && plan.batchVersion === value.batchVersion && plan.planId === value.planId && plan.planValidationComplete &&
    plan.operations.every((operation) => operation.valid && !operation.blockers.length) && applicationMetadata(value);
}
async function post(path: string, body: unknown): Promise<unknown> {
  const token = await getCsrfToken();
  return apiRequest<unknown>(path, { method: 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify(body) });
}
export async function readPilotContext(id: string, signal: globalThis.AbortSignal): Promise<PilotContext> {
  const source = await readResolvedReviewSource(id, signal);
  const decisions: ReviewDecision[] = [];
  let more = true;
  while (more && !signal.aborted) {
    const page = await readReviewPage<ReviewDecision>(`${importReviewPath}/${id}/decisions?mode=latest&limit=100&offset=${decisions.length}`, 'decisions', signal);
    decisions.push(...page.rows); more = page.hasMore;
  }
  if (signal.aborted) throw signal.reason;
  const products = await fetchAllPages<PilotCatalogProduct, { products: PilotCatalogProduct[]; hasMore: boolean }>('/products?active=true', (page) => {
    if (!Array.isArray(page.products) || !page.products.every((product) => object(product) && typeof product.id === 'string' && typeof product.name === 'string' && typeof product.active === 'boolean' && ['ASSET', 'QUANTITY'].includes(product.trackingMode))) invalid();
    return page.products;
  }, { signal });
  return { source, decisions, products: products.filter((product) => product.active && product.trackingMode === 'ASSET').map(({ active, ...product }) => ({ ...product, isActive: active })) };
}
export async function generatePilotPlan(id: string, request: PilotRequest): Promise<PilotPlan> {
  const value = await post(`${importReviewPath}/${id}/plan`, request);
  if (!planned(value) || value.batchId !== id || value.batchVersion !== request.expectedVersion || value.sourceRevision !== request.expectedSourceRevision ||
    value.operations.length !== request.operations.length || new Set(value.operations.map((operation) => operation.candidateId)).size !== request.operations.length ||
    value.operations.some((operation) => !request.operations.some((entry) => entry.candidateId === operation.candidateId && entry.type === operation.type &&
      (entry.type === 'CREATE_ASSET' ? entry.values.productId === operation.values.productId : entry.assetId === operation.assetId)))) invalid();
  return value;
}
export async function applyPilot(id: string, intent: ApplyIntent): Promise<ApplicationReceipt> {
  const value = await post(`${importReviewPath}/${id}/apply`, intent);
  if (!object(value) || value.mode !== 'APPLIED' || value.persisted !== true || typeof value.reused !== 'boolean' || !receipt(value.application) ||
    value.application.batchId !== id || value.application.requestId !== intent.requestId || value.application.planId !== intent.planId ||
    value.application.batchVersion !== intent.plan.expectedVersion || value.application.plan.sourceRevision !== intent.plan.expectedSourceRevision ||
    value.application.items.length !== intent.plan.operations.length || value.application.items.some((item) => !intent.plan.operations.some((operation) => operation.candidateId === item.candidateId && operation.type === item.operation.type))) invalid();
  return value.application;
}
export async function readApplication(id: string, applicationId: string, signal: globalThis.AbortSignal): Promise<ApplicationReceipt> {
  const value = await apiRequest<unknown>(`${importReviewPath}/${id}/applications/${applicationId}`, { signal });
  return validateCurrentPilotApplication(value, id, applicationId);
}
export function validateCurrentPilotApplication(value: unknown, id: string, applicationId: string): ApplicationReceipt {
  if (!object(value) || value.mode !== 'APPLIED' || value.persisted !== true || !receipt(value.application) || value.application.id !== applicationId || value.application.batchId !== id) invalid();
  return value.application;
}
