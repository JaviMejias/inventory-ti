import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { validHistoricalPlanAsset } from './closed-assignment-api';
import { validHistoricalInstant } from './closed-assignment-model';
import { sameSnapshot } from './history-evidence-api';
import { validRetirementSource, validRetirementWarning } from './retirement-plan-api';
import { retirementClassificationLabels, retirementCurrentStateLabels, retirementEvidenceStateLabels, type RetirementReconciliation } from './retirement-reconciliation-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown) { return Number.isInteger(value) && Number(value) >= 0; }
function day(value: unknown) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && validHistoricalInstant(value + 'T00:00:00Z'); }
function instant(value: unknown) { return typeof value === 'string' && validHistoricalInstant(value); }
function recordedDate(value: unknown) {
  return value === null || typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
const receiptKeys = ['id', 'assetId', 'evidenceId', 'evidenceVersion', 'amendmentId', 'sourceRevision', 'decommissionedAt', 'appliedAt', 'appliedById'];
function receipt(value: unknown) {
  return object(value) && Object.keys(value).length === receiptKeys.length && receiptKeys.every((key) => Object.hasOwn(value, key)) &&
    ['id', 'assetId', 'evidenceId', 'appliedById'].every((key) => uuid(value[key])) && integer(value.evidenceVersion) && Number(value.evidenceVersion) <= 1000 &&
    (value.evidenceVersion === 0 ? value.amendmentId === null : uuid(value.amendmentId)) && integer(value.sourceRevision) && instant(value.decommissionedAt) && instant(value.appliedAt);
}
function invalid(): never { throw new ApiRequestError('Unexpected retirement reconciliation', 200, 'INVALID_RESPONSE'); }
export function validateRetirementReconciliation(value: unknown, assetId: string, evidenceId: string): RetirementReconciliation {
  if (!object(value) || value.rulesVersion !== 'mda-retirement-reconciliation-1' || value.scope !== 'HISTORICAL_RETIREMENT_RECONCILIATION' || value.mode !== 'READ_ONLY_RECONCILIATION' ||
    ['canApply', 'persisted', 'affectsCurrentState', 'operationalResolutionImplemented'].some((key) => value[key] !== false) ||
    ['planId', 'proposedRetirement', 'planValidationComplete', 'requestId', 'request'].some((key) => Object.hasOwn(value, key)) ||
    !day(value.checkedAsOf) || !hash(value.assessmentId) || !hash(value.retirementPlanDigest) ||
    typeof value.classification !== 'string' || !Object.hasOwn(retirementClassificationLabels, value.classification) ||
    typeof value.currentState !== 'string' || !Object.hasOwn(retirementCurrentStateLabels, value.currentState) ||
    typeof value.evidenceState !== 'string' || !Object.hasOwn(retirementEvidenceStateLabels, value.evidenceState) ||
    !object(value.assetBefore) || !recordedDate(value.assetBefore.decommissionedAt) ||
    !validHistoricalPlanAsset({ ...value.assetBefore, decommissionedAt: null }, assetId) || !validRetirementSource(value.source, evidenceId, true)) invalid();
  const asset = value.assetBefore as Value; const source = value.source as Value;
  if (source.kind === 'RETIREMENT_OBSERVATION' ? !sameSnapshot(value.sourceRetirement, { effectiveAt: null, datePrecision: 'UNKNOWN', historicalActorId: null }) : value.sourceRetirement !== null) invalid();
  const terminal = asset.status === 'DECOMMISSIONED' && asset.isActive === false;
  if (terminal ? !object(value.existingRetirement) || value.existingRetirement.effectiveAt !== asset.decommissionedAt || value.existingRetirement.confirmsSourceDate !== false ||
    value.existingRetirement.datePrecision !== (asset.decommissionedAt === null ? 'UNKNOWN' : 'INSTANT') || !['CURRENT_ASSET', 'VERIFIED_IMPORT_RECEIPT'].includes(String(value.existingRetirement.dateOrigin)) : value.existingRetirement !== null) invalid();
  if (value.existingApplication !== null && (!receipt(value.existingApplication) || (value.existingApplication as Value).assetId !== assetId) ||
    value.evidenceApplication !== null && (!receipt(value.evidenceApplication) || (value.evidenceApplication as Value).evidenceId !== evidenceId)) invalid();
  const existing = value.existingApplication as Value | null; const used = value.evidenceApplication as Value | null;
  if (existing && used && existing.id === used.id && !sameSnapshot(existing, used)) invalid();
  if (!Array.isArray(value.warnings) || !value.warnings.every((entry) => validRetirementWarning(entry, evidenceId)) ||
    new Set(value.warnings.map((entry) => (entry as Value).id)).size !== value.warnings.length ||
    !Array.isArray(value.diagnostics) || !value.diagnostics.every((entry) => object(entry) && typeof entry.code === 'string' && entry.code !== 'WARNINGS_NOT_ACKNOWLEDGED' && (entry.relatedId === undefined || typeof entry.relatedId === 'string')) ||
    !Array.isArray(value.nextSteps) || !value.nextSteps.every((entry) => typeof entry === 'string' && /^[A-Z][A-Z0-9_]+$/.test(entry)) || new Set(value.nextSteps).size !== value.nextSteps.length ||
    !object(value.links) || value.links.verifiedPlan !== (value.classification === 'RETIREMENT_DATE_UNCONFIRMED' ? '/assets/' + assetId + '/imported-retirement-plan' : null) ||
    value.links.existingApplication !== (existing ? '/assets/' + assetId + '/imported-retirement-applications/' + existing.id : null)) invalid();
  return globalThis.structuredClone(value) as RetirementReconciliation;
}
export async function readRetirementReconciliation(assetId: string, evidenceId: string, signal: globalThis.AbortSignal) {
  if (!uuid(assetId) || !uuid(evidenceId)) throw new ApiRequestError('Revisa el activo y la evidencia seleccionados.', 400, 'VALIDATION_ERROR');
  const bounded = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)]);
  const token = await getCsrfToken(bounded);
  const response = await apiRequest<unknown>('/assets/' + encodeURIComponent(assetId) + '/imported-retirement-reconciliation', {
    method: 'POST', signal: bounded, headers: { 'X-CSRF-Token': token }, body: JSON.stringify({ evidenceId })
  });
  return validateRetirementReconciliation(response, assetId, evidenceId);
}
