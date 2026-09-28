import { CorrectionStatus, type MovementType, Prisma, ProductTrackingMode, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { movementEffect, movementReadResponse } from './inventory-service.js';
import type { MovementListQuery } from './inventory-schemas.js';

export async function currentMovementEffect(database: Prisma.TransactionClient, movement: { id: string; movementType: MovementType; quantity: number }) {
  const approved = await database.correctionRequest.aggregate({
    where: { originalMovementId: movement.id, status: CorrectionStatus.APPROVED },
    _sum: { delta: true }
  });
  return movementEffect(movement) + (approved._sum.delta ?? 0);
}

export async function getProductHistory(database: PrismaClient, productId: string, query: MovementListQuery) {
  return database.$transaction(async (transaction) => {
    const product = await transaction.product.findUnique({ where: { id: productId } });
    if (!product) throw new ApiError(404, 'NOT_FOUND', 'Product not found');
    if (product.trackingMode !== ProductTrackingMode.QUANTITY) throw new ApiError(409, 'CORRECTION_NOT_SUPPORTED', 'Only quantity inventory has a running stock balance');
    const stock = await transaction.inventoryStock.findUnique({ where: { productId } });
    const records = await transaction.inventoryMovement.findMany({
      where: { productId },
      include: {
        product: { select: { id: true, name: true, sku: true, trackingMode: true } },
        performedBy: { select: { id: true, username: true, displayName: true } },
        originalFor: { select: { id: true, status: true, delta: true, correctedQuantity: true, reviewedAt: true } },
        compensatingFor: { select: { id: true, status: true } }
      },
      orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
    });
    let balance = 0;
    let hasNegativeBalance = false;
    const movements = [];
    const compensatingMovements = [];
    for (const record of records) {
      if (record.compensatingFor) {
        compensatingMovements.push({ ...movementReadResponse(record), correctionId: record.compensatingFor.id });
        continue;
      }
      const originalQuantity = movementEffect(record);
      const correctionDelta = record.originalFor.reduce((total, correction) => total + (correction.status === CorrectionStatus.APPROVED ? correction.delta : 0), 0);
      const effectiveQuantity = originalQuantity + correctionDelta;
      const balanceBefore = balance;
      balance += effectiveQuantity;
      hasNegativeBalance ||= balance < 0;
      if (query.from && record.effectiveAt < query.from) continue;
      if (query.to && record.effectiveAt > query.to) continue;
      if (query.movementType && record.movementType !== query.movementType) continue;
      if (query.performedById && record.performedById !== query.performedById) continue;
      movements.push({ ...movementReadResponse(record), originalQuantity, effectiveQuantity, correctionDelta, balanceBefore, balanceAfter: balance });
    }
    const stockQuantity = stock?.quantity ?? 0;
    return { productId, stockQuantity, historyQuantity: balance, isConsistent: stockQuantity === balance, hasNegativeBalance, movements, compensatingMovements };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
