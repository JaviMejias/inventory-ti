import { AssetStatus, Prisma, Role, type PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { requireAuthenticated, requireCsrf, requireRole } from '../auth/service.js';
import { ApiError } from '../lib/errors.js';
import { assetAvailabilityQuerySchema, assetCreateSchema, assetIdSchema, assetListQuerySchema, assetStatusSchema, assetUpdateSchema } from './assets-schemas.js';
import { getAssetAvailability } from './asset-availability.js';
import { assignmentHistoryEvents, assignmentImportSelect, groupAssignmentImportSelect } from './assignment-history.js';
import { effectiveAssignmentRows, withEffectiveAssignment } from '../imports/assignment-effective.js';
import { assetInclude, changeAssetStatus, createAsset, decommissionAsset, updateAsset } from './assets-service.js';
import { groupRetirementImportSelect, retirementHistoryEvents, retirementImportSelect } from './retirement-history.js';

function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
  return result.data;
}

function idFrom(request: FastifyRequest) {
  return parse(assetIdSchema, request.params).id;
}

function assetConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = error.meta?.target;
    const targets = Array.isArray(target) ? target : [target];
    const field = targets.some((value) => typeof value === 'string' && value.includes('serialNumber'))
      ? 'serialNumber'
      : targets.some((value) => typeof value === 'string' && value.includes('assetTag')) ? 'assetTag' : undefined;
    throw new ApiError(409, 'ASSET_IDENTIFIER_CONFLICT', 'Asset tag or serial number already exists', field ? { field } : undefined);
  }
  throw error;
}

export function registerAssetRoutes(app: FastifyInstance, database: PrismaClient): void {
  const authenticate = requireAuthenticated(database);
  const assetManagers = requireRole(database, Role.JEFE, Role.COORDINADOR);
  const operators = requireRole(database, Role.JEFE, Role.COORDINADOR, Role.SOPORTE);
  const jefeOnly = requireRole(database, Role.JEFE);

  app.get('/assets', { preHandler: authenticate }, async (request) => {
    const query = parse(assetListQuerySchema, request.query);
    const search = query.search;
    const assets = await database.asset.findMany({
      where: {
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.status ? { status: query.status as AssetStatus } : {}),
        ...(query.assetTag ? { assetTag: { contains: query.assetTag, mode: 'insensitive' } } : {}),
        ...(query.serialNumber ? { serialNumber: { contains: query.serialNumber, mode: 'insensitive' } } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.technicalCondition ? { technicalCondition: { contains: query.technicalCondition, mode: 'insensitive' } } : {}),
        ...(query.usagePurpose ? { usagePurpose: { contains: query.usagePurpose, mode: 'insensitive' } } : {}),
        ...(query.location ? { location: { contains: query.location, mode: 'insensitive' } } : {}),
        ...(query.sector ? { sector: { contains: query.sector, mode: 'insensitive' } } : {}),
        product: {
          ...(query.equipmentType ? { equipmentType: { contains: query.equipmentType, mode: 'insensitive' } } : {}),
          ...(query.brand ? { brand: { contains: query.brand, mode: 'insensitive' } } : {}),
          ...(query.model ? { model: { contains: query.model, mode: 'insensitive' } } : {})
        },
        ...(search ? { OR: [
          ...['assetTag', 'serialNumber', 'location', 'sector', 'hostname', 'loanCode', 'ipAddress'].map((field) => ({ [field]: { contains: search, mode: 'insensitive' as const } })),
          { product: { OR: ['name', 'equipmentType', 'brand', 'model'].map((field) => ({ [field]: { contains: search, mode: 'insensitive' as const } })) } }
        ] } : {})
      },
      include: assetInclude,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
    });
    return { assets };
  });

  app.get('/assets/availability', { preHandler: authenticate }, async (request) => getAssetAvailability(database, parse(assetAvailabilityQuerySchema, request.query)));

  app.get('/assets/:id', { preHandler: authenticate }, async (request) => {
    const asset = await database.asset.findUnique({ include: assetInclude, where: { id: idFrom(request) } });
    if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
    return { asset };
  });

  app.post('/assets', { preHandler: [assetManagers, requireCsrf] }, async (request, reply) => {
    try {
      const asset = await createAsset(database, parse(assetCreateSchema, request.body), request.auth!.user.id);
      return reply.status(201).send({ asset });
    } catch (error) {
      return assetConflict(error);
    }
  });

  app.patch('/assets/:id', { preHandler: [assetManagers, requireCsrf] }, async (request) => {
    try {
      return { asset: await updateAsset(database, idFrom(request), parse(assetUpdateSchema, request.body), request.auth!.user.id) };
    } catch (error) {
      return assetConflict(error);
    }
  });

  app.get('/assets/:id/history', { preHandler: authenticate }, async (request) => {
    const id = idFrom(request);
    return database.$transaction(async (transaction) => {
      const rows = await effectiveAssignmentRows(transaction, { assetId: id }, 200);
      const [movements, assignments, auditLogs, retirement, groupRetirement] = await Promise.all([
        transaction.inventoryMovement.findMany({ where: { assetId: id }, include: { performedBy: { select: { displayName: true } } }, orderBy: { effectiveAt: 'desc' }, take: 200 }),
        transaction.assignment.findMany({ where: { id: { in: rows.map((row) => row.id) } }, include: { person: { select: { displayName: true } }, createdBy: { select: { displayName: true } }, endedBy: { select: { displayName: true } },
          importHistory: { select: assignmentImportSelect }, groupImportHistory: { select: groupAssignmentImportSelect } }, orderBy: { startedAt: 'desc' }, take: 200 }),
        transaction.auditLog.findMany({ where: { entityType: 'Asset', entityId: id }, include: { user: { select: { displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
        transaction.importRetirementApplication.findUnique({ where: { assetId: id }, select: retirementImportSelect }),
        transaction.importGroupRetirementApplication.findUnique({ where: { assetId: id }, select: groupRetirementImportSelect })
      ]);
      const events = [
        ...retirementHistoryEvents(retirement, groupRetirement),
        ...movements.map((movement) => ({ id: 'movement-' + movement.id, kind: 'movement', movementType: movement.movementType, quantity: movement.quantity, effectiveAt: movement.effectiveAt, actor: movement.performedBy?.displayName ?? null, reason: movement.reason })),
        ...auditLogs.map((audit) => ({ id: 'audit-' + audit.id, kind: 'status', action: audit.action, effectiveAt: audit.createdAt, actor: audit.user?.displayName ?? null, metadata: audit.metadata })),
        ...rows.flatMap((row) => assignmentHistoryEvents(withEffectiveAssignment(assignments.find((entry) => entry.id === row.id)!, row)))
      ].sort((left, right) => new Date(right.effectiveAt).getTime() - new Date(left.effectiveAt).getTime());
      return { events };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });

  app.post('/assets/:id/status', { preHandler: [operators, requireCsrf] }, async (request) => ({
    asset: await changeAssetStatus(database, idFrom(request), parse(assetStatusSchema, request.body), request.auth!.user.role, request.auth!.user.id)
  }));

  app.post('/assets/:id/decommission', { preHandler: [jefeOnly, requireCsrf] }, async (request) => ({
    asset: await decommissionAsset(database, idFrom(request), request.auth!.user.id)
  }));
}
