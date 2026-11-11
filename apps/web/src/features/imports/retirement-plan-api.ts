import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { validHistoricalPlanAsset } from './closed-assignment-api';
import { validHistoricalInstant } from './closed-assignment-model';
import { sameSnapshot } from './history-evidence-api';
import { historyKindLabels } from './history-evidence-model';
import type { RetirementPlan, RetirementPlanInput } from './retirement-plan-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown) { return Number.isInteger(value) && Number(value) >= 0; }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function text(value: unknown) { return value === null || typeof value === 'string'; }
function day(value: unknown) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && validHistoricalInstant(value + 'T00:00:00Z'); }
export function validRetirementSource(value: unknown, evidenceId: string, diagnostic = false) {
  return object(value) && value.evidenceId === evidenceId && ['evidenceId', 'captureId', 'batchId'].every((key) => uuid(value[key])) &&
    ['sourceHash', 'recordId', 'candidateId', 'snapshotDigest'].every((key) => hash(value[key])) && (diagnostic ? typeof value.kind === 'string' && Object.hasOwn(historyKindLabels, value.kind) : value.kind === 'RETIREMENT_OBSERVATION') &&
    typeof value.sheet === 'string' && integer(value.row) && Number(value.row) > 0 && integer(value.sourceRevision) && integer(value.capturedSourceRevision) &&
    Number(value.sourceRevision) >= Number(value.capturedSourceRevision) && integer(value.evidenceVersion) && Number(value.evidenceVersion) <= 1000 &&
    (value.evidenceVersion === 0 ? value.amendmentId === null && value.sourceRevision === value.capturedSourceRevision : uuid(value.amendmentId)) &&
    (value.effectiveDay === null ? value.datePrecision === 'UNKNOWN' : diagnostic && value.kind !== 'RETIREMENT_OBSERVATION' && day(value.effectiveDay) && value.datePrecision === 'DAY') && (value.sourceReceivedDay === null || day(value.sourceReceivedDay)) &&
    object(value.fields) && Object.values(value.fields).every(text);
}
export function validRetirementWarning(value: unknown, evidenceId: string) {
  if (!object(value) || !hash(value.id) || value.evidenceId !== evidenceId || !object(value.issue)) return false;
  const issue = value.issue;
  return typeof issue.code === 'string' && issue.severity === 'WARNING' && text(issue.sheet) && (issue.row === null || integer(issue.row) && Number(issue.row) > 0) &&
    text(issue.cell) && (issue.candidateId === null || hash(issue.candidateId));
}
export function validateRetirementPlan(value: unknown, input: RetirementPlanInput, assetId: string): RetirementPlan {
  const invalid = () => { throw new ApiRequestError('Unexpected retirement plan', 200, 'INVALID_RESPONSE'); };
  if (!object(value) || value.scope !== 'HISTORICAL_RETIREMENT_PLAN' || value.mode !== 'HISTORICAL_RETIREMENT_PLAN' || value.planRulesVersion !== 'mda-retirement-plan-1' ||
    value.canApply !== false || value.persisted !== false || value.affectsCurrentState !== false || !day(value.checkedAsOf) || !validHistoricalPlanAsset(value.assetBefore, assetId) ||
    !['currentAssignmentsDigest', 'sourceRevisionsDigest', 'planId'].every((key) => hash(value[key])) ||
    !sameSnapshot(value.request, { ...input, acknowledgedWarnings: [...input.acknowledgedWarnings].sort() }) || !validRetirementSource(value.source, input.evidenceId)) return invalid();
  const proposal = value.proposedRetirement;
  if (!object(proposal) || proposal.assetId !== assetId || proposal.status !== 'DECOMMISSIONED' || proposal.isActive !== false || proposal.historicalActorId !== null ||
    proposal.decommissionedAt !== (input.confirmedAt ? new Date(input.confirmedAt).toISOString() : null) ||
    !Array.isArray(value.warnings) || !value.warnings.every((entry) => validRetirementWarning(entry, input.evidenceId)) ||
    new Set(value.warnings.map((entry) => (entry as Value).id)).size !== value.warnings.length ||
    !Array.isArray(value.blockers) || !value.blockers.every((entry) => object(entry) && typeof entry.code === 'string' && (entry.relatedId === undefined || typeof entry.relatedId === 'string'))) return invalid();
  const complete = value.blockers.length === 0;
  if (value.planValidationComplete !== complete || !object(value.summary) || value.summary.retirementCount !== 1 || value.summary.validCount !== (complete ? 1 : 0) ||
    value.summary.blockingCount !== value.blockers.length || value.summary.warningCount !== value.warnings.length ||
    (complete && (!input.confirmedAt || !input.dateEvidenceReference || !sameSnapshot([...input.acknowledgedWarnings].sort(), value.warnings.map((entry) => (entry as Value).id).sort())))) return invalid();
  return value as unknown as RetirementPlan;
}
export async function readRetirementPlan(assetId: string, input: RetirementPlanInput, signal: globalThis.AbortSignal) {
  const bounded = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)]);
  const token = await getCsrfToken(bounded);
  const response = await apiRequest<unknown>(`/assets/${encodeURIComponent(assetId)}/imported-retirement-plan`, {
    method: 'POST', signal: bounded, headers: { 'X-CSRF-Token': token }, body: JSON.stringify(input)
  });
  return validateRetirementPlan(response, input, assetId);
}
