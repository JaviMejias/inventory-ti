import { Prisma, type ImportIdentityGroupDecision, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { identityGroupDecisionDigest, type IdentityGroupDecisionInput, type IdentityGroupDecisionListQuery } from './identity-group-decision-schemas.js';
import { identityGroupDecisionRulesVersion, validateIdentityGroupDecision } from './identity-group-decision.js';
import { readIdentityGroupProjection } from './identity-group-projection-service.js';
import { lockIdentityGroupSource, withIdentityGroupMutation } from './identity-group-review-service.js';

const scope = { scope: 'IDENTITY_GROUP_DECISION_ONLY', persisted: true, canApply: false, affectsCurrentState: false,
  groupedPilotImplemented: false, evidenceRelinked: false } as const;
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
async function decisionVersion(transaction: Prisma.TransactionClient, reviewId: string) {
  return (await transaction.importIdentityGroupDecision.aggregate({ where: { reviewId }, _max: { version: true } }))._max.version ?? 0;
}

export async function appendIdentityGroupDecision(database: PrismaClient, batchId: string, reviewId: string, input: IdentityGroupDecisionInput, actorId: string) {
  return withIdentityGroupMutation(database, async (transaction) => {
    await lockIdentityGroupSource(transaction, batchId);
    const review = await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId }, select: { id: true } });
    if (!review) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
    const requestDigest = identityGroupDecisionDigest(input);
    const previous = await transaction.importIdentityGroupDecision.findUnique({ where: { reviewId_requestId: { reviewId, requestId: input.requestId } } });
    if (previous) {
      if (previous.reviewedById !== actorId || previous.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to another group decision or actor');
      return { ...scope, decision: previous, decisionVersion: await decisionVersion(transaction, reviewId), reused: true };
    }
    const version = await decisionVersion(transaction, reviewId);
    if (version !== input.expectedDecisionVersion) throw new ApiError(409, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT', 'Reload group decisions', { currentVersion: version });
    // Freeze inventory writers while recalculating the exact reviewed projection.
    // NOWAIT prevents lock-order inversion with legacy CRUD writers.
    await transaction.$executeRawUnsafe('LOCK TABLE "Product", "Asset" IN EXCLUSIVE MODE NOWAIT');
    const projection = await readIdentityGroupProjection(transaction, batchId, reviewId);
    const group = validateIdentityGroupDecision(projection, input);
    if (input.action === 'LINK_EXISTING') {
      const duplicates = await transaction.$queryRaw<{ groupKey: string }[]>`
        SELECT "groupKey" FROM (
          SELECT DISTINCT ON ("groupKey") "groupKey", "action", "linkedAssetId"
          FROM "ImportIdentityGroupDecision" WHERE "reviewId" = ${reviewId}::uuid ORDER BY "groupKey", "version" DESC
        ) latest WHERE "groupKey" <> ${input.groupKey} AND "action" = 'LINK_EXISTING' AND "linkedAssetId" = ${input.linkedAssetId}::uuid`;
      if (duplicates.length) throw new ApiError(409, 'IDENTITY_GROUP_ASSET_ALREADY_PROPOSED', 'Another physical group already proposes this asset; review that decision first');
    }
    const decision = await transaction.importIdentityGroupDecision.create({ data: { reviewId: review.id, version: version + 1,
      requestId: input.requestId, requestDigest, rulesVersion: identityGroupDecisionRulesVersion, groupId: group.groupId, groupKey: group.groupKey,
      batchVersion: projection.batchVersion, sourceRevision: projection.sourceRevision, projectionId: projection.projectionId,
      projection: json(projection), action: input.action, linkedAssetId: input.linkedAssetId ?? null, note: input.note,
      evidenceReference: input.evidenceReference, evidenceReviews: json([...input.evidenceReviews].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))), reviewedById: actorId } });
    await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_IDENTITY_GROUP_DECISION_RECORDED',
      entityType: 'ImportIdentityGroupDecision', entityId: decision.id, metadata: { batchId: projection.batchId, reviewId: review.id,
        groupKey: group.groupKey, version: decision.version, projectionId: projection.projectionId, affectsCurrentState: false, evidenceRelinked: false } } });
    return { ...scope, decision, decisionVersion: decision.version, reused: false };
  });
}

async function requireReview(transaction: Prisma.TransactionClient, batchId: string, reviewId: string) {
  const review = await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId }, select: { id: true, release: { select: { id: true } } } });
  if (!review) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
  const projection = review.release ? null : await readIdentityGroupProjection(transaction, batchId, reviewId);
  return { currentProjectionId: projection?.projectionId ?? null, reviewActive: !review.release };
}

export async function listIdentityGroupDecisions(database: PrismaClient, batchId: string, reviewId: string, query: IdentityGroupDecisionListQuery) {
  return database.$transaction(async (transaction) => {
    const current = await requireReview(transaction, batchId, reviewId);
    const filter = Prisma.sql`WHERE "reviewId" = ${reviewId}::uuid AND (${query.groupKey ?? null}::text IS NULL OR "groupKey" = ${query.groupKey ?? null}::text)`;
    const selected = query.mode === 'latest'
      ? Prisma.sql`SELECT DISTINCT ON ("groupKey") * FROM "ImportIdentityGroupDecision" ${filter} ORDER BY "groupKey", "version" DESC`
      : Prisma.sql`SELECT * FROM "ImportIdentityGroupDecision" ${filter}`;
    const decisions = await transaction.$queryRaw<Omit<ImportIdentityGroupDecision, 'projection'>[]>(Prisma.sql`
      SELECT "id", "reviewId", "version", "requestId", "requestDigest", "rulesVersion", "groupId", "groupKey", "batchVersion",
        "sourceRevision", "projectionId", "action", "linkedAssetId", "note", "evidenceReference", "evidenceReviews", "reviewedById", "createdAt"
      FROM (${selected}) selected ORDER BY "version" DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
    const [count] = await transaction.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT count(*)::integer AS total FROM (${selected}) selected`);
    return { ...scope, ...current, decisionVersion: await decisionVersion(transaction, reviewId),
      decisions: decisions.map((decision) => ({ ...decision, projectionCurrent: current.reviewActive && decision.projectionId === current.currentProjectionId })),
      mode: query.mode, total: count.total, limit: query.limit, offset: query.offset, hasMore: query.offset + decisions.length < count.total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function getIdentityGroupDecision(database: PrismaClient, batchId: string, reviewId: string, decisionId: string) {
  return database.$transaction(async (transaction) => {
    const current = await requireReview(transaction, batchId, reviewId);
    const decision = await transaction.importIdentityGroupDecision.findFirst({ where: { id: decisionId, reviewId } });
    if (!decision) throw new ApiError(404, 'NOT_FOUND', 'Group decision not found in this review');
    return { ...scope, ...current, decision, projectionCurrent: current.reviewActive && decision.projectionId === current.currentProjectionId,
      decisionVersion: await decisionVersion(transaction, reviewId) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}
