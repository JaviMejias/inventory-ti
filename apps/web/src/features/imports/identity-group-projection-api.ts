import { ApiRequestError, apiRequest } from '../../lib/api';
import { validHistoricalInstant } from './closed-assignment-model';
import { sameSnapshot } from './history-evidence-api';
import { validIdentityGroupCandidate, validIdentityGroupCells, validIdentityGroupImpacts, validIdentityGroupIssue } from './identity-group-api';
import { freezeGroupReview, groupReviewUuid as uuid, type IdentityGroupReview } from './identity-group-review-model';
import { importReviewPath } from './import-review-api';
import type { IdentityGroupProjection } from './identity-group-projection-model';

type Value = Record<string, unknown>;
function object(value: unknown): value is Value { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown, max = 2147483647) { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max; }
function text(value: unknown) { return value === null || typeof value === 'string'; }
function list(value: unknown, guard: (entry: unknown) => boolean): value is unknown[] { return Array.isArray(value) && value.every(guard); }
function unique(rows: unknown[]) { return new Set(rows).size === rows.length; }
function invalid(): never { throw new ApiRequestError('Unexpected effective identity grouping', 200, 'INVALID_RESPONSE'); }

export function validateIdentityGroupProjection(value: unknown, review: IdentityGroupReview): IdentityGroupProjection {
  if (review.release || review.rows.some((row) => !row.isReserved)) invalid();
  return validateProjectionSnapshot(value, review);
}

export function validateArchivedIdentityGroupProjection(value: unknown, review: IdentityGroupReview): IdentityGroupProjection {
  if (review.rows.some((row) => row.isReserved !== !review.release)) invalid();
  return validateProjectionSnapshot(value, review);
}

function validateProjectionSnapshot(value: unknown, review: IdentityGroupReview): IdentityGroupProjection {
  if (!review.rows.length || review.rows.length > 25) invalid();
  const groups = new Map(review.plan.request.groups.map((group) => [group.groupId, group]));
  const originals = new Map(review.rows.map((row) => [row.recordId, row]));
  const recordIds = new Set(originals.keys()); const candidateIds = new Set(review.plan.request.candidateIds);
  if (!object(value) || value.rulesVersion !== 'mda-identity-group-projection-1' || value.scope !== 'IDENTITY_GROUP_EFFECTIVE_PREVIEW' ||
    value.reviewId !== review.id || value.batchId !== review.batchId || value.sourceHash !== review.sourceHash || value.reviewedPlanId !== review.planId ||
    !integer(value.batchVersion) || Number(value.batchVersion) < review.batchVersion || !integer(value.sourceRevision, 1000) || Number(value.sourceRevision) < review.sourceRevision ||
    value.timeZone !== 'America/Santiago' || typeof value.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf) || !validHistoricalInstant(value.asOf + 'T00:00:00Z') ||
    !['projectionId', 'reviewedPlanId', 'currentScenarioPlanId', 'currentPreviewDigest', 'projectedPreviewDigest', 'sourceContextDigest'].every((key) => hash(value[key])) ||
    ['canApply', 'persisted', 'affectsCurrentState', 'groupedPilotImplemented'].some((key) => value[key] !== false) || value.reviewPersisted !== true || value.requiresNewDecisions !== true ||
    !['IDENTITY_ONLY', 'SPLIT', 'MERGE', 'REPARTITION'].includes(String(value.operationKind)) || value.operationKind !== review.plan.operationKind ||
    !object(value.freshness) || !sameSnapshot(value.freshness, {
      reviewSnapshotCurrent: value.reviewedPlanId === value.currentScenarioPlanId, batchVersionChanged: value.batchVersion !== review.batchVersion,
      sourceRevisionChanged: value.sourceRevision !== review.sourceRevision, asOfChanged: value.asOf !== review.plan.asOf,
      sourceContextChanged: value.sourceContextDigest !== review.plan.sourceContextDigest, currentPreviewChanged: value.currentPreviewDigest !== review.plan.currentPreviewDigest
    }) || !validIdentityGroupImpacts(value.impacts, candidateIds, recordIds)) invalid();
  const impacts = value.impacts;
  if (!list(value.groups, (entry) => {
    if (!object(entry) || !hash(entry.groupKey) || entry.reviewId !== review.id || entry.requiresNewDecision !== true) return false;
    const requested = groups.get(String(entry.groupId));
    if (!requested || !['groupId', 'recordIds', 'serialNumber', 'assetTag', 'evidenceReference'].every((key) => sameSnapshot(entry[key], requested[key as keyof typeof requested])) ||
      !sameSnapshot(entry.originalCandidateIds, [...new Set(requested.recordIds.map((id) => originals.get(id)?.originalCandidateId))].sort()) ||
      !list(entry.candidates, (candidate) => validIdentityGroupCandidate(candidate, recordIds)) || !unique(entry.candidates.map((candidate) => (candidate as Value).id)) ||
      !list(entry.simulatedCandidateIds, hash) || !sameSnapshot(entry.simulatedCandidateIds, entry.candidates.map((candidate) => (candidate as Value).id).sort())) return false;
    if (!list(entry.observations, (observation) => {
      if (!object(observation)) return false;
      const saved = originals.get(String(observation.recordId));
      return Boolean(saved && saved.groupId === entry.groupId && observation.groupKey === entry.groupKey && observation.sheet === saved.snapshot.sheet && observation.row === saved.snapshot.row &&
        observation.originalCandidateId === saved.originalCandidateId && typeof observation.hidden === 'boolean' && ['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(String(observation.kind)) &&
        ['originalIdentityCells', 'reviewedIdentityCells', 'currentIdentityCells'].every((key) => validIdentityGroupCells(observation[key])) &&
        sameSnapshot(observation.originalIdentityCells, saved.snapshot.originalIdentityCells) && sameSnapshot(observation.reviewedIdentityCells, saved.snapshot.currentIdentityCells) &&
        sameSnapshot(observation.currentIdentityCells, saved.snapshot.currentIdentityCells) && object(observation.projectedIdentity) &&
        Object.keys(observation.projectedIdentity).length === 2 && ['serialKey', 'tagKey'].every((key) => Object.hasOwn(observation.projectedIdentity as Value, key) && text((observation.projectedIdentity as Value)[key])) &&
        object(observation.fields) && Object.values(observation.fields).every(text) && [null, 'AVAILABLE', 'DECOMMISSIONED'].includes(observation.statusEvidence as string | null));
    }) || entry.observations.length !== requested.recordIds.length || !unique(entry.observations.map((row) => (row as Value).recordId))) return false;
    const groupRecords = new Set(requested.recordIds);
    const groupCandidates = new Set(entry.originalCandidateIds as string[]);
    const evidence = impacts.evidence.filter((row) => groupRecords.has(row.recordId));
    const evidenceById = new Map(evidence.map((row) => [row.id, row]));
    if (!list(entry.evidence, (row) => {
      if (!object(row) || row.linkedToGroup !== false || row.requiresExplicitLineageReview !== true) return false;
      const metadata = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'linkedToGroup' && key !== 'requiresExplicitLineageReview'));
      return sameSnapshot(evidenceById.get(String(row.id)), metadata);
    }) || entry.evidence.length !== evidence.length || !unique(entry.evidence.map((row) => (row as Value).id)) || entry.requiresEvidenceLineageReview !== (evidence.length > 0) ||
      !sameSnapshot(entry.originalDecisions, impacts.decisions.filter((row) => groupCandidates.has(row.targetId)))) return false;
    return true;
  }) || value.groups.length !== groups.size || !unique(value.groups.map((row) => (row as Value).groupId)) || !unique(value.groups.map((row) => (row as Value).groupKey))) invalid();
  const observations = new Map(value.groups.flatMap((group) => (group as Value).observations as Value[]).map((row) => [row.recordId, row]));
  if (observations.size !== recordIds.size || !list(value.changes, (entry) => {
    if (!object(entry) || !recordIds.has(String(entry.recordId)) || !['serialNumber', 'assetTag'].includes(String(entry.field)) || entry.action !== 'REPLACE' || typeof entry.column !== 'string' || !/^[A-Z]{1,3}$/.test(entry.column)) return false;
    const row = observations.get(entry.recordId); if (!row) return false;
    const group = groups.get(originals.get(String(entry.recordId))!.groupId)!; const field = entry.field as 'serialNumber' | 'assetTag';
    return entry.candidateId === row.originalCandidateId && entry.sheet === row.sheet && entry.row === row.row && entry.value === group[field] &&
      sameSnapshot(entry.originalCell, (row.originalIdentityCells as Value)[field]) && sameSnapshot(entry.beforeCell, (row.currentIdentityCells as Value)[field]) &&
      object(entry.afterCell) && entry.afterCell.type === 'text' && entry.afterCell.value === entry.value;
  }) || value.changes.length > 50 || !unique(value.changes.map((row) => (row as Value).recordId + ':' + (row as Value).field)) ||
    !list(value.issues, validIdentityGroupIssue) || !list(value.warnings, validIdentityGroupIssue) || !sameSnapshot(value.warnings, value.issues.filter((row) => (row as Value).severity === 'WARNING')) ||
    !list(value.blockers, (row) => object(row) && typeof row.code === 'string' && (row.groupId === undefined || groups.has(String(row.groupId))) &&
      (row.recordId === undefined || recordIds.has(String(row.recordId))) && (row.relatedId === undefined || typeof row.relatedId === 'string') && (row.issue === undefined || validIdentityGroupIssue(row.issue))) ||
    value.projectionValidationComplete !== (value.blockers.length === 0) || value.requiresEvidenceLineageReview !== (impacts.evidence.length > 0) ||
    !sameSnapshot(value.summary, { originalCandidateCount: candidateIds.size, proposedGroupCount: groups.size, observationCount: recordIds.size, changedCellCount: value.changes.length, blockingCount: value.blockers.length, warningCount: value.warnings.length })) invalid();
  return freezeGroupReview(globalThis.structuredClone(value)) as IdentityGroupProjection;
}

export async function readIdentityGroupProjection(review: IdentityGroupReview, signal: globalThis.AbortSignal) {
  if (!uuid(review.batchId) || !uuid(review.id) || review.release) throw new ApiRequestError('Consulta una reserva activa de este lote.', 400, 'VALIDATION_ERROR');
  const captured = globalThis.structuredClone(review);
  const response = await apiRequest<unknown>(`${importReviewPath}/${captured.batchId}/identity-group-reviews/${captured.id}/effective-preview`, {
    signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)])
  });
  return validateIdentityGroupProjection(response, captured);
}
