import { AssetStatus, Prisma, type PrismaClient } from '@prisma/client';

import type { AssetAvailabilityQuery } from './assets-schemas.js';

export async function getAssetAvailability(database: PrismaClient, query: AssetAvailabilityQuery) {
  return database.$transaction(async (transaction) => {
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      trackingMode: 'ASSET',
      ...(query.productId ? { id: query.productId } : {}),
      ...(query.equipmentType ? { equipmentType: { contains: query.equipmentType, mode: 'insensitive' } } : {}),
      ...(query.brand ? { brand: { contains: query.brand, mode: 'insensitive' } } : {}),
      ...(query.model ? { model: { contains: query.model, mode: 'insensitive' } } : {})
    };
    const products = await transaction.product.findMany({
      where,
      select: { id: true, name: true, sku: true, equipmentType: true, brand: true, model: true, lowStockThreshold: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: query.limit,
      skip: query.offset
    });
    const total = await transaction.product.count({ where });
    const counts = products.length ? await transaction.asset.groupBy({
      by: ['productId', 'status'],
      where: { productId: { in: products.map((product) => product.id) }, isActive: true, status: { not: AssetStatus.DECOMMISSIONED } },
      _count: { _all: true }
    }) : [];
    const byProduct = new Map<string, Partial<Record<AssetStatus, number>>>();
    for (const row of counts) {
      const statuses = byProduct.get(row.productId) ?? {};
      statuses[row.status] = row._count._all;
      byProduct.set(row.productId, statuses);
    }
    return {
      products: products.map((product) => {
        const statusCounts = Object.fromEntries(Object.values(AssetStatus).map((status) => [status, byProduct.get(product.id)?.[status] ?? 0])) as Record<AssetStatus, number>;
        const availableCount = statusCounts.AVAILABLE;
        return {
          product,
          activeCount: Object.values(statusCounts).reduce((sum, count) => sum + count, 0),
          availableCount,
          statusCounts,
          lowStock: product.lowStockThreshold > 0 && availableCount <= product.lowStockThreshold
        };
      }),
      total,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + products.length < total
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
