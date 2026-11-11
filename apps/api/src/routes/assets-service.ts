import { AssetStatus, ProductTrackingMode, Role, type Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { lockProduct } from '../lib/product-lock.js';
import type { AssetCreateInput, AssetStatusInput, AssetUpdateInput } from './assets-schemas.js';
import { groupRetirementImportSelect, retirementImportSelect } from './retirement-history.js';


export const assetInclude = {
  importRetirement: { select: retirementImportSelect },
  groupRetirement: { select: groupRetirementImportSelect },
  product: { select: { id: true, name: true, sku: true, trackingMode: true, isActive: true, equipmentType: true, brand: true, model: true } }
} satisfies Prisma.AssetInclude;

const supportStatuses = new Set<AssetStatus>([
  AssetStatus.AVAILABLE,
  AssetStatus.RESERVED,
  AssetStatus.UNDER_REVIEW,
  AssetStatus.IN_REPAIR
]);

async function requireAssetProduct(database: Prisma.TransactionClient, productId: string) {
  const product = await lockProduct(database, productId);
  if (!product.isActive) throw new ApiError(409, 'PRODUCT_INACTIVE', 'The product is inactive');
  if (product.trackingMode !== ProductTrackingMode.ASSET) throw new ApiError(409, 'PRODUCT_NOT_ASSET', 'Quantity-tracked products cannot receive assets');
  return product;
}

async function lockAsset(database: Prisma.TransactionClient, assetId: string) {
  const rows = await database.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Asset"
    WHERE "id" = ${assetId}::uuid
    FOR UPDATE
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
  return database.asset.findUniqueOrThrow({ include: assetInclude, where: { id: assetId } });
}

function requireOperationalAsset(asset: { isActive: boolean; status: AssetStatus }) {
  if (!asset.isActive || asset.status === AssetStatus.DECOMMISSIONED) {
    throw new ApiError(409, 'ASSET_DECOMMISSIONED', 'A decommissioned asset cannot be changed');
  }
}

async function audit(database: Prisma.TransactionClient, userId: string, action: string, assetId: string, metadata?: Prisma.InputJsonValue) {
  await database.auditLog.create({ data: { userId, action, entityType: 'Asset', entityId: assetId, metadata } });
}

export async function createAsset(database: PrismaClient, input: AssetCreateInput, userId: string) {
  return database.$transaction((transaction) => createAssetInTransaction(transaction, input, userId));
}

export async function createAssetInTransaction(transaction: Prisma.TransactionClient, input: AssetCreateInput, userId: string) {
  await requireAssetProduct(transaction, input.productId);
  const asset = await transaction.asset.create({
    data: {
      ...input,
      status: AssetStatus.AVAILABLE,
      isActive: true
    },
    include: assetInclude
  });
  await audit(transaction, userId, 'ASSET_CREATED', asset.id, { productId: asset.productId, values: Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) });
  return asset;
}

export async function updateAsset(database: PrismaClient, assetId: string, input: AssetUpdateInput, userId: string) {
  return database.$transaction((transaction) => updateAssetInTransaction(transaction, assetId, input, userId));
}

export async function updateAssetInTransaction(transaction: Prisma.TransactionClient, assetId: string, input: AssetUpdateInput, userId: string) {
  const current = await lockAsset(transaction, assetId);
  requireOperationalAsset(current);
  const asset = await transaction.asset.update({
    where: { id: assetId },
    data: input,
    include: assetInclude
  });
  const fields = Object.keys(input).filter((key) => input[key as keyof AssetUpdateInput] !== undefined) as Array<keyof AssetUpdateInput>;
  await audit(transaction, userId, 'ASSET_UPDATED', asset.id, {
    fields,
    before: Object.fromEntries(fields.map((field) => [field, current[field]])),
    after: Object.fromEntries(fields.map((field) => [field, asset[field]]))
  });
  return asset;
}

export async function changeAssetStatus(database: PrismaClient, assetId: string, input: AssetStatusInput, role: Role, userId: string) {
  return database.$transaction(async (transaction) => {
    const current = await lockAsset(transaction, assetId);
    requireOperationalAsset(current);
    const activeAssignment = await transaction.assignment.findFirst({ where: { assetId, endedAt: null }, select: { id: true } });
    if (current.status === AssetStatus.ASSIGNED || activeAssignment) {
      throw new ApiError(409, 'ASSIGNMENT_REQUIRED', 'Return the active assignment before changing the asset status');
    }
    if (input.status === AssetStatus.ASSIGNED) throw new ApiError(409, 'ASSIGNMENT_REQUIRED', 'ASSIGNED status is managed by the assignment workflow');
    if (input.status === AssetStatus.DECOMMISSIONED) throw new ApiError(409, 'DECOMMISSION_REQUIRED', 'Use the decommission operation for this status');
    if (role === Role.SOPORTE && !supportStatuses.has(input.status)) throw new ApiError(403, 'FORBIDDEN', 'Support cannot set this asset status');
    if (current.status === input.status) throw new ApiError(409, 'ASSET_STATUS_UNCHANGED', 'The asset already has this status');
    const asset = await transaction.asset.update({ where: { id: assetId }, data: { status: input.status }, include: assetInclude });
    await audit(transaction, userId, 'ASSET_STATUS_CHANGED', asset.id, { from: current.status, to: asset.status });
    return asset;
  });
}

export async function decommissionAsset(database: PrismaClient, assetId: string, userId: string) {
  return database.$transaction(async (transaction) => {
    const current = await lockAsset(transaction, assetId);
    requireOperationalAsset(current);
    const activeAssignment = await transaction.assignment.findFirst({ where: { assetId, endedAt: null }, select: { id: true } });
    if (current.status === AssetStatus.ASSIGNED || activeAssignment) throw new ApiError(409, 'ASSET_ASSIGNED', 'An assigned asset cannot be decommissioned');
    const decommissionedAt = new Date();
    const asset = await transaction.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.DECOMMISSIONED, isActive: false, decommissionedAt },
      include: assetInclude
    });
    await audit(transaction, userId, 'ASSET_DECOMMISSIONED', asset.id, { from: current.status, decommissionedAt: decommissionedAt.toISOString() });
    return asset;
  });
}
