import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { applyImportPilot } from '../src/imports/apply-service.js';
import { pilotApplySchema } from '../src/imports/apply-schemas.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { hashPassword } from '../src/lib/password.js';
import { receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8);
const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: {
  async findMany({ args, query }) {
    return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
  }
} } });
const app = buildApp(database);
const cookies = {};
const users = {};
let product;

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE', 'SECOND_JEFE']) {
    const username = `apply-${role.toLowerCase()}-${suffix}`;
    const password = 'Apply-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Apply ${role}`, passwordHash: hashPassword(password), role: role === 'SECOND_JEFE' ? 'JEFE' : role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(login.statusCode, 200);
    const header = login.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Apply ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});

async function post(url, payload, role = 'JEFE', csrf = true, busyRetries = 6) {
  const cookie = cookies[role];
  const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  for (let attempt = 0; ; attempt++) {
    const response = await app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
    if (!url.endsWith('/apply') || response.statusCode !== 409 || response.json().code !== 'IMPORT_APPLY_BUSY' || attempt >= busyRetries) return response;
    await setTimeout(50);
  }
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }

async function prepare({ count = 1, existing = false, extra = {}, source: providedSource } = {}) {
  const serial = `APPLY-${randomUUID()}`;
  const asset = existing ? await database.asset.create({ data: { productId: product.id, serialNumber: serial, location: 'Old storage' } }) : null;
  const source = providedSource ?? workbook('Recepción', Array.from({ length: count }, (_, index) => receptionRow(index + 4,
    index === 0 ? serial : `APPLY-${randomUUID()}`, { K: textCell('Disponible'), ...extra })));
  const preview = (await post('/inventory/imports/preview', source)).json();
  const saved = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId });
  assert.equal(saved.statusCode, 201, saved.body);
  const batch = saved.json().batch;
  let version = 1;
  const operations = [];
  for (const candidate of preview.candidates) {
    const linked = candidate.existingAssets[0];
    const reviewed = await post(`/inventory/imports/batches/${batch.id}/decisions`, { expectedVersion: version, requestId: randomUUID(),
      targetType: 'CANDIDATE', targetId: candidate.id, action: linked ? 'LINK_EXISTING' : 'PROPOSE_NEW',
      ...(linked ? { linkedAssetId: linked.id } : {}), note: 'Physical identity checked' });
    assert.equal(reviewed.statusCode, 201, reviewed.body);
    version++;
    operations.push(linked
      ? { type: 'UPDATE_METADATA', candidateId: candidate.id, assetId: linked.id, note: 'Location verified', values: { location: 'New storage' } }
      : { type: 'CREATE_ASSET', candidateId: candidate.id, confirmation: 'AVAILABLE_UNASSIGNED', note: 'Identity and availability verified',
        values: { productId: product.id, serialNumber: candidate.serials[0] } });
  }
  const planInput = { expectedVersion: version, operations };
  const planned = await post(`/inventory/imports/batches/${batch.id}/plan`, planInput);
  assert.equal(planned.statusCode, 200, planned.body);
  const plan = planned.json();
  return { batch, preview, asset, source, plan, input: { requestId: randomUUID(), planId: plan.planId, confirmation: 'APPLY_ASSET_PILOT', plan: planInput },
    url: `/inventory/imports/batches/${batch.id}/apply` };
}

test('application DTO requires explicit confirmation, plan digest and retry key', () => {
  const plan = { expectedVersion: 2, operations: [{ type: 'CREATE_ASSET', candidateId: 'a'.repeat(64), confirmation: 'AVAILABLE_UNASSIGNED',
    note: 'Checked', values: { productId: randomUUID(), serialNumber: 'SERIAL-001' } }] };
  const input = { requestId: randomUUID(), planId: 'b'.repeat(64), confirmation: 'APPLY_ASSET_PILOT', plan };
  assert.equal(pilotApplySchema.safeParse(input).success, true);
  for (const invalid of [{ ...input, confirmation: true }, { ...input, planId: 'x' }, { ...input, requestId: null }, { ...input, force: true },
    { ...input, plan: { ...plan, operations: [] } }]) assert.equal(pilotApplySchema.safeParse(invalid).success, false);
});

test('application and receipts require JEFE and CSRF for writes', async () => {
  const { input, url, batch } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) {
    assert.equal((await post(url, input, role)).statusCode, 403);
    assert.equal((await get(`/inventory/imports/batches/${batch.id}/applications`, role)).statusCode, 403);
    assert.equal((await get(`/inventory/imports/batches/${batch.id}/applications/${randomUUID()}`, role)).statusCode, 403);
  }
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url, { ...input, force: true })).statusCode, 400);
  assert.equal((await post(`/inventory/imports/batches/${randomUUID()}/apply`, input)).statusCode, 404);
});

test('pilot creates assets atomically with immutable provenance, audit and recoverable receipts', async () => {
  const { input, url, plan, batch } = await prepare({ count: 2 });
  const assetCount = await database.asset.count({ where: { productId: product.id } });
  const response = await post(url, input);
  assert.equal(response.statusCode, 201, response.body);
  const result = response.json();
  assert.equal(result.mode, 'APPLIED');
  assert.equal(result.reused, false);
  assert.equal(result.application.items.length, 2);
  const parsed = pilotApplySchema.parse(input);
  const legacyPlan = { expectedVersion: parsed.plan.expectedVersion, operations: [...parsed.plan.operations]
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId)).map((operation) => ({ ...operation, acknowledgedWarnings: [...operation.acknowledgedWarnings].sort() })) };
  assert.equal(result.application.requestDigest, importPlanDigest({ ...parsed, plan: legacyPlan }));
  assert.deepEqual(result.application.plan, plan);
  assert.equal(await database.asset.count({ where: { productId: product.id } }), assetCount + 2);
  for (const item of result.application.items) {
    assert.equal(item.result.status, 'AVAILABLE');
    assert.equal(item.result.isActive, true);
    assert.equal(item.operation.source[0].sheet, 'Recepción');
    assert.equal(item.sourceHash, batch.sourceHash);
    assert.equal(await database.auditLog.count({ where: { action: 'ASSET_CREATED', entityId: item.assetId } }), 1);
  }
  assert.equal(await database.auditLog.count({ where: { action: 'IMPORT_PILOT_APPLIED', entityId: result.application.id } }), 1);
  assert.equal(await database.assignment.count({ where: { asset: { productId: product.id } } }), 0);
  assert.equal(await database.inventoryStock.count({ where: { productId: product.id } }), 0);
  assert.equal(await database.inventoryMovement.count({ where: { productId: product.id } }), 0);
  assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).version, input.plan.expectedVersion);
  const detail = await get(`/inventory/imports/batches/${batch.id}/applications/${result.application.id}`);
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().application, result.application);
  const page = (await get(`/inventory/imports/batches/${batch.id}/applications?limit=1`)).json();
  assert.equal(page.total, 1);
  assert.equal(page.applications[0].plan, undefined);
  assert.equal(page.applications[0].items, undefined);
  assert.equal((await get(`/inventory/imports/batches/${randomUUID()}/applications/${result.application.id}`)).statusCode, 404);
  assert.equal((await get(`/inventory/imports/batches/${batch.id}/applications?limit=101`)).statusCode, 400);
  await assert.rejects(database.importApplication.update({ where: { id: result.application.id }, data: { planId: 'c'.repeat(64) } }));
  await assert.rejects(database.importApplication.delete({ where: { id: result.application.id } }));
  await assert.rejects(database.importApplicationItem.update({ where: { id: result.application.items[0].id }, data: { result: {} } }));
  await assert.rejects(database.importApplicationItem.delete({ where: { id: result.application.items[0].id } }));
});

test('simultaneous identical retries return one receipt and another request cannot apply the same target', async () => {
  const { input, url, batch } = await prepare();
  const responses = await Promise.all([post(url, input), post(url, input)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]);
  assert.equal(responses[0].json().application.id, responses[1].json().application.id);
  assert.equal(await database.importApplication.count({ where: { batchId: batch.id } }), 1);
  assert.equal((await post(url, { ...input, requestId: randomUUID() })).json().code, 'IMPORT_TARGET_ALREADY_APPLIED');
  const changed = { ...input, plan: { ...input.plan, operations: [{ ...input.plan.operations[0], note: 'Different intent' }] } };
  assert.equal((await post(url, changed)).json().code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await post(url, input, 'SECOND_JEFE')).json().code, 'IDEMPOTENCY_KEY_REUSED');
});

test('metadata pilot preserves state and identity; retries return the original result after later edits', async () => {
  const { input, url, asset, batch } = await prepare({ existing: true });
  const before = await database.asset.findUniqueOrThrow({ where: { id: asset.id } });
  const applied = await post(url, input);
  assert.equal(applied.statusCode, 201, applied.body);
  const current = await database.asset.findUniqueOrThrow({ where: { id: asset.id } });
  assert.equal(current.location, 'New storage');
  for (const field of ['serialNumber', 'assetTag', 'status', 'productId', 'isActive']) assert.equal(current[field], before[field]);
  const event = await database.auditLog.findFirst({ where: { action: 'ASSET_UPDATED', entityId: asset.id } });
  assert.equal(event.metadata.before.location, 'Old storage');
  assert.equal(event.metadata.after.location, 'New storage');
  await database.asset.update({ where: { id: asset.id }, data: { location: 'Edited later' } });
  await post(`/inventory/imports/batches/${batch.id}/decisions`, { expectedVersion: input.plan.expectedVersion, requestId: randomUUID(),
    targetType: 'CANDIDATE', targetId: input.plan.operations[0].candidateId, action: 'HOLD', note: 'Later review' });
  const replay = await post(url, input);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().application, applied.json().application);
  assert.equal((await database.asset.findUniqueOrThrow({ where: { id: asset.id } })).location, 'Edited later');
});

test('recreating a batch for the same source cannot reapply its already recorded candidate', async () => {
  const first = await prepare();
  assert.equal((await post(first.url, first.input)).statusCode, 201);
  const second = await prepare({ source: first.source });
  assert.notEqual(second.batch.id, first.batch.id);
  const response = await post(second.url, second.input);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'IMPORT_TARGET_ALREADY_APPLIED');
  assert.equal(response.json().details.batchId, first.batch.id);
  assert.equal(await database.importApplication.count({ where: { batchId: second.batch.id } }), 0);
});

test('changed plans, stale review versions and blocked source evidence perform no writes', async () => {
  const prepared = await prepare();
  const response = await post(prepared.url, { ...prepared.input, planId: 'f'.repeat(64) });
  assert.equal(response.json().code, 'IMPORT_PLAN_CHANGED');
  await database.product.update({ where: { id: product.id }, data: { isActive: false } });
  try { assert.equal((await post(prepared.url, prepared.input)).json().code, 'IMPORT_PLAN_CHANGED'); }
  finally { await database.product.update({ where: { id: product.id }, data: { isActive: true } }); }
  await post(`/inventory/imports/batches/${prepared.batch.id}/decisions`, { expectedVersion: prepared.input.plan.expectedVersion, requestId: randomUUID(),
    targetType: 'CANDIDATE', targetId: prepared.input.plan.operations[0].candidateId, action: 'EXCLUDE', note: 'Excluded after planning' });
  assert.equal((await post(prepared.url, prepared.input)).json().code, 'REVIEW_VERSION_CONFLICT');
  assert.equal(await database.importApplication.count({ where: { batchId: prepared.batch.id } }), 0);
  const blocked = await prepare({ extra: { A: textCell('2055-01-01') } });
  assert.equal(blocked.plan.planValidationComplete, false);
  const invalid = await post(blocked.url, blocked.input);
  assert.equal(invalid.statusCode, 409, invalid.body);
  assert.equal(invalid.json().code, 'IMPORT_PLAN_BLOCKED');
  assert.equal(await database.importApplication.count({ where: { batchId: blocked.batch.id } }), 0);
});

test('simultaneous applications from different batches cannot duplicate a source candidate', async () => {
  const first = await prepare();
  const otherSource = JSON.parse(JSON.stringify(first.source));
  otherSource.sheets[0].rows[1].cells.L = textCell('Additional observation for review');
  const second = await prepare({ source: otherSource });
  const responses = await Promise.all([post(first.url, first.input), post(second.url, second.input)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'IMPORT_TARGET_ALREADY_APPLIED');
  assert.equal(await database.asset.count({ where: { productId: product.id, serialNumber: first.input.plan.operations[0].values.serialNumber } }), 1);
});

test('the database refuses incomplete receipts and mismatched source provenance', async () => {
  const { batch, plan, input } = await prepare();
  const data = { batchId: batch.id, batchVersion: input.plan.expectedVersion, requestId: randomUUID(), requestDigest: 'a'.repeat(64),
    planId: plan.planId, sourceHash: batch.sourceHash, plan, appliedById: users.JEFE.id };
  await assert.rejects(database.importApplication.create({ data }));
  await assert.rejects(database.importApplication.create({ data: { ...data, sourceHash: 'f'.repeat(64) } }));
  await assert.rejects(database.importApplication.create({ data: { ...data, plan: {} } }));
  assert.equal(await database.importApplication.count({ where: { batchId: batch.id } }), 0);
});

test('audit failure rolls back all assets, receipt items and application, allowing a safe retry', async () => {
  const { input, batch } = await prepare({ count: 2 });
  const before = await database.asset.count({ where: { productId: product.id } });
  const failing = database.$extends({ query: { auditLog: {
    async create({ args, query }) {
      if (args.data.action === 'IMPORT_PILOT_APPLIED') throw new Error('Injected final audit failure');
      return query(args);
    }
  } } });
  await assert.rejects(applyImportPilot(failing, batch.id, pilotApplySchema.parse(input), users.JEFE.id), /Injected final audit failure/);
  assert.equal(await database.asset.count({ where: { productId: product.id } }), before);
  assert.equal(await database.importApplication.count({ where: { batchId: batch.id } }), 0);
  assert.equal(await database.importApplicationItem.count({ where: { candidateId: { in: input.plan.operations.map((operation) => operation.candidateId) } } }), 0);
  for (const operation of input.plan.operations) {
    assert.equal(await database.asset.count({ where: { productId: product.id, serialNumber: operation.values.serialNumber } }), 0);
  }
  const recovered = await applyImportPilot(database, batch.id, pilotApplySchema.parse(input), users.JEFE.id);
  assert.equal(recovered.reused, false);
  assert.equal(recovered.application.items.length, 2);
});

test('busy inventory has bounded lock waits and leaves no partial application', async () => {
  const { input, url, batch } = await prepare();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const holder = database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${product.id}::uuid FOR UPDATE`;
    entered();
    await gate;
  }, { timeout: 10000 });
  await started;
  try {
    const response = await post(url, input, 'JEFE', true, 0);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'IMPORT_APPLY_BUSY');
    assert.equal(await database.importApplication.count({ where: { batchId: batch.id } }), 0);
  } finally { release(); await holder; }
  assert.equal((await post(url, input)).statusCode, 201);
});

test('application migration adds empty tables while preserving populated review and operational records', async () => {
  const migration = readFileSync(new URL('../../../prisma/migrations/0016_import_pilot_application/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `apply_migration_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      for (const name of ['User', 'Asset']) await transaction.$executeRawUnsafe(`CREATE TABLE "${name}" ("id" UUID PRIMARY KEY, "legacy" TEXT NOT NULL)`);
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportBatch" ("id" UUID PRIMARY KEY, "version" INTEGER NOT NULL, "sourceHash" TEXT NOT NULL)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportReviewDecision" ("id" UUID PRIMARY KEY, "batchId" UUID, "targetType" TEXT, "targetId" TEXT, "batchVersion" INTEGER, "action" TEXT, "linkedAssetId" UUID)');
      for (const name of ['User', 'Asset']) await transaction.$executeRawUnsafe(`INSERT INTO "${name}" VALUES ('${randomUUID()}', 'Preserved legacy record')`);
      await transaction.$executeRaw`INSERT INTO "ImportBatch" VALUES (${randomUUID()}::uuid, 5, ${'a'.repeat(64)})`;
      const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
      assert.equal(statements.length, 14);
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
      for (const name of ['User', 'Asset', 'ImportBatch']) {
        const [count] = await transaction.$queryRawUnsafe(`SELECT count(*)::integer AS count FROM "${name}"`);
        assert.equal(count.count, 1);
      }
      const [empty] = await transaction.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportApplication") AS applications, (SELECT count(*)::integer FROM "ImportApplicationItem") AS items`;
      assert.deepEqual(empty, { applications: 0, items: 0 });
      throw new RollbackTest();
    }, { timeout: 15000 });
  } catch (error) { if (!(error instanceof RollbackTest)) throw error; }
});

test('an Asset-first FK writer can finish while the pilot backs off instead of causing a deadlock', async () => {
  const { input, url, batch } = await prepare();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const writer = database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('LOCK TABLE "Asset" IN ROW EXCLUSIVE MODE');
    entered();
    await gate;
    return transaction.asset.create({ data: { productId: product.id, serialNumber: `CONCURRENT-FK-${randomUUID()}` } });
  }, { timeout: 10000 });
  await started;
  const applying = post(url, input);
  await setTimeout(40);
  release();
  const created = await writer;
  const response = await applying;
  assert.equal(response.statusCode, 409, response.body);
  assert.ok(['IMPORT_PLAN_CHANGED', 'IMPORT_APPLY_BUSY'].includes(response.json().code));
  assert.equal((await database.asset.findUniqueOrThrow({ where: { id: created.id } })).serialNumber, created.serialNumber);
  assert.equal(await database.importApplication.count({ where: { batchId: batch.id } }), 0);
});

after(async () => { await app.close(); });
