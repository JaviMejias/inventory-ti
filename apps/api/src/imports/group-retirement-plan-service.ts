import { Prisma, type ImportIdentityGroupDecision, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { effectiveHistoricalAssignments } from './assignment-effective.js';
import { buildGroupRetirementPlan } from './group-retirement-plan.js';
import type { GroupRetirementPlanInput } from './group-retirement-plan-schemas.js';
import { readIdentityGroupProjection } from './identity-group-projection-service.js';
import { readConsumedGroupRows } from './group-source-consumption.js';

export function planGroupRetirement(database: PrismaClient, batchId: string, reviewId: string, input: GroupRetirementPlanInput) {
  return database.$transaction((transaction) => readGroupRetirementPlan(transaction, batchId, reviewId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readGroupRetirementPlan(transaction: Prisma.TransactionClient, batchId: string, reviewId: string, input: GroupRetirementPlanInput) {
  const projection = await readIdentityGroupProjection(transaction, batchId, reviewId);
  const group = projection.groups.find((entry) => entry.groupKey === input.groupKey);
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Physical group not found in this review');
  const decisions = await transaction.$queryRaw<ImportIdentityGroupDecision[]>`
    SELECT DISTINCT ON ("groupKey") * FROM "ImportIdentityGroupDecision" WHERE "reviewId" = ${reviewId}::uuid ORDER BY "groupKey", "version" DESC LIMIT 26`;
  const decision = decisions.find((entry) => entry.groupKey === input.groupKey);
  const asset = decision?.linkedAssetId ? await transaction.asset.findUnique({ where: { id: decision.linkedAssetId }, select: {
    id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, decommissionedAt: true, updatedAt: true,
    product: { select: { id: true, trackingMode: true, isActive: true, updatedAt: true } }
  } }) : null;
  const evidence = await transaction.importHistoricalEvidence.findMany({ where: { sourceHash: projection.sourceHash, recordId: { in: group.recordIds } },
    orderBy: { id: 'asc' }, take: 101, include: { capture: { select: { id: true, batchId: true, sourceHash: true, sourceRevision: true, rulesVersion: true } },
      amendments: { take: 1, orderBy: { version: 'desc' } }, assignmentUse: { select: { itemId: true, endpoint: true } },
      groupAssignmentUse: { select: { itemId: true, endpoint: true } }, retirementUse: { select: { id: true, assetId: true } },
      groupHistoryLink: { select: { id: true, historyApplicationId: true, assetId: true, version: true } } } });
  const assignments = asset ? await transaction.assignment.findMany({ where: { assetId: asset.id }, orderBy: { id: 'asc' }, take: 10001,
    select: { id: true, startedAt: true, endedAt: true, recipientType: true, personName: true, officeName: true, assignmentType: true, returnStatus: true } }) : [];
  const revisions = await transaction.importSourceRevision.findMany({ where: { batchId: { in: [...new Set(evidence.map((entry) => entry.capture.batchId))] } },
    orderBy: [{ batchId: 'asc' }, { revision: 'asc' }], take: 1001, select: { batchId: true, revision: true, changes: true } });
  const consumedRows = await readConsumedGroupRows(transaction, projection.sourceHash, group.recordIds);
  if (assignments.length > 10000) throw new ApiError(409, 'GROUP_RETIREMENT_PLAN_LIMIT', 'Asset assignment history exceeds the retirement planning limit');
  return buildGroupRetirementPlan(projection, decisions, asset, evidence, await effectiveHistoricalAssignments(transaction, assignments), revisions, consumedRows, input);
}
