import { setTimeout } from 'node:timers/promises';

import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { createAssetInTransaction, updateAssetInTransaction } from '../routes/assets-service.js';
import type { ApplicationListQuery, PilotApplyInput } from './apply-schemas.js';
import { readImportPilot } from './plan-service.js';
import { importPlanDigest } from './plan.js';

const receiptInclude = { items: { orderBy: { candidateId: 'asc' as const } } };
const metadataSelect = { id: true, batchId: true, batchVersion: true, requestId: true, planId: true, sourceHash: true, appliedById: true, createdAt: true };
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function requestDigest(input: PilotApplyInput) {
  const { expectedSourceRevision, ...basePlan } = input.plan;
  return importPlanDigest({ ...input, plan: { ...basePlan, ...(expectedSourceRevision ? { expectedSourceRevision } : {}), operations: [...input.plan.operations]
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId))
    .map((operation) => ({ ...operation, acknowledgedWarnings: [...operation.acknowledgedWarnings].sort() })) } });
}

export async function applyImportPilot(database: PrismaClient, id: string, input: PilotApplyInput, actorId: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await applyAttempt(database, id, input, actorId);
    } catch (error) {
      if (!(error instanceof InventoryLockBusy)) throw error;
      if (attempt === 5) throw new ApiError(409, 'IMPORT_APPLY_BUSY', 'Inventory is busy; retry with the same request id');
      await setTimeout(25 * (attempt + 1));
    }
  }
  throw new ApiError(409, 'IMPORT_APPLY_BUSY', 'Inventory is busy; retry with the same request id');
}

class InventoryLockBusy extends Error {}

async function applyAttempt(database: PrismaClient, id: string, input: PilotApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      await transaction.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`;
      const batch = await transaction.importBatch.findUnique({ where: { id } });
      if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
      const intentDigest = requestDigest(input);
      const previous = await transaction.importApplication.findUnique({ where: { batchId_requestId: { batchId: id, requestId: input.requestId } }, include: receiptInclude });
      if (previous) {
        if (previous.appliedById !== actorId || previous.requestDigest !== intentDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id already belongs to a different application');
        return { mode: 'APPLIED' as const, persisted: true, application: previous, reused: true };
      }
      // Small administrative pilots freeze catalog/identity writes, including legacy CRUD
      // writers which do not participate in import-specific advisory locks. Reads remain allowed.
      // NOWAIT prevents deadlocks with INSERT/FK writers that acquire Asset before Product.
      // Failed attempts roll back immediately before any operational mutation.
      await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${batch.sourceHash}, 0))`;
      try {
        await transaction.$executeRawUnsafe('LOCK TABLE "Product", "Asset" IN EXCLUSIVE MODE NOWAIT');
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010' && error.meta?.code === '55P03') throw new InventoryLockBusy();
        throw error;
      }
      const applied = await transaction.importApplicationItem.findFirst({ where: { sourceHash: batch.sourceHash, candidateId: { in: input.plan.operations.map((operation) => operation.candidateId) } },
        select: { applicationId: true, candidateId: true, application: { select: { batchId: true } } } });
      if (applied) throw new ApiError(409, 'IMPORT_TARGET_ALREADY_APPLIED', 'A selected source candidate was already applied', {
        applicationId: applied.applicationId, candidateId: applied.candidateId, batchId: applied.application.batchId
      });
      const plan = await readImportPilot(transaction, id, input.plan);
      if (plan.planId !== input.planId) throw new ApiError(409, 'IMPORT_PLAN_CHANGED', 'Generate and confirm the current pilot plan');
      if (!plan.planValidationComplete) throw new ApiError(409, 'IMPORT_PLAN_BLOCKED', 'Resolve all selected pilot blockers before applying', {
        operations: plan.operations.filter((operation) => !operation.valid).map((operation) => ({ candidateId: operation.candidateId, blockers: operation.blockers }))
      });
      const application = await transaction.importApplication.create({ data: { batchId: id, batchVersion: batch.version,
        requestId: input.requestId, requestDigest: intentDigest, planId: plan.planId, sourceHash: batch.sourceHash, plan: json(plan), appliedById: actorId } });
      for (const operation of plan.operations) {
        const asset = operation.type === 'CREATE_ASSET'
          ? await createAssetInTransaction(transaction, operation.values, actorId)
          : await updateAssetInTransaction(transaction, operation.assetId, operation.values, actorId);
        await transaction.importApplicationItem.create({ data: { applicationId: application.id, candidateId: operation.candidateId,
          sourceHash: batch.sourceHash, decisionId: operation.decisionId!, assetId: asset.id, operation: json(operation),
          result: json(Object.fromEntries(Object.entries(asset).filter(([key]) => key !== 'groupRetirement'))) } });
      }
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_PILOT_APPLIED', entityType: 'ImportApplication', entityId: application.id,
        metadata: { batchId: id, batchVersion: batch.version, planId: plan.planId, sourceHash: batch.sourceHash, operationCount: plan.operations.length } } });
      const receipt = await transaction.importApplication.findUniqueOrThrow({ where: { id: application.id }, include: receiptInclude });
      return { mode: 'APPLIED' as const, persisted: true, application: receipt, reused: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'IMPORT_APPLICATION_CONFLICT', 'The plan or source identity was already applied; retrieve the receipt or generate a current plan');
      if (error.code === 'P2034' || error.code === 'P2028' || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'IMPORT_APPLY_BUSY', 'Inventory is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

export async function getImportApplication(database: PrismaClient, batchId: string, id: string) {
  const application = await database.importApplication.findFirst({ where: { id, batchId }, include: receiptInclude });
  if (!application) throw new ApiError(404, 'NOT_FOUND', 'Import application not found in this batch');
  return { mode: 'APPLIED' as const, persisted: true, application };
}

export async function listImportApplications(database: PrismaClient, batchId: string, query: ApplicationListQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.importBatch.findUnique({ where: { id: batchId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
    const applications = await transaction.importApplication.findMany({ where: { batchId }, select: metadataSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importApplication.count({ where: { batchId } });
    return { applications, total, limit: query.limit, offset: query.offset, hasMore: query.offset + applications.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
