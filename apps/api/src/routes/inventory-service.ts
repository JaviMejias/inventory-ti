import { randomUUID } from 'node:crypto';
import { MovementType, type Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { lockProduct } from '../lib/product-lock.js';
import { maximumQuantity } from '../lib/quantity.js';

type MovementInput = { productId: string; quantity: number; reason?: string | null; reference?: string | null; effectiveAt?: Date };
type MovementResponseInput = { id: string; productId: string; performedById: string | null; movementType: MovementType; quantity: number; reason: string | null; reference: string | null; effectiveAt: Date; createdAt: Date; product?: unknown; performedBy?: unknown };

function movementResponse(movement: MovementResponseInput) {
  return {
    id: movement.id,
    productId: movement.productId,
    performedById: movement.performedById,
    movementType: movement.movementType,
    quantity: movement.quantity,
    reason: movement.reason,
    reference: movement.reference,
    effectiveAt: movement.effectiveAt,
    createdAt: movement.createdAt,
    product: movement.product,
    performedBy: movement.performedBy
  };
}

export function movementEffect(movement: { movementType: MovementType; quantity: number }) {
  return movement.movementType === MovementType.EXIT ? -Math.abs(movement.quantity) : movement.quantity;
}

function movementReadResponse(movement: MovementResponseInput & { product?: { trackingMode?: string }; assetId: string | null; originalFor?: Array<{ id: string; status: string; delta?: number }>; compensatingFor?: { id: string } | null }) {
  const correctionRequests = movement.originalFor ?? [];
  const originalQuantity = movementEffect(movement);
  const effectiveQuantity = originalQuantity + correctionRequests.reduce((total, correction) => total + (correction.status === 'APPROVED' ? correction.delta ?? 0 : 0), 0);
  return {
    ...movementResponse(movement), assetId: movement.assetId, correctionRequests, originalQuantity, effectiveQuantity,
    compensatingCorrectionId: movement.compensatingFor?.id ?? null,
    canCorrect: movement.product?.trackingMode === 'QUANTITY' && !movement.assetId && !movement.compensatingFor && !correctionRequests.some((correction) => correction.status === 'PENDING')
  };
}

export function stockResponse(stock: { id: string; productId: string; quantity: number; product?: unknown; updatedAt: Date }) {
  return { id: stock.id, productId: stock.productId, quantity: stock.quantity, product: stock.product, updatedAt: stock.updatedAt };
}

async function getActiveProduct(database: Prisma.TransactionClient, productId: string) {
  const product = await lockProduct(database, productId);
  if (!product.isActive) throw new ApiError(409, 'PRODUCT_INACTIVE', 'The product is inactive');
  if (product.trackingMode !== 'QUANTITY') throw new ApiError(409, 'ASSET_PRODUCT_UNSUPPORTED', 'Asset-tracked products are not supported by quantity inventory');
  return product;
}

async function ensureStockRow(database: Prisma.TransactionClient, productId: string) {
  await database.$executeRaw`INSERT INTO "InventoryStock" ("id", "productId", "quantity", "createdAt", "updatedAt") VALUES (${randomUUID()}::uuid, ${productId}::uuid, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT ("productId") DO NOTHING`;
}

async function lockStock(database: Prisma.TransactionClient, productId: string) {
  await ensureStockRow(database, productId);
  const rows = await database.$queryRaw<Array<{ id: string; quantity: number }>>`SELECT "id", "quantity" FROM "InventoryStock" WHERE "productId" = ${productId}::uuid FOR UPDATE`;
  const stock = rows[0];
  if (!stock) throw new ApiError(500, 'STOCK_LOCK_FAILED', 'Unable to lock inventory stock');
  return stock;
}

async function createMovement(database: Prisma.TransactionClient, input: { productId: string; movementType: MovementType; quantity: number; performedById: string; reason?: string | null; reference?: string | null; effectiveAt?: Date }) {
  return database.inventoryMovement.create({
    data: {
      productId: input.productId,
      movementType: input.movementType,
      quantity: input.quantity,
      performedById: input.performedById,
      reason: input.reason ?? null,
      reference: input.reference ?? null,
      effectiveAt: input.effectiveAt ?? new Date()
    },
    include: {
      product: { select: { id: true, name: true, sku: true } },
      performedBy: { select: { id: true, username: true, displayName: true } }
    }
  });
}

async function applyDelta(database: Prisma.TransactionClient, productId: string, delta: number) {
  const stock = await lockStock(database, productId);
  const nextQuantity = stock.quantity + delta;
  if (nextQuantity < 0) throw new ApiError(409, 'INSUFFICIENT_STOCK', `Insufficient stock. Available: ${stock.quantity}; requested: ${Math.abs(delta)}`);
  if (nextQuantity > maximumQuantity) throw new ApiError(409, 'STOCK_LIMIT_EXCEEDED', 'The stock exceeds the supported range');
  await database.inventoryStock.update({ where: { id: stock.id }, data: { quantity: nextQuantity } });
  return nextQuantity;
}

export async function createCompensatingAdjustment(database: Prisma.TransactionClient, input: { productId: string; delta: number; performedById: string; reason: string; reference: string }) {
  const stock = await lockStock(database, input.productId);
  const nextQuantity = stock.quantity + input.delta;
  if (nextQuantity < 0) throw new ApiError(409, 'INSUFFICIENT_STOCK', `Insufficient stock. Available: ${stock.quantity}; requested: ${Math.abs(input.delta)}`);
  if (nextQuantity > maximumQuantity) throw new ApiError(409, 'STOCK_LIMIT_EXCEEDED', 'The corrected stock exceeds the supported range');
  const movement = await createMovement(database, {
    productId: input.productId,
    movementType: MovementType.ADJUSTMENT,
    quantity: input.delta,
    performedById: input.performedById,
    reason: input.reason,
    reference: input.reference
  });
  await database.inventoryStock.update({ where: { id: stock.id }, data: { quantity: nextQuantity } });
  return { movement, nextQuantity };
}

export async function createSimpleMovement(database: PrismaClient, input: MovementInput, movementType: MovementType, performedById: string) {
  const delta = movementType === MovementType.EXIT ? -input.quantity : input.quantity;
  return database.$transaction(async (transaction) => {
    await getActiveProduct(transaction, input.productId);
    await applyDelta(transaction, input.productId, delta);
    return createMovement(transaction, { ...input, movementType, performedById });
  });
}

export async function createInitialMovement(database: PrismaClient, input: MovementInput, performedById: string) {
  return database.$transaction(async (transaction) => {
    await getActiveProduct(transaction, input.productId);
    const stock = await lockStock(transaction, input.productId);
    const initial = await transaction.inventoryMovement.findFirst({ where: { productId: input.productId, movementType: MovementType.INITIAL } });
    if (initial) throw new ApiError(409, 'INITIAL_ALREADY_EXISTS', 'Initial stock already exists for this product');
    const nextQuantity = stock.quantity + input.quantity;
    if (nextQuantity > maximumQuantity) throw new ApiError(409, 'STOCK_LIMIT_EXCEEDED', 'The stock exceeds the supported range');
    await transaction.inventoryStock.update({ where: { id: stock.id }, data: { quantity: nextQuantity } });
    return createMovement(transaction, { ...input, movementType: MovementType.INITIAL, performedById });
  });
}

export async function createAdjustment(database: PrismaClient, input: MovementInput, performedById: string) {
  return database.$transaction(async (transaction) => {
    await getActiveProduct(transaction, input.productId);
    await applyDelta(transaction, input.productId, input.quantity);
    return createMovement(transaction, { ...input, movementType: MovementType.ADJUSTMENT, performedById });
  });
}

export { movementReadResponse, movementResponse };
