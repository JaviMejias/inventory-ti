import { Prisma, Role, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { requireAuthenticated, requireCsrf, requireRole } from '../auth/service.js';
import { ApiError } from '../lib/errors.js';
import { assetIdSchema, assignmentCreateSchema, assignmentListQuerySchema, assignmentParamsSchema, assignmentUserQuerySchema } from './assignments-schemas.js';
import { createAssignment, getAssignment, listAssignmentUsers, listAssetAssignments, listAssignments, returnAssignment } from './assignments-service.js';

function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
  return result.data;
}

function assignmentConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ApiError(409, 'ASSET_ALREADY_ASSIGNED', 'The asset already has an active assignment');
  }
  throw error;
}

export function registerAssignmentRoutes(app: FastifyInstance, database: PrismaClient): void {
  const authenticate = requireAuthenticated(database);
  const operators = requireRole(database, Role.JEFE, Role.COORDINADOR, Role.SOPORTE);

  app.get('/assignment-users', { preHandler: authenticate }, async (request) => listAssignmentUsers(database, parse(assignmentUserQuerySchema, request.query)));

  app.post('/assets/:id/assignments', { preHandler: [operators, requireCsrf] }, async (request, reply) => {
    try {
      const { id } = parse(assetIdSchema, request.params);
      const assignment = await createAssignment(database, id, parse(assignmentCreateSchema, request.body), request.auth!.user.id);
      return reply.status(201).send(assignment);
    } catch (error) {
      return assignmentConflict(error);
    }
  });

  app.get('/assets/:id/assignments', { preHandler: authenticate }, async (request) => {
    const { id } = parse(assetIdSchema, request.params);
    const query = parse(assignmentListQuerySchema, request.query);
    return listAssetAssignments(database, id, query);
  });

  app.post('/assets/:id/assignments/:assignmentId/return', { preHandler: [operators, requireCsrf] }, async (request) => {
    const { id, assignmentId } = parse(assignmentParamsSchema, request.params);
    return returnAssignment(database, id, assignmentId, request.auth!.user.id);
  });

  app.get('/assignments', { preHandler: authenticate }, async (request) => listAssignments(database, parse(assignmentListQuerySchema, request.query)));

  app.get('/assignments/:id', { preHandler: authenticate }, async (request) => {
    const { id } = parse(assetIdSchema, request.params);
    return { assignment: await getAssignment(database, id) };
  });
}
