import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { buildAssignmentCorrectionPlan } from './assignment-correction-plan.js';
import type { AssignmentCorrectionPlanInput } from './assignment-correction-schemas.js';
import { effectiveHistoricalAssignments } from './assignment-effective.js';
import { currentHistoricalEvidence, latestAmendmentInclude } from './evidence-current.js';
import { assertEvidenceIdentityUnreserved } from './identity-group-reservations.js';

export function planAssignmentCorrection(database: PrismaClient, assetId: string, applicationId: string, itemId: string, input: AssignmentCorrectionPlanInput) {
  return database.$transaction((transaction) => readAssignmentCorrectionPlan(transaction, assetId, applicationId, itemId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}
export async function readAssignmentCorrectionPlan(transaction: Prisma.TransactionClient, assetId: string, applicationId: string, itemId: string, input: AssignmentCorrectionPlanInput) {
  const receipt = await transaction.importAssignmentApplication.findFirst({ where: { id: applicationId, assetId },
    include: { items: { orderBy: { periodId: 'asc' }, take: 26, include: { assignment: { include: { groupImportHistory: { select: { id: true } } } },
      evidenceUses: { orderBy: { endpoint: 'asc' }, take: 3 } } } } });
  if (!receipt || !receipt.items.some((item) => item.id === itemId)) throw new ApiError(404, 'NOT_FOUND', 'Legacy assignment item not found in this receipt');
  if (receipt.items.length > 25) throw new ApiError(409, 'ASSIGNMENT_CORRECTION_LIMIT', 'Legacy receipt exceeds the supported period limit');
  const asset = await transaction.asset.findUnique({ where: { id: assetId }, include: { product: { select: { id: true, trackingMode: true, isActive: true, updatedAt: true } } } });
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
  const ids = receipt.items.flatMap((item) => [item.startEvidenceId, item.endEvidenceId]);
  const evidence = await transaction.importHistoricalEvidence.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, take: 51,
    include: { ...latestAmendmentInclude, capture: { select: { batchId: true, sourceRevision: true, rulesVersion: true } },
      assignmentUse: { select: { itemId: true, endpoint: true } }, groupAssignmentUse: { select: { itemId: true } },
      retirementUse: { select: { id: true } }, groupRetirementUse: { select: { id: true } }, groupHistoryLink: { select: { id: true } } } });
  if (evidence.length !== ids.length) throw new ApiError(409, 'INVALID_ASSIGNMENT_APPLICATION', 'Legacy origin endpoint coverage is incomplete');
  await assertEvidenceIdentityUnreserved(transaction, ids);
  const assignments = await transaction.assignment.findMany({ where: { assetId }, orderBy: { id: 'asc' }, take: 10001 });
  const revisions = await transaction.importSourceRevision.findMany({ where: { batchId: { in: [...new Set(evidence.map((entry) => entry.capture.batchId))] } },
    orderBy: [{ batchId: 'asc' }, { revision: 'asc' }], take: 1001, select: { batchId: true, revision: true, changes: true } });
  const audits = await transaction.auditLog.findMany({ where: { OR: [
    { action: 'IMPORT_CLOSED_ASSIGNMENTS_APPLIED', entityType: 'ImportAssignmentApplication', entityId: receipt.id },
    { action: 'IMPORT_CLOSED_ASSIGNMENT_ADDED', entityType: 'Assignment', entityId: { in: receipt.items.map((item) => item.assignmentId) } }
  ] }, orderBy: { id: 'asc' }, take: 27, select: { action: true, entityType: true, entityId: true, userId: true, metadata: true } });
  if (assignments.length > 10000 || revisions.length > 1000 || audits.length > 26) throw new ApiError(409, 'ASSIGNMENT_CORRECTION_LIMIT', 'Legacy correction exceeds supported history, revision or audit limits');
  const effective = await effectiveHistoricalAssignments(transaction, assignments);
  const corrections = await transaction.importAssignmentCorrection.findMany({ where: { itemId }, orderBy: { version: 'asc' }, take: 1001 });
  const { product, ...currentAsset } = asset;
  return buildAssignmentCorrectionPlan(receipt, itemId, audits, { asset: { id: asset.id, productId: asset.productId, serialNumber: asset.serialNumber,
    assetTag: asset.assetTag, status: asset.status, isActive: asset.isActive, decommissionedAt: asset.decommissionedAt, updatedAt: asset.updatedAt, product },
    currentAsset, custody: assignments.filter((entry) => entry.endedAt === null), assignments: effective, originalAssignments: assignments,
    evidence: evidence.map(currentHistoricalEvidence), revisions }, input, new Date(), corrections);
}
