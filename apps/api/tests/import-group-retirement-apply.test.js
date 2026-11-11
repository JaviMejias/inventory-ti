import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { applyGroupRetirement } from '../src/imports/group-retirement-apply-service.js';
import { groupRetirementApplySchema, groupRetirementRequestDigest } from '../src/imports/group-retirement-apply-schemas.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { hashPassword } from '../src/lib/password.js';
import { groupRetirementFixture } from './fixtures/group-retirement-import.js';

const productIds = []; const users = {}; const cookies = {}; let product;
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database);
before(async () => {
  for (const role of ['JEFE', 'OTHER_JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'group-retire-apply-' + randomUUID(); const password = 'Group-retire-apply-password-123';
    users[role] = await database.user.create({ data: { username, displayName: role, role: role === 'OTHER_JEFE' ? 'JEFE' : role, passwordHash: hashPassword(password) } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200, login.body);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group retirement apply ' + randomUUID(), trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function prepare(options = {}) { return groupRetirementFixture({ database, product, post, get, ...options }); }
async function confirmed(f, input = f.input) {
  const first = await post(f.url, input); assert.equal(first.statusCode, 200, first.body);
  const plan = { ...input, acknowledgedGroupWarnings: first.json().groupWarnings.map((entry) => entry.id), plan: { ...input.plan, acknowledgedWarnings: first.json().warnings.map((entry) => entry.id) } };
  const final = await post(f.url, plan); assert.equal(final.statusCode, 200, final.body);
  return { requestId: randomUUID(), planId: final.json().planId, confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT', plan };
}
function code(response, status, expected) { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().code, expected, response.body); }
function execute(client, f, input) { return applyGroupRetirement(client, f.batch.id, f.review.id, groupRetirementApplySchema.parse(input), users.JEFE.id); }
function afterTransaction(callback) {
  return new Proxy(database, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (operation, options) => database.$transaction(async (tx) => { const result = await operation(tx); await callback(tx, result); return result; }, options);
  } });
}

test('group retirement application commits one terminal asset, full source consumption and auditable original provenance', async () => {
  const f = await prepare(); const input = await confirmed(f); const original = await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } });
  const evidence = await database.importHistoricalEvidence.findMany({ where: { captureId: f.capture.id }, orderBy: { id: 'asc' } });
  const response = await post(f.url + '/apply', input); assert.equal(response.statusCode, 201, response.body); const result = response.json(); const receipt = result.application;
  assert.equal(result.persisted, true); assert.equal(result.affectsCurrentState, true); assert.equal(result.evidenceRelinked, false);
  assert.equal(receipt.rows.length, f.projection.groups[0].recordIds.length); assert.equal(receipt.evidenceId, f.retirement.id);
  const current = await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } });
  assert.equal(current.status, 'DECOMMISSIONED'); assert.equal(current.isActive, false); assert.equal(current.decommissionedAt.toISOString(), '2005-01-01T12:00:00.000Z');
  const omit = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !['status','isActive','decommissionedAt','updatedAt'].includes(key)));
  assert.deepEqual(omit(current), omit(original)); assert.deepEqual(await database.importHistoricalEvidence.findMany({ where: { captureId: f.capture.id }, orderBy: { id: 'asc' } }), evidence);
  assert.equal(await database.auditLog.count({ where: { entityId: receipt.id, action: 'IMPORT_GROUP_RETIREMENT_APPLIED', userId: users.JEFE.id } }), 1);
  assert.equal(await database.importRetirementApplication.count({ where: { assetId: f.asset.id } }), 0);
  const detail = await get(f.reviewUrl + '/retirement-applications/' + receipt.id); assert.equal(detail.statusCode, 200, detail.body); assert.deepEqual(detail.json().application, receipt);
  const asset = await get('/assets/' + f.asset.id); assert.equal(asset.statusCode, 200); assert.equal(asset.json().asset.groupRetirement.id, receipt.id);
  const history = await get('/assets/' + f.asset.id + '/history'); assert.equal(history.statusCode, 200);
  const event = history.json().events.find((entry) => entry.groupRetirementApplicationId === receipt.id); assert.equal(event.actor, null); assert.equal(event.recordedById, users.JEFE.id); assert.equal(event.effectiveAt, receipt.decommissionedAt);
});

test('group retirement application requires JEFE, CSRF and a distinct strict confirmation', async () => {
  const f = await prepare(); const input = await confirmed(f);
  assert.equal((await app.inject({ method: 'POST', url: f.url + '/apply', payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR','SOPORTE']) assert.equal((await post(f.url + '/apply', input, role)).statusCode, 403);
  assert.equal((await post(f.url + '/apply', input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT' }, { assetId: f.asset.id }, { force: true }, { requestId: 'invalid' }]) assert.equal((await post(f.url + '/apply', { ...input, ...change })).statusCode, 400);
  assert.equal((await post(f.url + '/apply?force=true', input)).statusCode, 400);
});

test('group retirement same-key concurrent retry recovers the exact receipt and binds actor and intent after review release', async () => {
  const f = await prepare(); const input = await confirmed(f);
  const responses = await Promise.all([post(f.url + '/apply', input), post(f.url + '/apply', input)]); assert.deepEqual(responses.map((entry) => entry.statusCode).sort(), [200,201]);
  const receipt = responses[0].json().application; assert.deepEqual(responses[1].json().application, receipt);
  code(await post(f.url + '/apply', input, 'OTHER_JEFE'), 409, 'IDEMPOTENCY_KEY_REUSED');
  code(await post(f.url + '/apply', { ...input, plan: { ...input.plan, plan: { ...input.plan.plan, note: 'Different intent' } } }), 409, 'IDEMPOTENCY_KEY_REUSED');
  const released = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Administrative release after irreversible disposal' }); assert.equal(released.statusCode, 201, released.body);
  const recovered = await post(f.url + '/apply', input); assert.equal(recovered.statusCode, 200, recovered.body); assert.deepEqual(recovered.json().application, receipt);
  const legacy = await post('/assets/' + f.asset.id + '/imported-retirement-plan', input.plan.plan); code(legacy, 409, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  code(await post(f.base + '/identity-group-plan', f.proposal), 409, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
});

test('group retirement failures roll back terminal state and preserve a reusable request key', async () => {
  const f = await prepare(); const input = await confirmed(f); const beforeState = await database.asset.findUnique({ where: { id: f.asset.id } });
  const unaudited = database.$extends({ query: { auditLog: { async create({ args, query }) { if (args.data.action === 'IMPORT_GROUP_RETIREMENT_APPLIED') throw new Error('Simulated audit failure'); return query(args); } } } });
  await assert.rejects(execute(unaudited, f, input), /audit failure/i);
  assert.equal(await database.importGroupRetirementApplication.count({ where: { reviewId: f.review.id } }), 0); assert.equal(await database.importGroupRetirementRowUse.count({ where: { reviewId: f.review.id } }), 0);
  assert.deepEqual(await database.asset.findUnique({ where: { id: f.asset.id } }), beforeState);
  assert.equal((await post(f.url + '/apply', input)).statusCode, 201);
});

test('group retirement receipts remain paginated, scoped and JEFE-only after application and release', async () => {
  const foreign = await prepare(); const f = await prepare(); const response = await post(f.url + '/apply', await confirmed(f)); assert.equal(response.statusCode, 201, response.body); const receipt = response.json().application;
  const listed = await get(f.reviewUrl + '/retirement-applications?limit=1&offset=0'); assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().total, 1); assert.equal(listed.json().hasMore, false); assert.equal(listed.json().applications[0].plan, undefined); assert.equal(listed.json().applications[0]._count.rows, 2);
  const empty = await get(f.reviewUrl + '/retirement-applications?limit=1&offset=1'); assert.deepEqual(empty.json().applications, []);
  for (const role of ['COORDINADOR','SOPORTE']) assert.equal((await get(f.reviewUrl + '/retirement-applications', role)).statusCode, 403);
  assert.equal((await get(foreign.reviewUrl + '/retirement-applications/' + receipt.id)).statusCode, 404);
  assert.equal((await get(f.reviewUrl.replace(f.batch.id, randomUUID()) + '/retirement-applications/' + receipt.id)).statusCode, 404);
  assert.equal((await get(f.reviewUrl + '/retirement-applications?limit=101')).statusCode, 400);
  assert.equal((await get(f.reviewUrl + '/retirement-applications/' + receipt.id + '?force=true')).statusCode, 400);
});

test('group retirement stale hashes and missing temporal proof fail before any terminal write', async () => {
  const f = await prepare(); const input = await confirmed(f);
  code(await post(f.url + '/apply', { ...input, planId: 'f'.repeat(64) }), 409, 'GROUP_RETIREMENT_PLAN_CHANGED');
  code(await post(f.url + '/apply', { ...input, plan: { ...input.plan, plan: { ...input.plan.plan, confirmedAt: null, dateEvidenceReference: null } } }), 409, 'GROUP_RETIREMENT_PLAN_BLOCKED');
  await database.asset.update({ where: { id: f.asset.id }, data: { location: 'Inventory context changed' } });
  code(await post(f.url + '/apply', input), 409, 'IDENTITY_GROUP_PROJECTION_CHANGED');
  assert.equal(await database.importGroupRetirementApplication.count({ where: { reviewId: f.review.id } }), 0);
  await f.refreshDecision(); const renewed = { ...await confirmed(f), requestId: input.requestId };
  assert.equal((await post(f.url + '/apply', renewed)).statusCode, 201);
});

test('group retirement SQL validates actor, transaction marker, current snapshot and exact proposed date', async () => {
  const f = await prepare(); const input = await confirmed(f);
  for (const change of [{ appliedById: users.SOPORTE.id }, { createdTransactionId: '1' }, { assetSnapshot: {} }, { decommissionedAt: new Date('2006-01-01') }]) {
    const forged = database.$extends({ query: { importGroupRetirementApplication: { async create({ args, query }) { return query({ ...args, data: { ...args.data, ...change } }); } } } });
    await assert.rejects(execute(forged, f, input), /retirement|timestamp|snapshot/i);
    assert.equal(await database.importGroupRetirementApplication.count({ where: { reviewId: f.review.id } }), 0);
  }
  assert.equal((await post(f.url + '/apply', input)).statusCode, 201);
});

test('group retirement SQL requires real audit and complete consumed rows, not successful-looking application responses', async () => {
  const f = await prepare(); const input = await confirmed(f); const original = await database.asset.findUnique({ where: { id: f.asset.id } });
  const withoutAudit = database.$extends({ query: { auditLog: { async create({ args, query }) {
    return args.data.action === 'IMPORT_GROUP_RETIREMENT_APPLIED' ? { id: randomUUID(), ...args.data, createdAt: new Date() } : query(args);
  } } } });
  await assert.rejects(execute(withoutAudit, f, input), /audit/i);
  const withoutRows = database.$extends({ query: { importGroupRetirementRowUse: { async createMany() { return { count: 0 }; } } } });
  await assert.rejects(execute(withoutRows, f, input), /consumption/i);
  assert.deepEqual(await database.asset.findUnique({ where: { id: f.asset.id } }), original);
  assert.equal(await database.importGroupRetirementApplication.count({ where: { reviewId: f.review.id } }), 0);
});

test('group retirement guards survive early constraints and released savepoints without allowing asset or custody changes', async () => {
  const f = await prepare(); const input = await confirmed(f);
  for (const kind of ['asset','assignment','audit']) {
    const modified = afterTransaction(async (tx) => {
      await tx.$executeRawUnsafe('SAVEPOINT after_retirement'); await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); await tx.$executeRawUnsafe('RELEASE SAVEPOINT after_retirement');
      if (kind === 'asset') await tx.asset.update({ where: { id: f.asset.id }, data: { notes: 'Forbidden extra metadata mutation' } });
      else if (kind === 'assignment') await tx.assignment.create({ data: { assetId: f.asset.id, personName: 'Forbidden custody change', startedAt: new Date('2001-01-01'), endedAt: new Date('2002-01-01'), returnStatus: 'AVAILABLE' } });
      else await tx.auditLog.deleteMany({ where: { entityId: (await tx.importGroupRetirementApplication.findFirstOrThrow({ where: { reviewId: f.review.id } })).id } });
    });
    await assert.rejects(execute(modified, f, input), /immutable|Assignments cannot change/i);
    assert.equal(await database.importGroupRetirementApplication.count({ where: { reviewId: f.review.id } }), 0);
  }
  assert.equal((await post(f.url + '/apply', input)).statusCode, 201);
});

test('group retirement receipts and source consumption are immutable and cannot be truncated, and terminal state cannot be rewritten', async () => {
  const f = await prepare(); const input = await confirmed(f); const response = await post(f.url + '/apply', input); assert.equal(response.statusCode, 201, response.body); const receipt = response.json().application;
  await assert.rejects(database.importGroupRetirementApplication.update({ where: { id: receipt.id }, data: { planId: 'f'.repeat(64) } }), /immutable/i);
  await assert.rejects(database.importGroupRetirementApplication.delete({ where: { id: receipt.id } }), /immutable/i);
  await assert.rejects(database.importGroupRetirementRowUse.deleteMany({ where: { applicationId: receipt.id } }), /immutable/i);
  await assert.rejects(database.$transaction(async (tx) => { await tx.$executeRawUnsafe('TRUNCATE TABLE "ImportGroupRetirementApplication", "ImportGroupRetirementRowUse"'); throw new Error('Unexpected truncate; roll back isolated data'); }), /immutable/i);
  await assert.rejects(database.asset.update({ where: { id: f.asset.id }, data: { status: 'AVAILABLE', isActive: true, decommissionedAt: null } }), /immutable/i);
  await assert.rejects(database.assignment.create({ data: { assetId: f.asset.id, personName: 'Too late', startedAt: new Date('2004-01-01'), endedAt: new Date('2006-01-01'), returnStatus: 'AVAILABLE' } }), /beyond grouped retirement/i);
});

test('group retirement occupied inventory locks fail recoverably with the same unused request key', async () => {
  const f = await prepare(); const input = await confirmed(f);
  await database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "Product" IN ROW EXCLUSIVE MODE');
    code(await post(f.url + '/apply', input), 409, 'GROUP_RETIREMENT_APPLY_BUSY');
  });
  const retry = await post(f.url + '/apply', input); assert.equal(retry.statusCode, 201, retry.body);
});

test('group retirement missing receipt storage returns 503 without changing asset state', async () => {
  const f = await prepare(); const input = await confirmed(f);
  const missing = database.$extends({ query: { importGroupRetirementApplication: { async findUnique() { throw new Prisma.PrismaClientKnownRequestError('Missing retirement storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportGroupRetirementApplication' } }); } } } });
  const isolated = buildApp(missing);
  try { code(await post(f.url + '/apply', input, 'JEFE', true, isolated), 503, 'IMPORT_REVIEW_NOT_READY'); } finally { await isolated.close(); }
});

test('group retirement new competing request keys cannot retire the same asset or physical rows twice', async () => {
  const f = await prepare(); const input = await confirmed(f);
  const responses = await Promise.all([post(f.url + '/apply', input), post(f.url + '/apply', { ...input, requestId: randomUUID() })]);
  assert.deepEqual(responses.map((entry) => entry.statusCode).sort(), [201,409]);
  assert.equal(await database.importGroupRetirementApplication.count({ where: { assetId: f.asset.id } }), 1);
  assert.equal(await database.importGroupRetirementRowUse.count({ where: { reviewId: f.review.id } }), 2);
});

test('group retirement partial application leaves a different physical group reviewable and consumable only once', async () => {
  const f = await prepare({ split: true }); const first = await post(f.url + '/apply', await confirmed(f)); assert.equal(first.statusCode, 201, first.body);
  f.asset = f.partner; f.targetGroupId = f.proposal.groups[1].groupId; f.retirement = f.capture.items.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION' && entry.snapshot.original.row === 6);
  await f.refreshDecision(); const second = await post(f.url + '/apply', await confirmed(f)); assert.equal(second.statusCode, 201, second.body);
  assert.notEqual(first.json().application.assetId, second.json().application.assetId);
  assert.equal(await database.importGroupRetirementApplication.count({ where: { reviewId: f.review.id } }), 2);
  assert.equal(await database.importGroupRetirementRowUse.count({ where: { reviewId: f.review.id } }), 2);
});

test('group retirement SQL rejects receipt chronology forged with a recomputed valid plan and request hash', async () => {
  const f = await prepare(); const input = await confirmed(f);
  const forged = database.$extends({ query: { importGroupRetirementApplication: { async create({ args, query }) {
    const plan = JSON.parse(JSON.stringify(args.data.plan)); const date = '1999-01-01T00:00:00.000Z'; plan.request.plan.confirmedAt = date; plan.proposedRetirement.decommissionedAt = date;
    const envelope = new Set(['planId','mode','persisted','canApply','affectsCurrentState','evidenceRelinked','operationalHistoryApplied','retirementApplicationImplemented','planValidationComplete','summary']);
    plan.planId = importPlanDigest(Object.fromEntries(Object.entries(plan).filter(([key]) => !envelope.has(key))));
    const requestDigest = groupRetirementRequestDigest({ ...input, planId: plan.planId, plan: plan.request });
    return query({ ...args, data: { ...args.data, plan, planId: plan.planId, requestDigest, decommissionedAt: new Date(date), result: { ...args.data.result, decommissionedAt: date } } });
  } } } });
  await assert.rejects(execute(forged,f,input), /receipt chronology/i);
  assert.equal(await database.importGroupRetirementApplication.count({ where: { reviewId: f.review.id } }),0);
  assert.equal((await post(f.url + '/apply',input)).statusCode,201);
});

test('group retirement SQL source writers cannot bypass committed consumption with an earlier repeatable snapshot', async () => {
  const f = await prepare(); const input = await confirmed(f);
  await database.$transaction(async (tx) => {
    await tx.importGroupRetirementApplication.count();
    const applied = await post(f.url + '/apply',input); assert.equal(applied.statusCode,201,applied.body);
    await assert.rejects(tx.$executeRawUnsafe('SELECT assert_import_group_source_unconsumed($1,$2,$3)',f.source.source.sha256,f.retirement.candidateId,f.retirement.recordId),/READ COMMITTED/i);
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,timeout:15000});
});

after(async () => { await app.close(); await database.$disconnect(); });
