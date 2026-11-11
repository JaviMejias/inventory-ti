import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
const readMigration = (name) => readFileSync(new URL('../../../prisma/migrations/' + name + '/migration.sql', import.meta.url), 'utf8');

test('correction migration adds an empty effective layer over populated pre-correction tables without rewriting inventory or origins', async () => {
  const schema = 'correction_upgrade_' + randomUUID().replaceAll('-', '');
  const source = readMigration('0028_import_group_assignment_corrections');
  assert.ok(source.startsWith('BEGIN;')); assert.ok(source.trim().endsWith('COMMIT;'));
  assert.equal(/^\s*(UPDATE|DELETE|TRUNCATE|DROP TABLE)\b/m.test(source), false);
  const tables = ['User', 'Product', 'Asset', 'Assignment', 'ImportBatch', 'ImportHistoryCapture', 'ImportHistoricalEvidence', 'ImportEvidenceAmendment',
    'ImportIdentityGroupReview', 'ImportIdentityGroupRow', 'ImportIdentityGroupRelease', 'ImportIdentityGroupDecision', 'ImportIdentityGroupApplication',
    'ImportIdentityGroupApplicationItem', 'ImportIdentityGroupRowUse', 'ImportSourceRevision', 'ImportAssignmentApplication', 'ImportAssignmentItem',
    'ImportAssignmentEvidenceUse', 'ImportRetirementApplication', 'ImportGroupHistoryApplication', 'ImportGroupHistoryLink', 'ImportGroupAssignmentApplication',
    'ImportGroupAssignmentItem', 'ImportGroupAssignmentEvidenceUse', 'AuditLog'];
  const functionPattern = /CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE (?:sql|plpgsql)(?: IMMUTABLE)?(?: STRICT)?;/g;
  const statements = source.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE VIEW[\s\S]*?;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE (?:sql|plpgsql)(?: IMMUTABLE)?(?: STRICT)?;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;|DO \$\$[\s\S]*?\$\$;/g);
  assert.ok(statements.length >= 15);
  class RollbackUpgrade extends Error {}
  await assert.rejects(database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    for (const table of tables) {
      await tx.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await tx.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await tx.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '", public');
    await tx.$executeRawUnsafe('CREATE VIEW "ImportHistoricalEvidenceCurrent" AS SELECT * FROM public."ImportHistoricalEvidenceCurrent"');
    for (const definition of readMigration('0027_import_group_assignments').match(functionPattern)) await tx.$executeRawUnsafe(definition);
    const retirement = readMigration('0022_import_verified_retirements').match(functionPattern).find((definition) => definition.startsWith('CREATE FUNCTION guard_import_retirement_application'));
    assert.ok(retirement); await tx.$executeRawUnsafe(retirement);
    const before = await tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "Assignment") AS assignments, (SELECT count(*)::integer FROM "Asset") AS assets,
      (SELECT count(*)::integer FROM "ImportGroupAssignmentEvidenceUse") AS uses, (SELECT count(*)::integer FROM "AuditLog") AS audits`;
    assert.ok(before[0].assignments > 0); assert.ok(before[0].uses > 0);
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    assert.deepEqual(await tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "Assignment") AS assignments, (SELECT count(*)::integer FROM "Asset") AS assets,
      (SELECT count(*)::integer FROM "ImportGroupAssignmentEvidenceUse") AS uses, (SELECT count(*)::integer FROM "AuditLog") AS audits`, before);
    assert.deepEqual(await tx.$queryRaw`SELECT count(*)::integer AS count FROM "ImportGroupAssignmentCorrection"`, [{ count: 0 }]);
    assert.deepEqual(await tx.$queryRaw`SELECT count(*)::integer AS count FROM "AssignmentEffective"`, [{ count: before[0].assignments }]);
    assert.deepEqual(await tx.$queryRaw`SELECT count(*)::integer AS count FROM "Assignment" a JOIN "AssignmentEffective" e USING ("id")
      WHERE a."startedAt" IS DISTINCT FROM e."startedAt" OR a."endedAt" IS DISTINCT FROM e."endedAt" OR a."notes" IS DISTINCT FROM e."notes"`, [{ count: 0 }]);
    throw new RollbackUpgrade();
  }, { timeout: 30000 }), (error) => error instanceof RollbackUpgrade);
  assert.deepEqual(await database.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`, []);
});

after(async () => { await database.$disconnect(); });
