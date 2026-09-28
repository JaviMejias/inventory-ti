import { AssetStatus, Prisma, Role, type PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { requireAuthenticated, requireCsrf, requireRole } from '../auth/service.js';
import { ApiError } from '../lib/errors.js';
import { assetCreateSchema, assetIdSchema, assetListQuerySchema, assetStatusSchema, assetUpdateSchema } from './assets-schemas.js';
import { assetInclude, changeAssetStatus, createAsset, decommissionAsset, updateAsset } from './assets-service.js';

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
        ...(search ? { OR: [{ assetTag: { contains: search, mode: 'insensitive' } }, { serialNumber: { contains: search, mode: 'insensitive' } }, { product: { name: { contains: search, mode: 'insensitive' } } }] } : {})
      },
      include: assetInclude,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
    });
    return { assets };
  });

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
    const [movements, assignments, auditLogs] = await Promise.all([
      database.inventoryMovement.findMany({ where: { assetId: id }, include: { performedBy: { select: { displayName: true } } }, orderBy: { effectiveAt: 'desc' }, take: 200 }),
      database.assignment.findMany({ where: { assetId: id }, include: { person: { select: { displayName: true } }, createdBy: { select: { displayName: true } }, endedBy: { select: { displayName: true } } }, orderBy: { startedAt: 'desc' }, take: 200 }),
      database.auditLog.findMany({ where: { entityType: 'Asset', entityId: id }, include: { user: { select: { displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 200 })
    ]);
    const events = [
      ...movements.map((movement) => ({ id: 'movement-' + movement.id, kind: 'movement', movementType: movement.movementType, quantity: movement.quantity, effectiveAt: movement.effectiveAt, actor: movement.performedBy?.displayName ?? null, reason: movement.reason })),
      ...auditLogs.map((audit) => ({ id: 'audit-' + audit.id, kind: 'status', action: audit.action, effectiveAt: audit.createdAt, actor: audit.user?.displayName ?? null, metadata: audit.metadata })),
      ...assignments.flatMap((assignment) => [{ id: 'assignment-start-' + assignment.id, kind: 'assignment', action: 'ASSET_ASSIGNED', effectiveAt: assignment.startedAt, actor: assignment.createdBy?.displayName ?? null, person: assignment.personName }, ...(assignment.endedAt ? [{ id: 'assignment-end-' + assignment.id, kind: 'assignment', action: 'ASSET_RETURNED', effectiveAt: assignment.endedAt, actor: assignment.endedBy?.displayName ?? null, person: assignment.personName }] : [])])
    ].sort((left, right) => new Date(right.effectiveAt).getTime() - new Date(left.effectiveAt).getTime());
    return { events };
  });

  app.post('/assets/:id/status', { preHandler: [operators, requireCsrf] }, async (request) => ({
    asset: await changeAssetStatus(database, idFrom(request), parse(assetStatusSchema, request.body), request.auth!.user.role, request.auth!.user.id)
  }));

  app.post('/assets/:id/decommission', { preHandler: [jefeOnly, requireCsrf] }, async (request) => ({
    asset: await decommissionAsset(database, idFrom(request), request.auth!.user.id)
  }));
}
