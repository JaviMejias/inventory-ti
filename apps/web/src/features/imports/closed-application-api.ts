import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { validateClosedPlan } from './closed-assignment-api';
import { validHistoricalInstant } from './closed-assignment-model';
import { closedInputFromPlan, type ClosedApplication, type ClosedApplicationIntent, type ClosedApplicationMetadata, type ClosedApplicationPage } from './closed-application-model';
import { sameSnapshot } from './history-evidence-api';
import { validateLegacyClosedApplicationPlan } from './legacy-closed-application-api';
import type { ClosedPlan } from './closed-assignment-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function instant(value: unknown) { return typeof value === 'string' && validHistoricalInstant(value); }
function invalid(): never { throw new ApiRequestError('Unexpected historical assignment receipt', 200, 'INVALID_RESPONSE'); }
function scope(value: unknown): value is Value { return object(value) && value.scope === 'CLOSED_ASSIGNMENT_HISTORY' && value.affectsCurrentState === false; }
function metadata(value: unknown, assetId: string): value is ClosedApplicationMetadata {
  return object(value) && value.assetId === assetId && ['id', 'requestId', 'appliedById'].every((key) => uuid(value[key])) && hash(value.planId) &&
    ['mda-closed-assignment-plan-1', 'mda-closed-assignment-plan-2'].includes(String(value.rulesVersion)) && instant(value.appliedAt);
}
export function validateClosedApplication(value: unknown, assetId: string, expected: { id?: string; intent?: ClosedApplicationIntent; actorId?: string } = {}): ClosedApplication {
  if (!scope(value) || value.mode !== 'APPLIED' || value.persisted !== true || !metadata(value.application, assetId)) invalid();
  const saved = value.application as unknown as Value;
  if (!hash(saved.requestDigest) || !object(saved.plan) || !Array.isArray(saved.plan.periods) || !saved.plan.periods.length || saved.plan.periods.length > 25 ||
    !Array.isArray(saved.items) || saved.items.length !== saved.plan.periods.length) invalid();
  const legacy = saved.rulesVersion === 'mda-closed-assignment-plan-1';
  if (legacy && (expected.intent || expected.actorId || Object.hasOwn(value, 'reused'))) invalid();
  let plan: ClosedApplication['plan'];
  try {
    if (legacy) plan = validateLegacyClosedApplicationPlan(saved.plan, assetId);
    else {
      const current = saved.plan as unknown as ClosedPlan;
      plan = validateClosedPlan(current, expected.intent?.plan ?? closedInputFromPlan(current), assetId);
    }
  } catch { return invalid(); }
  if (!plan.planValidationComplete || saved.planId !== plan.planId || saved.rulesVersion !== plan.planRulesVersion ||
    (expected.id && saved.id !== expected.id) || (expected.intent && (typeof value.reused !== 'boolean' || saved.requestId !== expected.intent.requestId || saved.planId !== expected.intent.planId || saved.appliedById !== expected.actorId))) invalid();
  const periods = new Map(plan.periods.map((period) => [period.periodId, period]));
  const itemIds = new Set<string>(); const assignmentIds = new Set<string>();
  for (const item of saved.items) {
    if (!object(item) || !['id', 'periodId', 'assignmentId'].every((key) => uuid(item[key])) || item.applicationId !== saved.id ||
      itemIds.has(String(item.id)) || assignmentIds.has(String(item.assignmentId))) invalid();
    itemIds.add(String(item.id)); assignmentIds.add(String(item.assignmentId));
    const period = periods.get(String(item.periodId)); const assignment = item.assignment;
    if (!period || item.startEvidenceId !== period.start.evidenceId || item.endEvidenceId !== period.end.evidenceId || !sameSnapshot(item.snapshot, period) || !object(assignment)) invalid();
    periods.delete(String(item.periodId));
    const proposal = period.proposedAssignment;
    if (assignment.id !== item.assignmentId || assignment.assetId !== assetId || assignment.importedHistory !== true ||
      !['personId', 'createdById', 'endedById', 'expectedReturnAt'].every((key) => assignment[key] === null) ||
      !['recipientType', 'personName', 'officeName', 'assignmentType', 'startedAt', 'endedAt', 'returnStatus', 'ticketReference', 'otReference', 'returnTicketReference', 'returnOtReference'].every((key) => assignment[key] === proposal[key as keyof typeof proposal]) ||
      !assignment.endedAt || assignment.notes !== period.note || assignment.returnNotes !== period.evidenceReference || assignment.createdAt !== saved.appliedAt || assignment.returnRecordedAt !== saved.appliedAt) invalid();
  }
  if (periods.size) invalid();
  return saved as unknown as ClosedApplication;
}
const path = (assetId: string) => '/assets/' + encodeURIComponent(assetId) + '/imported-assignment-applications';
export async function readClosedApplications(assetId: string, offset: number, signal: globalThis.AbortSignal): Promise<ClosedApplicationPage> {
  const value = await apiRequest<unknown>(path(assetId) + '?limit=25&offset=' + offset, { signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)]) });
  if (!scope(value) || !Array.isArray(value.applications) || !value.applications.every((entry) => metadata(entry, assetId)) || value.limit !== 25 || value.offset !== offset ||
    !Number.isInteger(value.total) || Number(value.total) < 0 || value.applications.length !== Math.min(25, Math.max(0, Number(value.total) - offset)) ||
    value.hasMore !== (offset + value.applications.length < Number(value.total)) || new Set(value.applications.map((entry) => entry.id)).size !== value.applications.length) invalid();
  return { items: value.applications as ClosedApplicationMetadata[], total: Number(value.total), offset, hasMore: Boolean(value.hasMore) };
}
export async function readClosedApplication(assetId: string, id: string, signal: globalThis.AbortSignal) {
  const value = await apiRequest<unknown>(path(assetId) + '/' + encodeURIComponent(id), { signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)]) });
  return validateClosedApplication(value, assetId, { id });
}
export async function saveClosedApplication(assetId: string, intent: ClosedApplicationIntent, actorId: string) {
  const signal = globalThis.AbortSignal.timeout(30_000);
  const token = await getCsrfToken(signal);
  const value = await apiRequest<unknown>('/assets/' + encodeURIComponent(assetId) + '/imported-assignment-plan/apply', { method: 'POST', signal, headers: { 'X-CSRF-Token': token }, body: JSON.stringify(intent) });
  return validateClosedApplication(value, assetId, { intent, actorId });
}
export function closedApplicationNeedsRecovery(error: unknown) {
  return !(error instanceof ApiRequestError) || error.status >= 500 || ['NETWORK_ERROR', 'INVALID_RESPONSE', 'HISTORICAL_APPLICATION_BUSY', 'HISTORICAL_APPLICATION_CONFLICT'].includes(error.code ?? '');
}
