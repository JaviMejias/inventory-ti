import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
const migration = readFileSync(new URL('../../../prisma/migrations/0015_import_review_staging/migration.sql', import.meta.url), 'utf8');

test('staging migration adds empty review tables without changing populated legacy users/assets', async () => {
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `review_migration_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await transaction.$executeRawUnsafe('CREATE TABLE "User" ("id" uuid PRIMARY KEY, "displayName" text NOT NULL)');
      await transaction.$executeRawUnsafe('CREATE TABLE "Asset" ("id" uuid PRIMARY KEY, "status" text NOT NULL)');
      const userId = randomUUID();
      const assetId = randomUUID();
      await transaction.$executeRaw`INSERT INTO "User" VALUES (${userId}::uuid, 'Legacy user')`;
      await transaction.$executeRaw`INSERT INTO "Asset" VALUES (${assetId}::uuid, 'DECOMMISSIONED')`;
      const statements = migration.match(/CREATE TYPE[^;]+;|CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
      assert.equal(statements.length, 16);
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
      assert.deepEqual(await transaction.$queryRaw`SELECT * FROM "User"`, [{ id: userId, displayName: 'Legacy user' }]);
      assert.deepEqual(await transaction.$queryRaw`SELECT * FROM "Asset"`, [{ id: assetId, status: 'DECOMMISSIONED' }]);
      const [count] = await transaction.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportBatch") AS batches, (SELECT count(*)::integer FROM "ImportReviewDecision") AS decisions`;
      assert.deepEqual(count, { batches: 0, decisions: 0 });
      throw new RollbackTest();
    }, { timeout: 15000 });
  } catch (error) {
    if (!(error instanceof RollbackTest)) throw error;
  }
});

after(async () => { await database.$disconnect(); });
