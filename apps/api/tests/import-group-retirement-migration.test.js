import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
test('group retirement migration adds empty receipt and consumption storage over populated inventory without rewriting historical rows', async () => {
  const source = readFileSync(new URL('../../../prisma/migrations/0029_import_group_retirements/migration.sql', import.meta.url),'utf8');
  assert.ok(source.startsWith('BEGIN;')); assert.ok(source.trim().endsWith('COMMIT;')); assert.equal(/^\s*(UPDATE|DELETE|TRUNCATE|DROP TABLE)\b/m.test(source),false);
  const statements = source.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
  assert.ok(statements.length >= 20);
  const schema = 'group_retirement_upgrade_' + randomUUID().replaceAll('-',''); class RollbackUpgrade extends Error {}
  const tables = ['User','Product','Asset','Assignment','ImportBatch','ImportHistoryCapture','ImportHistoricalEvidence','ImportEvidenceAmendment','ImportIdentityGroupReview',
    'ImportIdentityGroupRow','ImportIdentityGroupRelease','ImportIdentityGroupDecision','ImportSourceRevision','ImportIdentityGroupRowUse','AuditLog'];
  await assert.rejects(database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    for (const table of tables) {
      await tx.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await tx.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await tx.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '", public');
    const counts = async () => tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "Asset") AS assets,(SELECT count(*)::integer FROM "Assignment") AS assignments,
      (SELECT count(*)::integer FROM "ImportHistoricalEvidence") AS evidence,(SELECT count(*)::integer FROM "ImportIdentityGroupRowUse") AS existingUses,(SELECT count(*)::integer FROM "AuditLog") AS audits`;
    const original = await counts(); assert.ok(original[0].assets > 0); assert.ok(original[0].evidence > 0);
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    assert.deepEqual(await counts(),original);
    assert.deepEqual(await tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportGroupRetirementApplication") AS receipts,(SELECT count(*)::integer FROM "ImportGroupRetirementRowUse") AS uses`,[{ receipts:0,uses:0 }]);
    throw new RollbackUpgrade();
  },{timeout:30000}), (error)=>error instanceof RollbackUpgrade);
  assert.deepEqual(await database.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname=${schema}`,[]);
});
after(async () => { await database.$disconnect(); });
