import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { buildGroupHistoryPlan } from './identity-group-history-plan.js';
import type { IdentityGroupHistoryPlanInput } from './identity-group-history-schemas.js';

export async function readGroupHistoryLinkPlan(transaction: Prisma.TransactionClient, batchId: string, reviewId: string, applicationId: string, itemId: string, input: IdentityGroupHistoryPlanInput) {
  const application = await transaction.importIdentityGroupApplication.findFirst({ where: { id: applicationId, batchId, reviewId },
    include: { items: { take: 26, orderBy: { groupKey: 'asc' }, include: { rows: { take: 26, orderBy: { recordId: 'asc' } } } } } });
  if (!application) throw new ApiError(404, 'NOT_FOUND', 'Group application not found in this review');
  const item = application.items.find((entry) => entry.id === itemId);
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Applied group item not found in this application');
  const asset = await transaction.asset.findUnique({ where: { id: item.assetId }, select: {
    id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, decommissionedAt: true, updatedAt: true,
    product: { select: { id: true, trackingMode: true, isActive: true, updatedAt: true } }
  } });
  const evidence = await transaction.importHistoricalEvidence.findMany({ where: { sourceHash: application.sourceHash, recordId: { in: item.rows.map((row) => row.recordId) } },
    take: 101, orderBy: { id: 'asc' }, include: { capture: { select: { id: true, batchId: true, sourceHash: true, sourceRevision: true, rulesVersion: true } },
      amendments: { take: 1, orderBy: { version: 'desc' } }, groupHistoryLink: { select: { id: true, historyApplicationId: true, assetId: true, version: true } },
      assignmentUse: { select: { itemId: true, endpoint: true } }, groupAssignmentUse: { select: { itemId: true, endpoint: true } },
      retirementUse: { select: { id: true, assetId: true } } } });
  if (evidence.length > 100) throw new ApiError(409, 'GROUP_HISTORY_PLAN_LIMIT', 'Group evidence exceeds the planning limit');
  const revisions = await transaction.importSourceRevision.findMany({ where: { batchId: { in: [...new Set(evidence.map((entry) => entry.capture.batchId))] } },
    take: 1001, orderBy: [{ batchId: 'asc' }, { revision: 'asc' }], select: { batchId: true, revision: true, changes: true } });
  return buildGroupHistoryPlan(application, itemId, asset, evidence, revisions, input);
}

export function planGroupHistoryLink(database: PrismaClient, batchId: string, reviewId: string, applicationId: string, itemId: string, input: IdentityGroupHistoryPlanInput) {
  return database.$transaction((transaction) => readGroupHistoryLinkPlan(transaction, batchId, reviewId, applicationId, itemId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}
