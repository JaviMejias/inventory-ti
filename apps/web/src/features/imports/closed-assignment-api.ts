import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { sameSnapshot } from './history-evidence-api';
import { historyKindLabels } from './history-evidence-model';
import { validHistoricalInstant, type ClosedPlan, type ClosedPlanInput, type ClosedPlanPeriod, type ClosedPlanSource } from './closed-assignment-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, min = 0) { return Number.isInteger(value) && Number(value) >= min; }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function text(value: unknown) { return value === null || typeof value === 'string'; }
function instant(value: unknown) { return typeof value === 'string' && validHistoricalInstant(value); }
function day(value: unknown) { return typeof value === 'string' && instant(value + 'T00:00:00Z'); }
function source(value: unknown): value is ClosedPlanSource {
  return object(value) && ['start', 'end'].includes(String(value.endpoint)) && ['evidenceId', 'captureId', 'batchId'].every((key) => uuid(value[key])) &&
    ['sourceHash', 'recordId', 'candidateId', 'snapshotDigest'].every((key) => hash(value[key])) && typeof value.kind === 'string' && Object.hasOwn(historyKindLabels, value.kind) &&
    typeof value.sheet === 'string' && integer(value.row, 1) && integer(value.sourceRevision) && integer(value.capturedSourceRevision) &&
    Number(value.sourceRevision) >= Number(value.capturedSourceRevision) && integer(value.evidenceVersion) && Number(value.evidenceVersion) <= 1000 &&
    (value.evidenceVersion === 0 ? value.amendmentId === null && value.sourceRevision === value.capturedSourceRevision : uuid(value.amendmentId)) &&
    (value.effectiveDay === null ? value.datePrecision === 'UNKNOWN' : day(value.effectiveDay) && value.datePrecision === 'DAY') &&
    object(value.fields) && Object.values(value.fields).every(text);
}
function issue(value: unknown) {
  return object(value) && typeof value.code === 'string' && ['BLOCKING', 'WARNING', 'INFO'].includes(String(value.severity)) &&
    text(value.sheet) && (value.row === null || integer(value.row, 1)) && text(value.cell) && (value.candidateId === null || hash(value.candidateId));
}
function period(value: unknown, input: ClosedPlanInput['periods'][number], assetId: string): value is ClosedPlanPeriod {
  if (!object(value) || !['periodId', 'confirmation', 'start', 'end', 'recipient', 'assignmentType', 'returnStatus', 'note', 'evidenceReference'].every((key) => sameSnapshot(value[key], input[key as keyof typeof input])) ||
    !sameSnapshot(value.acknowledgedWarnings, [...input.acknowledgedWarnings].sort()) || !Array.isArray(value.sources) || value.sources.length !== 2 || !value.sources.every(source)) return false;
  const start = value.sources.find((entry) => entry.endpoint === 'start'); const end = value.sources.find((entry) => entry.endpoint === 'end');
  if (!start || !end || start.evidenceId !== input.start.evidenceId || end.evidenceId !== input.end.evidenceId) return false;
  const proposal = value.proposedAssignment;
  if (!object(proposal) || proposal.assetId !== assetId || proposal.personId !== null || proposal.assignedById !== null || proposal.returnedById !== null ||
    proposal.assignmentType !== input.assignmentType || proposal.returnStatus !== input.returnStatus || proposal.recipientType !== (input.recipient?.type ?? null) ||
    proposal.personName !== (input.recipient?.type === 'PERSON' ? input.recipient.name : null) || proposal.officeName !== (input.recipient?.type === 'OFFICE' ? input.recipient.name : null) ||
    proposal.startedAt !== (input.start.confirmedAt ? new Date(input.start.confirmedAt).toISOString() : null) || proposal.endedAt !== (input.end.confirmedAt ? new Date(input.end.confirmedAt).toISOString() : null) ||
    !['ticketReference', 'otReference', 'returnTicketReference', 'returnOtReference'].every((key) => text(proposal[key]) && (proposal[key] === null || String(proposal[key]).length <= 160))) return false;
  if (!Array.isArray(value.warnings) || !value.warnings.every((entry) => object(entry) && hash(entry.id) && [start.evidenceId, end.evidenceId].includes(String(entry.evidenceId)) && issue(entry.issue) && typeof entry.contextualOnly === 'boolean') ||
    !Array.isArray(value.blockers) || !value.blockers.every((entry) => object(entry) && typeof entry.code === 'string' &&
      (entry.endpoint === undefined || ['start', 'end'].includes(String(entry.endpoint))) && (entry.relatedId === undefined || typeof entry.relatedId === 'string'))) return false;
  return typeof value.valid === 'boolean' && value.valid === (value.blockers.length === 0);
}
function asset(value: unknown, id: string) {
  if (!object(value) || value.id !== id || !uuid(value.productId) || !text(value.serialNumber) || !text(value.assetTag) || typeof value.isActive !== 'boolean' ||
    !['AVAILABLE', 'ASSIGNED', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR', 'IN_WARRANTY', 'LOST', 'DECOMMISSIONED'].includes(String(value.status)) ||
    !instant(value.updatedAt) || !(value.decommissionedAt === null || instant(value.decommissionedAt)) || !object(value.product)) return false;
  return value.product.id === value.productId && ['ASSET', 'QUANTITY'].includes(String(value.product.trackingMode)) && typeof value.product.isActive === 'boolean' && instant(value.product.updatedAt);
}
export { asset as validHistoricalPlanAsset };
export function validateClosedPlan(value: unknown, input: ClosedPlanInput, assetId: string): ClosedPlan {
  const invalid = () => { throw new ApiRequestError('Unexpected closed assignment plan', 200, 'INVALID_RESPONSE'); };
  if (!object(value) || value.scope !== 'CLOSED_ASSIGNMENT_HISTORY_PLAN' || value.mode !== 'CLOSED_ASSIGNMENT_PLAN' || value.planRulesVersion !== 'mda-closed-assignment-plan-2' ||
    value.canApply !== false || value.persisted !== false || value.affectsCurrentState !== false || !day(value.checkedAsOf) || !asset(value.assetBefore, assetId) ||
    !['currentAssignmentsDigest', 'sourceRevisionsDigest', 'planId'].every((key) => hash(value[key])) || !Array.isArray(value.periods) || value.periods.length !== input.periods.length) return invalid();
  const periods = value.periods;
  const seen = new Set<string>();
  if (!periods.every((entry) => {
    if (!object(entry) || typeof entry.periodId !== 'string' || seen.has(entry.periodId)) return false;
    seen.add(entry.periodId); const expected = input.periods.find((item) => item.periodId === entry.periodId);
    return Boolean(expected && period(entry, expected, assetId));
  })) return invalid();
  const parsed = periods as ClosedPlanPeriod[];
  if (value.planValidationComplete !== parsed.every((entry) => entry.valid) || !object(value.summary) ||
    value.summary.periodCount !== parsed.length || value.summary.validCount !== parsed.filter((entry) => entry.valid).length ||
    value.summary.blockingCount !== parsed.reduce((count, entry) => count + entry.blockers.length, 0) ||
    value.summary.warningCount !== parsed.reduce((count, entry) => count + entry.warnings.length, 0)) return invalid();
  return value as unknown as ClosedPlan;
}
export async function readClosedAssignmentPlan(assetId: string, input: ClosedPlanInput, signal: globalThis.AbortSignal) {
  const bounded = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)]);
  const token = await getCsrfToken(bounded);
  const response = await apiRequest<unknown>(`/assets/${encodeURIComponent(assetId)}/imported-assignment-plan`, {
    method: 'POST', signal: bounded, headers: { 'X-CSRF-Token': token }, body: JSON.stringify(input)
  });
  return validateClosedPlan(response, input, assetId);
}
