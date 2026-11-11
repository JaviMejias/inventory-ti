import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { groupClosedAssignmentApplyDigest, type GroupClosedAssignmentApplyInput } from './group-assignment-apply-schemas.js';
import { readGroupClosedAssignmentPlan } from './group-assignment-plan-service.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { lockIdentityGroupSource } from './identity-group-review-service.js';

export const groupAssignmentApplicationRulesVersion = 'mda-group-closed-assignment-application-1';
const include = { items: { orderBy: { periodId: 'asc' as const }, include: { assignment: true, evidenceUses: { orderBy: { endpoint: 'asc' as const } } } } };
const scope = { scope: 'GROUP_CLOSED_ASSIGNMENT_HISTORY', mode: 'APPLIED', persisted: true, canApply: false,
  affectsCurrentState: false, evidenceRelinked: false, operationalHistoryApplied: true } as const;
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

export async function applyGroupClosedAssignments(database: PrismaClient, batchId: string, reviewId: string, applicationId: string,
  itemId: string, input: GroupClosedAssignmentApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await lockIdentityGroupSource(transaction, batchId);
      const item = await requireItem(transaction, batchId, reviewId, applicationId, itemId);
      const requestDigest = groupClosedAssignmentApplyDigest(input);
      const previous = await transaction.importGroupAssignmentApplication.findUnique({ where: { itemId_requestId: { itemId, requestId: input.requestId } }, include });
      if (previous) {
        if (previous.appliedById !== actorId || previous.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to another grouped historical application or actor');
        return { ...scope, application: previous, reused: true };
      }
      // NOWAIT preserves the source-first protocol without waiting behind legacy inventory writers.
      await transaction.$executeRawUnsafe('LOCK TABLE "Product", "Asset", "Assignment", "ImportHistoryCapture", "ImportHistoricalEvidence", "ImportEvidenceAmendment", "ImportGroupHistoryApplication", "ImportGroupHistoryLink" IN EXCLUSIVE MODE NOWAIT');
      const plan = await readGroupClosedAssignmentPlan(transaction, batchId, reviewId, applicationId, itemId, input.plan);
      const used = await transaction.importGroupAssignmentEvidenceUse.findFirst({ where: { evidenceId: { in: input.plan.links.map((link) => link.evidenceId) },
        link: { application: { itemId } } },
        select: { evidenceId: true, item: { select: { applicationId: true, assignmentId: true } } } });
      if (used) throw new ApiError(409, 'GROUP_ASSIGNMENT_EVIDENCE_ALREADY_APPLIED', 'An endpoint already belongs to a grouped imported period; retrieve its receipt', used);
      if (!plan.planValidationComplete) throw new ApiError(409, 'GROUP_ASSIGNMENT_PLAN_BLOCKED', 'Resolve every selected grouped historical period before applying', {
        periods: plan.periods.filter((period) => !period.valid).map(({ periodId, blockers }) => ({ periodId, blockers }))
      });
      if (plan.planId !== input.planId) throw new ApiError(409, 'GROUP_ASSIGNMENT_PLAN_CHANGED', 'Generate and confirm the current grouped closed assignment plan');
      const [snapshots] = await transaction.$queryRaw<{ assetSnapshot: Prisma.JsonObject; custodySnapshot: Prisma.JsonArray }[]>`
        SELECT to_jsonb(a) AS "assetSnapshot", coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s."id")
          FROM "Assignment" s WHERE s."assetId" = a."id" AND s."endedAt" IS NULL), '[]'::jsonb) AS "custodySnapshot"
        FROM "Asset" a WHERE a."id" = ${item.assetId}::uuid`;
      const [clock] = await transaction.$queryRaw<{ capturedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
      const application = await transaction.importGroupAssignmentApplication.create({ data: { itemId, assetId: item.assetId,
        requestId: input.requestId, requestDigest, planId: plan.planId, rulesVersion: groupAssignmentApplicationRulesVersion, plan: json(plan),
        assetSnapshot: snapshots.assetSnapshot, custodySnapshot: snapshots.custodySnapshot, appliedById: actorId, appliedAt: clock.capturedAt } });
      for (const period of plan.periods) {
        const proposed = period.proposedAssignment;
        const assignment = await transaction.assignment.create({ data: { assetId: item.assetId, importedHistory: true, personId: null,
          createdById: null, endedById: null, recipientType: period.recipient!.type, personName: proposed.personName, officeName: proposed.officeName,
          assignmentType: period.assignmentType, expectedReturnAt: null, startedAt: new Date(proposed.startedAt!), endedAt: new Date(proposed.endedAt!),
          returnStatus: period.returnStatus!, createdAt: application.appliedAt, returnRecordedAt: application.appliedAt,
          ticketReference: proposed.ticketReference, otReference: proposed.otReference, returnTicketReference: proposed.returnTicketReference,
          returnOtReference: proposed.returnOtReference, notes: period.note, returnNotes: period.evidenceReference } });
        const start = period.sources.find((source) => source.endpoint === 'start')!; const end = period.sources.find((source) => source.endpoint === 'end')!;
        const imported = await transaction.importGroupAssignmentItem.create({ data: { applicationId: application.id, periodId: period.periodId,
          assignmentId: assignment.id, startLinkId: start.groupHistoryLinkId, endLinkId: end.groupHistoryLinkId, snapshot: json(period) } });
        await transaction.importGroupAssignmentEvidenceUse.createMany({ data: [
          { evidenceId: start.evidenceId, linkId: start.groupHistoryLinkId, itemId: imported.id, endpoint: 'START' },
          { evidenceId: end.evidenceId, linkId: end.groupHistoryLinkId, itemId: imported.id, endpoint: 'END' }
        ] });
        await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_GROUP_CLOSED_ASSIGNMENT_ADDED', entityType: 'Assignment', entityId: assignment.id,
          metadata: { batchId, reviewId, applicationId, itemId, groupApplicationId: application.id, periodId: period.periodId,
            historicalActorsKnown: false, affectsCurrentState: false } } });
      }
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED', entityType: 'ImportGroupAssignmentApplication', entityId: application.id,
        metadata: { batchId, reviewId, applicationId, itemId, assetId: item.assetId, planId: plan.planId, periodCount: plan.periods.length, affectsCurrentState: false } } });
      return { ...scope, reused: false, application: await transaction.importGroupAssignmentApplication.findUniqueOrThrow({ where: { id: application.id }, include }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'GROUP_ASSIGNMENT_APPLICATION_CONFLICT', 'Plan, request or evidence already has a grouped history receipt');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'GROUP_ASSIGNMENT_APPLY_BUSY', 'Grouped historical application is busy; retry with the same request id');
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

export function getGroupAssignmentApplication(database: PrismaClient, batchId: string, reviewId: string, applicationId: string,
  itemId: string, groupApplicationId: string) {
  return database.$transaction(async (transaction) => {
    await requireItem(transaction, batchId, reviewId, applicationId, itemId);
    const application = await transaction.importGroupAssignmentApplication.findFirst({ where: { id: groupApplicationId, itemId }, include });
    if (!application) throw new ApiError(404, 'NOT_FOUND', 'Grouped assignment receipt not found in this applied group');
    return { ...scope, application };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function listGroupAssignmentApplications(database: PrismaClient, batchId: string, reviewId: string, applicationId: string,
  itemId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    await requireItem(transaction, batchId, reviewId, applicationId, itemId);
    const where = { itemId };
    const applications = await transaction.importGroupAssignmentApplication.findMany({ where, select: { id: true, itemId: true, assetId: true,
      requestId: true, planId: true, rulesVersion: true, appliedById: true, appliedAt: true, _count: { select: { items: true } } },
    orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importGroupAssignmentApplication.count({ where });
    return { ...scope, applications, total, ...query, hasMore: query.offset + applications.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
