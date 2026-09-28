import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(new URL('../../../prisma/migrations/0010_remove_locations/migration.sql', import.meta.url), 'utf8');

test('location removal consolidates stock and preserves historical transfer effects', () => {
  assert.match(migration, /SUM\("quantity"\)[\s\S]*GROUP BY "productId"/);
  assert.match(migration, /WHEN "locationId" = "sourceLocationId" THEN 'EXIT'[\s\S]*ELSE 'ENTRY'/);
  assert.match(migration, /"locationId" IS NULL OR "sourceLocationId" IS NULL OR "destinationLocationId" IS NULL/);
  assert.match(migration, /ranked_initials\.position > 1/);
  assert.match(migration, /DROP TABLE "Location"/);
  assert.match(migration, /ALTER TABLE "InventoryMovement" DROP COLUMN "sourceLocationId"/);
  assert.match(migration, /ALTER TABLE "Asset" DROP COLUMN "locationId"/);
  assert.doesNotMatch(migration, /CASCADE/i);
});
