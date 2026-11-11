import { Prisma, ProductTrackingMode, Role, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import type { AssignmentCreateInput, AssignmentListQuery, AssignmentReturnInput, AssignmentUserQuery } from './assignments-schemas.js';
import { assetInclude } from './assets-service.js';
import { assignmentImportSelect, groupAssignmentImportSelect } from './assignment-history.js';
import { effectiveAssignmentRows, effectiveAssignmentWhere, withEffectiveAssignment } from '../imports/assignment-effective.js';

const publicUserSelect = { id: true, username: true, displayName: true, isActive: true } satisfies Prisma.UserSelect;

export const assignmentInclude = {
  asset: { include: assetInclude },
  person: { select: publicUserSelect },
  createdBy: { select: publicUserSelect },
  endedBy: { select: publicUserSelect },
  importHistory: { select: assignmentImportSelect },
  groupImportHistory: { select: groupAssignmentImportSelect }
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

function effectiveDate(input: Date | undefined, role: Role, fallback: Date): Date {
  if (!input) return fallback;
  if (role === Role.SOPORTE) throw new ApiError(403, 'FORBIDDEN', 'Support cannot set an explicit assignment date');
  if (input.getTime() > Date.now()) throw new ApiError(400, 'VALIDATION_ERROR', 'The effective date cannot be in the future', [{ path: ['effectiveAt'], message: 'The effective date cannot be in the future' }]);
  return input;
}

export async function createAssignment(database: PrismaClient, assetId: string, input: AssignmentCreateInput, userId: string, role: Role = Role.SOPORTE) {
  return database.$transaction(async (transaction) => {
    const asset = await lockAsset(transaction, assetId);
    requireAssignableAsset(asset);
    const person = input.personId ? await lockPerson(transaction, input.personId) : null;
    const personName = input.recipientType === 'PERSON' ? input.personName ?? person?.displayName ?? null : null;
    if (input.recipientType === 'PERSON' && !personName) throw new ApiError(400, 'RECIPIENT_REQUIRED', 'A recipient name is required');

    const existing = await transaction.assignment.findFirst({ where: { assetId, endedAt: null }, select: { id: true } });
    if (existing) throw new ApiError(409, 'ASSET_ALREADY_ASSIGNED', 'The asset already has an active assignment');

    const startedAt = effectiveDate(input.effectiveAt, role, new Date());
    const [lastClosed] = await transaction.$queryRaw<{ endedAt: Date | null }[]>`SELECT max("endedAt") AS "endedAt" FROM "AssignmentEffective" WHERE "assetId" = ${assetId}::uuid`;
    if (lastClosed?.endedAt && startedAt < lastClosed.endedAt) throw new ApiError(409, 'ASSIGNMENT_DATE_CONFLICT', 'The assignment cannot overlap previous history');
    if (input.expectedReturnAt && input.expectedReturnAt <= startedAt) throw new ApiError(400, 'VALIDATION_ERROR', 'The expected return must follow the assignment date', [{ path: ['expectedReturnAt'], message: 'The expected return must follow the assignment date' }]);
    const created = await transaction.assignment.create({
      data: {
        assetId, personId: input.personId ?? null, personName, createdById: userId, startedAt,
        recipientType: input.recipientType, officeName: input.officeName ?? null,
        assignmentType: input.assignmentType, expectedReturnAt: input.expectedReturnAt ?? null,
        ticketReference: input.ticketReference, otReference: input.otReference, notes: input.notes
      }
    });
    const updatedAsset = await transaction.asset.update({
      where: { id: assetId },
      data: { status: 'ASSIGNED' },
      include: assetInclude
    });
    await audit(transaction, userId, 'ASSET_ASSIGNED', created.id, {
      assetId, personName, recipientType: created.recipientType, officeName: created.officeName, assignmentType: created.assignmentType,
      ...(input.personId ? { personId: input.personId } : {}),
      effectiveAt: startedAt.toISOString(), expectedReturnAt: created.expectedReturnAt?.toISOString() ?? null,
      ticketReference: created.ticketReference, otReference: created.otReference, notes: created.notes,
      fromStatus: 'AVAILABLE', toStatus: 'ASSIGNED'
    });
    const assignment = await transaction.assignment.findUniqueOrThrow({ where: { id: created.id }, include: assignmentInclude });
    return { assignment, asset: updatedAsset };
  });
}

export async function returnAssignment(database: PrismaClient, assetId: string, assignmentId: string, userId: string, input: AssignmentReturnInput = { returnStatus: 'AVAILABLE' }, role: Role = Role.SOPORTE) {
  return database.$transaction(async (transaction) => {
    const asset = await lockAsset(transaction, assetId);
    const current = await lockAssignment(transaction, assignmentId);
    if (current.assetId !== asset.id) throw new ApiError(404, 'NOT_FOUND', 'Assignment not found');
    if (current.endedAt) throw new ApiError(409, 'ASSIGNMENT_ALREADY_CLOSED', 'The assignment is already closed');
    if (asset.status !== 'ASSIGNED') throw new ApiError(409, 'ASSET_ASSIGNMENT_INCONSISTENT', 'The asset is not assigned');

    const endedAt = effectiveDate(input.effectiveAt, role, new Date(Math.max(Date.now(), current.startedAt.getTime() + 1)));
    if (endedAt <= current.startedAt) throw new ApiError(409, 'ASSIGNMENT_DATE_CONFLICT', 'The return must follow the assignment date');
    await transaction.assignment.update({
      where: { id: assignmentId },
      data: {
        endedAt, endedById: userId, returnRecordedAt: new Date(), returnStatus: input.returnStatus,
        returnTicketReference: input.ticketReference, returnOtReference: input.otReference, returnNotes: input.notes
      }
    });
    const updatedAsset = await transaction.asset.update({
      where: { id: assetId },
      data: { status: input.returnStatus },
      include: assetInclude
    });
    await audit(transaction, userId, 'ASSET_RETURNED', assignmentId, {
      assetId, personName: current.personName, recipientType: current.recipientType, officeName: current.officeName, assignmentType: current.assignmentType,
      ...(current.personId ? { personId: current.personId } : {}),
      effectiveAt: endedAt.toISOString(), ticketReference: input.ticketReference ?? null, otReference: input.otReference ?? null, notes: input.notes ?? null,
      fromStatus: 'ASSIGNED', toStatus: input.returnStatus
    });
    const assignment = await transaction.assignment.findUniqueOrThrow({ where: { id: assignmentId }, include: assignmentInclude });
    return { assignment, asset: updatedAsset };
  });
}

export async function listAssetAssignments(database: PrismaClient, assetId: string, query: AssignmentListQuery) {
  return database.$transaction(async (transaction) => {
    const asset = await transaction.asset.findUnique({ where: { id: assetId }, select: { id: true } });
    if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
    const page = await effectiveAssignmentPage(transaction, { ...query, assetId });
    const currentAssignment = await transaction.assignment.findFirst({ where: { assetId, endedAt: null }, include: assignmentInclude });
    return { currentAssignment, ...page };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function listAssignments(database: PrismaClient, query: AssignmentListQuery) {
  return database.$transaction((transaction) => effectiveAssignmentPage(transaction, query), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
async function effectiveAssignmentPage(transaction: Prisma.TransactionClient, query: AssignmentListQuery) {
  const rows = await effectiveAssignmentRows(transaction, query, query.limit, query.offset);
  const raw = await transaction.assignment.findMany({ where: { id: { in: rows.map((row) => row.id) } }, include: assignmentInclude });
  const assignments = rows.map((row) => withEffectiveAssignment(raw.find((entry) => entry.id === row.id)!, row));
  const [count] = await transaction.$queryRaw<{ total: number }[]>`SELECT count(*)::integer AS total FROM "AssignmentEffective" WHERE ${effectiveAssignmentWhere(query)}`;
  const total = count.total;
  return { assignments, total, limit: query.limit, offset: query.offset, hasMore: query.offset + assignments.length < total };
}

export async function getAssignment(database: PrismaClient, assignmentId: string) {
  return database.$transaction(async (transaction) => {
    const assignment = await transaction.assignment.findUnique({ where: { id: assignmentId }, include: assignmentInclude });
    if (!assignment) throw new ApiError(404, 'NOT_FOUND', 'Assignment not found');
    const [effective] = await effectiveAssignmentRows(transaction, { id: assignmentId }, 1);
    return withEffectiveAssignment(assignment, effective);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
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
