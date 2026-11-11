import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Role, type Prisma, type PrismaClient, type Product } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { lockProduct } from '../lib/product-lock.js';
import { requireAuthenticated, requireCsrf, requireRole } from '../auth/service.js';
import { catalogIdSchema, productCreateSchema, productListQuerySchema, productUpdateSchema } from './schemas.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
  }
  return result.data;
}

function conflict(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
    throw new ApiError(409, 'CONFLICT', message);
  }
  throw error;
}

function productResponse(product: Product) {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    equipmentType: product.equipmentType,
    brand: product.brand,
    model: product.model,
    trackingMode: product.trackingMode,
    lowStockThreshold: product.lowStockThreshold,
    active: product.isActive,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt
  };
}

function normalizeSku(sku: string | null | undefined): string | null {
  const normalized = sku?.trim() ?? '';
  return normalized || null;
}

async function getProductOrFail(database: DatabaseClient, id: string) {
  const product = await database.product.findUnique({ where: { id } });
  if (!product) throw new ApiError(404, 'NOT_FOUND', 'Product not found');
  return product;
}

async function ensureProductAvailable(database: DatabaseClient, input: { name?: string; sku?: string | null }, excludeId?: string) {
  if (input.name) {
    const duplicate = await database.product.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, ...(excludeId ? { NOT: { id: excludeId } } : {}) } });
    if (duplicate) throw new ApiError(409, 'CONFLICT', 'A product with the same name already exists');
  }
  if (input.sku) {
    const duplicateSku = await database.product.findFirst({ where: { sku: { equals: input.sku, mode: 'insensitive' }, ...(excludeId ? { NOT: { id: excludeId } } : {}) } });
    if (duplicateSku) throw new ApiError(409, 'CONFLICT', 'A product with the same SKU already exists');
  }
}

async function writeAudit(database: DatabaseClient, userId: string, action: string, entityId: string, metadata: object) {
  await database.auditLog.create({ data: { userId, action, entityType: 'Catalog', entityId, metadata } });
}

function idFrom(request: FastifyRequest) {
  return parse(catalogIdSchema, request.params).id;
}

export function registerCatalogRoutes(app: FastifyInstance, database: PrismaClient): void {
  const authenticate = requireAuthenticated(database);
  const administer = requireRole(database, Role.JEFE);
  const mutate = [administer, requireCsrf];

  app.get('/products', { preHandler: authenticate }, async (request) => {
    const query = parse(productListQuerySchema, request.query);
    const where = {
      ...(query.active === undefined ? {} : { isActive: query.active }),
      ...(query.equipmentType ? { equipmentType: { contains: query.equipmentType, mode: 'insensitive' as const } } : {}),
      ...(query.brand ? { brand: { contains: query.brand, mode: 'insensitive' as const } } : {}),
      ...(query.model ? { model: { contains: query.model, mode: 'insensitive' as const } } : {}),
      ...(query.search ? { OR: ['name', 'sku', 'equipmentType', 'brand', 'model'].map((field) => ({ [field]: { contains: query.search, mode: 'insensitive' as const } })) } : {})
    };
    const [products, total] = await database.$transaction([
      database.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: query.offset,
        take: query.limit
      }),
      database.product.count({ where })
    ]);
    return { products: products.map(productResponse), total, limit: query.limit, offset: query.offset, hasMore: query.offset + products.length < total };
  });

  app.get('/products/:id', { preHandler: authenticate }, async (request) => ({ product: productResponse(await getProductOrFail(database, idFrom(request))) }));

  app.post('/products', { preHandler: mutate }, async (request, reply) => {
    const input = parse(productCreateSchema, request.body);
    const sku = normalizeSku(input.sku);
    try {
      const product = await database.$transaction(async (transaction) => {
        await ensureProductAvailable(transaction, { name: input.name, sku });
        const created = await transaction.product.create({ data: { ...input, sku } });
        await writeAudit(transaction, request.auth!.user.id, 'PRODUCT_CREATED', created.id, { name: created.name, equipmentType: created.equipmentType, brand: created.brand, model: created.model });
        return getProductOrFail(transaction, created.id);
      });
      return reply.status(201).send({ product: productResponse(product) });
    } catch (error) {
      return conflict(error, 'A product with the same unique data already exists');
    }
  });

  app.patch('/products/:id', { preHandler: mutate }, async (request) => {
    const id = idFrom(request);
    const input = parse(productUpdateSchema, request.body);
    try {
      const product = await database.$transaction(async (transaction) => {
        const current = await lockProduct(transaction, id);
        if (input.trackingMode !== undefined && input.trackingMode !== current.trackingMode) {
          const [stock, movement, asset] = await Promise.all([
            transaction.inventoryStock.findUnique({ where: { productId: id }, select: { id: true } }),
            transaction.inventoryMovement.findFirst({ where: { productId: id }, select: { id: true } }),
            transaction.asset.findFirst({ where: { productId: id }, select: { id: true } })
          ]);
          if (stock || movement || asset) throw new ApiError(409, 'PRODUCT_TRACKING_MODE_LOCKED', 'The tracking mode cannot change after inventory or assets have been registered');
        }
        const sku = input.sku === undefined ? undefined : normalizeSku(input.sku);
        await ensureProductAvailable(transaction, { name: input.name ?? current.name, sku }, id);
        const updated = await transaction.product.update({ where: { id }, data: { ...input, sku } });
        const fields = Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined) as Array<keyof typeof input>;
        await writeAudit(transaction, request.auth!.user.id, 'PRODUCT_UPDATED', id, {
          fields,
          before: Object.fromEntries(fields.map((field) => [field, current[field]])),
          after: Object.fromEntries(fields.map((field) => [field, updated[field]]))
        });
        return getProductOrFail(transaction, updated.id);
      });
      return { product: productResponse(product) };
    } catch (error) {
      return conflict(error, 'A product with the same unique data already exists');
    }
  });

  app.post('/products/:id/activate', { preHandler: mutate }, async (request) => updateProductStatus(database, request, true));
  app.post('/products/:id/deactivate', { preHandler: mutate }, async (request) => updateProductStatus(database, request, false));
}

async function updateProductStatus(database: PrismaClient, request: FastifyRequest, isActive: boolean) {
  const id = idFrom(request);
  const product = await database.$transaction(async (transaction) => {
    await getProductOrFail(transaction, id);
    const updated = await transaction.product.update({ where: { id }, data: { isActive, inactivatedAt: isActive ? null : new Date() } });
    await writeAudit(transaction, request.auth!.user.id, isActive ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED', id, { active: isActive });
    return getProductOrFail(transaction, updated.id);
  });
  return { product: productResponse(product) };
}
