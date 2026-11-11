import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';

import { prisma } from './config/database.js';
import { environment } from './config/env.js';
import { registerAuthRoutes } from './auth/routes.js';
import { ApiError } from './lib/errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerAssignmentRoutes } from './routes/assignments.js';
import { registerCorrectionRoutes } from './routes/corrections.js';
import { registerImportPreviewRoutes } from './imports/routes.js';
import { registerImportReviewRoutes } from './imports/review-routes.js';

export function buildApp(database = prisma) {
  const app = Fastify({ logger: true, trustProxy: environment.TRUST_PROXY });

  app.register(cookie);
  app.register(cors, {
    origin: environment.WEB_ORIGIN,
    credentials: true
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      request.log.warn({ code: error.code, statusCode: error.statusCode }, 'Request rejected');
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
      const code = statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'VALIDATION_ERROR';
      const message = statusCode === 413 ? 'Request body is too large' : statusCode === 415 ? 'Unsupported content type' : 'Invalid request';
      request.log.warn({ code, statusCode }, 'Request rejected');
      return reply.status(statusCode).send({ code, message });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error'
    });
  });

  app.register(registerHealthRoutes);
  registerAuthRoutes(app, database);
  registerCatalogRoutes(app, database);
  registerInventoryRoutes(app, database);
  registerAssetRoutes(app, database);
  registerAssignmentRoutes(app, database);
  registerCorrectionRoutes(app, database);
  registerImportPreviewRoutes(app, database);
  registerImportReviewRoutes(app, database);
  app.addHook('onClose', async () => {
    await database.$disconnect();
  });

  return app;
}
