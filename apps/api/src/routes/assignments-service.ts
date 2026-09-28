import { Prisma, ProductTrackingMode, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import type { AssignmentCreateInput, AssignmentListQuery, AssignmentUserQuery } from './assignments-schemas.js';
import { assetInclude } from './assets-service.js';

const publicUserSelect = { id: true, username: true, displayName: true, isActive: true } satisfies Prisma.UserSelect;

export const assignmentInclude = {
  asset: { include: assetInclude },
  person: { select: publicUserSelect },
  createdBy: { select: publicUserSelect },
  endedBy: { select: publicUserSelect }
} satisfies Prisma.AssignmentInclude;

async function lockAsset(database: Prisma.TransactionClient, assetId: string) {
  const rows = await database.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Asset"
    WHERE "id" = ${assetId}::uuid
    FOR UPDATE
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
  return database.asset.findUniqueOrThrow({ where: { id: assetId }, include: assetInclude });
}

async function lockAssignment(database: Prisma.TransactionClient, assignmentId: string) {
  const rows = await database.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Assignment"
    WHERE "id" = ${assignmentId}::uuid
    FOR UPDATE
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Assignment not found');
  return database.assignment.findUniqueOrThrow({ where: { id: assignmentId }, include: assignmentInclude });
}

async function lockPerson(database: Prisma.TransactionClient, personId: string) {
  const rows = await database.$queryRaw<Array<{ id: string; isActive: boolean }>>`
    SELECT "id", "isActive"
    FROM "User"
    WHERE "id" = ${personId}::uuid
    FOR UPDATE
  `;
  const person = rows[0];
  if (!person) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (!person.isActive) throw new ApiError(409, 'USER_INACTIVE', 'The user is inactive');
  return database.user.findUniqueOrThrow({ where: { id: personId }, select: publicUserSelect });
}

function requireAssignableAsset(asset: { isActive: boolean; status: string; product: { trackingMode: ProductTrackingMode } }) {
  if (!asset.isActive) throw new ApiError(409, 'ASSET_INACTIVE', 'The asset is inactive');
  if (asset.status !== 'AVAILABLE') throw new ApiError(409, 'ASSET_NOT_ASSIGNABLE', 'The asset is not available for assignment');
  if (asset.product.trackingMode !== ProductTrackingMode.ASSET) throw new ApiError(409, 'PRODUCT_NOT_ASSET', 'The product is not asset-tracked');
}

async function audit(database: Prisma.TransactionClient, userId: string, action: string, assignmentId: string, metadata: Prisma.InputJsonValue) {
  await database.auditLog.create({ data: { userId, action, entityType: 'Assignment', entityId: assignmentId, metadata } });
}

function assignmentWhere(query: AssignmentListQuery): Prisma.AssignmentWhereInput {
  return {
    ...(query.assetId ? { assetId: query.assetId } : {}),
    ...(query.personId ? { personId: query.personId } : {}),
    ...(query.active === undefined ? {} : { endedAt: query.active ? null : { not: null } })
  };
}

export async function createAssignment(database: PrismaClient, assetId: string, input: AssignmentCreateInput, userId: string) {
  return database.$transaction(async (transaction) => {
    const asset = await lockAsset(transaction, assetId);
    requireAssignableAsset(asset);
    const person = input.personId ? await lockPerson(transaction, input.personId) : null;
    const personName = input.personName ?? person?.displayName;
    if (!personName) throw new ApiError(400, 'RECIPIENT_REQUIRED', 'A recipient name is required');

    const existing = await transaction.assignment.findFirst({ where: { assetId, endedAt: null }, select: { id: true } });
    if (existing) throw new ApiError(409, 'ASSET_ALREADY_ASSIGNED', 'The asset already has an active assignment');

    const startedAt = new Date();
    const created = await transaction.assignment.create({
      data: { assetId, personId: input.personId ?? null, personName, createdById: userId, startedAt }
    });
    const updatedAsset = await transaction.asset.update({
      where: { id: assetId },
      data: { status: 'ASSIGNED' },
      include: assetInclude
    });
    await audit(transaction, userId, 'ASSET_ASSIGNED', created.id, { assetId, personName, ...(input.personId ? { personId: input.personId } : {}), fromStatus: 'AVAILABLE', toStatus: 'ASSIGNED' });
    const assignment = await transaction.assignment.findUniqueOrThrow({ where: { id: created.id }, include: assignmentInclude });
    return { assignment, asset: updatedAsset };
  });
}

export async function returnAssignment(database: PrismaClient, assetId: string, assignmentId: string, userId: string) {
  return database.$transaction(async (transaction) => {
    const asset = await lockAsset(transaction, assetId);
    const current = await lockAssignment(transaction, assignmentId);
    if (current.assetId !== asset.id) throw new ApiError(404, 'NOT_FOUND', 'Assignment not found');
    if (current.endedAt) throw new ApiError(409, 'ASSIGNMENT_ALREADY_CLOSED', 'The assignment is already closed');
    if (asset.status !== 'ASSIGNED') throw new ApiError(409, 'ASSET_ASSIGNMENT_INCONSISTENT', 'The asset is not assigned');

    const endedAt = new Date(Math.max(Date.now(), current.startedAt.getTime() + 1));
    await transaction.assignment.update({
      where: { id: assignmentId },
      data: { endedAt, endedById: userId }
    });
    const updatedAsset = await transaction.asset.update({
      where: { id: assetId },
      data: { status: 'AVAILABLE' },
      include: assetInclude
    });
    await audit(transaction, userId, 'ASSET_RETURNED', assignmentId, { assetId, personName: current.personName, ...(current.personId ? { personId: current.personId } : {}), fromStatus: 'ASSIGNED', toStatus: 'AVAILABLE' });
    const assignment = await transaction.assignment.findUniqueOrThrow({ where: { id: assignmentId }, include: assignmentInclude });
    return { assignment, asset: updatedAsset };
  });
}

export async function listAssetAssignments(database: PrismaClient, assetId: string, query: Pick<AssignmentListQuery, 'limit' | 'offset'>) {
  const asset = await database.asset.findUnique({ where: { id: assetId }, select: { id: true } });
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
  const where = { assetId };
  const [assignments, currentAssignment, total] = await Promise.all([
    database.assignment.findMany({ where, include: assignmentInclude, orderBy: { startedAt: 'desc' }, skip: query.offset, take: query.limit }),
    database.assignment.findFirst({ where: { assetId, endedAt: null }, include: assignmentInclude }),
    database.assignment.count({ where })
  ]);
  return { currentAssignment, assignments, total, limit: query.limit, offset: query.offset };
}

export async function listAssignments(database: PrismaClient, query: AssignmentListQuery) {
  const where = assignmentWhere(query);
  const [assignments, total] = await Promise.all([
    database.assignment.findMany({ where, include: assignmentInclude, orderBy: { startedAt: 'desc' }, skip: query.offset, take: query.limit }),
    database.assignment.count({ where })
  ]);
  return { assignments, total, limit: query.limit, offset: query.offset };
}

export async function getAssignment(database: PrismaClient, assignmentId: string) {
  const assignment = await database.assignment.findUnique({ where: { id: assignmentId }, include: assignmentInclude });
  if (!assignment) throw new ApiError(404, 'NOT_FOUND', 'Assignment not found');
  return assignment;
}

export async function listAssignmentUsers(database: PrismaClient, query: AssignmentUserQuery) {
  const where: Prisma.UserWhereInput = {
    isActive: true,
    ...(query.search ? { OR: [{ username: { contains: query.search, mode: 'insensitive' } }, { displayName: { contains: query.search, mode: 'insensitive' } }] } : {})
  };
  const [users, total] = await Promise.all([
    database.user.findMany({ where, select: publicUserSelect, orderBy: [{ displayName: 'asc' }, { username: 'asc' }], skip: query.offset, take: query.limit }),
    database.user.count({ where })
  ]);
  return { users, total, limit: query.limit, offset: query.offset };
}
