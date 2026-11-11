import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { effectiveHistoricalAssignments } from './assignment-effective.js';
import { sheetDictionary } from './dictionary.js';
import { buildGroupRetirementReconciliation, groupReconciliationReceiptSelect, type GroupReconciliationConsumption } from './group-retirement-reconciliation.js';
import type { GroupRetirementReconciliationInput } from './group-retirement-reconciliation-schemas.js';
import { validateIdentityGroupReviewLineage } from './identity-group-projection.js';
import { importPlanDigest } from './plan.js';
import { previewDate } from './preview.js';
import { reconciliationReceiptSelect } from './retirement-reconciliation.js';
import { readResolvedSource } from './source-service.js';

export async function reconcileGroupRetirement(database: PrismaClient, batchId: string, reviewId: string, input: GroupRetirementReconciliationInput) {
  return database.$transaction((transaction) => readGroupRetirementReconciliation(transaction, batchId, reviewId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readGroupRetirementReconciliation(transaction: Prisma.TransactionClient, batchId: string, reviewId: string, input: GroupRetirementReconciliationInput) {
  const review = await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId },
    include: { rows: { orderBy: { recordId: 'asc' }, take: 26 }, release: { select: { id: true } } } });
  if (!review) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
  const resolved = await readResolvedSource(transaction, batchId); const now = new Date();
  const saved = validateIdentityGroupReviewLineage(review, resolved.original, previewDate(now));
  const group = saved.request.groups.find((entry) => importPlanDigest(['IMPORT_IDENTITY_GROUP', review.sourceHash, review.id, entry.groupId]) === input.groupKey);
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Physical group not found in this review');
  const asset = await transaction.asset.findUnique({ where: { id: input.assetId }, select: {
    id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, decommissionedAt: true, updatedAt: true,
    product: { select: { id: true, trackingMode: true, isActive: true, updatedAt: true } }
  } });
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
  const evidence = await transaction.importHistoricalEvidence.findMany({ where: { sourceHash: review.sourceHash, recordId: { in: group.recordIds } },
    orderBy: { id: 'asc' }, take: 101, include: { capture: { select: { id: true, batchId: true, sourceHash: true, sourceRevision: true, rulesVersion: true } },
      amendments: { take: 1, orderBy: { version: 'desc' } }, assignmentUse: { select: { itemId: true, endpoint: true } },
      groupAssignmentUse: { select: { itemId: true, endpoint: true } }, retirementUse: { select: { id: true, assetId: true } },
      groupHistoryLink: { select: { id: true, historyApplicationId: true, assetId: true, version: true } } } });
  if (!evidence.some((entry) => entry.id === input.evidenceId)) throw new ApiError(404, 'NOT_FOUND', 'Evidence not found in this physical group');
  const assignments = await transaction.assignment.findMany({ where: { assetId: asset.id }, orderBy: { id: 'asc' }, take: 10001,
    select: { id: true, startedAt: true, endedAt: true, recipientType: true, personName: true, officeName: true, assignmentType: true, returnStatus: true } });
  if (assignments.length > 10000) throw new ApiError(409, 'GROUP_RECONCILIATION_LIMIT', 'Asset history exceeds reconciliation limits');
  const revisions = await transaction.importSourceRevision.findMany({ where: { batchId: { in: [...new Set(evidence.map((entry) => entry.capture.batchId))] } },
    orderBy: [{ batchId: 'asc' }, { revision: 'asc' }], take: 1001, select: { batchId: true, revision: true, changes: true } });
  const where = { sourceHash: review.sourceHash, recordId: { in: group.recordIds } };
  const pilotRows = await transaction.importIdentityGroupRowUse.findMany({ where, take: 26, orderBy: { recordId: 'asc' }, select: { sourceHash: true, recordId: true, reviewId: true,
    item: { select: { assetId: true, applicationId: true, application: { select: { batchId: true } } } } } });
  const retiredRows = await transaction.importGroupRetirementRowUse.findMany({ where, take: 26, orderBy: { recordId: 'asc' }, select: { sourceHash: true, recordId: true, reviewId: true,
    applicationId: true, application: { select: { assetId: true, batchId: true } } } });
  const consumption: GroupReconciliationConsumption[] = [
    ...pilotRows.map(({ item, ...row }) => ({ ...row, assetId: item.assetId, applicationId: item.applicationId, batchId: item.application.batchId, origin: 'GROUP_ASSET_PILOT' as const })),
    ...retiredRows.map(({ application, ...row }) => ({ ...row, ...application, origin: 'GROUP_RETIREMENT' as const }))
  ].sort((a, b) => a.recordId.localeCompare(b.recordId) || a.origin.localeCompare(b.origin));
  const reservations = await transaction.importIdentityGroupRow.findMany({ where: { ...where, isReserved: true, review: { release: null } },
    take: 26, orderBy: { recordId: 'asc' }, select: { recordId: true, reviewId: true, groupId: true } });
  const receiptsWhere = { OR: [{ assetId: asset.id }, { evidenceId: input.evidenceId }] };
  const legacy = await transaction.importRetirementApplication.findMany({ where: receiptsWhere, select: reconciliationReceiptSelect, orderBy: { id: 'asc' }, take: 3 });
  const grouped = await transaction.importGroupRetirementApplication.findMany({ where: receiptsWhere, select: groupReconciliationReceiptSelect, orderBy: { id: 'asc' }, take: 3 });
  const documents = await transaction.importRetirementReconciliation.findMany({ where: { evidenceId: input.evidenceId }, orderBy: { evidenceVersion: 'asc' }, take: 1002,
    select: { id: true, assetId: true, evidenceId: true, evidenceVersion: true, amendmentId: true, sourceRevision: true, planId: true, recordedById: true, recordedAt: true } });
  const latestDecision = await transaction.importIdentityGroupDecision.findFirst({ where: { reviewId, groupKey: input.groupKey }, orderBy: { version: 'desc' },
    select: { id: true, version: true, action: true, linkedAssetId: true, projectionId: true } });
  const identityRevisedRecordIds = saved.observations.filter((row) => group.recordIds.includes(row.recordId)).filter((observation) => {
    const row = resolved.workbook.sheets.find((sheet) => sheet.name === observation.sheet)?.rows.find((entry) => entry.row === observation.row);
    const cells = Object.fromEntries(['serialNumber', 'assetTag'].map((field) => {
      const column = Object.entries(sheetDictionary[observation.sheet].columns).find(([, definition]) => definition.field === field)?.[0];
      return [field, column ? row?.cells[column] ?? null : null];
    }));
    return !row || importPlanDigest(cells) !== importPlanDigest(observation.currentIdentityCells);
  }).map((row) => row.recordId);
  const reviewSourceRevisedRecordIds = [...new Set(resolved.sourceContext.corrections.filter((change) =>
    change.revision > review.sourceRevision && group.recordIds.includes(change.recordId)).map((change) => change.recordId))];
  return buildGroupRetirementReconciliation({ review, saved, batchVersion: resolved.batch.version, sourceRevision: resolved.sourceContext.revision,
    identityRevisedRecordIds, reviewSourceRevisedRecordIds, asset, evidence, assignments: await effectiveHistoricalAssignments(transaction, assignments), revisions, consumption, reservations,
    receipts: [...legacy.map((receipt) => ({ ...receipt, origin: 'LEGACY' as const })), ...grouped.map((receipt) => ({ ...receipt, origin: 'GROUP' as const }))], documents, latestDecision }, input, now);
}
