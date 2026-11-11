import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { closedAssignmentApplySchema } from '../src/imports/assignment-apply-schemas.js';
import { applyClosedAssignments } from '../src/imports/assignment-apply-service.js';
import { hashPassword } from '../src/lib/password.js';
import { closedAssignmentFixture } from './fixtures/closed-assignment-import.js';

const suffix = randomUUID().slice(0, 8);
const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: {
  async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } }); }
} } });
const app = buildApp(database); const users = {}; const cookies = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `closed-${role.toLowerCase()}-${suffix}`; const password = 'Closed-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Closed ${role}`, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(login.statusCode, 200); const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Closed product ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role]; const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function prepare(options = {}) { return closedAssignmentFixture({ database, product, actorId: users.JEFE.id, post, get, ...options }); }
async function storageCounts(assetId) {
  return Promise.all([database.importAssignmentApplication.count({ where: { assetId } }), database.importAssignmentItem.count({ where: { application: { assetId } } }),
    database.assignment.count({ where: { assetId, importedHistory: true } }), database.importAssignmentEvidenceUse.count({ where: { item: { application: { assetId } } } })]);
}

test('closed history application and receipts enforce JEFE, CSRF and the separate strict confirmation', async () => {
  const { url, input, receiptUrl, asset } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) { assert.equal((await post(url, input, role)).statusCode, 403); assert.equal((await get(receiptUrl, role)).statusCode, 403); }
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url, { ...input, confirmation: 'VERIFIED_CLOSED_ASSIGNMENT' })).statusCode, 400);
  assert.equal((await post(url, { ...input, importedHistory: true })).statusCode, 400);
  assert.equal((await post(`/assets/${asset.id}/assignments`, { personName: 'Ordinary recipient', importedHistory: true })).statusCode, 400);
  assert.deepEqual(await storageCounts(asset.id), [0, 0, 0, 0]);
});

test('closed periods, receipts, endpoint ownership and audits persist atomically without changing assets, source or quantities', async () => {
  const { asset, input, batch, capture, receiptUrl } = await prepare({ count: 2 });
  const batchBefore = await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
  const sourceBefore = await database.importHistoryCapture.findUniqueOrThrow({ where: { id: capture.id }, include: { items: { orderBy: { id: 'asc' } } } });
  const result = await applyClosedAssignments(database, asset.id, closedAssignmentApplySchema.parse(input), users.JEFE.id);
  assert.equal(result.reused, false); assert.equal(result.affectsCurrentState, false); assert.equal(result.persisted, true);
  const application = result.application; assert.equal(application.items.length, 2); assert.equal(application.appliedById, users.JEFE.id);
  assert.deepEqual(await storageCounts(asset.id), [1, 2, 2, 4]);
  for (const item of application.items) {
    assert.equal(item.assignment.importedHistory, true); assert.equal(item.assignment.createdById, null); assert.equal(item.assignment.endedById, null);
    assert.equal(item.assignment.personId, null); assert.equal(item.assignment.returnStatus, 'UNDER_REVIEW');
    assert.deepEqual(item.assignment.createdAt, application.appliedAt); assert.deepEqual(item.assignment.returnRecordedAt, application.appliedAt);
    assert.equal(await database.auditLog.count({ where: { entityId: item.assignmentId, action: 'IMPORT_CLOSED_ASSIGNMENT_ADDED' } }), 1);
  }
  assert.equal(await database.auditLog.count({ where: { entityId: application.id, action: 'IMPORT_CLOSED_ASSIGNMENTS_APPLIED' } }), 1);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
  assert.deepEqual(await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }), batchBefore);
  assert.deepEqual(await database.importHistoryCapture.findUniqueOrThrow({ where: { id: capture.id }, include: { items: { orderBy: { id: 'asc' } } } }), sourceBefore);
  assert.equal(await database.inventoryMovement.count({ where: { assetId: asset.id } }), 0);
  const read = await get(receiptUrl + '/' + application.id); assert.equal(read.statusCode, 200); assert.equal(read.json().application.items.length, 2);
});

test('imported history reads expose unknown actors and the actual capturer, preserving a newer active assignment and its normal return', async () => {
  const { asset, input, url } = await prepare({ active: true });
  const current = await database.assignment.findFirstOrThrow({ where: { assetId: asset.id, endedAt: null } });
  const applied = await post(url, input); assert.equal(applied.statusCode, 201, applied.body); const application = applied.json().application;
  const listed = (await get(`/assets/${asset.id}/assignments`)).json(); assert.equal(listed.currentAssignment.id, current.id);
  const imported = listed.assignments.find((assignment) => assignment.importedHistory);
  assert.equal(imported.createdBy, null); assert.equal(imported.endedBy, null); assert.equal(imported.importHistory.application.appliedById, users.JEFE.id);
  const events = (await get(`/assets/${asset.id}/history`)).json().events.filter((event) => event.source === 'IMPORTED_HISTORY');
  assert.equal(events.length, 2); assert.equal(events.every((event) => event.actor === null && event.recordedById === users.JEFE.id && event.importApplicationId === application.id), true);
  assert.equal(events.every((event) => event.recordedAt === application.appliedAt), true);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
  assert.deepEqual(await database.assignment.findUniqueOrThrow({ where: { id: current.id } }), current);
  const returned = await post(`/assets/${asset.id}/assignments/${current.id}/return`, {}); assert.equal(returned.statusCode, 200, returned.body);
  assert.equal(returned.json().assignment.endedById, users.JEFE.id); assert.equal(returned.json().asset.status, 'AVAILABLE');
});

test('historical import never reactivates a terminal asset or reapplies its historical return condition', async () => {
  const { asset, input, url } = await prepare({ retired: true });
  const response = await post(url, input); assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().application.items[0].assignment.returnStatus, 'UNDER_REVIEW');
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
  assert.equal((await get(`/assets/${asset.id}/assignments`)).json().currentAssignment, null);
});

test('identical concurrent requests create one receipt, recover after later state changes and bind intention and actor', async () => {
  const { asset, input, url } = await prepare({ count: 2 });
  const responses = await Promise.all([post(url, input), post(url, input)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]);
  const applicationId = responses[0].json().application.id;
  await database.asset.update({ where: { id: asset.id }, data: { location: 'Later metadata' } });
  const recovered = await post(url, { ...input, plan: { periods: input.plan.periods.toReversed() } });
  assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(recovered.json().application.id, applicationId);
  assert.equal((await post(url, { ...input, planId: 'f'.repeat(64) })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(applyClosedAssignments(database, asset.id, closedAssignmentApplySchema.parse(input), users.COORDINADOR.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  assert.deepEqual(await storageCounts(asset.id), [1, 2, 2, 4]);
});

test('different applications cannot reuse an endpoint in either role, even across adjacent nonoverlapping periods', async () => {
  const { asset, input, capture, planUrl, url } = await prepare({ priorUsage: true });
  const period = input.plan.periods[0]; const prior = capture.items.find((item) => item.effectiveDay === '2000-01-01');
  const earlier = { periods: [{ ...period, periodId: randomUUID(), start: { ...period.start, evidenceId: prior.id, confirmedAt: '2000-01-01T09:00:00-03:00' },
    end: { ...period.end, evidenceId: period.start.evidenceId, confirmedAt: period.start.confirmedAt } }] };
  const planned = await post(planUrl, earlier); assert.equal(planned.json().planValidationComplete, true, planned.body);
  const other = { ...input, requestId: randomUUID(), planId: planned.json().planId, plan: earlier };
  const responses = await Promise.all([post(url, input), post(url, other)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'HISTORICAL_EVIDENCE_ALREADY_APPLIED');
  assert.deepEqual(await storageCounts(asset.id), [1, 1, 1, 2]);
  const currentPlan = (await post(planUrl, input.plan)).json();
  assert.ok(currentPlan.periods[0].blockers.some((blocker) => blocker.code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED'));
});

test('blocked and stale plans reject every write, including changed metadata, source interpretation and proof', async () => {
  const { asset, input, url, planUrl, base, capture } = await prepare();
  const incomplete = { periods: [{ ...input.plan.periods[0], recipient: null }] };
  const blocked = (await post(planUrl, incomplete)).json();
  const rejected = await post(url, { ...input, planId: blocked.planId, plan: incomplete });
  assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().code, 'HISTORICAL_PLAN_BLOCKED');
  await database.asset.update({ where: { id: asset.id }, data: { location: 'Changed after planning' } });
  assert.equal((await post(url, input)).json().code, 'HISTORICAL_PLAN_CHANGED');
  const fresh = (await post(planUrl, input.plan)).json();
  const revised = await post(base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(), note: 'Source rechecked', evidenceReference: 'Product label',
    changes: [{ recordId: capture.items[0].recordId, field: 'model', action: 'REPLACE', value: 'Model G10' }] });
  assert.equal(revised.statusCode, 201, revised.body);
  assert.equal((await post(url, { ...input, planId: fresh.planId })).json().code, 'HISTORICAL_PLAN_CHANGED');
  assert.deepEqual(await storageCounts(asset.id), [0, 0, 0, 0]);
});

test('late audit or second-item failure rolls back all periods, receipts and ownership, leaving the same retry key usable', async () => {
  for (const failure of ['audit', 'item']) {
    const { asset, input } = await prepare({ count: 2 }); let itemCount = 0;
    const failing = failure === 'audit' ? database.$extends({ query: { auditLog: { async create({ args, query }) {
      if (args.data.action === 'IMPORT_CLOSED_ASSIGNMENTS_APPLIED') throw new Error('Injected historical audit failure'); return query(args);
    } } } }) : database.$extends({ query: { importAssignmentItem: { async create({ args, query }) {
      if (++itemCount === 2) throw new Error('Injected historical item failure'); return query(args);
    } } } });
    await assert.rejects(applyClosedAssignments(failing, asset.id, closedAssignmentApplySchema.parse(input), users.JEFE.id), /Injected historical/);
    assert.deepEqual(await storageCounts(asset.id), [0, 0, 0, 0]);
    assert.equal(await database.auditLog.count({ where: { action: 'IMPORT_CLOSED_ASSIGNMENT_ADDED', metadata: { path: ['assetId'], equals: asset.id } } }), 0);
    assert.equal((await applyClosedAssignments(database, asset.id, closedAssignmentApplySchema.parse(input), users.JEFE.id)).reused, false);
  }
});

test('busy asset locks have bounded waits and leave no partial history before a safe retry', async () => {
  const { asset, input, url } = await prepare(); let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
  const holder = database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "Asset" WHERE "id" = ${asset.id}::uuid FOR UPDATE`; entered(); await gate;
  }, { timeout: 10000 });
  await started;
  try {
    const response = await post(url, input); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'HISTORICAL_APPLICATION_BUSY');
    assert.deepEqual(await storageCounts(asset.id), [0, 0, 0, 0]);
  } finally { release(); await holder; }
  assert.equal((await post(url, input)).statusCode, 201);
});

test('historical receipts are asset-scoped and paginated without duplicating plan snapshots in metadata lists', async () => {
  const { asset, input, planUrl, url, receiptUrl } = await prepare({ count: 2 });
  const applications = [];
  for (const period of input.plan.periods) {
    const plan = { periods: [period] }; const planned = (await post(planUrl, plan)).json();
    const applied = await post(url, { ...input, requestId: randomUUID(), planId: planned.planId, plan });
    assert.equal(applied.statusCode, 201, applied.body); applications.push(applied.json().application);
  }
  const list = (await get(receiptUrl + '?limit=1')).json(); assert.equal(list.total, 2); assert.equal(list.hasMore, true);
  assert.equal('plan' in list.applications[0], false); assert.equal('items' in list.applications[0], false);
  assert.equal((await get(receiptUrl + '?limit=101')).statusCode, 400);
  const other = await prepare(); assert.equal((await get(other.receiptUrl + '/' + applications[0].id)).statusCode, 404);
  assert.equal((await get(`/assets/${asset.id}/assignments?active=false`)).json().total, 2);
});

test('missing historical application storage returns a deployment error before any assignment write', async () => {
  const { asset, url, input } = await prepare();
  const missing = database.$extends({ query: { importAssignmentApplication: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing historical application storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportAssignmentApplication' } });
  } } } }); const isolated = buildApp(missing);
  try {
    const cookie = cookies.JEFE; const token = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': token }, payload: input });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
    assert.deepEqual(await storageCounts(asset.id), [0, 0, 0, 0]);
  } finally { await isolated.close(); }
});

test('database guards reject actor bypass, orphan history, incomplete receipts, mutations and overlapping legacy writes', async () => {
  const { asset, input } = await prepare();
  const assignmentData = { assetId: asset.id, recipientType: 'OFFICE', officeName: 'Old office', createdById: null, startedAt: new Date('1901-01-01'), endedAt: new Date('1902-01-01'),
    returnStatus: 'AVAILABLE', returnRecordedAt: new Date() };
  await assert.rejects(database.assignment.create({ data: assignmentData }));
  await assert.rejects(database.assignment.create({ data: { ...assignmentData, importedHistory: true } }), /complete immutable origin receipt/);
  const { application } = await applyClosedAssignments(database, asset.id, closedAssignmentApplySchema.parse(input), users.JEFE.id);
  const item = application.items[0];
  await assert.rejects(database.assignment.update({ where: { id: item.assignmentId }, data: { officeName: 'Tampered office' } }), /Closed Assignment records/);
  await assert.rejects(database.assignment.delete({ where: { id: item.assignmentId } }), /immutable/);
  await assert.rejects(database.importAssignmentApplication.update({ where: { id: application.id }, data: { planId: 'f'.repeat(64) } }), /immutable/);
  await assert.rejects(database.importAssignmentItem.delete({ where: { id: item.id } }), /immutable/);
  await assert.rejects(database.importAssignmentEvidenceUse.delete({ where: { evidenceId: item.startEvidenceId } }), /immutable/);
  await assert.rejects(database.assignment.create({ data: { ...assignmentData, createdById: users.JEFE.id, endedById: users.JEFE.id,
    startedAt: new Date('2001-06-01'), endedAt: new Date('2001-07-01') } }), /cannot overlap imported closed history/);
  await assert.rejects(database.importAssignmentApplication.create({ data: { assetId: asset.id, requestId: randomUUID(), requestDigest: 'f'.repeat(64),
    planId: 'e'.repeat(64), rulesVersion: application.rulesVersion, plan: { ...application.plan, planId: 'e'.repeat(64) }, appliedById: users.JEFE.id } }), /Every historical period requires/);
});

test('database guards roll back mismatched proposals, endpoint ownership and changes to current asset state', async () => {
  const { asset, input } = await prepare();
  const alteredProposal = database.$extends({ query: { assignment: { async create({ args, query }) {
    return query(args.data.importedHistory ? { ...args, data: { ...args.data, notes: 'Altered historical note' } } : args);
  } } } });
  const alteredOwnership = database.$extends({ query: { importAssignmentEvidenceUse: { async createMany({ args, query }) {
    return query({ ...args, data: args.data.map((entry) => ({ ...entry, endpoint: entry.endpoint === 'START' ? 'END' : 'START' })) });
  } } } });
  const alteredState = new Proxy(database, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (operation, options) => database.$transaction(async (transaction) => {
      const result = await operation(transaction);
      await transaction.asset.update({ where: { id: asset.id }, data: { status: 'UNDER_REVIEW' } });
      return result;
    }, options);
  } });
  for (const [connection, message] of [[alteredProposal, /must match its immutable proposal/], [alteredOwnership, /must match its exact endpoint/],
    [alteredState, /cannot change current asset state/]]) {
    await assert.rejects(applyClosedAssignments(connection, asset.id, closedAssignmentApplySchema.parse(input), users.JEFE.id), message);
    assert.deepEqual(await storageCounts(asset.id), [0, 0, 0, 0]);
    assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
  }
  assert.equal((await applyClosedAssignments(database, asset.id, closedAssignmentApplySchema.parse(input), users.JEFE.id)).reused, false);
});

test('closed assignment migration preserves populated operational assignments and adds empty receipt storage', async () => {
  const { asset } = await prepare();
  const ordinary = await database.assignment.create({ data: { assetId: asset.id, personName: 'Historical ordinary recipient', createdById: users.JEFE.id,
    endedById: users.JEFE.id, startedAt: new Date('1901-01-01'), endedAt: new Date('1902-01-01') } });
  const migration = readFileSync(new URL('../../../prisma/migrations/0020_import_closed_assignments/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `closed_migration_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      for (const table of ['User', 'Product', 'Asset', 'Assignment', 'ImportHistoricalEvidence']) await transaction.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      await transaction.$executeRawUnsafe('ALTER TABLE "Assignment" DROP COLUMN "importedHistory" CASCADE');
      await transaction.$executeRawUnsafe('ALTER TABLE "Assignment" ALTER COLUMN "createdById" SET NOT NULL');
      await transaction.$executeRawUnsafe('ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_end_metadata_consistent" CHECK (("endedAt" IS NULL AND "endedById" IS NULL) OR ("endedAt" IS NOT NULL AND "endedById" IS NOT NULL))');
      await transaction.$executeRaw`INSERT INTO "User" SELECT * FROM public."User" WHERE "id" = ${users.JEFE.id}::uuid`;
      await transaction.$executeRaw`INSERT INTO "Product" SELECT * FROM public."Product" WHERE "id" = ${product.id}::uuid`;
      await transaction.$executeRaw`INSERT INTO "Asset" SELECT * FROM public."Asset" WHERE "id" = ${asset.id}::uuid`;
      await transaction.$executeRaw`INSERT INTO "Assignment" SELECT (jsonb_populate_record(NULL::"Assignment", to_jsonb(a) - 'importedHistory')).* FROM public."Assignment" a WHERE a."id" = ${ordinary.id}::uuid`;
      const before = await transaction.$queryRaw`SELECT to_jsonb(a) AS data FROM "Assignment" a`;
      const statements = migration.match(/ALTER TABLE[^;]+;|CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
      assert.equal(statements.length, 24); for (const statement of statements) await transaction.$executeRawUnsafe(statement);
      const after = await transaction.$queryRaw`SELECT to_jsonb(a) - 'importedHistory' AS data, "importedHistory" FROM "Assignment" a`;
      assert.deepEqual(after, [{ data: before[0].data, importedHistory: false }]);
      const [counts] = await transaction.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportAssignmentApplication") AS applications, (SELECT count(*)::integer FROM "ImportAssignmentItem") AS items`;
      assert.deepEqual(counts, { applications: 0, items: 0 }); throw new RollbackTest();
    }, { timeout: 15000 });
  } catch (error) { if (!(error instanceof RollbackTest)) throw error; }
});

after(async () => { await app.close(); });
