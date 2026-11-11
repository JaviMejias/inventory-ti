import { ApiRequestError, apiRequest } from '../../lib/api';
import { sameSnapshot } from './history-evidence-api';
import { validateCurrentPilotApplication } from './pilot-api';
import type { LegacyPilotReceipt, PilotReadReceipt } from './pilot-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown, min = 0) { return Number.isSafeInteger(value) && Number(value) >= min; }
function text(value: unknown, max: number) { return typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= max; }
function instant(value: unknown) { return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value)); }
function day(value: unknown) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && instant(value + 'T00:00:00Z') && new Date(value).toISOString().slice(0, 10) === value; }
function invalid(): never { throw new ApiRequestError('Unexpected legacy pilot receipt', 200, 'INVALID_RESPONSE'); }
const metadataLimits: Record<string, number> = { technicalCondition: 100, usagePurpose: 100, location: 160, sector: 100, ipAddress: 45, hostname: 160, loanCode: 100, notes: 10000 };
const assetStatuses = ['AVAILABLE', 'ASSIGNED', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR', 'IN_WARRANTY', 'LOST', 'DECOMMISSIONED'];
function legacyOperation(value: unknown): value is Value {
  if (!object(value) || !['CREATE_ASSET', 'UPDATE_METADATA'].includes(String(value.type)) || !hash(value.candidateId) || !uuid(value.decisionId) || !text(value.note, 2000) ||
    ['sourceCorrections', 'identityRevision', 'decisionSourceRevision'].some((key) => Object.hasOwn(value, key)) || value.valid !== true || !Array.isArray(value.blockers) || value.blockers.length !== 0 ||
    !object(value.values) || !Object.keys(value.values).length || !object(value.product) || !uuid(value.product.id) || !text(value.product.name, 10000) || value.product.trackingMode !== 'ASSET' || value.product.isActive !== true || !instant(value.product.updatedAt)) return false;
  const values = value.values; const product = value.product;
  const create = value.type === 'CREATE_ASSET';
  const limits = create ? { ...metadataLimits, serialNumber: 160, assetTag: 100 } : metadataLimits;
  if (!Object.entries(values).every(([key, entry]) => create && key === 'productId' ? uuid(entry) && entry === product.id :
    Object.hasOwn(limits, key) && (entry === null || typeof entry === 'string' && entry.length <= limits[key]))) return false;
  if (create ? value.confirmation !== 'AVAILABLE_UNASSIGNED' || values.productId !== product.id || value.before !== null || value.resultingStatus !== 'AVAILABLE' || !values.serialNumber && !values.assetTag :
    !uuid(value.assetId) || !object(value.before) || value.before.id !== value.assetId || value.before.productId !== product.id || value.before.isActive !== true || value.before.status === 'DECOMMISSIONED' || !assetStatuses.includes(String(value.before.status)) || value.resultingStatus !== value.before.status) return false;
  if (!Array.isArray(value.source) || !value.source.length || value.source.length > 15000 || !value.source.every((row) => object(row) && hash(row.recordId) && text(row.sheet, 100) && integer(row.row, 1)) ||
    new Set(value.source.map((row) => row.recordId)).size !== value.source.length || !Array.isArray(value.warnings) || !value.warnings.every((warning) => object(warning) && hash(warning.id) &&
      typeof warning.code === 'string' && warning.severity === 'WARNING' && (warning.sheet === null || typeof warning.sheet === 'string') && (warning.row === null || integer(warning.row, 1)) &&
      (warning.cell === null || typeof warning.cell === 'string') && (warning.candidateId === null || warning.candidateId === value.candidateId)) ||
    !Array.isArray(value.acknowledgedWarnings) || value.acknowledgedWarnings.length > 500 || !value.acknowledgedWarnings.every(hash) || new Set(value.acknowledgedWarnings).size !== value.acknowledgedWarnings.length ||
    !sameSnapshot([...value.acknowledgedWarnings].sort(), value.warnings.map((warning) => warning.id).sort())) return false;
  const before = object(value.before) ? value.before : null;
  const fields = Object.keys(values).filter((key) => key !== 'productId' && (create || before?.[key] !== values[key]));
  return fields.length > 0 && Array.isArray(value.changes) && value.changes.length === fields.length && new Set(value.changes.map((change) => object(change) && change.field)).size === fields.length &&
    value.changes.every((change) => object(change) && typeof change.field === 'string' && fields.includes(change.field) && change.before === (before?.[change.field] ?? null) && change.after === values[change.field]);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function validateLegacyPilotReceipt(value: unknown, batchId: string, applicationId: string): LegacyPilotReceipt {
  if (!object(value) || value.mode !== 'APPLIED' || value.persisted !== true || !object(value.application) || (value.reused !== undefined && typeof value.reused !== 'boolean')) invalid();
  const receipt = value.application;
  if (receipt.id !== applicationId || receipt.batchId !== batchId || !['id', 'batchId', 'requestId', 'appliedById'].every((key) => uuid(receipt[key])) || !integer(receipt.batchVersion, 1) ||
    !['requestDigest', 'planId', 'sourceHash'].every((key) => hash(receipt[key])) || !instant(receipt.createdAt) || !object(receipt.plan)) invalid();
  const plan = receipt.plan;
  if (plan.planRulesVersion !== 'mda-pilot-1' || Object.hasOwn(plan, 'sourceRevision') || plan.mode !== 'PILOT_PLAN' || plan.scope !== 'ASSET_PILOT' || plan.persisted !== false || plan.canApply !== false ||
    plan.batchId !== batchId || plan.batchVersion !== receipt.batchVersion || plan.planId !== receipt.planId || !['stagedPreviewId', 'currentPreviewId'].every((key) => hash(plan[key])) || !day(plan.checkedAsOf) || !integer(plan.omittedTargetCount) ||
    !object(plan.freshness) || plan.freshness.stale !== false || !['rulesChanged', 'databaseChanged', 'reviewDateChanged'].every((key) => typeof (plan.freshness as Value)[key] === 'boolean') || plan.freshness.rulesChanged !== false || plan.freshness.databaseChanged !== false ||
    plan.planValidationComplete !== true || !Array.isArray(plan.operations) || plan.operations.length < 1 || plan.operations.length > 25 || !plan.operations.every(legacyOperation) ||
    new Set(plan.operations.map((operation) => operation.candidateId)).size !== plan.operations.length || !object(plan.summary)) invalid();
  const operations = plan.operations as Value[];
  const creates = operations.filter((operation) => operation.type === 'CREATE_ASSET').length;
  if (!sameSnapshot(plan.summary, { operationCount: operations.length, validCount: operations.length, blockedCount: 0, createCount: creates, updateCount: operations.length - creates }) ||
    !Array.isArray(receipt.items) || receipt.items.length !== operations.length || !receipt.items.every((item) => {
      if (!object(item) || !uuid(item.id) || item.applicationId !== receipt.id || item.sourceHash !== receipt.sourceHash || !uuid(item.assetId) || !object(item.result)) return false;
      const operation = operations.find((entry) => entry.candidateId === item.candidateId);
      if (!operation || item.decisionId !== operation.decisionId || !sameSnapshot(item.operation, operation) || item.result.id !== item.assetId || !object(operation.product) ||
        item.result.productId !== operation.product.id || !assetStatuses.includes(String(item.result.status)) || item.result.status !== operation.resultingStatus || item.result.isActive !== true ||
        !object(item.result.product) || item.result.product.id !== operation.product.id) return false;
      const values = operation.values as Value;
      const identity = ['serialNumber', 'assetTag'];
      if (!identity.every((key) => item.result && object(item.result) && (item.result[key] === null || typeof item.result[key] === 'string') &&
        item.result[key] === (operation.type === 'CREATE_ASSET' ? values[key] ?? null : (operation.before as Value)[key]))) return false;
      return (operation.type !== 'UPDATE_METADATA' || operation.assetId === item.assetId) &&
        (operation.changes as Value[]).every((change) => (item.result as Value)[String(change.field)] === change.after);
    }) || new Set(receipt.items.map((item) => item.id)).size !== operations.length || new Set(receipt.items.map((item) => item.candidateId)).size !== operations.length ||
    new Set(receipt.items.map((item) => item.assetId)).size !== operations.length) invalid();
  return freeze(globalThis.structuredClone(receipt)) as LegacyPilotReceipt;
}
export async function readPilotApplication(batchId: string, applicationId: string, signal: globalThis.AbortSignal): Promise<PilotReadReceipt> {
  if (!uuid(batchId) || !uuid(applicationId)) throw new ApiRequestError('Revisa el lote y el comprobante del piloto.', 400, 'VALIDATION_ERROR');
  const value = await apiRequest<unknown>('/inventory/imports/batches/' + encodeURIComponent(batchId) + '/applications/' + encodeURIComponent(applicationId), {
    signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)])
  });
  if (object(value) && object(value.application) && object(value.application.plan) && value.application.plan.planRulesVersion === 'mda-pilot-1') return validateLegacyPilotReceipt(value, batchId, applicationId);
  return validateCurrentPilotApplication(value, batchId, applicationId);
}
