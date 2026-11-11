import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { groupRetirementRequestDigest, type GroupRetirementApplyInput } from './group-retirement-apply-schemas.js';
import { readGroupRetirementPlan } from './group-retirement-plan-service.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { lockIdentityGroupSource } from './identity-group-review-service.js';

const scope = { scope: 'GROUP_VERIFIED_HISTORICAL_RETIREMENT', persisted: true, affectsCurrentState: true, evidenceRelinked: false, historicalActorKnown: false } as const;
const include = { rows: { orderBy: { recordId: 'asc' as const } } };
export const groupRetirementRulesVersion = 'mda-group-retirement-application-1';
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
async function requireReview(transaction: Prisma.TransactionClient, batchId: string, reviewId: string) {
  if (!await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
}

export async function applyGroupRetirement(database: PrismaClient, batchId: string, reviewId: string, input: GroupRetirementApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await lockIdentityGroupSource(transaction, batchId);
      await requireReview(transaction, batchId, reviewId);
      const requestDigest = groupRetirementRequestDigest(input);
      const previous = await transaction.importGroupRetirementApplication.findUnique({ where: { reviewId_requestId: { reviewId, requestId: input.requestId } }, include });
      if (previous) {
        if (previous.appliedById !== actorId || previous.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request belongs to another retirement intent or actor');
        return { ...scope, reused: true, application: previous };
      }
      await transaction.$executeRawUnsafe('LOCK TABLE "Product", "Asset", "Assignment", "ImportHistoricalEvidence", "ImportHistoryCapture", "ImportEvidenceAmendment", "ImportIdentityGroupReview", "ImportIdentityGroupRow", "ImportIdentityGroupRelease", "ImportIdentityGroupDecision", "ImportSourceRevision", "ImportIdentityGroupRowUse", "ImportGroupRetirementApplication", "ImportGroupRetirementRowUse" IN EXCLUSIVE MODE NOWAIT');
      const plan = await readGroupRetirementPlan(transaction, batchId, reviewId, input.plan);
      if (!plan.planValidationComplete) throw new ApiError(409, 'GROUP_RETIREMENT_PLAN_BLOCKED', 'Resolve every grouped retirement blocker', { blockers: plan.blockers });
      if (plan.planId !== input.planId) throw new ApiError(409, 'GROUP_RETIREMENT_PLAN_CHANGED', 'Generate and review the current grouped retirement plan');
      const [snapshot] = await transaction.$queryRaw<{ assetSnapshot: Prisma.JsonObject }[]>`SELECT to_jsonb(a) AS "assetSnapshot" FROM "Asset" a WHERE a."id" = ${plan.assetBefore.id}::uuid FOR UPDATE`;
      const [clock] = await transaction.$queryRaw<{ capturedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
      const decommissionedAt = new Date(plan.proposedRetirement.decommissionedAt!);
      const result = { ...snapshot.assetSnapshot, status: 'DECOMMISSIONED', isActive: false, decommissionedAt: decommissionedAt.toISOString(), updatedAt: clock.capturedAt.toISOString() };
      const application = await transaction.importGroupRetirementApplication.create({ data: { batchId, reviewId, decisionId: plan.decisionId,
        groupId: plan.groupId, groupKey: plan.groupKey, sourceHash: plan.sourceHash, assetId: plan.assetBefore.id, evidenceId: plan.source.evidenceId,
        evidenceVersion: plan.source.evidenceVersion, amendmentId: plan.source.amendmentId, sourceRevision: plan.source.sourceRevision, decommissionedAt,
        requestId: input.requestId, requestDigest, planId: plan.planId, rulesVersion: groupRetirementRulesVersion, plan: json(plan), result: json(result),
        assetSnapshot: snapshot.assetSnapshot, appliedById: actorId, appliedAt: clock.capturedAt } });
      await transaction.importGroupRetirementRowUse.createMany({ data: plan.sourceRows.map((row) => ({ sourceHash: plan.sourceHash,
        recordId: row.recordId, originalCandidateId: row.originalCandidateId, reviewId, applicationId: application.id })) });
      await transaction.asset.update({ where: { id: application.assetId }, data: { status: 'DECOMMISSIONED', isActive: false, decommissionedAt, updatedAt: clock.capturedAt } });
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_GROUP_RETIREMENT_APPLIED', entityType: 'ImportGroupRetirementApplication', entityId: application.id,
        metadata: { batchId, reviewId, assetId: application.assetId, evidenceId: application.evidenceId, groupKey: plan.groupKey, planId: plan.planId, historicalActorKnown: false, affectsCurrentState: true } } });
      return { ...scope, reused: false, application: await transaction.importGroupRetirementApplication.findUniqueOrThrow({ where: { id: application.id }, include }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'GROUP_RETIREMENT_APPLICATION_CONFLICT', 'Asset, evidence, source, plan or request already has a retirement receipt');
      if (['P2028', 'P2034'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) throw new ApiError(409, 'GROUP_RETIREMENT_APPLY_BUSY', 'Grouped retirement is busy; retry with the same request id and body');
    }
    throw error;
  }
}

export function listGroupRetirements(database: PrismaClient, batchId: string, reviewId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    await requireReview(transaction, batchId, reviewId);
    const applications = await transaction.importGroupRetirementApplication.findMany({ where: { reviewId }, select: { id: true, batchId: true, reviewId: true, groupKey: true, groupId: true,
      assetId: true, evidenceId: true, decommissionedAt: true, requestId: true, planId: true, rulesVersion: true, appliedById: true, appliedAt: true, _count: { select: { rows: true } } },
    orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importGroupRetirementApplication.count({ where: { reviewId } });
    return { ...scope, applications, ...query, total, hasMore: query.offset + applications.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export function getGroupRetirement(database: PrismaClient, batchId: string, reviewId: string, id: string) {
  return database.$transaction(async (transaction) => {
    await requireReview(transaction, batchId, reviewId);
    const application = await transaction.importGroupRetirementApplication.findFirst({ where: { id, reviewId }, include });
    if (!application) throw new ApiError(404, 'NOT_FOUND', 'Grouped retirement receipt not found in this review');
    return { ...scope, application };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
