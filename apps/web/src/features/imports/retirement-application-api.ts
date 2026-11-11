import { ApiRequestError, apiRequest, getApiErrorMessage, getCsrfToken } from '../../lib/api';
import { validHistoricalInstant } from './closed-assignment-model';
import { sameSnapshot } from './history-evidence-api';
import { validateRetirementApplicationIntent, type RetirementApplication, type RetirementApplicationIntent, type RetirementApplicationMetadata, type RetirementApplicationPage } from './retirement-application-model';
import { validateRetirementPlan } from './retirement-plan-api';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown, max = 2147483647) { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max; }
function instant(value: unknown): value is string { return typeof value === 'string' && validHistoricalInstant(value); }
function invalid(): never { throw new ApiRequestError('No se pudo validar el comprobante de baja. Recupera la misma intención y clave.', 200, 'INVALID_RESPONSE'); }
function scope(value: unknown): value is Value { return object(value) && value.scope === 'VERIFIED_HISTORICAL_RETIREMENT' && value.affectsCurrentState === true; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
function metadata(value: unknown, assetId: string): value is RetirementApplicationMetadata {
  return object(value) && value.assetId === assetId && ['id', 'assetId', 'evidenceId', 'requestId', 'appliedById'].every((key) => uuid(value[key])) &&
    hash(value.planId) && value.rulesVersion === 'mda-retirement-plan-1' && integer(value.evidenceVersion, 1000) && integer(value.sourceRevision, 1000) &&
    (value.evidenceVersion === 0 ? value.amendmentId === null : uuid(value.amendmentId)) && instant(value.decommissionedAt) && instant(value.appliedAt);
}
export function validateRetirementApplication(value: unknown, assetId: string, expected: { id?: string; intent?: RetirementApplicationIntent; actorId?: string } = {}): RetirementApplication {
  if (!scope(value) || value.mode !== 'APPLIED' || value.persisted !== true || !metadata(value.application, assetId)) invalid();
  const saved = value.application as unknown as Value;
  if (!hash(saved.requestDigest) || !object(saved.plan) || !object(saved.result) || (expected.id !== undefined && saved.id !== expected.id)) invalid();
  let intent: RetirementApplicationIntent;
  try {
    intent = validateRetirementApplicationIntent(expected.intent ?? {
      requestId: saved.requestId, planId: saved.planId, confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT', plan: saved.plan.request
    });
  } catch { return invalid(); }
  let plan;
  try { plan = validateRetirementPlan(saved.plan, { ...intent.plan, acknowledgedWarnings: [...intent.plan.acknowledgedWarnings] }, assetId); } catch { return invalid(); }
  if (!plan.planValidationComplete || plan.blockers.length || saved.planId !== plan.planId || saved.rulesVersion !== plan.planRulesVersion ||
    saved.requestId !== intent.requestId || saved.planId !== intent.planId || saved.evidenceId !== plan.source.evidenceId ||
    saved.evidenceVersion !== plan.source.evidenceVersion || saved.amendmentId !== plan.source.amendmentId || saved.sourceRevision !== plan.source.sourceRevision ||
    saved.decommissionedAt !== plan.proposedRetirement.decommissionedAt ||
    (expected.actorId !== undefined && saved.appliedById !== expected.actorId) ||
    (expected.intent && (!uuid(expected.actorId) || typeof value.reused !== 'boolean')) ||
    (!expected.intent && value.reused !== undefined && typeof value.reused !== 'boolean')) invalid();
  const before = plan.assetBefore;
  if (!sameSnapshot(saved.result, { id: assetId, productId: before.productId, serialNumber: before.serialNumber, assetTag: before.assetTag,
    status: 'DECOMMISSIONED', isActive: false, decommissionedAt: saved.decommissionedAt, updatedAt: saved.appliedAt })) invalid();
  return freeze(globalThis.structuredClone(saved)) as RetirementApplication;
}
const path = (assetId: string) => '/assets/' + encodeURIComponent(assetId) + '/imported-retirement-applications';
function bounded(signal?: globalThis.AbortSignal) {
  const deadline = globalThis.AbortSignal.timeout(30_000);
  return signal ? globalThis.AbortSignal.any([signal, deadline]) : deadline;
}
function validRequest(assetId: string, id?: string, offset?: number) {
  if (!uuid(assetId) || (id !== undefined && !uuid(id)) || (offset !== undefined && !integer(offset))) {
    throw new ApiRequestError('Revisa el activo, el comprobante y la página solicitada.', 400, 'VALIDATION_ERROR');
  }
}
export async function readRetirementApplications(assetId: string, offset: number, signal: globalThis.AbortSignal): Promise<RetirementApplicationPage> {
  validRequest(assetId, undefined, offset);
  const value = await apiRequest<unknown>(path(assetId) + '?limit=25&offset=' + offset, { signal: bounded(signal) });
  if (!scope(value) || !Array.isArray(value.applications) || !value.applications.every((entry) => metadata(entry, assetId) &&
    object(entry) && !['plan', 'result', 'requestDigest'].some((key) => Object.hasOwn(entry, key))) ||
    value.limit !== 25 || value.offset !== offset || !integer(value.total) ||
    value.applications.length !== Math.min(25, Math.max(0, Number(value.total) - offset)) ||
    value.hasMore !== (offset + value.applications.length < Number(value.total)) ||
    new Set(value.applications.map((entry) => entry.id)).size !== value.applications.length) invalid();
  return freeze(globalThis.structuredClone({ items: value.applications as RetirementApplicationMetadata[], total: Number(value.total), limit: 25 as const, offset, hasMore: Boolean(value.hasMore) }));
}
export async function readRetirementApplication(assetId: string, id: string, signal: globalThis.AbortSignal): Promise<RetirementApplication> {
  validRequest(assetId, id);
  const value = await apiRequest<unknown>(path(assetId) + '/' + encodeURIComponent(id), { signal: bounded(signal) });
  return validateRetirementApplication(value, assetId, { id });
}
export async function saveRetirementApplication(assetId: string, intent: RetirementApplicationIntent, actorId: string): Promise<RetirementApplication> {
  validRequest(assetId, actorId);
  const captured = validateRetirementApplicationIntent(intent);
  const body = JSON.stringify(captured); const signal = bounded();
  const token = await getCsrfToken(signal);
  const value = await apiRequest<unknown>('/assets/' + encodeURIComponent(assetId) + '/imported-retirement-plan/apply', {
    method: 'POST', signal, headers: { 'X-CSRF-Token': token }, body
  });
  return validateRetirementApplication(value, assetId, { intent: captured, actorId });
}
export function retirementApplicationNeedsRecovery(error: unknown): boolean {
  return !(error instanceof ApiRequestError) || error.status >= 500 ||
    ['NETWORK_ERROR', 'INVALID_RESPONSE', 'RETIREMENT_APPLICATION_BUSY', 'RETIREMENT_APPLICATION_CONFLICT', 'RETIREMENT_ALREADY_APPLIED'].includes(error.code ?? '');
}
export function getRetirementApplicationErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'RETIREMENT_PLAN_CHANGED': return 'El plan de baja cambió. Genera otro plan, revísalo y confirma una nueva intención.';
      case 'RETIREMENT_PLAN_BLOCKED': return 'El plan de baja tiene bloqueos. Actualízalo y revisa las incidencias antes de confirmar.';
      case 'RETIREMENT_ALREADY_APPLIED': return 'La baja ya tiene un comprobante. Consulta los comprobantes de este activo antes de continuar.';
      case 'RETIREMENT_APPLICATION_BUSY':
      case 'RETIREMENT_APPLICATION_CONFLICT': return 'No se pudo confirmar la baja. Recupera el comprobante o reintenta exactamente la misma intención y clave.';
    }
  }
  if (retirementApplicationNeedsRecovery(error)) return 'No se pudo confirmar el resultado de la baja. Recupera el comprobante o reintenta exactamente la misma intención y clave.';
  return getApiErrorMessage(error, 'No se pudo completar la baja histórica. Revisa la sesión y los datos antes de continuar.');
}
