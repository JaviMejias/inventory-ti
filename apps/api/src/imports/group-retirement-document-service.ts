import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { groupRetirementDocumentRequestDigest, type GroupRetirementDocumentApplyInput } from './group-retirement-document-schemas.js';
import { groupRetirementDocumentRulesVersion, readGroupRetirementDocumentPlan } from './group-retirement-document-plan-service.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { lockIdentityGroupSource } from './identity-group-review-service.js';

const scope = { scope: 'GROUP_RETIREMENT_DOCUMENT_RECONCILIATION', persisted: true, affectsCurrentState: false,
  evidenceRelinked: false, confirmsSourceDate: false, consumesOperationalEvidence: false, historicalActorKnown: false } as const;
const metadataSelect = { id: true, batchId: true, reviewId: true, decisionId: true, groupId: true, groupKey: true, sourceHash: true, assetId: true, evidenceId: true,
  evidenceVersion: true, amendmentId: true, sourceRevision: true, requestId: true, planId: true, rulesVersion: true, recordedAt: true, recordedById: true };
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
async function requireReview(transaction: Prisma.TransactionClient, batchId: string, reviewId: string) {
  if (!await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
}
export async function recordGroupRetirementDocument(database: PrismaClient, batchId: string, reviewId: string, input: GroupRetirementDocumentApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await lockIdentityGroupSource(transaction, batchId); await requireReview(transaction, batchId, reviewId);
      const requestDigest = groupRetirementDocumentRequestDigest(input);
      const previous = await transaction.importGroupRetirementDocument.findUnique({ where: { reviewId_requestId: { reviewId, requestId: input.requestId } } });
      if (previous) {
        if (previous.recordedById !== actorId || previous.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request belongs to a different group documentary intent or actor');
        return { ...scope, reused: true, reconciliation: previous };
      }
      await transaction.$executeRawUnsafe('LOCK TABLE "Asset", "Product", "Assignment", "User", "ImportHistoricalEvidence", "ImportHistoryCapture", "ImportEvidenceAmendment", "ImportSourceRevision", "ImportIdentityGroupReview", "ImportIdentityGroupRow", "ImportIdentityGroupRelease", "ImportIdentityGroupDecision", "ImportIdentityGroupRowUse", "ImportGroupRetirementRowUse", "ImportGroupAssignmentCorrection", "ImportRetirementReconciliation", "ImportGroupRetirementDocument" IN EXCLUSIVE MODE NOWAIT');
      const actor = await transaction.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true, passwordHash: true } });
      if (!actor?.isActive || actor.role !== 'JEFE' || !actor.passwordHash) throw new ApiError(403, 'FORBIDDEN', 'Only an active configured JEFE can reconcile group documents');
      const plan = await readGroupRetirementDocumentPlan(transaction, batchId, reviewId, input.plan);
      if (!plan.planValidationComplete) throw new ApiError(409, 'GROUP_DOCUMENT_BLOCKED', 'Resolve every group documentary blocker', { blockers: plan.blockers });
      if (plan.planId !== input.planId) throw new ApiError(409, 'GROUP_DOCUMENT_PLAN_CHANGED', 'Generate and review the current group documentary plan');
      const [clock] = await transaction.$queryRaw<{ recordedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "recordedAt"`;
      const reconciliation = await transaction.importGroupRetirementDocument.create({ data: { batchId, reviewId, decisionId: plan.decisionId,
        groupId: plan.groupId, groupKey: plan.groupKey, sourceHash: plan.sourceHash, assetId: plan.assetBefore.id, evidenceId: plan.source.evidenceId,
        evidenceVersion: plan.source.evidenceVersion, amendmentId: plan.source.amendmentId, sourceRevision: plan.source.sourceRevision,
        requestId: input.requestId, requestDigest, planId: plan.planId, rulesVersion: groupRetirementDocumentRulesVersion,
        plan: json(plan), recordedById: actorId, recordedAt: clock!.recordedAt } });
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_GROUP_RETIREMENT_DOCUMENT_RECONCILED', entityType: 'ImportGroupRetirementDocument',
        entityId: reconciliation.id, metadata: { batchId, reviewId, assetId: reconciliation.assetId, evidenceId: reconciliation.evidenceId,
          evidenceVersion: reconciliation.evidenceVersion, planId: plan.planId, affectsCurrentState: false, confirmsSourceDate: false, consumesOperationalEvidence: false } } });
      return { ...scope, reused: false, reconciliation };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'GROUP_DOCUMENT_CONFLICT', 'This evidence version was already documented; retrieve its receipt');
      if (['P2034','P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03','40P01','40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'GROUP_DOCUMENT_BUSY', 'Group documentary reconciliation is busy; retry the same request');
      }
    }
    throw error;
  }
}
export async function listGroupRetirementDocuments(database: PrismaClient, batchId: string, reviewId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    await requireReview(transaction, batchId, reviewId);
    const reconciliations = await transaction.importGroupRetirementDocument.findMany({ where: { reviewId }, select: metadataSelect,
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importGroupRetirementDocument.count({ where: { reviewId } });
    return { ...scope, reconciliations, total, limit: query.limit, offset: query.offset, hasMore: query.offset + reconciliations.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export async function getGroupRetirementDocument(database: PrismaClient, batchId: string, reviewId: string, reconciliationId: string) {
  const reconciliation = await database.importGroupRetirementDocument.findFirst({ where: { id: reconciliationId, batchId, reviewId } });
  if (!reconciliation) throw new ApiError(404, 'NOT_FOUND', 'Group documentary receipt not found in this review');
  return { ...scope, reconciliation };
}
