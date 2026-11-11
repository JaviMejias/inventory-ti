import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { buildGroupAssignmentCorrectionPlan } from './group-assignment-correction-plan.js';
import type { GroupAssignmentCorrectionPlanInput } from './group-assignment-correction-schemas.js';
import { readGroupClosedAssignmentContext } from './group-assignment-plan-service.js';
import { effectiveHistoricalAssignments } from './assignment-effective.js';

export function planGroupAssignmentCorrection(database: PrismaClient, batchId: string, reviewId: string, applicationId: string,
  itemId: string, groupApplicationId: string, assignmentItemId: string, input: GroupAssignmentCorrectionPlanInput) {
  return database.$transaction((transaction) => readGroupAssignmentCorrectionPlan(transaction, batchId, reviewId, applicationId, itemId, groupApplicationId, assignmentItemId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readGroupAssignmentCorrectionPlan(transaction: Prisma.TransactionClient, batchId: string, reviewId: string, applicationId: string,
  itemId: string, groupApplicationId: string, assignmentItemId: string, input: GroupAssignmentCorrectionPlanInput) {
  const receipt = await transaction.importGroupAssignmentApplication.findFirst({ where: { id: groupApplicationId, itemId,
    item: { applicationId, application: { batchId, reviewId } } },
  include: { items: { take: 26, orderBy: { periodId: 'asc' }, include: { assignment: { include: { importHistory: { select: { id: true } } } },
    evidenceUses: { take: 3, orderBy: { endpoint: 'asc' } } } } } });
  if (!receipt || !receipt.items.some((item) => item.id === assignmentItemId)) throw new ApiError(404, 'NOT_FOUND', 'Imported assignment item not found in this receipt');
  const context = await readGroupClosedAssignmentContext(transaction, batchId, reviewId, applicationId, itemId);
  const asset = await transaction.asset.findUnique({ where: { id: receipt.assetId } });
  const custody = await transaction.assignment.findMany({ where: { assetId: receipt.assetId, endedAt: null }, take: 2, orderBy: { id: 'asc' } });
  const audits = await transaction.auditLog.findMany({ where: { userId: receipt.appliedById, OR: [
    { action: 'IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED', entityType: 'ImportGroupAssignmentApplication', entityId: receipt.id },
    { action: 'IMPORT_GROUP_CLOSED_ASSIGNMENT_ADDED', entityType: 'Assignment', entityId: { in: receipt.items.map((item) => item.assignmentId) } }
  ] }, take: 27, orderBy: { id: 'asc' }, select: { action: true, entityType: true, entityId: true, userId: true } });
  const corrections = await transaction.importGroupAssignmentCorrection.findMany({ where: { itemId: assignmentItemId }, orderBy: { version: 'asc' }, take: 1001 });
  const effective = await effectiveHistoricalAssignments(transaction, context.assignments);
  return buildGroupAssignmentCorrectionPlan(context, receipt, assignmentItemId, audits, { asset, custody }, input, new Date(), corrections, effective);
}
