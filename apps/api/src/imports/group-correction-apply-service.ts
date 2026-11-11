import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { groupCorrectionRequestDigest, type GroupCorrectionApplyInput } from './group-correction-apply-schemas.js';
import { readGroupAssignmentCorrectionPlan } from './group-assignment-correction-service.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { lockIdentityGroupSource } from './identity-group-review-service.js';

const scope = { scope: 'GROUP_CLOSED_ASSIGNMENT_CORRECTION', persisted: true, affectsCurrentState: false, evidenceRelinked: false,
  operationalHistoryApplied: true, canApply: false } as const;
type Parents = { batchId: string; reviewId: string; applicationId: string; itemId: string; groupApplicationId: string; assignmentItemId: string };
export async function requireCorrectionItem(transaction: Prisma.TransactionClient, parents: Parents) {
  const item = await transaction.importGroupAssignmentItem.findFirst({ where: { id: parents.assignmentItemId, applicationId: parents.groupApplicationId,
    application: { itemId: parents.itemId, item: { applicationId: parents.applicationId, application: { batchId: parents.batchId, reviewId: parents.reviewId } } } },
    select: { id: true, assignmentId: true, assignment: { select: { assetId: true } } } });
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Correction item not found in this saved origin');
  return item;
}

export async function applyGroupAssignmentCorrection(database: PrismaClient, parents: Parents, input: GroupCorrectionApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await lockIdentityGroupSource(transaction, parents.batchId);
      const item = await requireCorrectionItem(transaction, parents);
      const requestDigest = groupCorrectionRequestDigest(input);
      const previous = await transaction.importGroupAssignmentCorrection.findUnique({ where: { itemId_requestId: { itemId: item.id, requestId: input.requestId } } });
      if (previous) {
        if (previous.correctedById !== actorId || previous.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request belongs to another correction intent or actor');
        return { ...scope, reused: true, correction: previous };
      }
      await transaction.$executeRawUnsafe('LOCK TABLE "Product", "Asset", "Assignment", "ImportHistoryCapture", "ImportHistoricalEvidence", "ImportEvidenceAmendment", "ImportGroupHistoryApplication", "ImportGroupHistoryLink", "ImportGroupAssignmentCorrection" IN EXCLUSIVE MODE NOWAIT');
      const plan = await readGroupAssignmentCorrectionPlan(transaction, parents.batchId, parents.reviewId, parents.applicationId, parents.itemId,
        parents.groupApplicationId, parents.assignmentItemId, input.plan);
      if (!plan.planValidationComplete) throw new ApiError(409, 'GROUP_CORRECTION_PLAN_BLOCKED', 'Resolve every correction blocker', { blockers: plan.blockers });
      if (plan.correctionPlanId !== input.correctionPlanId) throw new ApiError(409, 'GROUP_CORRECTION_PLAN_CHANGED', 'Generate and review the current correction plan');
      const [snapshot] = await transaction.$queryRaw<{ assetSnapshot: Prisma.JsonObject; custodySnapshot: Prisma.JsonArray }[]>`
        SELECT to_jsonb(a) AS "assetSnapshot", coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s."id") FROM "Assignment" s
          WHERE s."assetId" = a."id" AND s."endedAt" IS NULL), '[]'::jsonb) AS "custodySnapshot" FROM "Asset" a WHERE a."id" = ${item.assignment.assetId}::uuid`;
      const [clock] = await transaction.$queryRaw<{ capturedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
      const correction = await transaction.importGroupAssignmentCorrection.create({ data: { itemId: item.id, version: plan.currentCorrectionVersion + 1,
        previousId: plan.currentCorrectionId, requestId: input.requestId, requestDigest, correctionPlanId: plan.correctionPlanId,
        rulesVersion: 'mda-group-assignment-correction-application-1', plan: JSON.parse(JSON.stringify(plan)) as Prisma.InputJsonObject,
        reason: input.plan.reason, supportingReference: input.plan.supportingReference, ...snapshot, correctedById: actorId, correctedAt: clock.capturedAt } });
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_GROUP_ASSIGNMENT_CORRECTED', entityType: 'ImportGroupAssignmentCorrection', entityId: correction.id,
        metadata: { ...parents, assignmentId: item.assignmentId, version: correction.version, previousId: correction.previousId, affectsCurrentState: false } } });
      return { ...scope, reused: false, correction };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'GROUP_CORRECTION_CONFLICT', 'Correction version, plan or request already exists');
      if (['P2028', 'P2034'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'GROUP_CORRECTION_BUSY', 'Correction is busy; retry with the same request id and body');
      }
    }
    throw error;
  }
}

export function listGroupAssignmentCorrections(database: PrismaClient, parents: Parents, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    await requireCorrectionItem(transaction, parents);
    const where = { itemId: parents.assignmentItemId };
    const corrections = await transaction.importGroupAssignmentCorrection.findMany({ where, select: { id: true, itemId: true, version: true, previousId: true,
      requestId: true, correctionPlanId: true, reason: true, supportingReference: true, correctedById: true, correctedAt: true },
      orderBy: { version: 'desc' }, take: query.limit, skip: query.offset });
    const total = await transaction.importGroupAssignmentCorrection.count({ where });
    return { ...scope, corrections, total, ...query, hasMore: query.offset + corrections.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export function getGroupAssignmentCorrection(database: PrismaClient, parents: Parents, correctionId: string) {
  return database.$transaction(async (transaction) => {
    await requireCorrectionItem(transaction, parents);
    const correction = await transaction.importGroupAssignmentCorrection.findFirst({ where: { id: correctionId, itemId: parents.assignmentItemId } });
    if (!correction) throw new ApiError(404, 'NOT_FOUND', 'Correction receipt not found in this assignment');
    return { ...scope, correction };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
