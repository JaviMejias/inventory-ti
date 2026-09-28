import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';

const migration = readFileSync(new URL('../../../prisma/migrations/0005_correction_delta/migration.sql', import.meta.url), 'utf8');

test('0005 validates historical correction rows before making delta required', () => {
  assert.match(migration, /status.*IS DISTINCT FROM.*APPROVED/s);
  assert.match(migration, /compensatingMovementId.*IS NULL/s);
  assert.match(migration, /compensating.*movementType.*IS DISTINCT FROM.*ADJUSTMENT/s);
  assert.match(migration, /compensating.*quantity.*= 0/s);
  assert.match(migration, /original.*id.*IS NULL/s);
  assert.match(migration, /compensating.*productId.*IS DISTINCT FROM original.*productId/s);
  assert.match(migration, /compensating.*locationId.*IS DISTINCT FROM original.*locationId/s);
  assert.match(migration, /compensating.*reference.*IS DISTINCT FROM.*correction:/s);
  assert.match(migration, /GROUP BY correction\."originalMovementId"\s+HAVING COUNT\(\*\) > 1/s);
  assert.match(migration, /SET "delta" = compensating\."quantity"/);
  assert.doesNotMatch(migration, /SET "delta"\s*=\s*original\."quantity"/);
});
