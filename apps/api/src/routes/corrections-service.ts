import { CorrectionStatus, MovementType, ProductTrackingMode, type Prisma, type PrismaClient, type Role } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { maximumQuantity, minimumQuantity } from '../lib/quantity.js';
import { createCompensatingAdjustment } from './inventory-service.js';
import { currentMovementEffect } from './inventory-history.js';
import type { CorrectionCreateInput, CorrectionListQuery } from './corrections-schemas.js';

const publicUserSelect = { id: true, username: true, displayName: true, role: true } satisfies Prisma.UserSelect;
const movementInclude = {
  product: { select: { id: true, name: true, sku: true, trackingMode: true } },
  performedBy: { select: publicUserSelect },
  compensatingFor: { select: { id: true } }
} satisfies Prisma.InventoryMovementInclude;
const correctionInclude = {
  originalMovement: { include: movementInclude },
  compensatingMovement: { include: movementInclude },
  requestedBy: { select: publicUserSelect },
  reviewedBy: { select: publicUserSelect }
} satisfies Prisma.CorrectionRequestInclude;

async function lockMovement(database: Prisma.TransactionClient, movementId: string) {
  const rows = await database.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "InventoryMovement" WHERE "id" = ${movementId}::uuid FOR UPDATE
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Movement not found');
  return database.inventoryMovement.findUniqueOrThrow({ where: { id: movementId }, include: movementInclude });
}

async function lockCorrection(database: Prisma.TransactionClient, correctionId: string) {
  const rows = await database.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "CorrectionRequest" WHERE "id" = ${correctionId}::uuid FOR UPDATE
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Correction request not found');
  return database.correctionRequest.findUniqueOrThrow({ where: { id: correctionId }, include: correctionInclude });
}

function ensureCorrectableMovement(movement: { assetId: string | null; product: { trackingMode: ProductTrackingMode } }) {
  if (movement.assetId || movement.product.trackingMode !== ProductTrackingMode.QUANTITY) {
    throw new ApiError(409, 'CORRECTION_NOT_SUPPORTED', 'Only quantity inventory movements can be corrected');
  }
}

function correctionResponse<T extends { correctedQuantity: number; delta: number }>(correction: T) {
  return { ...correction, previousQuantity: correction.correctedQuantity - correction.delta };
}

async function lockCorrectionMovement(database: Prisma.TransactionClient, correctionId: string) {
  const correction = await database.correctionRequest.findUnique({ where: { id: correctionId }, select: { originalMovementId: true } });
  if (!correction) throw new ApiError(404, 'NOT_FOUND', 'Correction request not found');
  const movement = await lockMovement(database, correction.originalMovementId);
  const current = await lockCorrection(database, correctionId);
  return { current, movement };
}

type StoredCorrection = Prisma.CorrectionRequestGetPayload<{ include: typeof correctionInclude }>;
type StoredMovement = Prisma.InventoryMovementGetPayload<{ include: typeof movementInclude }>;

async function applyCorrection(database: Prisma.TransactionClient, current: StoredCorrection, original: StoredMovement, reviewerId: string, autoApplied = false) {
  if (current.status !== CorrectionStatus.PENDING) throw new ApiError(409, 'CORRECTION_ALREADY_PROCESSED', 'The correction request has already been processed');
  if (!autoApplied && current.requestedById === reviewerId) throw new ApiError(403, 'CORRECTION_SELF_APPROVAL', 'A correction requester cannot approve their own request');
  ensureCorrectableMovement(original);
  const previousQuantity = await currentMovementEffect(database, original);
  if (previousQuantity !== current.correctedQuantity - current.delta) throw new ApiError(409, 'CORRECTION_STALE', 'The movement has changed since this correction was requested');
  const { movement: compensatingMovement } = await createCompensatingAdjustment(database, {
    productId: original.productId,
    delta: current.delta,
    performedById: reviewerId,
    reason: `Correction: ${current.reason}`,
    reference: `correction:${current.id}`
  });
  const approved = await database.correctionRequest.update({
    where: { id: current.id },
    data: { status: CorrectionStatus.APPROVED, reviewedById: reviewerId, reviewedAt: new Date(), compensatingMovementId: compensatingMovement.id },
    include: correctionInclude
  });
  await audit(database, reviewerId, 'CORRECTION_APPROVED', 'CorrectionRequest', current.id, { compensatingMovementId: compensatingMovement.id, delta: current.delta, correctedQuantity: current.correctedQuantity, previousQuantity, autoApplied });
  await audit(database, reviewerId, 'CORRECTION_MOVEMENT_CREATED', 'InventoryMovement', compensatingMovement.id, { correctionId: current.id, originalMovementId: current.originalMovementId });
  return approved;
}

async function audit(database: Prisma.TransactionClient, userId: string, action: string, entityType: string, entityId: string, metadata: Prisma.InputJsonValue) {
  await database.auditLog.create({ data: { userId, action, entityType, entityId, metadata } });
}

function canViewAll(role: Role) {
  return role === 'JEFE';
}

export async function createCorrection(database: PrismaClient, movementId: string, input: CorrectionCreateInput, userId: string, role: Role) {
  return database.$transaction(async (transaction) => {
    const movement = await lockMovement(transaction, movementId);
    ensureCorrectableMovement(movement);
    if (movement.compensatingFor) throw new ApiError(409, 'CORRECTION_NOT_SUPPORTED', 'Correct the original movement, not its compensating adjustment');
    const existing = await transaction.correctionRequest.findFirst({ where: { originalMovementId: movementId, status: CorrectionStatus.PENDING }, select: { id: true } });
    if (existing) throw new ApiError(409, 'CORRECTION_ALREADY_EXISTS', 'This movement already has a pending correction request');
    const previousQuantity = await currentMovementEffect(transaction, movement);
    const correctedQuantity = 'correctedQuantity' in input ? input.correctedQuantity : previousQuantity + input.delta;
    const delta = correctedQuantity - previousQuantity;
    if (delta === 0) throw new ApiError(400, 'CORRECTION_NO_CHANGE', 'The corrected quantity must differ from the current movement quantity');
    if (correctedQuantity < minimumQuantity || correctedQuantity > maximumQuantity || delta < minimumQuantity || delta > maximumQuantity) throw new ApiError(400, 'CORRECTION_INVALID_QUANTITY', 'The corrected quantity or difference is outside the supported range');
    if ((movement.movementType === MovementType.EXIT && correctedQuantity > 0) || (movement.movementType !== MovementType.EXIT && movement.movementType !== MovementType.ADJUSTMENT && correctedQuantity < 0)) {
      throw new ApiError(400, 'CORRECTION_INVALID_QUANTITY', 'The corrected quantity must preserve the movement direction');
    }
    const correction = await transaction.correctionRequest.create({
      data: { originalMovementId: movementId, requestedById: userId, status: CorrectionStatus.PENDING, reason: input.reason, delta, correctedQuantity },
      include: correctionInclude
    });
    await audit(transaction, userId, 'CORRECTION_REQUESTED', 'CorrectionRequest', correction.id, { originalMovementId: movementId, delta, previousQuantity, correctedQuantity });
    return correctionResponse(role === 'JEFE' ? await applyCorrection(transaction, correction, movement, userId, true) : correction);
  });
}

export async function listCorrections(database: PrismaClient, userId: string, role: Role, query: CorrectionListQuery) {
  const originalMovement: Prisma.InventoryMovementWhereInput = {
    ...(query.movementType ? { movementType: query.movementType } : {}),
    ...(query.from || query.to ? { effectiveAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {})
  };
  const where: Prisma.CorrectionRequestWhereInput = {
    ...(canViewAll(role) ? {} : { requestedById: userId }),
    ...(query.status ? { status: query.status as CorrectionStatus } : {}),
    ...(Object.keys(originalMovement).length > 0 ? { originalMovement } : {}),
    ...(query.search ? {
      OR: [
        { reason: { contains: query.search, mode: 'insensitive' as const } },
        { requestedBy: { displayName: { contains: query.search, mode: 'insensitive' as const } } },
        { originalMovement: { product: { name: { contains: query.search, mode: 'insensitive' as const } } } },
        { originalMovement: { product: { sku: { contains: query.search, mode: 'insensitive' as const } } } }
      ]
    } : {})
  };
  const [corrections, total, pendingTotal] = await database.$transaction([
    database.correctionRequest.findMany({ where, include: correctionInclude, orderBy: { createdAt: 'desc' }, skip: query.offset, take: query.limit }),
    database.correctionRequest.count({ where }),
    database.correctionRequest.count({ where: { ...where, status: CorrectionStatus.PENDING } })
  ]);
  return { corrections: corrections.map(correctionResponse), total, pendingTotal, limit: query.limit, offset: query.offset, hasMore: query.offset + corrections.length < total };
}

export async function getCorrection(database: PrismaClient, correctionId: string, userId: string, role: Role) {
  const correction = await database.correctionRequest.findUnique({ where: { id: correctionId }, include: correctionInclude });
  if (!correction || (!canViewAll(role) && correction.requestedById !== userId)) throw new ApiError(404, 'NOT_FOUND', 'Correction request not found');
  return correctionResponse(correction);
}

export async function approveCorrection(database: PrismaClient, correctionId: string, reviewerId: string) {
  return database.$transaction(async (transaction) => {
    const { current, movement } = await lockCorrectionMovement(transaction, correctionId);
    return correctionResponse(await applyCorrection(transaction, current, movement, reviewerId));
  });
}

export async function rejectCorrection(database: PrismaClient, correctionId: string, reviewerId: string) {
  return database.$transaction(async (transaction) => {
    const { current } = await lockCorrectionMovement(transaction, correctionId);
    if (current.status !== CorrectionStatus.PENDING) throw new ApiError(409, 'CORRECTION_ALREADY_PROCESSED', 'The correction request has already been processed');
    if (current.requestedById === reviewerId) throw new ApiError(403, 'CORRECTION_SELF_APPROVAL', 'A correction requester cannot reject their own request');
    const rejected = await transaction.correctionRequest.update({ where: { id: correctionId }, data: { status: CorrectionStatus.REJECTED, reviewedById: reviewerId, reviewedAt: new Date() }, include: correctionInclude });
    await audit(transaction, reviewerId, 'CORRECTION_REJECTED', 'CorrectionRequest', correctionId, { delta: current.delta });
    return correctionResponse(rejected);
  });
}
