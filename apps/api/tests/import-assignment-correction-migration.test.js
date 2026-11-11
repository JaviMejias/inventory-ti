import './require-test-database.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after,test } from 'node:test';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';

const database=new PrismaClient();
test('legacy correction migration adds empty effective versions over populated originals without rewriting facts',async()=>{
  const source=readFileSync(new URL('../../../prisma/migrations/0032_import_assignment_corrections/migration.sql',import.meta.url),'utf8');
  assert.ok(source.startsWith('BEGIN;'));assert.ok(source.trim().endsWith('COMMIT;'));assert.equal(/^\s*(UPDATE|DELETE|TRUNCATE|DROP TABLE)\b/m.test(source),false);
  const statements=source.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE OR REPLACE VIEW[\s\S]*?;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE (?:sql|plpgsql)(?: IMMUTABLE)?(?: STRICT)?;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
  assert.ok(statements.length>20);const schema='legacy_upgrade_'+randomUUID().replaceAll('-','');class RollbackUpgrade extends Error{}
  const tables=['User','Product','Asset','Assignment','InventoryMovement','InventoryStock','AuditLog','ImportAssignmentApplication','ImportAssignmentItem','ImportAssignmentEvidenceUse','ImportGroupAssignmentItem','ImportGroupAssignmentCorrection',
    'ImportHistoricalEvidence','ImportHistoryCapture','ImportEvidenceAmendment','ImportSourceRevision','ImportRetirementReconciliation','ImportGroupRetirementDocument','ImportIdentityGroupReview','ImportIdentityGroupRow','ImportIdentityGroupRelease','ImportIdentityGroupDecision'];
  const p=await database.product.create({data:{name:'Legacy upgrade fixture '+randomUUID(),trackingMode:'ASSET'}});await database.asset.create({data:{productId:p.id,serialNumber:'UPGRADE-'+randomUUID()}});
  await assert.rejects(database.$transaction(async(tx)=>{
    await tx.$executeRawUnsafe('CREATE SCHEMA "'+schema+'"');
    for(const table of tables){await tx.$executeRawUnsafe('CREATE TABLE "'+schema+'"."'+table+'" (LIKE public."'+table+'" INCLUDING ALL)');await tx.$executeRawUnsafe('INSERT INTO "'+schema+'"."'+table+'" SELECT * FROM public."'+table+'"');}
    await tx.$executeRawUnsafe('SET LOCAL search_path TO "'+schema+'", public');
    const before=await tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "Asset") AS assets,(SELECT count(*)::integer FROM "Assignment") AS assignments,(SELECT count(*)::integer FROM "AuditLog") AS audits`;
    for(const statement of statements)await tx.$executeRawUnsafe(statement);
    assert.deepEqual(await tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "Asset") AS assets,(SELECT count(*)::integer FROM "Assignment") AS assignments,(SELECT count(*)::integer FROM "AuditLog") AS audits`,before);
    assert.deepEqual(await tx.$queryRaw`SELECT count(*)::integer AS count FROM "ImportAssignmentCorrection"`,[{count:0}]);
    assert.deepEqual(await tx.$queryRaw`SELECT count(*)::integer AS count FROM "AssignmentEffective"`,[{count:before[0].assignments}]);throw new RollbackUpgrade();
  },{timeout:30000}),(error)=>error instanceof RollbackUpgrade);
  assert.deepEqual(await database.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname=${schema}`,[]);
});
after(async()=>{await database.$disconnect();});
