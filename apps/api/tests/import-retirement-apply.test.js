import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { historicalRetirementApplySchema } from '../src/imports/retirement-apply-schemas.js';
import { applyHistoricalRetirement } from '../src/imports/retirement-apply-service.js';
import { hashPassword } from '../src/lib/password.js';
import { verifiedRetirementFixture } from './fixtures/verified-retirement-import.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const users = {}; const cookies = {}; let product;
before(async () => {
  for (const key of ['JEFE', 'JEFE2', 'COORDINADOR', 'SOPORTE']) {
    const username = `retapply-${key.toLowerCase()}-${suffix}`; const password = 'Retirement-apply-password-123';
    users[key] = await database.user.create({ data: { username, displayName: `Retirement ${key}`, passwordHash: hashPassword(password), role: key === 'JEFE2' ? 'JEFE' : key } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200);
    const header = login.headers['set-cookie']; cookies[key] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Retire apply ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role]; const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function prepare(options = {}) { return verifiedRetirementFixture({ database, product, actorId: users.JEFE.id, post, get, ...options }); }
async function amendment(evidenceId, assetId) {
  const base = `/inventory/imports/evidence/${evidenceId}`;
  const response = await post(base + '/amendment-plan', { assetId }); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  return { plan, url: base + '/amendments', input: { requestId: randomUUID(), amendmentPlanId: plan.amendmentPlanId,
    expectedEvidenceVersion: plan.evidenceVersion, expectedBatchVersion: plan.batchVersion, expectedSourceRevision: plan.sourceRevision,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId, note: 'Retirement evidence rechecked', evidenceReference: 'Original asset and disposal records' } };
}
function receiptData(fixture) {
  const appliedAt = new Date(); const plan = fixture.plan;
  return { assetId: fixture.asset.id, evidenceId: fixture.evidence.id, evidenceVersion: plan.source.evidenceVersion, amendmentId: plan.source.amendmentId,
    sourceRevision: plan.source.sourceRevision, decommissionedAt: new Date(plan.proposedRetirement.decommissionedAt), requestId: randomUUID(), requestDigest: 'a'.repeat(64),
    planId: plan.planId, rulesVersion: plan.planRulesVersion, plan, appliedById: users.JEFE.id, appliedAt,
    result: { id: fixture.asset.id, productId: fixture.asset.productId, serialNumber: fixture.asset.serialNumber, assetTag: fixture.asset.assetTag,
      status: 'DECOMMISSIONED', isActive: false, decommissionedAt: plan.proposedRetirement.decommissionedAt, updatedAt: appliedAt.toISOString() } };
}

test('verified retirement apply and receipts require JEFE, CSRF and a separate strict application confirmation', async () => {
  const { asset, input, url, receiptUrl } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) {
    assert.equal((await post(url, input, role)).statusCode, 403); assert.equal((await get(receiptUrl, role)).statusCode, 403);
  }
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { confirmation: 'VERIFIED_HISTORICAL_RETIREMENT' }, { requestId: 'a'.repeat(64) }]) assert.equal((await post(url, { ...input, ...change })).statusCode, 400);
  assert.equal((await post(`/assets/${randomUUID()}/imported-retirement-plan/apply`, input)).statusCode, 404);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
});

test('verified retirement commits exact terminal date, immutable receipt and audit without changing metadata, source or quantities', async () => {
  const { asset, batch, capture, evidence, input, url } = await prepare();
  const beforeBatch = await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }); const beforeCapture = await database.importHistoryCapture.findUniqueOrThrow({ where: { id: capture.id }, include: { items: true } });
  const response = await post(url, input); assert.equal(response.statusCode, 201, response.body); const result = response.json(); const receipt = result.application;
  assert.equal(result.affectsCurrentState, true); assert.equal(result.persisted, true); assert.equal(result.reused, false);
  const updated = await database.asset.findUniqueOrThrow({ where: { id: asset.id } });
  assert.equal(updated.status, 'DECOMMISSIONED'); assert.equal(updated.isActive, false); assert.equal(updated.decommissionedAt.toISOString(), '2005-01-01T12:00:00.000Z');
  for (const field of Object.keys(asset).filter((field) => !['status', 'isActive', 'decommissionedAt', 'updatedAt'].includes(field))) assert.deepEqual(updated[field], asset[field]);
  assert.equal(receipt.plan.proposedRetirement.historicalActorId, null); assert.equal(receipt.appliedById, users.JEFE.id); assert.equal(receipt.evidenceId, evidence.id);
  assert.equal(updated.updatedAt.toISOString(), receipt.appliedAt); assert.equal(receipt.result.updatedAt, receipt.appliedAt);
  assert.deepEqual(await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }), beforeBatch);
  assert.deepEqual(await database.importHistoryCapture.findUniqueOrThrow({ where: { id: capture.id }, include: { items: true } }), beforeCapture);
  assert.equal(await database.assignment.count({ where: { assetId: asset.id } }), 0); assert.equal(await database.inventoryMovement.count({ where: { assetId: asset.id } }), 0);
  assert.equal(await database.inventoryStock.count({ where: { productId: product.id } }), 0);
  assert.equal(await database.auditLog.count({ where: { entityId: receipt.id, action: 'IMPORT_HISTORICAL_RETIREMENT_APPLIED' } }), 1);
});

test('retirement history and general asset reads separate unknown event actor from current import operator for every authenticated role', async () => {
  const { asset, input, url } = await prepare(); const applied = await post(url, input); assert.equal(applied.statusCode, 201, applied.body); const receipt = applied.json().application;
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const detail = await get(`/assets/${asset.id}`, role); assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().asset.importRetirement.id, receipt.id); assert.equal(detail.json().asset.importRetirement.plan, undefined);
    const history = await get(`/assets/${asset.id}/history`, role); assert.equal(history.statusCode, 200, history.body);
    const event = history.json().events.find((entry) => entry.importApplicationId === receipt.id); assert.ok(event);
    assert.equal(event.actor, null); assert.equal(event.recordedById, users.JEFE.id); assert.equal(event.effectiveAt, receipt.decommissionedAt); assert.equal(event.recordedAt, receipt.appliedAt);
    assert.equal(history.json().events.filter((entry) => entry.action === 'ASSET_DECOMMISSIONED').length, 1);
  }
  assert.equal((await get(`/assets?status=DECOMMISSIONED&isActive=false&productId=${product.id}`)).json().assets.some((entry) => entry.id === asset.id), true);
  assert.equal((await post(`/assets/${asset.id}/decommission`, {})).statusCode, 409);
});

test('identical concurrent retries return one retirement receipt, bind actor and intent and recover despite later source revisions', async () => {
  const fixture = await prepare(); const responses = await Promise.all([post(fixture.url, fixture.input), post(fixture.url, fixture.input)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]); assert.equal(responses[0].json().application.id, responses[1].json().application.id);
  const revised = await post(fixture.base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(), note: 'Later archival catalog review',
    evidenceReference: 'Catalog document', changes: [{ recordId: fixture.evidence.recordId, field: 'model', action: 'REPLACE', value: 'Model G10' }] }); assert.equal(revised.statusCode, 201, revised.body);
  assert.equal((await post(fixture.url, fixture.input)).statusCode, 200);
  assert.equal((await post(fixture.url, { ...fixture.input, plan: { ...fixture.input.plan, evidenceReference: 'Other proof' } })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await post(fixture.url, fixture.input, 'JEFE2')).json().code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await database.importRetirementApplication.count({ where: { assetId: fixture.asset.id } }), 1);
});

test('different concurrent requests cannot retire the same asset or consume its observation twice', async () => {
  const { asset, input, url } = await prepare(); const responses = await Promise.all([post(url, input), post(url, { ...input, requestId: randomUUID() })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]); assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'RETIREMENT_ALREADY_APPLIED');
  assert.equal(await database.importRetirementApplication.count({ where: { assetId: asset.id } }), 1);
});

test('stale asset, source and evidence versions invalidate retirement before any terminal write', async () => {
  for (const kind of ['asset', 'source', 'evidence']) {
    const fixture = await prepare();
    if (kind === 'asset') await database.asset.update({ where: { id: fixture.asset.id }, data: { notes: 'New operational observation' } });
    else if (kind === 'source') {
      const revised = await post(fixture.base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(), note: 'Receipt corrected',
        evidenceReference: 'Receiving record', changes: [{ recordId: fixture.evidence.recordId, field: 'receivedDate', action: 'REPLACE', value: '2002-01-01' }] }); assert.equal(revised.statusCode, 201, revised.body);
    } else { const planned = await amendment(fixture.evidence.id, null); assert.equal((await post(planned.url, planned.input)).statusCode, 201); }
    const response = await post(fixture.url, fixture.input); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'RETIREMENT_PLAN_CHANGED');
    assert.equal(await database.importRetirementApplication.count({ where: { assetId: fixture.asset.id } }), 0); assert.equal((await database.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } })).status, 'AVAILABLE');
  }
});

test('fresh blocked proposals cannot invent dates, close active custody, reinterpret existing retirement or link unknown evidence', async () => {
  for (const options of [{ active: true }, { retired: true }, { unlinked: true }]) {
    const fixture = await prepare(options); const response = await post(fixture.url, fixture.input); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'RETIREMENT_PLAN_BLOCKED');
    assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } }), fixture.asset);
  }
  const fixture = await prepare(); const proposal = { ...fixture.input.plan, confirmedAt: null, dateEvidenceReference: null };
  const plan = (await post(fixture.planUrl, proposal)).json(); const response = await post(fixture.url, { ...fixture.input, planId: plan.planId, plan: proposal });
  assert.equal(response.json().code, 'RETIREMENT_PLAN_BLOCKED'); assert.equal(await database.importRetirementApplication.count({ where: { assetId: fixture.asset.id } }), 0);
});

test('applied retirement evidence is sealed against V12 amendment, including a precomputed plan', async () => {
  const { asset, evidence, input, url } = await prepare(); const planned = await amendment(evidence.id, null);
  assert.equal((await post(url, input)).statusCode, 201);
  const response = await post(planned.url, planned.input); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'EVIDENCE_ALREADY_APPLIED');
  const current = await amendment(evidence.id, asset.id); assert.ok(current.plan.blockers.includes('EVIDENCE_ALREADY_APPLIED'));
  const data = { evidenceId: evidence.id, version: 1, previousAmendmentId: null, batchVersion: 2, sourceRevision: 0, requestId: randomUUID(), requestDigest: 'a'.repeat(64),
    amendmentPlanId: planned.plan.amendmentPlanId, rulesVersion: 'mda-history-amendment-1', assetId: null, effectiveDay: null, snapshot: planned.plan.proposed,
    note: 'Direct amendment attempt', evidenceReference: 'Archived source', amendedById: users.JEFE.id };
  await assert.rejects(database.importEvidenceAmendment.create({ data }), /cannot be amended/); assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: evidence.id } }), 0);
});

test('concurrent retirement and evidence unlink either preserve applied proof or invalidate the retirement plan', async () => {
  const { asset, evidence, input, url } = await prepare(); const planned = await amendment(evidence.id, null);
  const responses = await Promise.all([post(url, input), post(planned.url, planned.input)]); assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  if (responses[0].statusCode === 201) assert.equal(responses[1].json().code, 'EVIDENCE_ALREADY_APPLIED');
  else { assert.equal(responses[0].json().code, 'RETIREMENT_PLAN_CHANGED'); assert.equal((await database.asset.findUniqueOrThrow({ where: { id: asset.id } })).status, 'AVAILABLE'); }
});

test('audit failure rolls back retirement, receipt and evidence reservation, preserving the retry key', async () => {
  const { asset, evidence, input, url } = await prepare();
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_HISTORICAL_RETIREMENT_APPLIED') throw new Error('Injected retirement audit failure'); return query(args);
  } } } });
  await assert.rejects(applyHistoricalRetirement(failing, asset.id, historicalRetirementApplySchema.parse(input), users.JEFE.id), /Injected retirement audit failure/);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset); assert.equal(await database.importRetirementApplication.count({ where: { evidenceId: evidence.id } }), 0);
  assert.equal((await post(url, input)).statusCode, 201);
});

test('retirement applies the exact amended evidence version and rechecks the operator before any write', async () => {
  const fixture = await prepare({ unknownReceipt: true });
  const revised = await post(fixture.base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(), note: 'Receiving record verified',
    evidenceReference: 'Signed reception document', changes: [{ recordId: fixture.evidence.recordId, field: 'receivedDate', action: 'REPLACE', value: '2001-01-01' }] });
  assert.equal(revised.statusCode, 201, revised.body); const planned = await amendment(fixture.evidence.id, fixture.asset.id);
  const amended = await post(planned.url, planned.input); assert.equal(amended.statusCode, 201, amended.body);
  const refreshed = await post(fixture.planUrl, fixture.input.plan); assert.equal(refreshed.statusCode, 200, refreshed.body); const plan = refreshed.json();
  assert.equal(plan.planValidationComplete, true); const input = { ...fixture.input, planId: plan.planId };
  await assert.rejects(applyHistoricalRetirement(database, fixture.asset.id, historicalRetirementApplySchema.parse(input), users.COORDINADOR.id), (error) => error.code === 'FORBIDDEN');
  assert.equal(await database.importRetirementApplication.count({ where: { assetId: fixture.asset.id } }), 0);
  const applied = await post(fixture.url, input); assert.equal(applied.statusCode, 201, applied.body); const receipt = applied.json().application;
  assert.equal(receipt.evidenceVersion, 1); assert.equal(receipt.amendmentId, amended.json().event.id); assert.equal(receipt.sourceRevision, 1);
  assert.equal(receipt.plan.source.capturedSourceRevision, 0);
  assert.deepEqual((await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: fixture.evidence.id } })).snapshot, fixture.evidence.snapshot);
});

test('concurrent assignment and retirement cannot both change the same asset successfully', async () => {
  const { asset, input, url } = await prepare();
  const responses = await Promise.all([post(url, input), post(`/assets/${asset.id}/assignments`, { recipientType: 'OFFICE', officeName: 'Current office' })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  const current = await database.asset.findUniqueOrThrow({ where: { id: asset.id } });
  assert.equal(await database.assignment.count({ where: { assetId: asset.id, endedAt: null } }), current.status === 'ASSIGNED' ? 1 : 0);
  assert.equal(await database.importRetirementApplication.count({ where: { assetId: asset.id } }), current.status === 'DECOMMISSIONED' ? 1 : 0);
});

test('source contention has bounded waits and never leaves a partial retirement', async () => {
  const { asset, evidence, input, url } = await prepare(); let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
  const holder = database.$transaction(async (transaction) => { await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${evidence.sourceHash}, 0))`; entered(); await gate; }, { timeout: 10000 });
  await started;
  try { const response = await post(url, input); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'RETIREMENT_APPLICATION_BUSY'); assert.equal(await database.importRetirementApplication.count({ where: { assetId: asset.id } }), 0); }
  finally { release(); await holder; }
  assert.equal((await post(url, input)).statusCode, 201);
});

test('retirement receipts are scoped, paginated metadata and immutable detail, not full plans in lists', async () => {
  const fixture = await prepare(); const applied = await post(fixture.url, fixture.input); assert.equal(applied.statusCode, 201, applied.body); const id = applied.json().application.id;
  const listed = (await get(fixture.receiptUrl + '?limit=1&offset=0')).json(); assert.equal(listed.total, 1); assert.equal(listed.hasMore, false); assert.equal(listed.applications[0].plan, undefined);
  assert.equal((await get(fixture.receiptUrl + '?limit=1&offset=1')).json().applications.length, 0);
  assert.equal((await get(fixture.receiptUrl + '/' + id)).json().application.planId, fixture.input.planId);
  const other = await prepare(); assert.equal((await get(other.receiptUrl + '/' + id)).statusCode, 404);
  assert.equal((await get(fixture.receiptUrl + '?limit=101')).statusCode, 400);
});

test('SQL rejects orphan receipts, forged versions, actors, blocked plans, identity rewrites and terminal reactivation', async () => {
  const fixture = await prepare(); const data = receiptData(fixture);
  await assert.rejects(database.importRetirementApplication.create({ data }), /must commit together/);
  for (const change of [{ evidenceVersion: 1, amendmentId: randomUUID() }, { appliedById: users.COORDINADOR.id },
    { plan: { ...fixture.plan, proposedRetirement: { ...fixture.plan.proposedRetirement, historicalActorId: users.JEFE.id } } },
    { plan: { ...fixture.plan, blockers: [{ code: 'SOURCE_MODEL_CONFLICT' }] } },
    { plan: { ...fixture.plan, source: { ...fixture.plan.source, sourceReceivedDay: null } } }]) await assert.rejects(database.importRetirementApplication.create({ data: { ...data, ...change } }));
  await assert.rejects(database.$transaction(async (transaction) => {
    await transaction.importRetirementApplication.create({ data }); await transaction.asset.update({ where: { id: fixture.asset.id }, data: {
      status: 'DECOMMISSIONED', isActive: false, decommissionedAt: data.decommissionedAt, updatedAt: data.appliedAt, notes: 'Unauthorized metadata rewrite' } });
  }), /only its confirmed terminal state/);
  const applied = await post(fixture.url, fixture.input); assert.equal(applied.statusCode, 201, applied.body); const id = applied.json().application.id;
  await assert.rejects(database.importRetirementApplication.update({ where: { id }, data: { requestDigest: 'b'.repeat(64) } }), /immutable/);
  await assert.rejects(database.importRetirementApplication.delete({ where: { id } }), /immutable/);
  await assert.rejects(database.asset.update({ where: { id: fixture.asset.id }, data: { status: 'AVAILABLE', isActive: true, decommissionedAt: null } }), /immutable/);
  await assert.rejects(database.assignment.create({ data: { assetId: fixture.asset.id, personName: 'Late recipient', createdById: users.JEFE.id, startedAt: new Date('2006-01-01') } }), /beyond an imported retirement/);
  const unused = await database.asset.create({ data: { productId: product.id, serialNumber: `UNUSED-${randomUUID()}` } }); await database.asset.delete({ where: { id: unused.id } });
  assert.equal(await database.asset.findUnique({ where: { id: unused.id } }), null);
});

test('missing retirement storage returns a deployment error before terminal writes', async () => {
  const { asset, input, url } = await prepare(); const missing = database.$extends({ query: { importRetirementApplication: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing retirement storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportRetirementApplication' } });
  } } } }); const isolated = buildApp(missing);
  try { const cookie = cookies.JEFE; const token = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': token }, payload: input });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY'); assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
  } finally { await isolated.close(); }
});

test('retirement migration adds empty receipt storage and guards without rewriting populated operational or archival tables', async () => {
  const { asset, batch, capture } = await prepare(); const migration = readFileSync(new URL('../../../prisma/migrations/0022_import_verified_retirements/migration.sql', import.meta.url), 'utf8');
  const evidenceMigration = readFileSync(new URL('../../../prisma/migrations/0021_import_evidence_amendments/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try { await database.$transaction(async (transaction) => {
    const schema = `retirement_migration_${randomUUID().replaceAll('-', '')}`;
    await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
    for (const table of ['User', 'Product', 'Asset', 'Assignment', 'ImportBatch', 'ImportHistoryCapture', 'ImportHistoricalEvidence', 'ImportSourceRevision', 'ImportEvidenceAmendment', 'ImportAssignmentItem', 'ImportAssignmentEvidenceUse']) {
      await transaction.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    await transaction.$executeRaw`INSERT INTO "User" SELECT * FROM public."User" WHERE "id" = ${users.JEFE.id}::uuid`;
    await transaction.$executeRaw`INSERT INTO "Product" SELECT * FROM public."Product" WHERE "id" = ${product.id}::uuid`;
    await transaction.$executeRaw`INSERT INTO "Asset" SELECT * FROM public."Asset" WHERE "id" = ${asset.id}::uuid`;
    await transaction.$executeRaw`INSERT INTO "ImportBatch" SELECT * FROM public."ImportBatch" WHERE "id" = ${batch.id}::uuid`;
    await transaction.$executeRaw`INSERT INTO "ImportHistoryCapture" SELECT * FROM public."ImportHistoryCapture" WHERE "id" = ${capture.id}::uuid`;
    await transaction.$executeRaw`INSERT INTO "ImportHistoricalEvidence" SELECT * FROM public."ImportHistoricalEvidence" WHERE "captureId" = ${capture.id}::uuid`;
    await transaction.$executeRawUnsafe(evidenceMigration.match(/CREATE VIEW[\s\S]*?;/)[0]);
    const before = await transaction.$queryRaw`SELECT to_jsonb(a) AS data FROM "Asset" a`;
    const sourceBefore = await transaction.$queryRaw`SELECT to_jsonb(e) AS data FROM "ImportHistoricalEvidence" e ORDER BY "id"`;
    const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
    assert.equal(statements.length, 18); for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    assert.deepEqual(await transaction.$queryRaw`SELECT to_jsonb(a) AS data FROM "Asset" a`, before);
    assert.deepEqual(await transaction.$queryRaw`SELECT to_jsonb(e) AS data FROM "ImportHistoricalEvidence" e ORDER BY "id"`, sourceBefore);
    const [count] = await transaction.$queryRaw`SELECT count(*)::integer AS total FROM "ImportRetirementApplication"`; assert.equal(count.total, 0); throw new RollbackTest();
  }, { timeout: 15000 }); } catch (error) { if (!(error instanceof RollbackTest)) throw error; }
});

after(async () => { await app.close(); });
