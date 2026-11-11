import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { assignmentCorrectionRequestDigest, type AssignmentCorrectionApplyInput } from './assignment-correction-apply-schemas.js';
import { readAssignmentCorrectionPlan } from './assignment-correction-service.js';
import type { HistoryPageQuery } from './history-schemas.js';

const scope = { scope: 'LEGACY_CLOSED_ASSIGNMENT_CORRECTION', persisted: true, affectsCurrentState: false, evidenceRelinked: false, operationalHistoryApplied: true, canApply: false } as const;
async function requireItem(transaction: Prisma.TransactionClient, assetId: string, applicationId: string, itemId: string) {
  const item = await transaction.importAssignmentItem.findFirst({ where: { id: itemId, applicationId, application: { assetId } }, select: { id: true, assignmentId: true } });
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Legacy correction item not found in this origin'); return item;
}
export async function applyAssignmentCorrection(database: PrismaClient, assetId: string, applicationId: string, itemId: string, input: AssignmentCorrectionApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      const item = await requireItem(transaction, assetId, applicationId, itemId);
      const requestDigest = assignmentCorrectionRequestDigest(input);
      const lookup = () => transaction.importAssignmentCorrection.findUnique({ where: { itemId_requestId: { itemId, requestId: input.requestId } } });
      const reuse = (correction: NonNullable<Awaited<ReturnType<typeof lookup>>>) => {
        if (correction.correctedById !== actorId || correction.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request belongs to a different legacy correction intent or actor');
        return { ...scope, correction, reused: true };
      };
      const previous = await lookup(); if (previous) return reuse(previous);
      const sources = await transaction.importHistoricalEvidence.findMany({ where: { assignmentUse: { item: { applicationId } } }, select: { sourceHash: true }, orderBy: { sourceHash: 'asc' } });
      for (const hash of [...new Set(sources.map((row) => row.sourceHash))]) await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${hash}, 0))`;
      await transaction.$executeRawUnsafe('LOCK TABLE "Asset", "Product", "Assignment", "User", "AuditLog", "ImportAssignmentApplication", "ImportAssignmentItem", "ImportAssignmentEvidenceUse", "ImportHistoricalEvidence", "ImportHistoryCapture", "ImportEvidenceAmendment", "ImportSourceRevision", "ImportAssignmentCorrection", "ImportGroupAssignmentCorrection", "ImportIdentityGroupRow", "ImportIdentityGroupRelease" IN EXCLUSIVE MODE NOWAIT');
      const recovered = await lookup(); if (recovered) return reuse(recovered);
      const actor = await transaction.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true, passwordHash: true } });
      if (!actor?.isActive || actor.role !== 'JEFE' || !actor.passwordHash) throw new ApiError(403, 'FORBIDDEN', 'Only an active configured JEFE can correct legacy history');
      const plan = await readAssignmentCorrectionPlan(transaction, assetId, applicationId, itemId, input.plan);
      if (!plan.planValidationComplete) throw new ApiError(409, 'ASSIGNMENT_CORRECTION_PLAN_BLOCKED', 'Resolve every legacy correction blocker', { blockers: plan.blockers });
      if (plan.correctionPlanId !== input.correctionPlanId) throw new ApiError(409, 'ASSIGNMENT_CORRECTION_PLAN_CHANGED', 'Generate and review the current correction plan');
      const [clock] = await transaction.$queryRaw<{ capturedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
      const correction = await transaction.importAssignmentCorrection.create({ data: { itemId, version: plan.currentCorrectionVersion + 1, previousId: plan.currentCorrectionId,
        requestId: input.requestId, requestDigest, correctionPlanId: plan.correctionPlanId, rulesVersion: 'mda-legacy-assignment-correction-application-1',
        plan: JSON.parse(JSON.stringify(plan)) as Prisma.InputJsonObject, reason: input.plan.reason, supportingReference: input.plan.supportingReference,
        assetSnapshot: JSON.parse(JSON.stringify(plan.currentAsset)) as Prisma.InputJsonObject, custodySnapshot: JSON.parse(JSON.stringify(plan.currentCustody)) as Prisma.InputJsonArray,
        correctedById: actorId, correctedAt: clock.capturedAt } });
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_LEGACY_ASSIGNMENT_CORRECTED', entityType: 'ImportAssignmentCorrection', entityId: correction.id,
        metadata: { assetId, applicationId, assignmentItemId: itemId, assignmentId: item.assignmentId, version: correction.version, previousId: correction.previousId, affectsCurrentState: false } } });
      return { ...scope, correction, reused: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'ASSIGNMENT_CORRECTION_CONFLICT', 'This legacy correction version or intent already exists');
      if (['P2028','P2034'].includes(error.code) || (error.code === 'P2010' && ['55P03','40P01','40001'].includes(String(error.meta?.code)))) throw new ApiError(409, 'ASSIGNMENT_CORRECTION_BUSY', 'Correction is busy; retry the same request');
    }
    throw error;
  }
}
export function listAssignmentCorrections(database: PrismaClient, assetId: string, applicationId: string, itemId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    await requireItem(transaction, assetId, applicationId, itemId);
    const corrections = await transaction.importAssignmentCorrection.findMany({ where: { itemId }, orderBy: { version: 'desc' }, take: query.limit, skip: query.offset,
      select: { id: true, itemId: true, version: true, previousId: true, requestId: true, correctionPlanId: true, reason: true, supportingReference: true, correctedById: true, correctedAt: true } });
    const total = await transaction.importAssignmentCorrection.count({ where: { itemId } }); return { ...scope, corrections, total, ...query, hasMore: query.offset + corrections.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export async function getAssignmentCorrection(database: PrismaClient, assetId: string, applicationId: string, itemId: string, correctionId: string) {
  return database.$transaction(async (transaction) => {
    await requireItem(transaction, assetId, applicationId, itemId); const correction = await transaction.importAssignmentCorrection.findFirst({ where: { id: correctionId, itemId } });
    if (!correction) throw new ApiError(404, 'NOT_FOUND', 'Legacy correction receipt not found in this origin'); return { ...scope, correction };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
