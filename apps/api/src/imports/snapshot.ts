import type { PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';

export async function readPreviewAssets(database: Pick<PrismaClient, 'asset'>) {
  // Select only pre-V1 columns, so a read-only preview does not require a live migration.
  const assets = await database.asset.findMany({
    select: { id: true, productId: true, serialNumber: true, assetTag: true, status: true, isActive: true, updatedAt: true, product: { select: { name: true } } },
    orderBy: { id: 'asc' }, take: 25001
  });
  if (assets.length > 25000) throw new ApiError(409, 'PREVIEW_DATABASE_LIMIT', 'Database exceeds the preview asset limit');
  return assets;
}
