import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { groupHistoryApplyDigest, type GroupHistoryApplyInput } from './identity-group-history-apply-schemas.js';
import { readGroupHistoryLinkPlan } from './identity-group-history-service.js';
import { lockIdentityGroupSource } from './identity-group-review-service.js';
import { identifierKey } from './preview.js';

export const groupHistoryApplicationRulesVersion = 'mda-group-history-link-application-1';
const include = { links: { orderBy: { evidenceId: 'asc' as const } } };
const scope = { scope: 'IDENTITY_GROUP_HISTORY_LINK_APPLICATION', persisted: true, canApply: false,
  affectsCurrentState: false, evidenceRelinked: false, historyProjectionPersisted: true, operationalHistoryApplied: false } as const;
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

export function buildGroupHistoryProjection(operation: Pick<Awaited<ReturnType<typeof readGroupHistoryLinkPlan>>['operations'][number],
  'currentSnapshot' | 'proposedAssetId' | 'proposedIdentity'>, itemId: string) {
  const snapshot = operation.currentSnapshot as Prisma.JsonObject;
  const effective = snapshot.effective as Prisma.JsonObject;
  const fields = effective.fields as Prisma.JsonObject;
  return { ...snapshot, assetId: operation.proposedAssetId, identityLinkBlocked: false,
    linkBasis: { type: 'APPLIED_IDENTITY_GROUP', id: itemId },
    effective: { ...effective, serialKey: identifierKey(operation.proposedIdentity.serialNumber), tagKey: identifierKey(operation.proposedIdentity.assetTag),
      fields: { ...fields, serialNumber: operation.proposedIdentity.serialNumber, assetTag: operation.proposedIdentity.assetTag } } };
}

export async function applyGroupHistoryLinks(database: PrismaClient, batchId: string, reviewId: string, applicationId: string,
  itemId: string, input: GroupHistoryApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await lockIdentityGroupSource(transaction, batchId);
      const item = await requireItem(transaction, batchId, reviewId, applicationId, itemId);
      const requestDigest = groupHistoryApplyDigest(input);
      const previous = await transaction.importGroupHistoryApplication.findUnique({ where: { itemId_requestId: { itemId, requestId: input.requestId } }, include });
      if (previous) {
        if (previous.appliedById !== actorId || previous.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to another history link confirmation or actor');
        return { ...scope, application: previous, reused: true };
      }
      // Match V21 lock ordering without waiting behind legacy inventory writers.
      await transaction.$executeRawUnsafe('LOCK TABLE "Product", "Asset", "ImportHistoryCapture", "ImportHistoricalEvidence", "ImportEvidenceAmendment" IN EXCLUSIVE MODE NOWAIT');
      const plan = await readGroupHistoryLinkPlan(transaction, batchId, reviewId, applicationId, itemId, input.plan);
      if (!plan.planValidationComplete) throw new ApiError(409, 'GROUP_HISTORY_LINK_BLOCKED', 'Resolve every selected history link blocker before confirming', {
        operations: plan.operations.filter((operation) => !operation.valid).map((operation) => ({ evidenceId: operation.evidenceId, blockers: operation.blockers }))
      });
      if (plan.historyLinkPlanId !== input.historyLinkPlanId) throw new ApiError(409, 'GROUP_HISTORY_LINK_PLAN_CHANGED', 'Generate and confirm the current history link plan');
      const [clock] = await transaction.$queryRaw<{ capturedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
      const application = await transaction.importGroupHistoryApplication.create({ data: { itemId, requestId: input.requestId, requestDigest,
        planId: plan.historyLinkPlanId, rulesVersion: groupHistoryApplicationRulesVersion, plan: json(plan), appliedById: actorId, appliedAt: clock.capturedAt } });
      for (const operation of plan.operations) {
        await transaction.importGroupHistoryLink.create({ data: { historyApplicationId: application.id, evidenceId: operation.evidenceId,
          assetId: item.assetId, version: 1, evidenceVersion: operation.evidenceVersion, amendmentId: operation.amendmentId,
          sourceRevision: operation.effectiveSourceRevision, operation: json(operation), projection: json(buildGroupHistoryProjection(operation, itemId)) } });
      }
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_GROUP_HISTORY_LINKS_SAVED', entityType: 'ImportGroupHistoryApplication', entityId: application.id,
        metadata: { batchId, reviewId, applicationId, itemId, planId: plan.historyLinkPlanId, assetId: item.assetId,
          evidenceCount: plan.operations.length, affectsCurrentState: false, historicalActorId: null } } });
      return { ...scope, application: await transaction.importGroupHistoryApplication.findUniqueOrThrow({ where: { id: application.id }, include }), reused: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'GROUP_HISTORY_LINK_CONFLICT', 'A selected evidence or plan already has a saved history link; retrieve its receipt');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'GROUP_HISTORY_LINK_BUSY', 'History link confirmation is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

async function requireItem(transaction: Prisma.TransactionClient, batchId: string, reviewId: string, applicationId: string, itemId: string) {
  const item = await transaction.importIdentityGroupApplicationItem.findFirst({ where: { id: itemId, applicationId, application: { batchId, reviewId } }, select: { id: true, assetId: true } });
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Applied group item not found in this review');
  return item;
}

export function getGroupHistoryApplication(database: PrismaClient, batchId: string, reviewId: string, applicationId: string, itemId: string, historyApplicationId: string) {
  return database.$transaction(async (transaction) => {
    await requireItem(transaction, batchId, reviewId, applicationId, itemId);
    const application = await transaction.importGroupHistoryApplication.findFirst({ where: { id: historyApplicationId, itemId }, include });
    if (!application) throw new ApiError(404, 'NOT_FOUND', 'History link receipt not found in this applied group');
    return { ...scope, application };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function listGroupHistoryApplications(database: PrismaClient, batchId: string, reviewId: string, applicationId: string, itemId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    await requireItem(transaction, batchId, reviewId, applicationId, itemId);
    const where = { itemId };
    const applications = await transaction.importGroupHistoryApplication.findMany({ where, select: { id: true, itemId: true, requestId: true, planId: true, rulesVersion: true,
      appliedById: true, appliedAt: true, _count: { select: { links: true } } }, orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importGroupHistoryApplication.count({ where });
    return { ...scope, applications, total, ...query, hasMore: query.offset + applications.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
