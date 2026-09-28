import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Role } from '@prisma/client';

import type { Prisma, PrismaClient } from '@prisma/client';
import { ApiError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { clearSessionCookie, csrfToken, login, requireAuthenticated, requireCsrf, requireRole, setSessionCookie, toPublicUser } from './service.js';
import { accountUpdateSchema, activationSchema, changePasswordSchema, loginSchema, userCreateSchema, userIdSchema, userListQuerySchema, userUpdateSchema } from './schemas.js';

const loginAttemptWindowMs = 15 * 60 * 1000;
const loginAttemptLimit = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
  }
  return result.data;
}

function handlePrismaConflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
    const meta = 'meta' in error && typeof error.meta === 'object' && error.meta !== null ? error.meta : undefined;
    const target = meta && 'target' in meta ? meta.target : undefined;
    const targets = Array.isArray(target) ? target : [target];
    const field = targets.find((value): value is 'username' | 'email' => value === 'username' || value === 'email');
    throw new ApiError(409, 'CONFLICT', 'A user with the same unique data already exists', field ? { field } : undefined);
  }
  throw error;
}

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const activationCodeTtlMs = 24 * 60 * 60 * 1000;
const activationAttemptWindowMs = 15 * 60 * 1000;
const activationAttemptLimit = 10;
const activationAttempts = new Map<string, { count: number; resetAt: number }>();

function hashActivationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateActivationCode(): { code: string; codeHash: string; expiresAt: Date } {
  const code = randomBytes(16).toString('hex');
  return {
    code,
    codeHash: hashActivationCode(code),
    expiresAt: new Date(Date.now() + activationCodeTtlMs)
  };
}

async function lockUser(database: Prisma.TransactionClient, id: string): Promise<void> {
  await database.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id}::uuid FOR UPDATE`;
}

async function issueActivationCode(database: Prisma.TransactionClient, userId: string): Promise<string> {
  await database.activationCode.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  const generated = generateActivationCode();
  await database.activationCode.create({ data: { userId, codeHash: generated.codeHash, expiresAt: generated.expiresAt } });
  return generated.code;
}

function checkActivationRateLimit(key: string): void {
  const now = Date.now();
  const attempt = activationAttempts.get(key);
  if (attempt && attempt.resetAt > now && attempt.count >= activationAttemptLimit) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many activation attempts');
  }
}

function recordActivationFailure(key: string): void {
  const now = Date.now();
  const attempt = activationAttempts.get(key);
  const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + activationAttemptWindowMs };
  activationAttempts.set(key, { count: current.count + 1, resetAt: current.resetAt });
}

async function getUserOrFail(database: DatabaseClient, id: string) {
  const user = await database.user.findUnique({ where: { id } });
  if (!user) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }
  return user;
}

async function writeAudit(database: DatabaseClient, userId: string, action: string, entityId: string, metadata: object) {
  await database.auditLog.create({ data: { userId, action, entityType: 'User', entityId, metadata } });
}

export function registerAuthRoutes(app: FastifyInstance, database: PrismaClient): void {
  app.post('/auth/login', async (request, reply) => {
    const input = parse(loginSchema, request.body);
    const now = Date.now();
    const attempt = loginAttempts.get(request.ip);
    if (attempt && attempt.resetAt > now && attempt.count >= loginAttemptLimit) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many login attempts');
    }

    let result;
    try {
      result = await login(database, input.identifier, input.password);
      loginAttempts.delete(request.ip);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') {
        const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + loginAttemptWindowMs };
        loginAttempts.set(request.ip, { count: current.count + 1, resetAt: current.resetAt });
      }
      throw error;
    }
    await setSessionCookie(reply, result.token, result.expiresAt);
    return reply.send({ user: result.user });
  });

  app.get('/auth/me', { preHandler: requireAuthenticated(database) }, async (request) => ({ user: request.auth!.user }));

  app.patch('/auth/me', { preHandler: [requireAuthenticated(database), requireCsrf] }, async (request) => {
    const input = parse(accountUpdateSchema, request.body);
    try {
      const user = await database.$transaction(async (transaction) => {
        await lockUser(transaction, request.auth!.user.id);
        await getUserOrFail(transaction, request.auth!.user.id);
        const updatedUser = await transaction.user.update({ where: { id: request.auth!.user.id }, data: input });
        await writeAudit(transaction, updatedUser.id, 'PROFILE_UPDATED', updatedUser.id, { fields: Object.keys(input) });
        return updatedUser;
      });
      return { user: toPublicUser(user) };
    } catch (error) {
      return handlePrismaConflict(error);
    }
  });

  app.get('/auth/csrf', { preHandler: requireAuthenticated(database) }, async (request) => ({ csrfToken: csrfToken(request) }));
  app.post('/auth/activate', async (request) => {
    const input = parse(activationSchema, request.body);
    checkActivationRateLimit(request.ip);
    try {
      const user = await database.$transaction(async (transaction) => {
        const initialCode = await transaction.activationCode.findUnique({ where: { codeHash: hashActivationCode(input.activationCode) } });
        if (!initialCode) {
          throw new ApiError(400, 'INVALID_ACTIVATION_CODE', 'Invalid or expired activation code');
        }
        await lockUser(transaction, initialCode.userId);
        const code = await transaction.activationCode.findUnique({ where: { id: initialCode.id } });
        const currentUser = await transaction.user.findUnique({ where: { id: initialCode.userId } });
        const identifierMatches = currentUser && (currentUser.username === input.identifier || currentUser.email === input.identifier);
        if (!currentUser || !currentUser.isActive || !identifierMatches || !code || code.usedAt || code.expiresAt <= new Date() || currentUser.passwordHash !== null) {
          throw new ApiError(400, 'INVALID_ACTIVATION_CODE', 'Invalid or expired activation code');
        }
        const claimed = await transaction.activationCode.updateMany({ where: { id: code.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
        if (claimed.count !== 1) {
          throw new ApiError(400, 'INVALID_ACTIVATION_CODE', 'Invalid or expired activation code');
        }
        const updatedUser = await transaction.user.update({ where: { id: currentUser.id }, data: { passwordHash: hashPassword(input.password) } });
        await writeAudit(transaction, updatedUser.id, 'USER_ACTIVATED', updatedUser.id, { activation: true });
        await writeAudit(transaction, updatedUser.id, 'PASSWORD_SETUP', updatedUser.id, { activation: true });
        return updatedUser;
      });
      activationAttempts.delete(request.ip);
      return { user: toPublicUser(user) };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_ACTIVATION_CODE') {
        recordActivationFailure(request.ip);
      }
      throw error;
    }
  });

  app.post('/auth/logout', { preHandler: [requireAuthenticated(database), requireCsrf] }, async (request, reply) => {
    await database.session.deleteMany({ where: { id: request.auth!.sessionId } });
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.post('/auth/password', { preHandler: [requireAuthenticated(database), requireCsrf] }, async (request) => {
    const input = parse(changePasswordSchema, request.body);
    const user = await database.$transaction(async (transaction) => {
      await lockUser(transaction, request.auth!.user.id);
      const currentUser = await getUserOrFail(transaction, request.auth!.user.id);
      if (!verifyPassword(input.currentPassword, currentUser.passwordHash)) {
        throw new ApiError(401, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }
      const updatedUser = await transaction.user.update({ where: { id: currentUser.id }, data: { passwordHash: hashPassword(input.newPassword) } });
      await transaction.session.deleteMany({ where: { userId: currentUser.id, id: { not: request.auth!.sessionId } } });
      await writeAudit(transaction, currentUser.id, 'PASSWORD_CHANGED', currentUser.id, { sessionsInvalidated: true });
      return updatedUser;
    });
    return { user: toPublicUser(user) };
  });

  app.get('/users', { preHandler: requireRole(database, Role.JEFE) }, async (request) => {
    const query = parse(userListQuerySchema, request.query);
    const where = {
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.search ? {
        OR: [
          { username: { contains: query.search, mode: 'insensitive' as const } },
          { displayName: { contains: query.search, mode: 'insensitive' as const } },
          { email: { contains: query.search, mode: 'insensitive' as const } },
          { phone: { contains: query.search, mode: 'insensitive' as const } }
        ]
      } : {})
    };
    const [users, total] = await database.$transaction([
      database.user.findMany({ where, orderBy: { username: 'asc' }, skip: query.offset, take: query.limit }),
      database.user.count({ where })
    ]);
    return { users: users.map(toPublicUser), total, limit: query.limit, offset: query.offset, hasMore: query.offset + users.length < total };
  });

  app.get('/users/:id', { preHandler: requireRole(database, Role.JEFE) }, async (request) => {
    const { id } = parse(userIdSchema, request.params);
    return { user: toPublicUser(await getUserOrFail(database, id)) };
  });

  app.post('/users', { preHandler: [requireRole(database, Role.JEFE), requireCsrf] }, async (request, reply) => {
    const input = parse(userCreateSchema, request.body);
    try {
      const result = await database.$transaction(async (transaction) => {
        const createdUser = await transaction.user.create({ data: { ...input, passwordHash: null, role: input.role as Role } });
        const activationCode = await issueActivationCode(transaction, createdUser.id);
        await writeAudit(transaction, request.auth!.user.id, 'USER_CREATED', createdUser.id, { role: createdUser.role });
        return { user: createdUser, activationCode };
      });
      return reply.status(201).send({ user: toPublicUser(result.user), activationCode: result.activationCode });
    } catch (error) {
      return handlePrismaConflict(error);
    }
  });

  app.patch('/users/:id', { preHandler: [requireRole(database, Role.JEFE), requireCsrf] }, async (request) => {
    const { id } = parse(userIdSchema, request.params);
    const input = parse(userUpdateSchema, request.body);
    try {
      const user = await database.$transaction(async (transaction) => {
        await getUserOrFail(transaction, id);
        const updatedUser = await transaction.user.update({ where: { id }, data: input });
        await writeAudit(transaction, request.auth!.user.id, 'USER_UPDATED', updatedUser.id, { fields: Object.keys(input) });
        return updatedUser;
      });
      return { user: toPublicUser(user) };
    } catch (error) {
      return handlePrismaConflict(error);
    }
  });

  app.post('/users/:id/reset-access', { preHandler: [requireRole(database, Role.JEFE), requireCsrf] }, async (request) => {
    const { id } = parse(userIdSchema, request.params);
    const result = await database.$transaction(async (transaction) => {
      await lockUser(transaction, id);
      await getUserOrFail(transaction, id);
      const updatedUser = await transaction.user.update({ where: { id }, data: { passwordHash: null } });
      await transaction.session.deleteMany({ where: { userId: id } });
      const activationCode = await issueActivationCode(transaction, id);
      await writeAudit(transaction, request.auth!.user.id, 'ACCESS_RESET_REQUESTED', id, { sessionsInvalidated: true });
      return { user: updatedUser, activationCode };
    });
    return { user: toPublicUser(result.user), activationCode: result.activationCode };
  });

  app.post('/users/:id/activate', { preHandler: [requireRole(database, Role.JEFE), requireCsrf] }, async (request) => updateUserStatus(database, request, true));
  app.post('/users/:id/deactivate', { preHandler: [requireRole(database, Role.JEFE), requireCsrf] }, async (request) => updateUserStatus(database, request, false));
}

async function updateUserStatus(database: PrismaClient, request: FastifyRequest, isActive: boolean) {
  const { id } = parse(userIdSchema, request.params);
  const user = await database.$transaction(async (transaction) => {
    await lockUser(transaction, id);
    await getUserOrFail(transaction, id);
    const updatedUser = await transaction.user.update({ where: { id }, data: { isActive } });
    if (!isActive) {
      await transaction.session.deleteMany({ where: { userId: id } });
    }
    await writeAudit(transaction, request.auth!.user.id, isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', updatedUser.id, { isActive });
    return updatedUser;
  });
  return { user: toPublicUser(user) };
}
