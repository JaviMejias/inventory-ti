import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient, Role, User } from '@prisma/client';

import { environment } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';
import type { AuthContext, PublicUser } from './types.js';

export const sessionCookieName = 'inventory_ti_session';
export const csrfHeaderName = 'x-csrf-token';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toPublicUser(user: Pick<User, 'id' | 'username' | 'email' | 'displayName' | 'phone' | 'passwordHash' | 'role' | 'isActive'>): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    phone: user.phone,
    role: user.role,
    isActive: user.isActive,
    isActivated: user.passwordHash !== null
  };
}

function csrfForSession(sessionToken: string): string {
  return createHmac('sha256', environment.SESSION_SECRET).update(sessionToken).digest('hex');
}

export async function authenticateRequest(request: FastifyRequest, database: PrismaClient): Promise<AuthContext> {
  const sessionToken = request.cookies[sessionCookieName];
  if (!sessionToken) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }

  const session = await database.session.findUnique({
    where: { tokenHash: hashToken(sessionToken) },
    include: { user: true }
  });
  if (!session || session.expiresAt <= new Date() || !session.user.isActive) {
    if (session) {
      await database.session.deleteMany({ where: { id: session.id } });
    }
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }

  const refreshed = await database.session.updateMany({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  if (refreshed.count !== 1) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { user: toPublicUser(session.user), sessionId: session.id, sessionToken };
}

export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (!request.auth) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
}

export function requireAuthenticated(database: PrismaClient) {
  return async function authenticationGuard(request: FastifyRequest): Promise<void> {
    request.auth = await authenticateRequest(request, database);
  };
}

export function requireRole(database: PrismaClient, ...roles: Role[]) {
  return async function roleGuard(request: FastifyRequest): Promise<void> {
    request.auth = await authenticateRequest(request, database);
    await requireAuth(request);
    if (!request.auth || !roles.includes(request.auth.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    }
  };
}

export async function requireCsrf(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  const submittedToken = request.headers[csrfHeaderName];
  if (typeof submittedToken !== 'string' || !request.auth || submittedToken !== csrfForSession(request.auth.sessionToken)) {
    throw new ApiError(403, 'CSRF_INVALID', 'Invalid CSRF token');
  }
}

export async function createSession(database: PrismaClient, user: User): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + environment.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await database.session.create({
    data: { tokenHash: hashToken(token), userId: user.id, expiresAt }
  });
  return { token, expiresAt };
}

export async function login(database: PrismaClient, identifier: string, password: string): Promise<{ user: PublicUser; token: string; expiresAt: Date }> {
  const user = await database.user.findFirst({
    where: { OR: [{ username: identifier }, { email: identifier }] }
  });
  if (!user || !user.isActive) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username/email or password');
  }
  if (!user.passwordHash) {
    throw new ApiError(403, 'ACCOUNT_PENDING', 'Account activation is required');
  }
  if (!verifyPassword(password, user.passwordHash)) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username/email or password');
  }

  const session = await createSession(database, user);
  return { user: toPublicUser(user), ...session };
}

export function csrfToken(request: FastifyRequest): string {
  if (!request.auth) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return csrfForSession(request.auth.sessionToken);
}

export async function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): Promise<void> {
  reply.setCookie(sessionCookieName, token, {
    httpOnly: true,
    secure: environment.COOKIE_SECURE,
    sameSite: environment.COOKIE_SAME_SITE,
    path: '/',
    expires: expiresAt
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: environment.COOKIE_SECURE,
    sameSite: environment.COOKIE_SAME_SITE,
    path: '/'
  });
}
