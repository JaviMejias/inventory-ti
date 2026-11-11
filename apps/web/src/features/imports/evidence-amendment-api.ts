import { ApiRequestError, apiRequest, getCsrfToken } from '../../lib/api';
import { captured, captureMetadata, sameSnapshot } from './history-evidence-api';
import type { AmendmentIntent, AmendmentMetadata, AmendmentPage, AmendmentPlan, CurrentEvidence, EvidenceAmendment, EvidenceOwner, OriginalEvidence } from './evidence-amendment-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
function nullableUuid(value: unknown) { return value === null || uuid(value); }
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown, min: number, max: number) { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max; }
function instant(value: unknown) { return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value)); }
function day(value: unknown) { return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value); }
function text(value: unknown, max: number) { return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max; }
function invalid(): never { throw new ApiRequestError('Unexpected evidence amendment response', 200, 'INVALID_RESPONSE'); }
function scope(value: unknown): value is Value { return object(value) && value.scope === 'HISTORICAL_EVIDENCE_ONLY' && value.canApply === false && value.affectsCurrentState === false; }
function matchesOwner(value: Value, owner: EvidenceOwner) { return ['id', 'captureId', 'recordId', 'candidateId', 'kind'].every((key) => value[key] === owner[key as keyof EvidenceOwner]); }
function original(value: unknown, owner: EvidenceOwner): value is OriginalEvidence {
  if (!object(value) || !captured(value.snapshot)) return false;
  const snapshot = value.snapshot;
  return matchesOwner(value, owner) && uuid(value.id) && captureMetadata(value.capture) &&
    value.capture.id === value.captureId && value.sourceHash === value.capture.sourceHash && instant(value.capturedAt) &&
    (['recordId', 'candidateId', 'kind', 'effectiveDay', 'assetId'] as const).every((key) => value[key] === snapshot[key]);
}
function current(value: unknown, saved: OriginalEvidence): value is CurrentEvidence {
  if (!object(value) || !captured(value.snapshot)) return false;
  const snapshot = value.snapshot;
  if (!object(value) || !matchesOwner(value, saved) || value.sourceHash !== saved.sourceHash || value.capturedAt !== saved.capturedAt || !sameSnapshot(value.capture, saved.capture) ||
    !captured(value.snapshot) || !sameSnapshot(value.snapshot.original, saved.snapshot.original) ||
    !(['recordId', 'candidateId', 'kind', 'effectiveDay', 'assetId'] as const).every((key) => value[key] === snapshot[key]) ||
    !integer(value.evidenceVersion,0,1000) || !integer(value.effectiveSourceRevision,saved.capture.sourceRevision,1000) ||
    value.capturedSourceRevision !== saved.capture.sourceRevision || value.capturedAssetId !== saved.assetId || value.capturedEffectiveDay !== saved.effectiveDay) return false;
  return value.evidenceVersion === 0 ? value.amendmentId === null && value.amendedAt === null && value.effectiveSourceRevision === saved.capture.sourceRevision && sameSnapshot(value.snapshot,saved.snapshot) :
    uuid(value.amendmentId) && instant(value.amendedAt);
}
function metadata(value: unknown, evidenceId: string): value is AmendmentMetadata {
  return object(value) && value.evidenceId === evidenceId && uuid(value.id) && integer(value.version,1,1000) &&
    (value.version === 1 ? value.previousAmendmentId === null : uuid(value.previousAmendmentId)) &&
    integer(value.batchVersion,1,2147483647) && integer(value.sourceRevision,0,1000) && uuid(value.requestId) && hash(value.amendmentPlanId) &&
    value.rulesVersion === 'mda-history-amendment-1' && nullableUuid(value.assetId) && day(value.effectiveDay) && text(value.note,2000) &&
    text(value.evidenceReference,500) && uuid(value.amendedById) && instant(value.amendedAt);
}
export function validateAmendmentPlan(value: unknown, owner: EvidenceOwner, assetId: string | null): AmendmentPlan {
  if (!scope(value) || value.mode !== 'EVIDENCE_AMENDMENT_PLAN' || value.persisted !== false || value.rulesVersion !== 'mda-history-amendment-1' ||
    value.evidenceId !== owner.id || !original(value.originalEvidence,owner) || !current(value.current,value.originalEvidence) ||
    value.batchId !== value.originalEvidence.capture.batchId || !integer(value.batchVersion,value.originalEvidence.capture.batchVersion,2147483647) ||
    !integer(value.sourceRevision,value.current.effectiveSourceRevision,1000) || value.evidenceVersion !== value.current.evidenceVersion ||
    value.previousAmendmentId !== value.current.amendmentId || !hash(value.historyPreviewId) || !hash(value.amendmentPlanId) ||
    !Array.isArray(value.blockers) || !value.blockers.every((entry) => typeof entry === 'string') || value.valid !== (value.blockers.length === 0)) invalid();
  if (value.proposed !== null && (!captured(value.proposed) || value.proposed.assetId !== assetId ||
    value.proposed.recordId !== owner.recordId || value.proposed.candidateId !== owner.candidateId || value.proposed.kind !== owner.kind ||
    !sameSnapshot(value.proposed.original,value.originalEvidence.snapshot.original))) invalid();
  if (value.used !== null && (!object(value.used) || value.used.evidenceId !== owner.id || !uuid(value.used.itemId) ||
    !['START','END','RETIREMENT'].includes(String(value.used.endpoint)))) invalid();
  if ((value.used !== null && !value.blockers.includes('EVIDENCE_ALREADY_APPLIED')) || (value.valid && (!value.proposed || value.used || Number(value.evidenceVersion) >= 1000))) invalid();
  return value as unknown as AmendmentPlan;
}
export function validateAmendmentEvent(value: unknown, originalEvidence: OriginalEvidence, expected: { id?: string; intent?: AmendmentIntent; plan?: AmendmentPlan; actorId?: string } = {}): EvidenceAmendment {
  if (!scope(value) || value.persisted !== true || !metadata(value.event,originalEvidence.id)) invalid();
  const event = value.event as unknown as EvidenceAmendment;
  if (!hash(event.requestDigest) || !captured(event.snapshot) || !sameSnapshot(event.snapshot.original,originalEvidence.snapshot.original) ||
    !(['recordId','candidateId','kind'] as const).every((key) => event.snapshot[key] === originalEvidence[key]) ||
    event.assetId !== event.snapshot.assetId || event.effectiveDay !== event.snapshot.effectiveDay ||
    event.sourceRevision < originalEvidence.capture.sourceRevision || event.batchVersion < originalEvidence.capture.batchVersion ||
    Date.parse(event.amendedAt) < Date.parse(originalEvidence.capturedAt) || (expected.id && event.id !== expected.id)) invalid();
  const intent = expected.intent; const plan = expected.plan;
  if (intent && (!plan || typeof value.reused !== 'boolean' || event.requestId !== intent.requestId || event.amendmentPlanId !== intent.amendmentPlanId ||
    event.version !== intent.expectedEvidenceVersion + 1 || event.previousAmendmentId !== plan.previousAmendmentId || event.batchVersion !== intent.expectedBatchVersion ||
    event.sourceRevision !== intent.expectedSourceRevision || event.assetId !== intent.assetId || event.note !== intent.note || event.evidenceReference !== intent.evidenceReference ||
    event.amendedById !== expected.actorId || !sameSnapshot(event.snapshot,plan.proposed))) invalid();
  return event;
}
const path = (id: string) => '/inventory/imports/evidence/' + encodeURIComponent(id);
function bounded(signal?: globalThis.AbortSignal) { const deadline = globalThis.AbortSignal.timeout(30_000); return signal ? globalThis.AbortSignal.any([signal,deadline]) : deadline; }
export async function readAmendments(owner: EvidenceOwner, offset: number, signal: globalThis.AbortSignal): Promise<AmendmentPage> {
  const value = await apiRequest<unknown>(path(owner.id) + '/amendments?limit=25&offset=' + offset, { signal: bounded(signal) });
  if (!scope(value) || !original(value.originalEvidence,owner) || !current(value.current,value.originalEvidence) ||
    !Array.isArray(value.events) || !value.events.every((entry) => metadata(entry,owner.id)) || value.total !== value.current.evidenceVersion ||
    value.offset !== offset || value.limit !== 25 || value.events.length !== Math.min(25,Math.max(0,Number(value.total)-offset)) ||
    value.hasMore !== (offset + value.events.length < Number(value.total)) ||
    !value.events.every((entry,index,events) => entry.version === Number(value.total)-offset-index && (index === events.length - 1 || entry.previousAmendmentId === events[index + 1].id)) || new Set(value.events.map((entry)=>entry.id)).size !== value.events.length) invalid();
  if (!offset && value.events.length && (value.events[0].id !== value.current.amendmentId || value.events[0].amendedAt !== value.current.amendedAt ||
    value.events[0].assetId !== value.current.assetId || value.events[0].effectiveDay !== value.current.effectiveDay || value.events[0].sourceRevision !== value.current.effectiveSourceRevision)) invalid();
  return { original:value.originalEvidence, current:value.current, events:value.events as AmendmentMetadata[], total:Number(value.total), offset, hasMore:Boolean(value.hasMore) };
}
export async function readAmendmentPlan(owner: EvidenceOwner, assetId: string | null, signal: globalThis.AbortSignal) {
  const deadline = bounded(signal); const token = await getCsrfToken(deadline);
  const value = await apiRequest<unknown>(path(owner.id) + '/amendment-plan', { method:'POST',signal:deadline,headers:{'X-CSRF-Token':token},body:JSON.stringify({assetId}) });
  return validateAmendmentPlan(value,owner,assetId);
}
export async function readAmendment(originalEvidence: OriginalEvidence, id: string, signal: globalThis.AbortSignal) {
  const value = await apiRequest<unknown>(path(originalEvidence.id) + '/amendments/' + encodeURIComponent(id), { signal:bounded(signal) });
  return validateAmendmentEvent(value,originalEvidence,{id});
}
export async function saveAmendment(plan: AmendmentPlan, intent: AmendmentIntent, actorId: string) {
  const signal = bounded(); const token = await getCsrfToken(signal);
  const value = await apiRequest<unknown>(path(plan.evidenceId) + '/amendments', { method:'POST',signal,headers:{'X-CSRF-Token':token},body:JSON.stringify(intent) });
  return validateAmendmentEvent(value,plan.originalEvidence,{intent,plan,actorId});
}
export function amendmentNeedsRecovery(error: unknown) {
  return !(error instanceof ApiRequestError) || error.status >= 500 || ['NETWORK_ERROR','INVALID_RESPONSE','EVIDENCE_AMENDMENT_BUSY','EVIDENCE_AMENDMENT_CONFLICT'].includes(error.code ?? '');
}
