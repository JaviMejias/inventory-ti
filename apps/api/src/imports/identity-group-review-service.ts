import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { readIdentityGroupPlan } from './identity-group-plan-service.js';
import { identityGroupReviewDigest, type IdentityGroupReleaseInput, type IdentityGroupReviewInput } from './identity-group-review-schemas.js';
import { importPlanDigest } from './plan.js';

const include = { rows: { orderBy: { recordId: 'asc' as const } }, release: true };
const scope = { scope: 'IDENTITY_GROUP_REVIEW_ONLY', persisted: true, canApply: false, affectsCurrentState: false, groupedPilotImplemented: false } as const;
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function receipt<T>(review: T, reused: boolean) { return { ...scope, review, reused }; }
function checkReuse(actorId: string, digest: string, previousActor: string, previousDigest: string) {
  if (actorId !== previousActor || digest !== previousDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to another identity review intent or actor');
}

export async function lockIdentityGroupSource(transaction: Prisma.TransactionClient, batchId: string) {
  await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
  await transaction.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${batchId}::uuid FOR NO KEY UPDATE`;
  const batch = await transaction.importBatch.findUnique({ where: { id: batchId }, select: { sourceHash: true } });
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
  await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${batch.sourceHash}, 0))`;
}

export async function withIdentityGroupMutation<T>(database: PrismaClient, operation: (transaction: Prisma.TransactionClient) => Promise<T>) {
  try {
    return await database.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'IDENTITY_GROUP_REVIEW_CONFLICT', 'Retrieve the existing review or generate a new plan');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'IDENTITY_GROUP_REVIEW_BUSY', 'Review is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

export async function saveIdentityGroupReview(database: PrismaClient, batchId: string, input: IdentityGroupReviewInput, actorId: string) {
  return withIdentityGroupMutation(database, async (transaction) => {
    await lockIdentityGroupSource(transaction, batchId);
    const digest = identityGroupReviewDigest(input);
    const previous = await transaction.importIdentityGroupReview.findUnique({ where: { batchId_requestId: { batchId, requestId: input.requestId } }, include });
    if (previous) { checkReuse(actorId, digest, previous.reviewedById, previous.requestDigest); return receipt(previous, true); }
    // Freeze legacy inventory writers while validating the exact reviewed database snapshot.
    // NOWAIT avoids lock-order inversion with older CRUD writers; no operational data is changed.
    await transaction.$executeRawUnsafe('LOCK TABLE "Product", "Asset" IN EXCLUSIVE MODE NOWAIT');
    const plan = await readIdentityGroupPlan(transaction, batchId, input.plan);
    if (plan.planId !== input.planId) throw new ApiError(409, 'IDENTITY_GROUP_PLAN_CHANGED', 'Generate and review the current identity grouping plan');
    if (!plan.proposalValidationComplete) throw new ApiError(409, 'IDENTITY_GROUP_PLAN_BLOCKED', 'Resolve every source/grouping blocker before reserving', { blockers: plan.blockers });
    const [capture] = await transaction.$queryRaw<{ capturedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
    const review = await transaction.importIdentityGroupReview.create({ data: { batchId, batchVersion: plan.batchVersion,
      sourceRevision: plan.sourceRevision, sourceHash: plan.sourceHash, requestId: input.requestId, requestDigest: digest,
      planId: plan.planId, plan: json(plan), reviewedById: actorId, createdAt: capture.capturedAt } });
    await transaction.importIdentityGroupRow.createMany({ data: plan.observations.map((observation) => ({ reviewId: review.id,
      sourceHash: plan.sourceHash, recordId: observation.recordId, originalCandidateId: observation.originalCandidateId,
      groupId: observation.proposedGroupId, snapshot: json(observation) })) });
    await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_IDENTITY_GROUP_RESERVED', entityType: 'ImportIdentityGroupReview', entityId: review.id,
      metadata: { batchId, sourceHash: plan.sourceHash, planId: plan.planId, observationCount: plan.observations.length, affectsCurrentState: false } } });
    return receipt(await transaction.importIdentityGroupReview.findUniqueOrThrow({ where: { id: review.id }, include }), false);
  });
}

export async function releaseIdentityGroupReview(database: PrismaClient, batchId: string, reviewId: string, input: IdentityGroupReleaseInput, actorId: string) {
  return withIdentityGroupMutation(database, async (transaction) => {
    await lockIdentityGroupSource(transaction, batchId);
    const review = await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId }, include });
    if (!review) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
    const digest = importPlanDigest(input);
    if (review.release) {
      if (review.release.requestId !== input.requestId) throw new ApiError(409, 'IDENTITY_GROUP_ALREADY_RELEASED', 'Retrieve the existing release; it cannot be rewritten');
      checkReuse(actorId, digest, review.release.releasedById, review.release.requestDigest); return receipt(review, true);
    }
    // Capture database time before INSERT; a client-side default may round ahead of the SQL future-time guard.
    const [capture] = await transaction.$queryRaw<{ capturedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
    await transaction.importIdentityGroupRelease.create({ data: { reviewId, requestId: input.requestId, requestDigest: digest, note: input.note, releasedById: actorId, createdAt: capture.capturedAt } });
    await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_IDENTITY_GROUP_RELEASED', entityType: 'ImportIdentityGroupReview', entityId: reviewId,
      metadata: { batchId, sourceHash: review.sourceHash, affectsCurrentState: false } } });
    return receipt(await transaction.importIdentityGroupReview.findUniqueOrThrow({ where: { id: reviewId }, include }), false);
  });
}

export async function getIdentityGroupReview(database: PrismaClient, batchId: string, reviewId: string) {
  const review = await database.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId }, include });
  if (!review) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
  return { ...scope, review };
}

export async function listIdentityGroupReviews(database: PrismaClient, batchId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.importBatch.findUnique({ where: { id: batchId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
    const reviews = await transaction.importIdentityGroupReview.findMany({ where: { batchId }, select: { id: true, batchId: true, batchVersion: true,
      sourceRevision: true, sourceHash: true, planId: true, reviewedById: true, createdAt: true, release: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importIdentityGroupReview.count({ where: { batchId } });
    return { ...scope, reviews, total, ...query, hasMore: query.offset + reviews.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
