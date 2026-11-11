import { Role, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { requireCsrf, requireRole } from '../auth/service.js';
import { ApiError } from '../lib/errors.js';
import { buildWorkbookPreview, previewDate } from './preview.js';
import { previewBodyLimit, workbookPreviewSchema } from './schemas.js';
import { readPreviewAssets } from './snapshot.js';

export { readPreviewAssets } from './snapshot.js';

export function registerImportPreviewRoutes(app: FastifyInstance, database: PrismaClient): void {
  app.post('/inventory/imports/preview', {
    bodyLimit: previewBodyLimit,
    preHandler: [requireRole(database, Role.JEFE), requireCsrf]
  }, async (request) => {
    const parsed = workbookPreviewSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid workbook preview envelope');
    const assets = await readPreviewAssets(database);
    return buildWorkbookPreview(parsed.data, assets, previewDate(), 'DATABASE');
  });
}
