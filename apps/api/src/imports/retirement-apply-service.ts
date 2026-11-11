import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { retirementRequestDigest, type HistoricalRetirementApplyInput } from './retirement-apply-schemas.js';
import { readHistoricalRetirementPlan } from './retirement-plan-service.js';
import { historicalRetirementRulesVersion } from './retirement-plan.js';

const scope = { scope: 'VERIFIED_HISTORICAL_RETIREMENT' as const, affectsCurrentState: true };
const metadataSelect = { id: true, assetId: true, evidenceId: true, evidenceVersion: true, amendmentId: true, sourceRevision: true,
  decommissionedAt: true, requestId: true, planId: true, rulesVersion: true, appliedById: true, appliedAt: true };
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

export async function applyHistoricalRetirement(database: PrismaClient, assetId: string, input: HistoricalRetirementApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      const requestDigest = retirementRequestDigest(input);
      const lookup = () => transaction.importRetirementApplication.findUnique({ where: { assetId_requestId: { assetId, requestId: input.requestId } } });
      const reuse = (application: NonNullable<Awaited<ReturnType<typeof lookup>>>) => {
        if (application.appliedById !== actorId || application.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to a different retirement application');
        return { ...scope, mode: 'APPLIED', persisted: true, reused: true, application };
      };
      const previous = await lookup(); if (previous) return reuse(previous);
      const evidence = await transaction.importHistoricalEvidence.findUnique({ where: { id: input.plan.evidenceId }, select: { sourceHash: true } });
      if (!evidence) throw new ApiError(404, 'NOT_FOUND', 'Historical retirement evidence not found');
      await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${evidence.sourceHash}, 0))`;
      await transaction.$queryRaw`SELECT "id" FROM "ImportHistoricalEvidence" WHERE "id" = ${input.plan.evidenceId}::uuid FOR NO KEY UPDATE`;
      const assets = await transaction.$queryRaw<{ id: string; productId: string }[]>`SELECT "id", "productId" FROM "Asset" WHERE "id" = ${assetId}::uuid FOR UPDATE`;
      if (!assets[0]) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
      const recovered = await lookup(); if (recovered) return reuse(recovered);
      await transaction.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${assets[0].productId}::uuid FOR SHARE`;
      const actors = await transaction.$queryRaw<{ role: string; isActive: boolean; configured: boolean }[]>`
        SELECT "role", "isActive", ("passwordHash" IS NOT NULL) AS configured FROM "User" WHERE "id" = ${actorId}::uuid FOR SHARE`;
      if (!actors[0]?.isActive || actors[0].role !== 'JEFE' || !actors[0].configured) throw new ApiError(403, 'FORBIDDEN', 'Only an active configured JEFE can apply a historical retirement');
      const applied = await transaction.importRetirementApplication.findFirst({ where: { OR: [{ assetId }, { evidenceId: input.plan.evidenceId }] }, select: metadataSelect });
      if (applied) throw new ApiError(409, 'RETIREMENT_ALREADY_APPLIED', 'Retrieve the existing historical retirement receipt', applied);
      const plan = await readHistoricalRetirementPlan(transaction, assetId, input.plan);
      if (plan.planId !== input.planId) throw new ApiError(409, 'RETIREMENT_PLAN_CHANGED', 'Generate and review the current retirement plan');
      if (!plan.planValidationComplete) throw new ApiError(409, 'RETIREMENT_PLAN_BLOCKED', 'Resolve every retirement blocker before applying', { blockers: plan.blockers });
      const appliedAt = new Date(); const decommissionedAt = new Date(plan.proposedRetirement.decommissionedAt!);
      const result = { id: assetId, productId: plan.assetBefore.productId, serialNumber: plan.assetBefore.serialNumber, assetTag: plan.assetBefore.assetTag,
        status: 'DECOMMISSIONED', isActive: false, decommissionedAt, updatedAt: appliedAt };
      const application = await transaction.importRetirementApplication.create({ data: { assetId, evidenceId: input.plan.evidenceId,
        evidenceVersion: plan.source.evidenceVersion, amendmentId: plan.source.amendmentId, sourceRevision: plan.source.sourceRevision,
        decommissionedAt, requestId: input.requestId, requestDigest, planId: plan.planId, rulesVersion: historicalRetirementRulesVersion,
        plan: json(plan), result: json(result), appliedById: actorId, appliedAt } });
      await transaction.asset.update({ where: { id: assetId }, data: { status: 'DECOMMISSIONED', isActive: false, decommissionedAt, updatedAt: appliedAt } });
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_HISTORICAL_RETIREMENT_APPLIED', entityType: 'ImportRetirementApplication', entityId: application.id,
        metadata: { assetId, evidenceId: application.evidenceId, evidenceVersion: application.evidenceVersion, planId: plan.planId,
          historicalActorKnown: false, affectsCurrentState: true } } });
      return { ...scope, mode: 'APPLIED', persisted: true, reused: false, application };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'RETIREMENT_APPLICATION_CONFLICT', 'Plan, asset or evidence was already retired; retrieve its receipt');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'RETIREMENT_APPLICATION_BUSY', 'Historical retirement is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

export async function listRetirementApplications(database: PrismaClient, assetId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.asset.findUnique({ where: { id: assetId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
    const applications = await transaction.importRetirementApplication.findMany({ where: { assetId }, select: metadataSelect,
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importRetirementApplication.count({ where: { assetId } });
    return { ...scope, applications, total, limit: query.limit, offset: query.offset, hasMore: query.offset + applications.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getRetirementApplication(database: PrismaClient, assetId: string, applicationId: string) {
  const application = await database.importRetirementApplication.findFirst({ where: { id: applicationId, assetId } });
  if (!application) throw new ApiError(404, 'NOT_FOUND', 'Retirement application not found for this asset');
  return { ...scope, mode: 'APPLIED', persisted: true, application };
}
