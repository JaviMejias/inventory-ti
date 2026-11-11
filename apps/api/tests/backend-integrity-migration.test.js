import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
const migration = readFileSync(new URL('../../../prisma/migrations/0012_backend_integrity/migration.sql', import.meta.url), 'utf8');
const statements = migration.match(/LOCK TABLE[^;]+;|DO \$\$[\s\S]*?\$\$;|CREATE UNIQUE INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE TRIGGER[^;]+;/g);

class RollbackTest extends Error {}

async function withLegacyTables(callback) {
  try {
    await database.$transaction(async (transaction) => {
      const schema = `integrity_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await transaction.$executeRawUnsafe('CREATE TABLE "Product" ("id" uuid PRIMARY KEY, "sku" text, "trackingMode" text NOT NULL)');
      for (const table of ['InventoryStock', 'InventoryMovement', 'Asset']) {
        await transaction.$executeRawUnsafe(`CREATE TABLE "${table}" ("productId" uuid NOT NULL)`);
      }
      await callback(transaction);
      throw new RollbackTest();
    });
  } catch (error) {
    if (!(error instanceof RollbackTest)) throw error;
  }
}

async function applyMigration(transaction) {
  assert.equal(statements.length, 5);
  for (const statement of statements) await transaction.$executeRawUnsafe(statement);
}

test('backend integrity migration fails safely for existing normalized SKU duplicates', async () => {
  await assert.rejects(withLegacyTables(async (transaction) => {
    await transaction.$executeRaw`INSERT INTO "Product" VALUES (${randomUUID()}::uuid, 'Legacy-SKU', 'QUANTITY'), (${randomUUID()}::uuid, ' legacy-sku ', 'ASSET')`;
    await applyMigration(transaction);
  }), /Resolve case-insensitive duplicate product SKUs/);
});

test('backend integrity migration preserves legacy rows and prevents SKU and tracking-mode conflicts', async () => {
  await withLegacyTables(async (transaction) => {
    const used = randomUUID();
    const unused = randomUUID();
    await transaction.$executeRaw`INSERT INTO "Product" VALUES (${used}::uuid, 'Legacy-SKU', 'QUANTITY'), (${unused}::uuid, NULL, 'ASSET'), (${randomUUID()}::uuid, NULL, 'QUANTITY')`;
    await transaction.$executeRaw`INSERT INTO "InventoryStock" VALUES (${used}::uuid)`;
    await applyMigration(transaction);
    await transaction.$executeRaw`UPDATE "Product" SET "trackingMode" = 'QUANTITY' WHERE "id" = ${unused}::uuid`;
    const rows = await transaction.$queryRaw`SELECT "id", "sku", "trackingMode" FROM "Product" ORDER BY "id"`;
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => row.id === used).sku, 'Legacy-SKU');
    assert.equal(rows.find((row) => row.id === unused).trackingMode, 'QUANTITY');
  });
  await assert.rejects(withLegacyTables(async (transaction) => {
    await transaction.$executeRaw`INSERT INTO "Product" VALUES (${randomUUID()}::uuid, 'Legacy-SKU', 'QUANTITY')`;
    await applyMigration(transaction);
    await transaction.$executeRaw`INSERT INTO "Product" VALUES (${randomUUID()}::uuid, ' legacy-sku ', 'ASSET')`;
  }), (error) => error.code === 'P2010' && error.meta.code === '23505');
  await assert.rejects(withLegacyTables(async (transaction) => {
    const used = randomUUID();
    await transaction.$executeRaw`INSERT INTO "Product" VALUES (${used}::uuid, NULL, 'QUANTITY')`;
    await transaction.$executeRaw`INSERT INTO "InventoryMovement" VALUES (${used}::uuid)`;
    await applyMigration(transaction);
    await transaction.$executeRaw`UPDATE "Product" SET "trackingMode" = 'ASSET' WHERE "id" = ${used}::uuid`;
  }), (error) => error.code === 'P2010' && error.meta.code === '23514');
});

after(async () => { await database.$disconnect(); });
