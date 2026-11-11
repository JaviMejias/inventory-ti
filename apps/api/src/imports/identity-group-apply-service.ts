import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { createAssetInTransaction, updateAssetInTransaction } from '../routes/assets-service.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { identityGroupApplyDigest, type IdentityGroupApplyInput } from './identity-group-apply-schemas.js';
import { readIdentityGroupPilot } from './identity-group-pilot-service.js';
import { lockIdentityGroupSource } from './identity-group-review-service.js';

const include = { items: { orderBy: { groupKey: 'asc' as const }, include: { rows: { orderBy: { recordId: 'asc' as const } } } } };
const scope = { scope: 'IDENTITY_GROUP_ASSET_APPLICATION', mode: 'APPLIED', persisted: true, canApply: false,
  affectsCurrentState: true, groupedPilotImplemented: true, evidenceRelinked: false } as const;
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

export async function applyIdentityGroupPilot(database: PrismaClient, batchId: string, reviewId: string, input: IdentityGroupApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await lockIdentityGroupSource(transaction, batchId);
      const review = await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId }, select: { id: true, sourceHash: true } });
      if (!review) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
      const digest = identityGroupApplyDigest(input);
      const previous = await transaction.importIdentityGroupApplication.findUnique({ where: { reviewId_requestId: { reviewId, requestId: input.requestId } }, include });
      if (previous) {
        if (previous.appliedById !== actorId || previous.requestDigest !== digest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to another group application or actor');
        return { ...scope, application: previous, reused: true };
      }
      // NOWAIT avoids lock-order inversion with legacy inventory writers.
      await transaction.$executeRawUnsafe('LOCK TABLE "Product", "Asset", "ImportHistoryCapture", "ImportHistoricalEvidence", "ImportEvidenceAmendment" IN EXCLUSIVE MODE NOWAIT');
      const consumed = await transaction.importIdentityGroupRowUse.findFirst({ where: { sourceHash: review.sourceHash,
        item: { application: { reviewId }, groupKey: { in: input.plan.operations.map((operation) => operation.groupKey) } } },
        select: { recordId: true, itemId: true } });
      if (consumed) throw new ApiError(409, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED', 'A selected group was already applied; retrieve its receipt', consumed);
      const plan = await readIdentityGroupPilot(transaction, batchId, reviewId, input.plan);
      if (!plan.planValidationComplete) throw new ApiError(409, 'IDENTITY_GROUP_PILOT_BLOCKED', 'Resolve every selected group blocker before applying', {
        operations: plan.operations.filter((operation) => !operation.valid).map((operation) => ({ groupKey: operation.groupKey, blockers: operation.blockers }))
      });
      if (plan.planId !== input.planId) throw new ApiError(409, 'IDENTITY_GROUP_PILOT_CHANGED', 'Generate and confirm the current group pilot plan');
      const application = await transaction.importIdentityGroupApplication.create({ data: { batchId, reviewId, sourceHash: review.sourceHash,
        requestId: input.requestId, requestDigest: digest, planId: plan.planId, plan: json(plan), appliedById: actorId } });
      for (const operation of plan.operations) {
        const asset = operation.type === 'CREATE_ASSET'
          ? await createAssetInTransaction(transaction, operation.values, actorId)
          : await updateAssetInTransaction(transaction, operation.assetId, operation.values, actorId);
        const item = await transaction.importIdentityGroupApplicationItem.create({ data: { applicationId: application.id, groupKey: operation.groupKey,
          groupId: operation.groupId, decisionId: operation.decisionId, assetId: asset.id, operation: json(operation),
          result: json(Object.fromEntries(Object.entries(asset).filter(([key]) => key !== 'groupRetirement'))) } });
        await transaction.importIdentityGroupRowUse.createMany({ data: operation.source.map((row) => ({ sourceHash: review.sourceHash,
          recordId: row.recordId, originalCandidateId: row.originalCandidateId, reviewId, itemId: item.id })) });
      }
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_IDENTITY_GROUP_PILOT_APPLIED', entityType: 'ImportIdentityGroupApplication',
        entityId: application.id, metadata: { batchId, reviewId, sourceHash: review.sourceHash, planId: plan.planId,
          operationCount: plan.operations.length, observationCount: plan.summary.selectedObservationCount, affectsCurrentState: true, evidenceRelinked: false } } });
      return { ...scope, application: await transaction.importIdentityGroupApplication.findUniqueOrThrow({ where: { id: application.id }, include }), reused: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'IDENTITY_GROUP_APPLICATION_CONFLICT', 'Retrieve the existing receipt; the plan or source row was already applied');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'IDENTITY_GROUP_APPLY_BUSY', 'Inventory is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

export async function getIdentityGroupApplication(database: PrismaClient, batchId: string, reviewId: string, applicationId: string) {
  const application = await database.importIdentityGroupApplication.findFirst({ where: { id: applicationId, batchId, reviewId }, include });
  if (!application) throw new ApiError(404, 'NOT_FOUND', 'Group application not found in this review');
  return { ...scope, application };
}

export async function listIdentityGroupApplications(database: PrismaClient, batchId: string, reviewId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
    const where = { reviewId, batchId };
    const applications = await transaction.importIdentityGroupApplication.findMany({ where, select: { id: true, batchId: true, reviewId: true,
      sourceHash: true, requestId: true, planId: true, appliedById: true, appliedAt: true }, orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importIdentityGroupApplication.count({ where });
    return { ...scope, applications, total, ...query, hasMore: query.offset + applications.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
