import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { groupClosedAssignmentFixture } from './fixtures/group-closed-assignment.js';

const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database);

test('group historical migration is additive over populated inventory and provenance and its test schema rolls back completely', async () => {
  const username = 'groupmigration-' + randomUUID(); const password = 'Group-migration-password-123';
  await database.user.create({ data: { username, displayName: 'Group migration', role: 'JEFE', passwordHash: hashPassword(password) } });
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
  assert.equal(login.statusCode, 200, login.body); const header = login.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header).split(';')[0];
  async function post(url, payload) {
    const csrfToken = (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    return app.inject({ method: 'POST', url, payload, headers: { cookie, 'x-csrf-token': csrfToken } });
  }
  const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } });
  const product = await database.product.create({ data: { name: username, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
  const fixture = await groupClosedAssignmentFixture({ database, product, post, get });
  const asset = await database.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } });
  const proof = await database.importGroupHistoryApplication.findUniqueOrThrow({ where: { id: fixture.historyApplication.id }, include: { links: { orderBy: { evidenceId: 'asc' } } } });
  const migration = readFileSync(new URL('../../../prisma/migrations/0027_import_group_assignments/migration.sql', import.meta.url), 'utf8');
  assert.ok(migration.startsWith('BEGIN;')); assert.ok(migration.trim().endsWith('COMMIT;'));
  assert.equal(/^\s*(DELETE|TRUNCATE|DROP TABLE|UPDATE)\b/m.test(migration), false);
  const schema = 'group_assignment_migration_' + randomUUID().replaceAll('-', '');
  class RollbackTest extends Error {}
  await assert.rejects(database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    const tables = ['User', 'Product', 'Asset', 'Assignment', 'ImportBatch', 'ImportHistoryCapture', 'ImportHistoricalEvidence', 'ImportEvidenceAmendment',
      'ImportIdentityGroupReview', 'ImportIdentityGroupRow', 'ImportIdentityGroupRelease', 'ImportIdentityGroupDecision', 'ImportIdentityGroupApplication',
      'ImportIdentityGroupApplicationItem', 'ImportIdentityGroupRowUse', 'ImportSourceRevision', 'ImportAssignmentApplication', 'ImportAssignmentItem',
      'ImportAssignmentEvidenceUse', 'ImportRetirementApplication', 'ImportGroupHistoryApplication', 'ImportGroupHistoryLink', 'AuditLog'];
    for (const table of tables) {
      await tx.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await tx.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await tx.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '", public');
    const current = () => tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "Asset") AS assets,
      (SELECT count(*)::integer FROM "Assignment") AS assignments, (SELECT count(*)::integer FROM "ImportIdentityGroupRowUse") AS consumed,
      (SELECT count(*)::integer FROM "ImportGroupHistoryLink") AS links, (SELECT count(*)::integer FROM "AuditLog") AS audits`;
    const before = await current(); assert.ok(before[0].assets > 0); assert.ok(before[0].links > 0);
    const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE (?:plpgsql|sql)(?: IMMUTABLE)?(?: STRICT)?;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
    assert.ok(statements.length >= 15);
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    assert.deepEqual(await current(), before);
    assert.deepEqual(await tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportGroupAssignmentApplication") AS receipts,
      (SELECT count(*)::integer FROM "ImportGroupAssignmentItem") AS items, (SELECT count(*)::integer FROM "ImportGroupAssignmentEvidenceUse") AS uses`, [{ receipts: 0, items: 0, uses: 0 }]);
    throw new RollbackTest();
  }, { timeout: 20000 }), (error) => error instanceof RollbackTest);
  assert.deepEqual(await database.$queryRaw`SELECT "nspname" FROM pg_namespace WHERE "nspname" = ${schema}`, []);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
  assert.deepEqual(await database.importGroupHistoryApplication.findUniqueOrThrow({ where: { id: proof.id }, include: { links: { orderBy: { evidenceId: 'asc' } } } }), proof);
});

after(async () => { await app.close(); });
