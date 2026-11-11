import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { assertEvidenceIdentityUnreserved } from './identity-group-reservations.js';
import { buildClosedAssignmentPlan } from './assignment-plan.js';
import type { ClosedAssignmentPlanInput } from './assignment-plan-schemas.js';
import { currentHistoricalEvidence, latestAmendmentInclude } from './evidence-current.js';
import { effectiveHistoricalAssignments } from './assignment-effective.js';

export async function planClosedAssignments(database: PrismaClient, assetId: string, input: ClosedAssignmentPlanInput) {
  return database.$transaction((transaction) => readClosedAssignmentPlan(transaction, assetId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readClosedAssignmentPlan(transaction: Prisma.TransactionClient, assetId: string, input: ClosedAssignmentPlanInput) {
  const asset = await transaction.asset.findUnique({ where: { id: assetId }, select: {
    id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, decommissionedAt: true, updatedAt: true,
    product: { select: { id: true, trackingMode: true, isActive: true, updatedAt: true } }
  } });
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
  const ids = input.periods.flatMap((period) => [period.start.evidenceId, period.end.evidenceId]);
  const evidence = await transaction.importHistoricalEvidence.findMany({ where: { id: { in: ids } },
    include: { ...latestAmendmentInclude, capture: { select: { batchId: true, sourceRevision: true, rulesVersion: true } } }, orderBy: { id: 'asc' } });
  if (evidence.length !== ids.length) throw new ApiError(404, 'NOT_FOUND', 'Historical endpoint evidence not found');
  await assertEvidenceIdentityUnreserved(transaction, ids);
  const assignments = await transaction.assignment.findMany({ where: { assetId }, orderBy: { id: 'asc' }, take: 10001,
    select: { id: true, startedAt: true, endedAt: true, recipientType: true, personName: true, officeName: true, assignmentType: true, returnStatus: true } });
  if (assignments.length > 10000) throw new ApiError(409, 'HISTORICAL_PLAN_LIMIT', 'Asset assignment history exceeds the planning limit');
  const revisions = await transaction.importSourceRevision.findMany({ where: { batchId: { in: [...new Set(evidence.map((entry) => entry.capture.batchId))] } },
    select: { batchId: true, revision: true, changes: true }, orderBy: [{ batchId: 'asc' }, { revision: 'asc' }], take: 1001 });
  if (revisions.length > 1000) throw new ApiError(409, 'HISTORICAL_PLAN_LIMIT', 'Selected source revisions exceed the planning limit');
  const usedEvidence = await transaction.importAssignmentEvidenceUse.findMany({ where: { evidenceId: { in: ids } },
    select: { evidenceId: true, itemId: true }, orderBy: { evidenceId: 'asc' } });
  return buildClosedAssignmentPlan(asset, evidence.map(currentHistoricalEvidence), await effectiveHistoricalAssignments(transaction, assignments), revisions, input, new Date(), usedEvidence);
}
