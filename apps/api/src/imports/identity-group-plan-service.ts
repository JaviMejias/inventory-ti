import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { assertIdentityGroupUnreserved } from './identity-group-reservations.js';
import type { IdentityGroupPlanInput } from './identity-group-plan-schemas.js';
import { buildIdentityGroupPlan, selectIdentityGroupScope, type IdentityGroupImpacts } from './identity-group-plan.js';
import { buildWorkbookPreview, previewDate } from './preview.js';
import { readPreviewAssets } from './snapshot.js';
import { readResolvedSource } from './source-service.js';

export async function planIdentityGroups(database: PrismaClient, batchId: string, input: IdentityGroupPlanInput) {
  return database.$transaction((transaction) => readIdentityGroupPlan(transaction, batchId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readIdentityGroupPlan(transaction: Prisma.TransactionClient, batchId: string, input: IdentityGroupPlanInput) {
  const resolved = await readResolvedSource(transaction, batchId);
  if (resolved.batch.version !== input.expectedVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the current batch version');
  if (resolved.sourceContext.revision !== input.expectedSourceRevision) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload the current source revision');
  const asOf = previewDate();
  const baseline = buildWorkbookPreview(resolved.original, [], asOf);
  const records = [...selectIdentityGroupScope(baseline, input).selectedRecords];
  await assertIdentityGroupUnreserved(transaction, resolved.batch.sourceHash, input.candidateIds, records);
  const impacts = await readIdentityGroupImpacts(transaction, batchId, resolved.batch.sourceHash, input.candidateIds, records);
  return buildIdentityGroupPlan(resolved.original, resolved.workbook, await readPreviewAssets(transaction),
    { batchId, batchVersion: resolved.batch.version, sourceContext: resolved.sourceContext }, input, impacts, asOf);
}

export async function readIdentityGroupImpacts(transaction: Prisma.TransactionClient, batchId: string, sourceHash: string, candidateIds: string[], records: string[]): Promise<IdentityGroupImpacts> {
  const decisions = await transaction.$queryRaw<IdentityGroupImpacts['decisions']>`
    SELECT DISTINCT ON ("targetId") "id", "targetType", "targetId", "action", "linkedAssetId", "batchVersion", "sourceRevision"
    FROM "ImportReviewDecision" WHERE "batchId" = ${batchId}::uuid AND "targetType" = 'CANDIDATE' AND "targetId" IN (${Prisma.join(candidateIds)})
    ORDER BY "targetId", "batchVersion" DESC`;
  const pilotItems = await transaction.importApplicationItem.findMany({ where: { sourceHash, candidateId: { in: candidateIds } },
    select: { id: true, candidateId: true, assetId: true, applicationId: true }, orderBy: { id: 'asc' } });
  const evidence = await transaction.importHistoricalEvidence.findMany({ where: { sourceHash, recordId: { in: records } }, take: 101,
    orderBy: { id: 'asc' }, select: { id: true, recordId: true, candidateId: true, captureId: true, assetId: true,
      capture: { select: { batchId: true, sourceRevision: true } }, amendments: { take: 1, orderBy: { version: 'desc' }, select: { id: true, version: true, assetId: true, sourceRevision: true } },
      assignmentUse: { select: { itemId: true, endpoint: true } }, retirementUse: { select: { id: true, assetId: true } } } });
  if (evidence.length > 100) throw new ApiError(409, 'IDENTITY_GROUP_EVIDENCE_LIMIT', 'Selected historical evidence exceeds the planning limit');
  return { decisions, pilotItems,
      evidence: evidence.map(({ amendments, assetId, capture, ...item }) => ({ ...item, capturedAssetId: assetId,
        currentAssetId: amendments[0] ? amendments[0].assetId : assetId, evidenceVersion: amendments[0]?.version ?? 0,
        amendmentId: amendments[0]?.id ?? null, sourceRevision: amendments[0]?.sourceRevision ?? capture.sourceRevision,
        captureBatchId: capture.batchId, capturedSourceRevision: capture.sourceRevision })) };
}
