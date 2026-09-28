import { Role, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { requireAuthenticated, requireCsrf, requireRole } from '../auth/service.js';
import { ApiError } from '../lib/errors.js';
import { approveCorrection, createCorrection, getCorrection, listCorrections, rejectCorrection } from './corrections-service.js';
import { correctionCreateSchema, correctionIdSchema, correctionListQuerySchema, correctionMovementParamsSchema } from './corrections-schemas.js';

function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
  return result.data;
}

export function registerCorrectionRoutes(app: FastifyInstance, database: PrismaClient): void {
  const authenticate = requireAuthenticated(database);
  const operators = requireRole(database, Role.JEFE, Role.COORDINADOR, Role.SOPORTE);
  const reviewers = requireRole(database, Role.JEFE);

  app.post('/inventory/movements/:movementId/corrections', { preHandler: [operators, requireCsrf] }, async (request, reply) => {
    const { movementId } = parse(correctionMovementParamsSchema, request.params);
    const correction = await createCorrection(database, movementId, parse(correctionCreateSchema, request.body), request.auth!.user.id, request.auth!.user.role);
    return reply.status(201).send({ correction });
  });

  app.get('/corrections', { preHandler: authenticate }, async (request) => listCorrections(database, request.auth!.user.id, request.auth!.user.role, parse(correctionListQuerySchema, request.query)));

  app.get('/corrections/:id', { preHandler: authenticate }, async (request) => {
    const { id } = parse(correctionIdSchema, request.params);
    return { correction: await getCorrection(database, id, request.auth!.user.id, request.auth!.user.role) };
  });

  app.post('/corrections/:id/approve', { preHandler: [reviewers, requireCsrf] }, async (request) => {
    const { id } = parse(correctionIdSchema, request.params);
    return { correction: await approveCorrection(database, id, request.auth!.user.id) };
  });

  app.post('/corrections/:id/reject', { preHandler: [reviewers, requireCsrf] }, async (request) => {
    const { id } = parse(correctionIdSchema, request.params);
    return { correction: await rejectCorrection(database, id, request.auth!.user.id) };
  });
}
