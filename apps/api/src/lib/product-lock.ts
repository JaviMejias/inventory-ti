import type { Prisma } from '@prisma/client';

import { ApiError } from './errors.js';

export async function lockProduct(database: Prisma.TransactionClient, id: string) {
  // Allow foreign-key checks from corrections while serializing product mutations.
  await database.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`;
  const product = await database.product.findUnique({ where: { id } });
  if (!product) throw new ApiError(404, 'NOT_FOUND', 'Product not found');
  return product;
}
