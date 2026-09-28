import type { FastifyInstance } from 'fastify';
import { MovementType, Role, type PrismaClient } from '@prisma/client';

import { requireAuthenticated, requireCsrf, requireRole } from '../auth/service.js';
import { ApiError } from '../lib/errors.js';
import { getProductHistory } from './inventory-history.js';
import { createAdjustment, createInitialMovement, createSimpleMovement, movementReadResponse, movementResponse, stockResponse } from './inventory-service.js';
import { adjustmentSchema, entrySchema, exitSchema, idSchema, initialSchema, movementListQuerySchema, returnSchema, stockListQuerySchema } from './inventory-schemas.js';

function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
  return result.data;
}

export function registerInventoryRoutes(app: FastifyInstance, database: PrismaClient): void {
  const authenticate = requireAuthenticated(database);
  const operations = requireRole(database, Role.JEFE, Role.COORDINADOR, Role.SOPORTE);
  const adjustments = requireRole(database, Role.JEFE, Role.COORDINADOR);

  app.get('/inventory/products/:productId/history', { preHandler: authenticate }, async (request) => {
    const productId = parse(idSchema, { id: (request.params as { productId: string }).productId }).id;
    return getProductHistory(database, productId, parse(movementListQuerySchema.omit({ productId: true }), request.query));
  });

  app.get('/inventory/stock', { preHandler: authenticate }, async (request) => {
    const query = parse(stockListQuerySchema, request.query);
    const stocks = await database.inventoryStock.findMany({
      where: query.productId ? { productId: query.productId } : undefined,
      include: { product: { select: { id: true, name: true, sku: true, trackingMode: true } } },
      orderBy: { product: { name: 'asc' } }
    });
    return { stock: stocks.map(stockResponse) };
  });

  app.get('/inventory/stock/:productId', { preHandler: authenticate }, async (request) => {
    const productId = parse(idSchema, { id: (request.params as { productId: string }).productId }).id;
    const stock = await database.inventoryStock.findUnique({
      where: { productId },
      include: { product: { select: { id: true, name: true, sku: true, trackingMode: true } } }
    });
    return { stock: stock ? [stockResponse(stock)] : [] };
  });

  app.get('/inventory/movements', { preHandler: authenticate }, async (request) => {
    const query = parse(movementListQuerySchema, request.query);
    const movements = await database.inventoryMovement.findMany({
      where: {
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.performedById ? { performedById: query.performedById } : {}),
        ...(query.movementType ? { movementType: query.movementType as MovementType } : {}),
        ...(query.from || query.to ? { effectiveAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {})
      },
      include: {
        product: { select: { id: true, name: true, sku: true, trackingMode: true } },
        performedBy: { select: { id: true, username: true, displayName: true } },
        originalFor: { select: { id: true, status: true, delta: true } },
        compensatingFor: { select: { id: true } }
      },
      orderBy: { effectiveAt: 'desc' }
    });
    return { movements: movements.map(movementReadResponse) };
  });

  app.get('/inventory/movements/:id', { preHandler: authenticate }, async (request) => {
    const id = parse(idSchema, request.params).id;
    const movement = await database.inventoryMovement.findUnique({
      where: { id },
      include: {
        product: { select: { id: true, name: true, sku: true, trackingMode: true } },
        performedBy: { select: { id: true, username: true, displayName: true } },
        originalFor: { select: { id: true, status: true, delta: true } },
        compensatingFor: { select: { id: true } }
      }
    });
    if (!movement) throw new ApiError(404, 'NOT_FOUND', 'Movement not found');
    return { movement: movementReadResponse(movement) };
  });

  app.post('/inventory/movements/initial', { preHandler: [requireRole(database, Role.JEFE), requireCsrf] }, async (request) => ({ movement: movementResponse(await createInitialMovement(database, parse(initialSchema, request.body), request.auth!.user.id)) }));
  app.post('/inventory/movements/entry', { preHandler: [operations, requireCsrf] }, async (request) => ({ movement: movementResponse(await createSimpleMovement(database, parse(entrySchema, request.body), MovementType.ENTRY, request.auth!.user.id)) }));
  app.post('/inventory/movements/exit', { preHandler: [operations, requireCsrf] }, async (request) => ({ movement: movementResponse(await createSimpleMovement(database, parse(exitSchema, request.body), MovementType.EXIT, request.auth!.user.id)) }));
  app.post('/inventory/movements/return', { preHandler: [operations, requireCsrf] }, async (request) => ({ movement: movementResponse(await createSimpleMovement(database, parse(returnSchema, request.body), MovementType.RETURN, request.auth!.user.id)) }));
  app.post('/inventory/movements/adjustment', { preHandler: [adjustments, requireCsrf] }, async (request) => ({ movement: movementResponse(await createAdjustment(database, parse(adjustmentSchema, request.body), request.auth!.user.id)) }));
}
