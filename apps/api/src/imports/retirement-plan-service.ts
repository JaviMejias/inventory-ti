import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { assertEvidenceIdentityUnreserved } from './identity-group-reservations.js';
import { currentHistoricalEvidence, latestAmendmentInclude } from './evidence-current.js';
import type { HistoricalRetirementPlanInput } from './retirement-plan-schemas.js';
import { buildHistoricalRetirementPlan } from './retirement-plan.js';
import { effectiveHistoricalAssignments } from './assignment-effective.js';

export async function planHistoricalRetirement(database: PrismaClient, assetId: string, input: HistoricalRetirementPlanInput) {
  return database.$transaction((transaction) => readHistoricalRetirementPlan(transaction, assetId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readHistoricalRetirementPlan(transaction: Prisma.TransactionClient, assetId: string, input: HistoricalRetirementPlanInput) {
  const asset = await transaction.asset.findUnique({ where: { id: assetId }, select: {
    id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, decommissionedAt: true, updatedAt: true,
    product: { select: { id: true, trackingMode: true, isActive: true, updatedAt: true } }
  } });
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
  const evidence = await transaction.importHistoricalEvidence.findUnique({ where: { id: input.evidenceId },
    include: { ...latestAmendmentInclude, capture: { select: { batchId: true, sourceRevision: true, rulesVersion: true } } } });
  if (!evidence) throw new ApiError(404, 'NOT_FOUND', 'Historical retirement evidence not found');
  await assertEvidenceIdentityUnreserved(transaction, [evidence.id]);
  const assignments = await transaction.assignment.findMany({ where: { assetId }, orderBy: { id: 'asc' }, take: 10001,
    select: { id: true, startedAt: true, endedAt: true, recipientType: true, personName: true, officeName: true, assignmentType: true, returnStatus: true } });
  if (assignments.length > 10000) throw new ApiError(409, 'HISTORICAL_PLAN_LIMIT', 'Asset assignment history exceeds the planning limit');
  const revisions = await transaction.importSourceRevision.findMany({ where: { batchId: evidence.capture.batchId },
    select: { batchId: true, revision: true, changes: true }, orderBy: { revision: 'asc' }, take: 1001 });
  if (revisions.length > 1000) throw new ApiError(409, 'HISTORICAL_PLAN_LIMIT', 'Selected source revisions exceed the planning limit');
  const usedEvidence = await transaction.importAssignmentEvidenceUse.findMany({ where: { evidenceId: evidence.id },
    select: { evidenceId: true, itemId: true }, orderBy: { evidenceId: 'asc' } });
  const retirement = await transaction.importRetirementApplication.findUnique({ where: { evidenceId: evidence.id }, select: { id: true, evidenceId: true } });
  if (retirement) usedEvidence.push({ evidenceId: retirement.evidenceId, itemId: retirement.id });
  return buildHistoricalRetirementPlan(asset, currentHistoricalEvidence(evidence), await effectiveHistoricalAssignments(transaction, assignments), revisions, input, new Date(), usedEvidence);
}
