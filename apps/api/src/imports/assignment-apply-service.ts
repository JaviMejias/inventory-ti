import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { closedAssignmentRequestDigest, type ClosedAssignmentApplyInput } from './assignment-apply-schemas.js';
import { readClosedAssignmentPlan } from './assignment-plan-service.js';
import { closedAssignmentRulesVersion } from './assignment-plan.js';
import type { HistoryPageQuery } from './history-schemas.js';

const receiptInclude = { items: { orderBy: { periodId: 'asc' as const }, include: { assignment: true } } };
const metadataSelect = { id: true, assetId: true, requestId: true, planId: true, rulesVersion: true, appliedById: true, appliedAt: true };
const scope = { scope: 'CLOSED_ASSIGNMENT_HISTORY' as const, affectsCurrentState: false };
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

export async function applyClosedAssignments(database: PrismaClient, assetId: string, input: ClosedAssignmentApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      const requestDigest = closedAssignmentRequestDigest(input);
      const lookup = () => transaction.importAssignmentApplication.findUnique({ where: { assetId_requestId: { assetId, requestId: input.requestId } }, include: receiptInclude });
      const reuse = (receipt: NonNullable<Awaited<ReturnType<typeof lookup>>>) => {
        if (receipt.appliedById !== actorId || receipt.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to a different historical application');
        return { ...scope, mode: 'APPLIED', persisted: true, reused: true, application: receipt };
      };
      const previous = await lookup();
      if (previous) return reuse(previous);
      const ids = input.plan.periods.flatMap((period) => [period.start.evidenceId, period.end.evidenceId]);
      const sources = await transaction.importHistoricalEvidence.findMany({ where: { id: { in: ids } }, select: { sourceHash: true } });
      if (sources.length !== ids.length) throw new ApiError(404, 'NOT_FOUND', 'Historical endpoint evidence not found');
      for (const hash of [...new Set(sources.map((source) => source.sourceHash))].sort()) {
        await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${hash}, 0))`;
      }
      const assets = await transaction.$queryRaw<{ id: string; productId: string }[]>`SELECT "id", "productId" FROM "Asset" WHERE "id" = ${assetId}::uuid FOR UPDATE`;
      if (!assets[0]) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
      const recovered = await lookup();
      if (recovered) return reuse(recovered);
      await transaction.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${assets[0].productId}::uuid FOR SHARE`;
      const used = await transaction.importAssignmentEvidenceUse.findFirst({ where: { evidenceId: { in: ids } }, select: {
        evidenceId: true, item: { select: { applicationId: true, assignmentId: true } }
      } });
      if (used) throw new ApiError(409, 'HISTORICAL_EVIDENCE_ALREADY_APPLIED', 'Endpoint evidence already belongs to an imported period', used);
      const plan = await readClosedAssignmentPlan(transaction, assetId, input.plan);
      if (plan.planId !== input.planId) throw new ApiError(409, 'HISTORICAL_PLAN_CHANGED', 'Generate and review the current closed assignment plan');
      if (!plan.planValidationComplete) throw new ApiError(409, 'HISTORICAL_PLAN_BLOCKED', 'Resolve every closed assignment blocker before applying', {
        periods: plan.periods.filter((period) => !period.valid).map(({ periodId, blockers }) => ({ periodId, blockers }))
      });
      const application = await transaction.importAssignmentApplication.create({ data: { assetId, requestId: input.requestId, requestDigest,
        planId: plan.planId, rulesVersion: closedAssignmentRulesVersion, plan: json(plan), appliedById: actorId, appliedAt: new Date() } });
      for (const period of plan.periods) {
        const proposal = period.proposedAssignment;
        const assignment = await transaction.assignment.create({ data: {
          assetId, importedHistory: true, createdById: null, endedById: null, personId: null,
          recipientType: period.recipient!.type, personName: proposal.personName, officeName: proposal.officeName,
          assignmentType: period.assignmentType, expectedReturnAt: null, startedAt: new Date(proposal.startedAt!), endedAt: new Date(proposal.endedAt!),
          returnStatus: period.returnStatus!, createdAt: application.appliedAt, returnRecordedAt: application.appliedAt,
          ticketReference: proposal.ticketReference, otReference: proposal.otReference, returnTicketReference: proposal.returnTicketReference,
          returnOtReference: proposal.returnOtReference, notes: period.note, returnNotes: period.evidenceReference
        } });
        const item = await transaction.importAssignmentItem.create({ data: { applicationId: application.id, periodId: period.periodId, assignmentId: assignment.id,
          startEvidenceId: period.start.evidenceId, endEvidenceId: period.end.evidenceId, snapshot: json(period) } });
        await transaction.importAssignmentEvidenceUse.createMany({ data: [
          { evidenceId: period.start.evidenceId, itemId: item.id, endpoint: 'START' }, { evidenceId: period.end.evidenceId, itemId: item.id, endpoint: 'END' }
        ] });
        await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_CLOSED_ASSIGNMENT_ADDED', entityType: 'Assignment', entityId: assignment.id,
          metadata: { assetId, applicationId: application.id, periodId: period.periodId, historicalActorsKnown: false, affectsCurrentState: false } } });
      }
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_CLOSED_ASSIGNMENTS_APPLIED', entityType: 'ImportAssignmentApplication', entityId: application.id,
        metadata: { assetId, planId: plan.planId, periodCount: plan.periods.length, affectsCurrentState: false } } });
      const receipt = await transaction.importAssignmentApplication.findUniqueOrThrow({ where: { id: application.id }, include: receiptInclude });
      return { ...scope, mode: 'APPLIED', persisted: true, reused: false, application: receipt };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'HISTORICAL_APPLICATION_CONFLICT', 'Plan, request or evidence was already applied; retrieve its receipt');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'HISTORICAL_APPLICATION_BUSY', 'Historical application is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

export async function listAssignmentApplications(database: PrismaClient, assetId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.asset.findUnique({ where: { id: assetId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
    const applications = await transaction.importAssignmentApplication.findMany({ where: { assetId }, select: metadataSelect,
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }], skip: query.offset, take: query.limit });
    const total = await transaction.importAssignmentApplication.count({ where: { assetId } });
    return { ...scope, applications, total, limit: query.limit, offset: query.offset, hasMore: query.offset + applications.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getAssignmentApplication(database: PrismaClient, assetId: string, id: string) {
  const application = await database.importAssignmentApplication.findFirst({ where: { id, assetId }, include: receiptInclude });
  if (!application) throw new ApiError(404, 'NOT_FOUND', 'Historical application not found for this asset');
  return { ...scope, mode: 'APPLIED', persisted: true, application };
}
