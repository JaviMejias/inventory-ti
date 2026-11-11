import { ApiRequestError } from '../../lib/api';
import { validHistoricalPlanAsset } from './closed-assignment-api';
import { validHistoricalInstant } from './closed-assignment-model';
import type { LegacyClosedPlan } from './legacy-closed-application-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown, min = 0) { return Number.isSafeInteger(value) && Number(value) >= min; }
function instant(value: unknown): value is string { return typeof value === 'string' && validHistoricalInstant(value); }
function day(value: unknown) { return typeof value === 'string' && instant(value + 'T00:00:00Z'); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value; }
function nullableText(value: unknown) { return value === null || typeof value === 'string'; }
function endpoint(value: unknown): value is Value & { confirmedAt: string } {
  return object(value) && uuid(value.evidenceId) && instant(value.confirmedAt) && text(value.dateEvidenceReference, 500);
}
function source(value: unknown): value is Value {
  return object(value) && ['start', 'end'].includes(String(value.endpoint)) && ['evidenceId', 'captureId', 'batchId'].every((key) => uuid(value[key])) &&
    ['sourceHash', 'recordId', 'candidateId', 'snapshotDigest'].every((key) => hash(value[key])) &&
    ['USAGE_OBSERVATION', 'LOAN_OBSERVATION', 'RECEIPT_OBSERVATION'].includes(String(value.kind)) &&
    typeof value.sheet === 'string' && integer(value.row, 1) && integer(value.sourceRevision) &&
    // Do not accept a rules2 source relabelled as rules1, including explicit null/default fields.
    !['evidenceVersion', 'amendmentId', 'capturedSourceRevision'].some((key) => Object.hasOwn(value, key)) &&
    (value.effectiveDay === null ? value.datePrecision === 'UNKNOWN' : day(value.effectiveDay) && value.datePrecision === 'DAY') &&
    object(value.fields) && Object.values(value.fields).every(nullableText);
}
function issue(value: unknown) {
  return object(value) && typeof value.code === 'string' && ['BLOCKING', 'WARNING', 'INFO'].includes(String(value.severity)) &&
    nullableText(value.sheet) && (value.row === null || integer(value.row, 1)) && nullableText(value.cell) && (value.candidateId === null || hash(value.candidateId));
}
function period(value: unknown, assetId: string): value is Value {
  if (!object(value) || !uuid(value.periodId) || value.confirmation !== 'VERIFIED_CLOSED_ASSIGNMENT' ||
    !endpoint(value.start) || !endpoint(value.end) || value.start.evidenceId === value.end.evidenceId ||
    Date.parse(value.start.confirmedAt) >= Date.parse(value.end.confirmedAt) ||
    !object(value.recipient) || !['PERSON', 'OFFICE'].includes(String(value.recipient.type)) ||
    !text(value.recipient.name, value.recipient.type === 'PERSON' ? 150 : 160) ||
    (value.recipient.type === 'PERSON' && !/\s+\S+/.test(value.recipient.name)) ||
    !['STANDARD', 'LOAN'].includes(String(value.assignmentType)) || !['AVAILABLE', 'UNDER_REVIEW', 'IN_REPAIR'].includes(String(value.returnStatus)) ||
    !text(value.note, 2000) || !text(value.evidenceReference, 500) || value.valid !== true || !Array.isArray(value.blockers) || value.blockers.length !== 0 ||
    !Array.isArray(value.acknowledgedWarnings) || value.acknowledgedWarnings.length > 1000 || !value.acknowledgedWarnings.every(hash) ||
    new Set(value.acknowledgedWarnings).size !== value.acknowledgedWarnings.length ||
    !Array.isArray(value.sources) || value.sources.length !== 2 || !value.sources.every(source)) return false;
  const start = value.sources.find((entry) => entry.endpoint === 'start'); const end = value.sources.find((entry) => entry.endpoint === 'end');
  if (!start || !end || start.evidenceId !== value.start.evidenceId || end.evidenceId !== value.end.evidenceId ||
    !['USAGE_OBSERVATION', 'LOAN_OBSERVATION'].includes(String(start.kind)) || !['RECEIPT_OBSERVATION', 'USAGE_OBSERVATION'].includes(String(end.kind)) ||
    (start.sourceHash === end.sourceHash && start.recordId === end.recordId) ||
    (start.effectiveDay !== null && start.effectiveDay !== value.start.confirmedAt.slice(0, 10)) ||
    (end.effectiveDay !== null && end.effectiveDay !== value.end.confirmedAt.slice(0, 10))) return false;
  const proposal = value.proposedAssignment;
  if (!object(proposal) || proposal.assetId !== assetId || proposal.personId !== null || proposal.assignedById !== null || proposal.returnedById !== null ||
    proposal.assignmentType !== value.assignmentType || proposal.returnStatus !== value.returnStatus || proposal.recipientType !== value.recipient.type ||
    proposal.personName !== (value.recipient.type === 'PERSON' ? value.recipient.name : null) || proposal.officeName !== (value.recipient.type === 'OFFICE' ? value.recipient.name : null) ||
    proposal.startedAt !== new Date(value.start.confirmedAt).toISOString() || proposal.endedAt !== new Date(value.end.confirmedAt).toISOString() ||
    !['ticketReference', 'otReference', 'returnTicketReference', 'returnOtReference'].every((key) => proposal[key] === null || text(proposal[key], 160))) return false;
  if (!Array.isArray(value.warnings) || !value.warnings.every((warning) => object(warning) && hash(warning.id) &&
    [start.evidenceId, end.evidenceId].includes(warning.evidenceId) && issue(warning.issue) && typeof warning.contextualOnly === 'boolean')) return false;
  const warningIds = new Set(value.warnings.map((warning) => warning.id));
  return warningIds.size === value.acknowledgedWarnings.length && value.acknowledgedWarnings.every((id) => warningIds.has(id));
}

// Validate the archived contract only; never project it into a current plan or re-run current business rules.
export function validateLegacyClosedApplicationPlan(value: unknown, assetId: string): LegacyClosedPlan {
  const invalid = (): never => { throw new ApiRequestError('Unexpected legacy historical assignment snapshot', 200, 'INVALID_RESPONSE'); };
  if (!object(value) || value.planRulesVersion !== 'mda-closed-assignment-plan-1' || value.scope !== 'CLOSED_ASSIGNMENT_HISTORY_PLAN' ||
    value.mode !== 'CLOSED_ASSIGNMENT_PLAN' || value.canApply !== false || value.persisted !== false || value.affectsCurrentState !== false ||
    value.planValidationComplete !== true || !day(value.checkedAsOf) || !validHistoricalPlanAsset(value.assetBefore, assetId) ||
    !['currentAssignmentsDigest', 'sourceRevisionsDigest', 'planId'].every((key) => hash(value[key])) ||
    !Array.isArray(value.periods) || !value.periods.length || value.periods.length > 25 || !value.periods.every((entry) => period(entry, assetId))) return invalid();
  const parsed = value as unknown as LegacyClosedPlan;
  const periodIds = parsed.periods.map((entry) => entry.periodId);
  const evidenceIds = parsed.periods.flatMap((entry) => [entry.start.evidenceId, entry.end.evidenceId]);
  if (new Set(periodIds).size !== periodIds.length || new Set(evidenceIds).size !== evidenceIds.length || !object(value.summary) ||
    value.summary.periodCount !== parsed.periods.length || value.summary.validCount !== parsed.periods.length || value.summary.blockingCount !== 0 ||
    value.summary.warningCount !== parsed.periods.reduce((count, entry) => count + entry.warnings.length, 0)) return invalid();
  return parsed;
}
