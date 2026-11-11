import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
test('group documentary migration is additive over populated inventory and creates no synthetic terminal or evidence', async () => {
  const source = readFileSync(new URL('../../../prisma/migrations/0031_import_group_retirement_documents/migration.sql', import.meta.url), 'utf8');
  assert.ok(source.startsWith('BEGIN;')); assert.ok(source.trim().endsWith('COMMIT;')); assert.equal(/^\s*(UPDATE|DELETE|TRUNCATE|DROP TABLE)\b/m.test(source), false);
  const statements = source.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
  assert.ok(statements.length > 20); const schema = 'group_document_upgrade_' + randomUUID().replaceAll('-', ''); class RollbackUpgrade extends Error {}
  const tables = ['User', 'Product', 'Asset', 'Assignment', 'InventoryMovement', 'InventoryStock', 'ImportBatch', 'ImportIdentityGroupReview', 'ImportIdentityGroupRow',
    'ImportIdentityGroupDecision', 'ImportIdentityGroupRelease', 'ImportIdentityGroupRowUse', 'ImportGroupRetirementRowUse', 'ImportEvidenceAmendment', 'ImportSourceRevision', 'ImportRetirementReconciliation',
    'ImportHistoryCapture', 'ImportHistoricalEvidence', 'ImportGroupAssignmentCorrection', 'AuditLog'];
  const product = await database.product.create({ data: { name: 'Group documentary upgrade ' + randomUUID(), trackingMode: 'ASSET' } });
  await database.asset.create({ data: { productId: product.id, serialNumber: 'GROUP-DOC-UPGRADE-' + randomUUID() } });
  await assert.rejects(database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    for (const table of tables) {
      await transaction.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await transaction.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await transaction.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '", public');
    const snapshot = async () => ({ assets: await transaction.asset.findMany({ orderBy: { id: 'asc' } }),
      rows: await transaction.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportIdentityGroupRow") AS reservations,
        (SELECT count(*)::integer FROM "ImportGroupRetirementRowUse") AS consumptions, (SELECT count(*)::integer FROM "AuditLog") AS audits` });
    const before = await snapshot(); assert.ok(before.assets.length > 0);
    for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    assert.deepEqual(await snapshot(), before); assert.deepEqual(await transaction.$queryRaw`SELECT count(*)::integer AS receipts FROM "ImportGroupRetirementDocument"`, [{ receipts: 0 }]);
    throw new RollbackUpgrade();
  }, { timeout: 30000 }), (error) => error instanceof RollbackUpgrade);
  assert.deepEqual(await database.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`, []);
});
after(async () => { await database.$disconnect(); });
