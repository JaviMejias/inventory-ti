import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { assertIdentityGroupUnreserved } from './identity-group-reservations.js';
import { buildPilotPlan, type PlanDecision } from './plan.js';
import type { PilotPlanInput } from './plan-schemas.js';
import { previewDate } from './preview.js';
import { buildResolvedPreview } from './identity.js';
import { readPreviewAssets } from './snapshot.js';
import { readResolvedSource } from './source-service.js';

export async function planImportPilot(database: PrismaClient, id: string, input: PilotPlanInput) {
  return database.$transaction((transaction) => readImportPilot(transaction, id, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readImportPilot(transaction: Prisma.TransactionClient, id: string, input: PilotPlanInput) {
  const batch = await transaction.importBatch.findUnique({ where: { id } });
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
  if (batch.version !== input.expectedVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the batch before planning changes', { currentVersion: batch.version });
  await assertIdentityGroupUnreserved(transaction, batch.sourceHash, input.operations.map((operation) => operation.candidateId));
  const resolved = await readResolvedSource(transaction, id);
  const preview = buildResolvedPreview(resolved.original, resolved.workbook, await readPreviewAssets(transaction), previewDate(), 'DATABASE');
  const decisions = await transaction.$queryRaw<PlanDecision[]>`
    SELECT DISTINCT ON ("targetType", "targetId") "id", "targetType", "targetId", "action", "linkedAssetId", "batchVersion", "sourceRevision"
    FROM "ImportReviewDecision" WHERE "batchId" = ${id}::uuid
    ORDER BY "targetType", "targetId", "batchVersion" DESC`;
  const assets = await transaction.asset.findMany({ where: { id: { in: input.operations.flatMap((operation) => operation.type === 'UPDATE_METADATA' ? [operation.assetId] : []) } },
    select: { id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, updatedAt: true,
      technicalCondition: true, usagePurpose: true, location: true, sector: true, ipAddress: true, hostname: true, loanCode: true, notes: true } });
  const productIds = [...assets.map((asset) => asset.productId), ...input.operations.flatMap((operation) => operation.type === 'CREATE_ASSET' ? [operation.values.productId] : [])];
  const products = await transaction.product.findMany({ where: { id: { in: productIds } }, select: {
    id: true, name: true, trackingMode: true, isActive: true, equipmentType: true, brand: true, model: true, updatedAt: true
  } });
  return buildPilotPlan(batch, preview, decisions, products, assets, input, resolved.sourceContext);
}
