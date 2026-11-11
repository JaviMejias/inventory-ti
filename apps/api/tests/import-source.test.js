import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { appendSourceRevision } from '../src/imports/source-service.js';
import { sourceRevisionSchema } from '../src/imports/source-schemas.js';
import { prepareSourceChanges, sourceRequestDigest } from '../src/imports/source.js';
import { hashPassword } from '../src/lib/password.js';
import { receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8);
const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: {
  async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } }); }
} } });
const app = buildApp(database);
const cookies = {};
const users = {};
let product;

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `source-${role.toLowerCase()}-${suffix}`;
    const password = 'Source-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Source ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Source product ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: `Brand ${suffix}`, model: `Model G9 ${suffix}` } });
  productIds.push(product.id);
});

async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role];
  const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  for (let attempt = 0; ; attempt++) {
    const response = await app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
    if (!url.endsWith('/apply') || response.statusCode !== 409 || response.json().code !== 'IMPORT_APPLY_BUSY' || attempt >= 6) return response;
    await setTimeout(50);
  }
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }

async function prepare(conflict = true, extra = {}, missingColumn) {
  const serial = `SOURCE-${randomUUID()}`;
  const rows = [receptionRow(4, serial, { A: textCell(conflict ? '2055-01-01' : '2001-01-01'), D: textCell(product.brand), E: textCell(product.model), K: textCell('Disponible'), ...extra }),
    ...(conflict ? [receptionRow(5, serial, { D: textCell(product.brand), E: textCell(`Model G10 ${suffix}`), K: textCell('Disponible') })] : [])];
  if (missingColumn) delete rows[0].cells[missingColumn];
  const source = workbook('Recepción', rows);
  const preview = (await post('/inventory/imports/preview', source)).json();
  const saved = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId });
  assert.equal(saved.statusCode, 201, saved.body);
  const batch = saved.json().batch;
  const candidate = preview.candidates[0];
  const reviewed = await post(`/inventory/imports/batches/${batch.id}/decisions`, { expectedVersion: 1, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: candidate.id, action: 'PROPOSE_NEW', note: 'Physical identity checked' });
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  const input = { expectedRevision: 0, expectedBatchVersion: 2, requestId: randomUUID(), note: 'Checked catalog and receiving evidence', evidenceReference: 'Receiving document R-001',
    changes: [{ recordId: preview.records.find((record) => record.row === 4).id, field: 'receivedDate', action: 'REPLACE', value: '2002-01-01' },
      ...(conflict ? [{ recordId: preview.records.find((record) => record.row === 5).id, field: 'model', action: 'REPLACE', value: product.model }] : [])] };
  const planInput = { expectedVersion: 2, operations: [{ type: 'CREATE_ASSET', candidateId: candidate.id, note: 'Physical availability confirmed',
    confirmation: 'AVAILABLE_UNASSIGNED', values: { productId: product.id, serialNumber: serial } }] };
  return { batch, source, preview, candidate, input, planInput, url: `/inventory/imports/batches/${batch.id}/source-revisions`, base: `/inventory/imports/batches/${batch.id}` };
}

test('source correction and catalog routes require JEFE and CSRF without arbitrary field writes', async () => {
  const { input, url, base } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) {
    assert.equal((await post(url, input, role)).statusCode, 403);
    for (const path of ['/source-revisions', '/resolved-preview', '/catalog-review']) assert.equal((await get(base + path, role)).statusCode, 403);
  }
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url, { ...input, changes: [{ ...input.changes[0], field: 'serialNumber' }] })).statusCode, 400);
  assert.equal((await post(`/inventory/imports/batches/${randomUUID()}/source-revisions`, input)).statusCode, 404);
});

test('source revisions preserve original workbook/snapshot and resolve only the chosen catalog/date evidence', async () => {
  const { input, url, base, batch, preview } = await prepare();
  const original = await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
  const count = await database.asset.count({ where: { productId: product.id } });
  const saved = await post(url, input);
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().event.revision, 1);
  assert.equal(saved.json().canApply, false);
  const effective = (await get(base + '/resolved-preview')).json();
  assert.equal(effective.sourceContext.revision, 1);
  assert.equal(effective.sourceContext.corrections.length, 2);
  assert.equal(effective.preview.issues.some((issue) => ['PRODUCT_MODEL_CONFLICT', 'FUTURE_SOURCE_DATE'].includes(issue.code)), false);
  assert.notEqual(effective.effectivePayloadDigest, effective.originalPayloadDigest);
  assert.deepEqual((await get(base + '/preview')).json().snapshot, preview);
  const after = await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
  assert.deepEqual(after, original);
  assert.equal(await database.asset.count({ where: { productId: product.id } }), count);
  assert.equal(await database.auditLog.count({ where: { entityId: batch.id, action: 'IMPORT_SOURCE_CORRECTED' } }), 1);
  await assert.rejects(database.importSourceRevision.update({ where: { id: saved.json().event.id }, data: { note: 'Changed history' } }));
  await assert.rejects(database.importSourceRevision.delete({ where: { id: saved.json().event.id } }));
});

test('correction idempotence binds intent/author and simultaneous writers cannot overwrite revisions', async () => {
  const { input, url, batch } = await prepare();
  const responses = await Promise.all([post(url, input), post(url, { ...input, requestId: randomUUID() })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'SOURCE_REVISION_CONFLICT');
  const winningId = responses.find((response) => response.statusCode === 201).json().event.requestId;
  const retry = await post(url, { ...input, requestId: winningId, changes: input.changes.toReversed() });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().reused, true);
  assert.equal((await post(url, { ...input, requestId: winningId, note: 'Other intent' })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(appendSourceRevision(database, batch.id, sourceRevisionSchema.parse({ ...input, requestId: winningId }), users.COORDINADOR.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await database.importSourceRevision.count({ where: { batchId: batch.id } }), 1);
});

test('restore is a new event, restores original blockers and offers real history pagination', async () => {
  const { input, url, base } = await prepare();
  assert.equal((await post(url, input)).statusCode, 201);
  const restored = await post(url, { ...input, expectedRevision: 1, requestId: randomUUID(), changes: input.changes.map(({ recordId, field }) => ({ recordId, field, action: 'RESTORE' })) });
  assert.equal(restored.statusCode, 201, restored.body);
  const effective = (await get(base + '/resolved-preview')).json();
  assert.equal(effective.sourceContext.revision, 2);
  assert.equal(effective.sourceContext.corrections.length, 0);
  assert.ok(effective.preview.issues.some((issue) => issue.code === 'PRODUCT_MODEL_CONFLICT'));
  const page = (await get(url + '?limit=1')).json();
  assert.equal(page.revision, 2);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.events[0].revision, 2);
  assert.equal((await get(url + '?limit=1&offset=1')).json().events[0].revision, 1);
  assert.equal((await post(url, input)).statusCode, 200);
});

test('corrected source is version-bound in planning/application and retained in immutable receipts', async () => {
  const { input, url, base, planInput, batch } = await prepare();
  const old = (await post(base + '/plan', planInput)).json();
  assert.equal(old.planValidationComplete, false);
  assert.equal((await post(url, input)).statusCode, 201);
  assert.equal((await post(base + '/plan', planInput)).json().code, 'SOURCE_REVISION_CONFLICT');
  const correctedInput = { ...planInput, expectedSourceRevision: 1 };
  const planResponse = await post(base + '/plan', correctedInput);
  assert.equal(planResponse.statusCode, 200, planResponse.body);
  const plan = planResponse.json();
  assert.equal(plan.planValidationComplete, true);
  assert.equal(plan.sourceRevision, 1);
  assert.equal(plan.operations[0].sourceCorrections.length, 2);
  const applied = await post(base + '/apply', { requestId: randomUUID(), planId: plan.planId, confirmation: 'APPLY_ASSET_PILOT', plan: correctedInput });
  assert.equal(applied.statusCode, 201, applied.body);
  assert.equal(applied.json().application.items[0].operation.sourceCorrections[0].evidenceReference, input.evidenceReference);
  assert.equal(applied.json().application.plan.sourceRevision, 1);
  const blocked = await post(url, { ...input, expectedRevision: 1, requestId: randomUUID(), changes: [{ ...input.changes[0], value: '2003-01-01' }] });
  assert.equal(blocked.json().code, 'SOURCE_TARGET_ALREADY_APPLIED');
  assert.equal(await database.importSourceRevision.count({ where: { batchId: batch.id } }), 1);
});

test('a correction after planning invalidates that plan; other independent blockers are never waived', async () => {
  const clean = await prepare(false);
  const old = (await post(clean.base + '/plan', clean.planInput)).json();
  assert.equal(old.planValidationComplete, true);
  assert.equal((await post(clean.url, clean.input)).statusCode, 201);
  const outdated = await post(clean.base + '/apply', { requestId: randomUUID(), planId: old.planId, confirmation: 'APPLY_ASSET_PILOT', plan: clean.planInput });
  assert.equal(outdated.json().code, 'SOURCE_REVISION_CONFLICT');
  const independent = await prepare(true, { Q: textCell('Unmapped value') });
  assert.equal((await post(independent.url, independent.input)).statusCode, 201);
  const plan = (await post(independent.base + '/plan', { ...independent.planInput, expectedSourceRevision: 1 })).json();
  assert.equal(plan.planValidationComplete, false);
  assert.ok(plan.operations[0].blockers.some((issue) => issue.code === 'UNMAPPED_COLUMN'));
});

test('catalog review suggests only compatible active ASSET products and never chooses or creates one', async () => {
  const { input, url, base } = await prepare();
  const initial = (await get(base + '/catalog-review')).json();
  assert.equal(initial.candidates[0].conflict, true);
  assert.deepEqual(initial.candidates[0].suggestedProducts, []);
  assert.equal((await post(url, input)).statusCode, 201);
  await database.product.create({ data: { name: `Inactive source ${suffix}`, trackingMode: 'ASSET', isActive: false, equipmentType: product.equipmentType, brand: product.brand, model: product.model } });
  await database.product.create({ data: { name: `Quantity source ${suffix}`, trackingMode: 'QUANTITY', equipmentType: product.equipmentType, brand: product.brand, model: product.model } });
  const before = await database.product.count({ where: { brand: product.brand } });
  const response = await get(base + '/catalog-review?limit=1');
  assert.equal(response.statusCode, 200, response.body);
  const catalog = response.json();
  assert.equal(catalog.sourceRevision, 1);
  assert.equal(catalog.total, 1);
  assert.equal(catalog.canApply, false);
  assert.equal(catalog.candidates[0].requiresExplicitChoice, true);
  assert.deepEqual(catalog.candidates[0].suggestedProducts.map((entry) => entry.id), [product.id]);
  assert.equal(await database.product.count({ where: { brand: product.brand } }), before);
  assert.equal((await get(base + '/catalog-review?limit=101')).statusCode, 400);
});

test('invalid targets/dates/versions and source limits reject changes without persisting unusable revisions', async () => {
  const { input, url, base, batch } = await prepare();
  assert.equal((await post(url, { ...input, expectedBatchVersion: 1 })).json().code, 'REVIEW_VERSION_CONFLICT');
  assert.equal((await post(url, { ...input, changes: [{ ...input.changes[0], recordId: 'f'.repeat(64) }] })).json().code, 'INVALID_SOURCE_TARGET');
  assert.equal((await post(url, { ...input, changes: [{ ...input.changes[0], value: '2055-01-01' }] })).json().code, 'FUTURE_SOURCE_CORRECTION');
  assert.equal(await database.importSourceRevision.count({ where: { batchId: batch.id } }), 0);
  const extra = Object.fromEntries(Array.from({ length: 64 }, (_, index) => {
    const column = index < 26 ? String.fromCharCode(65 + index) : String.fromCharCode(64 + Math.floor(index / 26)) + String.fromCharCode(65 + index % 26);
    return [column, textCell('x')];
  }));
  delete extra.D;
  extra.BM = textCell('x');
  const limit = await prepare(false, extra, 'D');
  const overflow = await post(limit.url, { ...limit.input, changes: [{ recordId: limit.preview.records[0].id, field: 'brand', action: 'REPLACE', value: product.brand }] });
  assert.equal(overflow.json().code, 'SOURCE_CORRECTION_LIMIT');
  assert.equal((await get(base + '/source-revisions')).json().total, 0);
});

test('audit failure rolls back the source event and preserves safe retry behavior', async () => {
  const { input, url, batch } = await prepare();
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_SOURCE_CORRECTED') throw new Error('Injected source audit failure');
    return query(args);
  } } } });
  await assert.rejects(appendSourceRevision(failing, batch.id, sourceRevisionSchema.parse(input), users.JEFE.id), /Injected source audit failure/);
  assert.equal(await database.importSourceRevision.count({ where: { batchId: batch.id } }), 0);
  assert.equal((await post(url, input)).statusCode, 201);
});

test('database guards reject forged originals, broken value chains, unsupported fields and revision gaps', async () => {
  const { input, url, batch, source } = await prepare();
  const parsed = sourceRevisionSchema.parse(input);
  const changes = prepareSourceChanges(source, source, parsed);
  const data = { batchId: batch.id, revision: 1, expectedBatchVersion: 2, requestId: randomUUID(), requestDigest: sourceRequestDigest(parsed),
    note: input.note, evidenceReference: input.evidenceReference, changes, reviewedById: users.JEFE.id };
  for (const override of [
    { revision: 2 }, { changes: [{ ...changes[0], field: 'serialNumber' }] },
    { changes: [{ ...changes[0], originalCell: textCell('Forged original') }] },
    { changes: [{ ...changes[0], beforeCell: null }] },
    { changes: [{ ...changes[0], action: 'RESTORE' }] }
  ]) await assert.rejects(database.importSourceRevision.create({ data: { ...data, ...override } }));
  assert.equal(await database.importSourceRevision.count({ where: { batchId: batch.id } }), 0);
  assert.equal((await post(url, input)).statusCode, 201);
});

test('source revision migration is additive on populated staging and operational tables', async () => {
  const migration = readFileSync(new URL('../../../prisma/migrations/0017_import_source_revisions/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `source_migration_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await transaction.$executeRawUnsafe('CREATE TABLE "User" ("id" UUID PRIMARY KEY)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportBatch" ("id" UUID PRIMARY KEY, "version" INTEGER, "sourceHash" TEXT, "preview" JSONB)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportApplicationItem" ("sourceHash" TEXT, "candidateId" TEXT)');
      await transaction.$executeRawUnsafe('CREATE TABLE "Asset" ("id" UUID PRIMARY KEY, "status" TEXT)');
      const assetId = randomUUID();
      await transaction.$executeRaw`INSERT INTO "Asset" VALUES (${assetId}::uuid, 'DECOMMISSIONED')`;
      await transaction.$executeRaw`INSERT INTO "ImportBatch" VALUES (${randomUUID()}::uuid, 4, ${'a'.repeat(64)}, ${'{}'}::jsonb)`;
      const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE TRIGGER[^;]+;/g);
      assert.equal(statements.length, 5);
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
      assert.deepEqual(await transaction.$queryRaw`SELECT * FROM "Asset"`, [{ id: assetId, status: 'DECOMMISSIONED' }]);
      const [counts] = await transaction.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportBatch") AS batches, (SELECT count(*)::integer FROM "ImportSourceRevision") AS revisions`;
      assert.deepEqual(counts, { batches: 1, revisions: 0 });
      throw new RollbackTest();
    }, { timeout: 15000 });
  } catch (error) { if (!(error instanceof RollbackTest)) throw error; }
});

after(async () => { await app.close(); });
