import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const migration = readFileSync(new URL('../../../prisma/migrations/0011_correction_final_quantity/migration.sql', import.meta.url), 'utf8');
const statements = migration.split(';').map((statement) => statement.trim()).filter((statement) => statement && statement !== 'BEGIN' && statement !== 'COMMIT');

class RollbackTest extends Error {}

async function withLegacyTables(callback) {
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('CREATE TEMP TABLE "InventoryMovement" ("id" uuid PRIMARY KEY, "movementType" text NOT NULL, "quantity" integer NOT NULL) ON COMMIT DROP');
      await transaction.$executeRawUnsafe('CREATE TEMP TABLE "CorrectionRequest" ("id" uuid PRIMARY KEY, "originalMovementId" uuid NOT NULL, "delta" integer NOT NULL, "status" text NOT NULL, "createdAt" timestamp NOT NULL, "reviewedAt" timestamp) ON COMMIT DROP');
      await callback(transaction);
      throw new RollbackTest();
    });
  } catch (error) {
    if (!(error instanceof RollbackTest)) throw error;
  }
}

async function applyMigration(transaction) {
  for (const statement of statements) await transaction.$executeRawUnsafe(statement);
}

async function insertLegacy(transaction, movementType, quantity, delta, status = 'PENDING') {
  const movementId = randomUUID();
  const correctionId = randomUUID();
  await transaction.$executeRaw`INSERT INTO "InventoryMovement" VALUES (${movementId}::uuid, ${movementType}, ${quantity})`;
  await transaction.$executeRaw`INSERT INTO "CorrectionRequest" VALUES (${correctionId}::uuid, ${movementId}::uuid, ${delta}, ${status}, '2026-01-01'::timestamp, NULL)`;
  return { movementId, correctionId };
}

test('final-quantity migration backfills legacy exits and signed adjustments without changing delta or movement', async () => {
  await withLegacyTables(async (transaction) => {
    const examples = [];
    for (const [type, quantity, delta, expected] of [
      ['EXIT', 5, 1, -4], ['EXIT', -5, 1, -4], ['ENTRY', 10, -3, 7], ['ADJUSTMENT', -3, 1, -2]
    ]) {
      examples.push({ ...await insertLegacy(transaction, type, quantity, delta), quantity, delta, expected });
    }
    await applyMigration(transaction);
    for (const example of examples) {
      const [correction] = await transaction.$queryRaw`SELECT "delta", "correctedQuantity" FROM "CorrectionRequest" WHERE "id" = ${example.correctionId}::uuid`;
      const [movement] = await transaction.$queryRaw`SELECT "quantity" FROM "InventoryMovement" WHERE "id" = ${example.movementId}::uuid`;
      assert.equal(correction.delta, example.delta);
      assert.equal(correction.correctedQuantity, example.expected);
      assert.equal(movement.quantity, example.quantity);
    }
  });
});

test('migration includes earlier approved differences but not rejected corrections', async () => {
  await withLegacyTables(async (transaction) => {
    const { movementId, correctionId } = await insertLegacy(transaction, 'ENTRY', 10, -3, 'APPROVED');
    await transaction.$executeRaw`UPDATE "CorrectionRequest" SET "reviewedAt" = '2026-01-02'::timestamp WHERE "id" = ${correctionId}::uuid`;
    await transaction.$executeRaw`INSERT INTO "CorrectionRequest" VALUES (${randomUUID()}::uuid, ${movementId}::uuid, 100, 'REJECTED', '2026-01-03'::timestamp, '2026-01-04'::timestamp)`;
    const pendingId = randomUUID();
    await transaction.$executeRaw`INSERT INTO "CorrectionRequest" VALUES (${pendingId}::uuid, ${movementId}::uuid, 1, 'PENDING', '2026-01-05'::timestamp, NULL)`;
    await applyMigration(transaction);
    const [pending] = await transaction.$queryRaw`SELECT "correctedQuantity" FROM "CorrectionRequest" WHERE "id" = ${pendingId}::uuid`;
    assert.equal(pending.correctedQuantity, 8);
  });
});

test('PostgreSQL permits processed history but rejects a second pending request', async () => {
  await assert.rejects(withLegacyTables(async (transaction) => {
    const { movementId } = await insertLegacy(transaction, 'ENTRY', 10, -3);
    await applyMigration(transaction);
    await transaction.$executeRaw`INSERT INTO "CorrectionRequest" ("id", "originalMovementId", "delta", "status", "createdAt", "correctedQuantity") VALUES (${randomUUID()}::uuid, ${movementId}::uuid, 1, 'REJECTED', CURRENT_TIMESTAMP, 11)`;
    await transaction.$executeRaw`INSERT INTO "CorrectionRequest" ("id", "originalMovementId", "delta", "status", "createdAt", "correctedQuantity") VALUES (${randomUUID()}::uuid, ${movementId}::uuid, 1, 'APPROVED', CURRENT_TIMESTAMP, 11)`;
    await transaction.$executeRaw`INSERT INTO "CorrectionRequest" ("id", "originalMovementId", "delta", "status", "createdAt", "correctedQuantity") VALUES (${randomUUID()}::uuid, ${movementId}::uuid, 1, 'PENDING', CURRENT_TIMESTAMP, 11)`;
  }), (error) => error.code === 'P2010' && error.meta.code === '23505');
});

test('migration fails rather than inventing a final quantity for an orphaned correction', async () => {
  await assert.rejects(withLegacyTables(async (transaction) => {
    await transaction.$executeRaw`INSERT INTO "CorrectionRequest" VALUES (${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, 'PENDING', CURRENT_TIMESTAMP, NULL)`;
    await applyMigration(transaction);
  }), (error) => error.code === 'P2010' && error.meta.code === '23502');
});

after(async () => { await prisma.$disconnect(); });
