import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { currentHistoricalEvidence, latestAmendmentInclude } from './evidence-current.js';
import type { EvidenceAmendmentInput } from './evidence-amendment-schemas.js';
import { readHistoryPreview } from './history-service.js';
import { historicalLinkBasis, historyRulesVersion } from './history.js';
import { importPlanDigest } from './plan.js';

export const evidenceAmendmentRulesVersion = 'mda-history-amendment-1';
const scope = { scope: 'HISTORICAL_EVIDENCE_ONLY', affectsCurrentState: false, canApply: false } as const;
const amendmentMetadataSelect = { id: true, evidenceId: true, version: true, previousAmendmentId: true, batchVersion: true, sourceRevision: true,
  requestId: true, amendmentPlanId: true, rulesVersion: true, assetId: true, effectiveDay: true, note: true, evidenceReference: true, amendedById: true, amendedAt: true };
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

export async function readEvidenceAmendmentPlan(transaction: Prisma.TransactionClient, id: string, assetId: string | null) {
  const original = await transaction.importHistoricalEvidence.findUnique({ where: { id }, include: { ...latestAmendmentInclude, capture: true } });
  if (!original) throw new ApiError(404, 'NOT_FOUND', 'Historical evidence not found');
  const current = currentHistoricalEvidence(original);
  const view = await readHistoryPreview(transaction, original.capture.batchId);
  const observation = view.observations.find((item) => item.recordId === original.recordId && item.kind === original.kind);
  const assignmentUse = await transaction.importAssignmentEvidenceUse.findUnique({ where: { evidenceId: id } });
  const retirementUse = await transaction.importRetirementApplication.findUnique({ where: { evidenceId: id }, select: { id: true, evidenceId: true } });
  const used = assignmentUse ?? (retirementUse ? { evidenceId: retirementUse.evidenceId, itemId: retirementUse.id, endpoint: 'RETIREMENT' } : null);
  const blockers: string[] = [];
  if (await transaction.importGroupHistoryLink.findUnique({ where: { evidenceId: id }, select: { id: true } })) blockers.push('GROUP_HISTORY_LINK_ALREADY_SAVED');
  if (used) blockers.push('EVIDENCE_ALREADY_APPLIED');
  if (current.evidenceVersion >= 1000) blockers.push('EVIDENCE_AMENDMENT_LIMIT');
  if (original.capture.rulesVersion !== historyRulesVersion) blockers.push('EVIDENCE_RULES_CHANGED');
  if (!observation || observation.candidateId !== original.candidateId) blockers.push('OBSERVATION_NO_LONGER_MAPPED');
  const linkBasis = observation ? historicalLinkBasis(observation, assetId, view.decisions, view.applied, view.resolved.sourceContext) : undefined;
  if (linkBasis === undefined) blockers.push('HISTORY_ASSET_LINK_UNCONFIRMED');
  const proposed = observation && linkBasis !== undefined ? { ...observation, assetId, linkBasis } : null;
  const sourceRevision = view.resolved.sourceContext.revision;
  if (proposed && assetId === current.assetId && sourceRevision === current.effectiveSourceRevision && importPlanDigest(proposed) === importPlanDigest(current.snapshot)) {
    blockers.push('EVIDENCE_AMENDMENT_UNCHANGED');
  }
  const content = { rulesVersion: evidenceAmendmentRulesVersion, evidenceId: id, batchId: original.capture.batchId,
    batchVersion: view.resolved.batch.version, sourceRevision, evidenceVersion: current.evidenceVersion,
    previousAmendmentId: current.amendmentId, originalEvidence: { ...original, amendments: undefined }, current, proposed, used,
    historyPreviewId: view.historyPreviewId, blockers };
  return { ...scope, ...content, mode: 'EVIDENCE_AMENDMENT_PLAN', amendmentPlanId: importPlanDigest(content), persisted: false, valid: blockers.length === 0 };
}

export function planEvidenceAmendment(database: PrismaClient, id: string, assetId: string | null) {
  return database.$transaction((transaction) => readEvidenceAmendmentPlan(transaction, id, assetId),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function amendHistoricalEvidence(database: PrismaClient, id: string, input: EvidenceAmendmentInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      const requestDigest = importPlanDigest(input);
      const lookup = () => transaction.importEvidenceAmendment.findUnique({ where: { evidenceId_requestId: { evidenceId: id, requestId: input.requestId } } });
      const reuse = (event: NonNullable<Awaited<ReturnType<typeof lookup>>>) => {
        if (event.amendedById !== actorId || event.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to a different evidence amendment');
        return { ...scope, persisted: true, reused: true, event };
      };
      const previous = await lookup(); if (previous) return reuse(previous);
      const evidence = await transaction.importHistoricalEvidence.findUnique({ where: { id }, include: { capture: { select: { batchId: true } } } });
      if (!evidence) throw new ApiError(404, 'NOT_FOUND', 'Historical evidence not found');
      await transaction.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${evidence.capture.batchId}::uuid FOR NO KEY UPDATE`;
      await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${evidence.sourceHash}, 0))`;
      await transaction.$queryRaw`SELECT "id" FROM "ImportHistoricalEvidence" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`;
      const recovered = await lookup(); if (recovered) return reuse(recovered);
      if (input.assetId) {
        const assets = await transaction.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Asset" WHERE "id" = ${input.assetId}::uuid FOR SHARE`;
        if (!assets[0]) throw new ApiError(404, 'NOT_FOUND', 'Linked asset not found');
      }
      const plan = await readEvidenceAmendmentPlan(transaction, id, input.assetId);
      if (plan.evidenceVersion !== input.expectedEvidenceVersion) throw new ApiError(409, 'EVIDENCE_VERSION_CONFLICT', 'Reload evidence amendments', { currentVersion: plan.evidenceVersion });
      if (plan.batchVersion !== input.expectedBatchVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the review batch', { currentVersion: plan.batchVersion });
      if (plan.sourceRevision !== input.expectedSourceRevision) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload the source interpretation', { currentRevision: plan.sourceRevision });
      if (plan.used) throw new ApiError(409, 'EVIDENCE_ALREADY_APPLIED', 'Applied historical evidence requires a separate operational amendment workflow', { itemId: plan.used.itemId });
      if (plan.amendmentPlanId !== input.amendmentPlanId) throw new ApiError(409, 'EVIDENCE_AMENDMENT_PLAN_CHANGED', 'Generate and review the current evidence amendment plan');
      if (!plan.valid || !plan.proposed) throw new ApiError(409, 'EVIDENCE_AMENDMENT_BLOCKED', 'Resolve evidence amendment blockers', { blockers: plan.blockers });
      const event = await transaction.importEvidenceAmendment.create({ data: { evidenceId: id, version: plan.evidenceVersion + 1,
        previousAmendmentId: plan.previousAmendmentId, batchVersion: plan.batchVersion, sourceRevision: plan.sourceRevision,
        requestId: input.requestId, requestDigest, amendmentPlanId: plan.amendmentPlanId, rulesVersion: evidenceAmendmentRulesVersion,
        assetId: input.assetId, effectiveDay: plan.proposed.effectiveDay, snapshot: json(plan.proposed), note: input.note,
        evidenceReference: input.evidenceReference, amendedById: actorId, amendedAt: new Date() } });
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_HISTORY_EVIDENCE_AMENDED', entityType: 'ImportEvidenceAmendment', entityId: event.id,
        metadata: { evidenceId: id, batchId: plan.batchId, evidenceVersion: event.version, sourceRevision: event.sourceRevision, affectsCurrentState: false } } });
      return { ...scope, persisted: true, reused: false, event };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'EVIDENCE_AMENDMENT_CONFLICT', 'Evidence version or request already recorded; reload its amendments');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'EVIDENCE_AMENDMENT_BUSY', 'Evidence amendment is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

export async function listEvidenceAmendments(database: PrismaClient, id: string, query: { limit: number; offset: number }) {
  return database.$transaction(async (transaction) => {
    const original = await transaction.importHistoricalEvidence.findUnique({ where: { id }, include: { ...latestAmendmentInclude, capture: true } });
    if (!original) throw new ApiError(404, 'NOT_FOUND', 'Historical evidence not found');
    const events = await transaction.importEvidenceAmendment.findMany({ where: { evidenceId: id }, select: amendmentMetadataSelect,
      orderBy: { version: 'desc' }, take: query.limit, skip: query.offset });
    const total = await transaction.importEvidenceAmendment.count({ where: { evidenceId: id } });
    return { ...scope, originalEvidence: { ...original, amendments: undefined }, current: currentHistoricalEvidence(original),
      events, total, limit: query.limit, offset: query.offset, hasMore: query.offset + events.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function getEvidenceAmendment(database: PrismaClient, id: string, amendmentId: string) {
  const event = await database.importEvidenceAmendment.findFirst({ where: { id: amendmentId, evidenceId: id } });
  if (!event) throw new ApiError(404, 'NOT_FOUND', 'Evidence amendment not found for this observation');
  return { ...scope, persisted: true, event };
}
