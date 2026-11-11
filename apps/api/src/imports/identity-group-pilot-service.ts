import { Prisma, type ImportIdentityGroupDecision, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import type { IdentityGroupPilotInput } from './identity-group-pilot-schemas.js';
import { buildIdentityGroupPilot } from './identity-group-pilot.js';
import { readIdentityGroupProjection } from './identity-group-projection-service.js';
import { readConsumedGroupRows } from './group-source-consumption.js';

export function planIdentityGroupPilot(database: PrismaClient, batchId: string, reviewId: string, input: IdentityGroupPilotInput) {
  return database.$transaction((transaction) => readIdentityGroupPilot(transaction, batchId, reviewId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readIdentityGroupPilot(transaction: Prisma.TransactionClient, batchId: string, reviewId: string, input: IdentityGroupPilotInput) {
  const projection = await readIdentityGroupProjection(transaction, batchId, reviewId);
  const decisions = await transaction.$queryRaw<ImportIdentityGroupDecision[]>`
    SELECT DISTINCT ON ("groupKey") * FROM "ImportIdentityGroupDecision"
    WHERE "reviewId" = ${reviewId}::uuid ORDER BY "groupKey", "version" DESC LIMIT 26`;
  if (decisions.length > 25) throw new ApiError(409, 'IDENTITY_GROUP_DECISION_LIMIT', 'Review exceeds the latest group decision limit');
  const assets = await transaction.asset.findMany({ where: { id: { in: input.operations.flatMap((operation) => operation.type === 'UPDATE_METADATA' ? [operation.assetId] : []) } },
    select: { id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, updatedAt: true,
      technicalCondition: true, usagePurpose: true, location: true, sector: true, ipAddress: true, hostname: true, loanCode: true, notes: true } });
  const productIds = [...assets.map((asset) => asset.productId), ...input.operations.flatMap((operation) => operation.type === 'CREATE_ASSET' ? [operation.values.productId] : [])];
  const products = await transaction.product.findMany({ where: { id: { in: productIds } }, select: {
    id: true, name: true, trackingMode: true, isActive: true, equipmentType: true, brand: true, model: true, updatedAt: true
  } });
  const consumedRows = await readConsumedGroupRows(transaction, projection.sourceHash, projection.groups.flatMap((group) => group.recordIds));
  return buildIdentityGroupPilot(projection, decisions, products, assets, input, consumedRows);
}
