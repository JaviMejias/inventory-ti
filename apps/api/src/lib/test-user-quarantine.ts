import { Role, type PrismaClient, type User } from '@prisma/client';

import { verifyPassword } from './password.js';
import { lockAdministratorChanges } from '../auth/administrator-guard.js';

const fixturePassword = 'Valid-password-123';
const fixtures = new Map<string, { role: Role; names: string[] }>();
for (const [suite, title] of [['asset', 'Asset'], ['assignment', 'Assignment'], ['catalog', 'Catalog'], ['correction', 'Correction'], ['inventory', 'Inventory']]) {
  for (const [roleName, role] of [['jefe', Role.JEFE], ['coordinator', Role.COORDINADOR], ['support', Role.SOPORTE]] as const) {
    fixtures.set(`${suite}-${roleName}`, { role, names: [`${title} ${roleName}`] });
  }
}
fixtures.set('inventory-jefe', { role: Role.JEFE, names: ['Inventory jefe', 'Inventory Jefe'] });
fixtures.set('inventory-coordinador', { role: Role.COORDINADOR, names: ['Inventory Coordinador'] });
fixtures.set('inventory-soporte', { role: Role.SOPORTE, names: ['Inventory Soporte'] });
fixtures.set('correction-jefe-2', { role: Role.JEFE, names: ['Second correction jefe'] });
fixtures.set('correction-other', { role: Role.SOPORTE, names: ['Other support'] });
for (const [name, role] of [['jefe', Role.JEFE], ['coordinator', Role.COORDINADOR], ['support', Role.SOPORTE], ['inactive', Role.SOPORTE]] as const) {
  fixtures.set(`phase3-${name}`, { role, names: [name] });
}

export function isFixtureIdentity(user: Pick<User, 'username' | 'email' | 'displayName' | 'role'>) {
  const match = /^(.*)-[a-f0-9]{8}$/.exec(user.username);
  const fixture = match ? fixtures.get(match[1]) : undefined;
  return Boolean(fixture && fixture.role === user.role && fixture.names.includes(user.displayName) && user.email === `${user.username}@example.com`);
}

export async function findTestUsers(database: PrismaClient, onlyIds?: string[]) {
  const users = await database.user.findMany({ where: { passwordHash: { not: null }, ...(onlyIds ? { id: { in: onlyIds } } : {}) } });
  return users.filter((user) => isFixtureIdentity(user) && verifyPassword(fixturePassword, user.passwordHash));
}

export async function quarantineTestUsers(database: PrismaClient, onlyIds?: string[]) {
  const candidates = await findTestUsers(database, onlyIds);
  if (candidates.length === 0) return { users: 0, sessions: 0, activationCodes: 0 };
  return database.$transaction(async (transaction) => {
    await lockAdministratorChanges(transaction);
    const ids = candidates.map((user) => user.id);
    const rows = await transaction.user.findMany({ where: { OR: [{ id: { in: ids } }, { role: Role.JEFE, isActive: true, passwordHash: { not: null } }] }, orderBy: { id: 'asc' } });
    for (const row of rows) await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
    const current = await transaction.user.findMany({ where: { id: { in: ids } } });
    const confirmed = current.filter((user) => isFixtureIdentity(user) && candidates.some((candidate) => candidate.id === user.id && candidate.passwordHash === user.passwordHash));
    const confirmedIds = confirmed.map((user) => user.id);
    const administrators = await transaction.user.count({ where: { role: Role.JEFE, isActive: true, passwordHash: { not: null }, id: { in: rows.map((user) => user.id), notIn: confirmedIds } } });
    if (administrators === 0) throw new Error('Quarantine refused: activate a real JEFE account before disabling test accounts');
    const sessions = await transaction.session.deleteMany({ where: { userId: { in: confirmedIds } } });
    const activationCodes = await transaction.activationCode.updateMany({ where: { userId: { in: confirmedIds }, usedAt: null }, data: { usedAt: new Date() } });
    await transaction.user.updateMany({ where: { id: { in: confirmedIds } }, data: { isActive: false, passwordHash: null } });
    await transaction.auditLog.createMany({ data: confirmedIds.map((id) => ({ userId: null, action: 'TEST_ACCOUNT_QUARANTINED', entityType: 'User', entityId: id, metadata: { sessionsInvalidated: true, historyPreserved: true } })) });
    return { users: confirmedIds.length, sessions: sessions.count, activationCodes: activationCodes.count };
  }, { timeout: 30_000 });
}
