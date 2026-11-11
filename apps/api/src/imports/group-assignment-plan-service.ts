import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { buildGroupClosedAssignmentPlan } from './group-assignment-plan.js';
import type { GroupClosedAssignmentPlanInput } from './group-assignment-plan-schemas.js';
import { effectiveHistoricalAssignments } from './assignment-effective.js';

function limit(): never { throw new ApiError(409, 'GROUP_ASSIGNMENT_PLAN_LIMIT', 'Group assignment context exceeds supported planning limits'); }

export async function readGroupClosedAssignmentContext(transaction: Prisma.TransactionClient, batchId: string, reviewId: string,
  applicationId: string, itemId: string) {
  const application = await transaction.importIdentityGroupApplication.findFirst({ where: { id: applicationId, batchId, reviewId },
    include: { items: { take: 26, orderBy: { groupKey: 'asc' }, include: { rows: { take: 26, orderBy: { recordId: 'asc' } } } } } });
  if (!application) throw new ApiError(404, 'NOT_FOUND', 'Group application not found in this review');
  const item = application.items.find((value) => value.id === itemId);
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Applied group item not found in this application');
  const asset = await transaction.asset.findUnique({ where: { id: item.assetId }, select: {
    id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, decommissionedAt: true, updatedAt: true,
    product: { select: { id: true, trackingMode: true, isActive: true, updatedAt: true } }
  } });
  const receipts = await transaction.importGroupHistoryApplication.findMany({ where: { itemId }, take: 101, orderBy: { id: 'asc' },
    include: { links: { take: 26, orderBy: { evidenceId: 'asc' } } } });
  if (receipts.length > 100) return limit();
  const evidence = await transaction.importHistoricalEvidence.findMany({ where: { sourceHash: application.sourceHash, recordId: { in: item.rows.map((row) => row.recordId) } },
    take: 101, orderBy: { id: 'asc' }, include: { capture: { select: { id: true, batchId: true, sourceHash: true, sourceRevision: true, rulesVersion: true } },
      amendments: { take: 1, orderBy: { version: 'desc' } }, assignmentUse: { select: { itemId: true, endpoint: true } },
      groupAssignmentUse: { select: { itemId: true, endpoint: true } }, retirementUse: { select: { id: true, assetId: true } } } });
  if (evidence.length > 100) return limit();
  const assignments = await transaction.assignment.findMany({ where: { assetId: item.assetId }, orderBy: { id: 'asc' }, take: 10001,
    select: { id: true, startedAt: true, endedAt: true, recipientType: true, personName: true, officeName: true, assignmentType: true, returnStatus: true } });
  if (assignments.length > 10000) return limit();
  const revisions = await transaction.importSourceRevision.findMany({ where: { batchId: { in: [...new Set(evidence.map((entry) => entry.capture.batchId))] } },
    select: { batchId: true, revision: true, changes: true }, orderBy: [{ batchId: 'asc' }, { revision: 'asc' }], take: 1001 });
  if (revisions.length > 1000) return limit();
  return { application, item, asset, receipts, evidence, assignments, revisions };
}

export type GroupClosedAssignmentContext = Awaited<ReturnType<typeof readGroupClosedAssignmentContext>>;

export async function readGroupClosedAssignmentPlan(transaction: Prisma.TransactionClient, batchId: string, reviewId: string,
  applicationId: string, itemId: string, input: GroupClosedAssignmentPlanInput) {
  const context = await readGroupClosedAssignmentContext(transaction, batchId, reviewId, applicationId, itemId);
  return buildGroupClosedAssignmentPlan(context.application, itemId, context.asset, context.receipts, context.evidence,
    await effectiveHistoricalAssignments(transaction, context.assignments), context.revisions, input);
}

export function planGroupClosedAssignments(database: PrismaClient, batchId: string, reviewId: string, applicationId: string,
  itemId: string, input: GroupClosedAssignmentPlanInput) {
  return database.$transaction((transaction) => readGroupClosedAssignmentPlan(transaction, batchId, reviewId, applicationId, itemId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}
