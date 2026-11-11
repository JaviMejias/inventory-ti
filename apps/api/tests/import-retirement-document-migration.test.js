import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
test('retirement document migration adds empty documentary storage over populated inventory without rewriting facts', async () => {
  const source = readFileSync(new URL('../../../prisma/migrations/0030_import_retirement_documents/migration.sql', import.meta.url), 'utf8');
  assert.ok(source.startsWith('BEGIN;')); assert.ok(source.trim().endsWith('COMMIT;')); assert.equal(/^\s*(UPDATE|DELETE|TRUNCATE|DROP TABLE)\b/m.test(source), false);
  const statements = source.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
  assert.ok(statements.length >= 15); const schema = 'retirement_document_upgrade_' + randomUUID().replaceAll('-', ''); class RollbackUpgrade extends Error {}
  const tables = ['User', 'Product', 'Asset', 'Assignment', 'ImportEvidenceAmendment', 'ImportSourceRevision', 'AuditLog'];
  const product = await database.product.create({ data: { name: 'Document migration fixture ' + randomUUID(), trackingMode: 'ASSET' } });
  await database.asset.create({ data: { productId: product.id, serialNumber: 'DOCUMENT-UPGRADE-' + randomUUID() } });
  await assert.rejects(database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    for (const table of tables) {
      await transaction.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await transaction.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await transaction.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '", public');
    const counts = () => transaction.$queryRaw`SELECT (SELECT count(*)::integer FROM "Asset") AS assets, (SELECT count(*)::integer FROM "Assignment") AS assignments,
      (SELECT count(*)::integer FROM "ImportEvidenceAmendment") AS amendments, (SELECT count(*)::integer FROM "AuditLog") AS audits`;
    const original = await counts(); assert.ok(original[0].assets > 0);
    for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    assert.deepEqual(await counts(), original);
    assert.deepEqual(await transaction.$queryRaw`SELECT count(*)::integer AS receipts FROM "ImportRetirementReconciliation"`, [{ receipts: 0 }]);
    throw new RollbackUpgrade();
  }, { timeout: 30000 }), (error) => error instanceof RollbackUpgrade);
  assert.deepEqual(await database.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`, []);
});
after(async () => { await database.$disconnect(); });
