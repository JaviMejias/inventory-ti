import { Role, type Prisma, type User } from '@prisma/client';

import { ApiError } from '../lib/errors.js';

const administratorLockKey = 84821102;
type AdministratorState = Pick<User, 'id' | 'role' | 'isActive' | 'passwordHash'>;

export async function lockAdministratorChanges(database: Prisma.TransactionClient): Promise<void> {
  // Serialize removals across processes, including changes to different JEFE rows.
  await database.$executeRaw`SELECT pg_advisory_xact_lock(${administratorLockKey})`;
}

export async function requireUserAdministration(database: Prisma.TransactionClient, actorId: string): Promise<void> {
  await lockAdministratorChanges(database);
  const actor = await database.user.findUnique({ where: { id: actorId } });
  if (!actor || actor.role !== Role.JEFE || !actor.isActive || actor.passwordHash === null) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
  }
}

export async function ensureAdministratorRemains(database: Prisma.TransactionClient, current: AdministratorState, changes: Partial<Omit<AdministratorState, 'id'>>): Promise<void> {
  const next = { ...current, ...changes };
  const usable = (user: AdministratorState) => user.role === Role.JEFE && user.isActive && user.passwordHash !== null;
  if (!usable(current) || usable(next)) return;
  const others = await database.user.count({ where: { role: Role.JEFE, isActive: true, passwordHash: { not: null }, id: { not: current.id } } });
  if (others === 0) throw new ApiError(409, 'LAST_ADMIN_REQUIRED', 'At least one active JEFE with a configured password must remain');
}
