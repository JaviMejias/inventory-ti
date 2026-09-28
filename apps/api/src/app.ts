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

export function buildApp(database = prisma) {
  const app = Fastify({ logger: true });

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
  app.addHook('onClose', async () => {
    await database.$disconnect();
  });

  return app;
}
