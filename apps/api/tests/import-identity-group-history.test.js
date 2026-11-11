import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { planGroupHistoryLink } from '../src/imports/identity-group-history-service.js';
import { identityGroupHistoryPlanSchema } from '../src/imports/identity-group-history-schemas.js';
import { hashPassword } from '../src/lib/password.js';
import { appliedGroupHistoryFixture } from './fixtures/applied-group-history.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'grouphistory-' + role.toLowerCase() + '-' + suffix; const password = 'Group-history-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group history ' + role, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group history ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function prepare(options = {}) { return appliedGroupHistoryFixture({ post, get, database, product, ...options }); }
async function acknowledged(f) {
  const result = await post(f.url, f.input); assert.equal(result.statusCode, 200, result.body);
  return { ...f.input, operations: f.input.operations.map((operation) => ({ ...operation,
    acknowledgedWarnings: result.json().operations.find((entry) => entry.evidenceId === operation.evidenceId).warnings.map((entry) => entry.id) })) };
}
async function snapshot(f) {
  return { assets: await database.asset.findMany({ orderBy: { id: 'asc' } }), assignments: await database.assignment.findMany({ where: { asset: { productId: product.id } }, orderBy: { id: 'asc' } }),
    evidence: await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' } }),
    amendments: await database.importEvidenceAmendment.count({ where: { evidenceId: { in: f.capture.items.map((entry) => entry.id) } } }),
    batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }),
    application: await database.importIdentityGroupApplication.findUniqueOrThrow({ where: { id: f.application.id }, include: { items: { orderBy: { groupKey: 'asc' }, include: { rows: { orderBy: { recordId: 'asc' } } } } } }),
    stock: await database.inventoryStock.count({ where: { productId: product.id } }), movements: await database.inventoryMovement.count({ where: { productId: product.id } }), audit: await database.auditLog.count() };
}

test('group history route requires JEFE and CSRF and cannot accept client-selected assets, operational dates or force flags', async () => {
  const f = await prepare(); assert.equal((await app.inject({ method: 'POST', url: f.url, payload: f.input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(f.url, f.input, role)).statusCode, 403);
  assert.equal((await post(f.url, f.input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { assetId: f.item.assetId }, { operations: [] }, { operations: [{ ...f.input.operations[0], confirmedAt: '2001-01-01' }] }]) {
    assert.equal((await post(f.url, { ...f.input, ...change })).statusCode, 400);
  }
  assert.equal((await post(f.url + '?force=true', f.input)).statusCode, 400);
  assert.equal((await post(f.url + '/apply', f.input)).statusCode, 400);
});

test('group history plan is deterministic, partial and strictly read-only across inventory, archive, review, consumption and audits', async () => {
  const f = await prepare(); const input = await acknowledged(f); const original = await snapshot(f);
  const response = await post(f.url, input); assert.equal(response.statusCode, 200, response.body); const result = response.json();
  assert.equal(result.planValidationComplete, true); assert.equal(result.canApply, false); assert.equal(result.persisted, false); assert.equal(result.affectsCurrentState, false);
  assert.equal(result.evidenceRelinked, false); assert.equal(result.historyLinkApplicationImplemented, false); assert.equal(result.summary.omittedEvidenceCount, 1);
  assert.equal(result.operations[0].capturedAssetId, null); assert.equal(result.operations[0].currentAssetId, null); assert.equal(result.operations[0].proposedAssetId, f.item.assetId);
  assert.equal(result.operations[0].historicalActorId, null); assert.equal(result.operations[0].effectiveDay, '2001-01-01');
  assert.deepEqual(result.operations[0].assetApplicationReview, { evidenceVersion: 0, disposition: 'EXCLUDE_FROM_GROUP_PILOT', antecedentOnly: true });
  assert.equal(result.sourceRows.length, 2); assert.equal(result.operations[0].proposedIdentity.serialNumber, f.item.result.serialNumber);
  assert.equal((await post(f.url, input)).json().historyLinkPlanId, result.historyLinkPlanId); assert.deepEqual(await snapshot(f), original);
});

test('group history scopes all parent UUIDs and rejects evidence from another applied group or receipt', async () => {
  const f = await prepare({ split: true });
  for (const id of [f.batch.id, f.review.id, f.application.id, f.item.id]) assert.equal((await post(f.url.replace(id, randomUUID()), f.input)).statusCode, 404);
  const other = f.capture.items.find((entry) => !f.item.rows.some((row) => row.recordId === entry.recordId));
  assert.equal((await post(f.url, { ...f.input, operations: [{ ...f.input.operations[0], evidenceId: other.id }] })).statusCode, 404);
  const upper = f.url.replace(f.batch.id, f.batch.id.toUpperCase()).replace(f.review.id, f.review.id.toUpperCase()).replace(f.application.id, f.application.id.toUpperCase()).replace(f.item.id, f.item.id.toUpperCase());
  const response = await post(upper, { ...f.input, operations: [{ ...f.input.operations[0], evidenceId: f.input.operations[0].evidenceId.toUpperCase() }] }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().itemId, f.item.id);
});

test('group history remains available after administrative cancellation without unlocking earlier importers or changing receipt authority', async () => {
  const f = await prepare(); const input = await acknowledged(f);
  const released = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Release administrative reservations only' }); assert.equal(released.statusCode, 201, released.body);
  const original = await snapshot(f); const response = await post(f.url, input); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().planValidationComplete, true);
  const legacy = await post(f.base + '/plan', { expectedVersion: 1, expectedSourceRevision: 0, operations: [{ type: 'CREATE_ASSET', candidateId: f.preview.candidates[0].id,
    note: 'Cannot reuse group source', confirmation: 'AVAILABLE_UNASSIGNED', values: { productId: product.id, serialNumber: 'LEGACY' } }] }); assert.equal(legacy.json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  assert.deepEqual(await snapshot(f), original);
});

test('group history administrative release captures database time explicitly instead of depending on a client clock default', async () => {
  const f = await prepare(); let capturedAt;
  const inspecting = database.$extends({ query: { importIdentityGroupRelease: { async create({ args, query }) {
    assert.ok(args.data.createdAt instanceof Date); capturedAt = args.data.createdAt; return query(args);
  } } } }); const instance = buildApp(inspecting);
  try {
    const response = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Capture administrative release using database time' }, 'JEFE', true, instance);
    assert.equal(response.statusCode, 201, response.body); assert.equal(response.json().review.release.createdAt, capturedAt.toISOString());
    const [clock] = await database.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "currentTime"`;
    assert.ok(capturedAt <= clock.currentTime);
  } finally { await instance.close(); }
});

test('group history requires exact receipt and evidence versions while retaining old explicit null ownership', async () => {
  const f = await prepare();
  assert.equal((await post(f.url, { ...f.input, expectedApplicationPlanId: 'e'.repeat(64) })).json().code, 'IDENTITY_GROUP_APPLICATION_CHANGED');
  assert.equal((await post(f.url, { ...f.input, operations: [{ ...f.input.operations[0], expectedEvidenceVersion: 1 }] })).json().code, 'EVIDENCE_VERSION_CONFLICT');
  const id = f.evidence[0].id; const plan = await post('/inventory/imports/evidence/' + id + '/amendment-plan', { assetId: null });
  assert.equal(plan.statusCode, 200, plan.body); assert.equal(plan.json().current.assetId, null);
  const response = await post(f.url, await acknowledged(f)); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().operations[0].currentAssetId, null);
});

test('group history plan uses one consistent snapshot while concurrent asset metadata changes invalidate the next fingerprint', async () => {
  const f = await prepare(); const input = await acknowledged(f); const original = (await post(f.url, input)).json();
  let visited = false;
  const changing = database.$extends({ query: { importHistoricalEvidence: { async findMany({ args, query }) {
    if (!visited) { visited = true; await database.asset.update({ where: { id: f.item.assetId }, data: { location: 'Changed concurrently' } }); } return query(args);
  } } } });
  const result = await planGroupHistoryLink(changing, f.batch.id, f.review.id, f.application.id, f.item.id, identityGroupHistoryPlanSchema.parse(input));
  assert.equal(result.historyLinkPlanId, original.historyLinkPlanId);
  assert.notEqual((await post(f.url, input)).json().historyLinkPlanId, original.historyLinkPlanId);
});

test('group history target identity and metadata are not silently repaired or treated as a fresh group receipt', async () => {
  const f = await prepare(); const input = await acknowledged(f); const original = (await post(f.url, input)).json().historyLinkPlanId;
  await database.asset.update({ where: { id: f.item.assetId }, data: { serialNumber: 'UNRELATED-' + randomUUID() } }); const beforeState = await snapshot(f);
  const result = await post(f.url, input); assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().operations[0].blockers.includes('GROUP_ASSET_IDENTITY_CHANGED'), true); assert.notEqual(result.json().historyLinkPlanId, original);
  assert.deepEqual(await snapshot(f), beforeState);
});

test('group history keeps both captured and current null links after an explicit archival amendment and invalidates old version requests', async () => {
  const f = await prepare({ originalLink: true }); const id = f.evidence[0].id; const input = await acknowledged(f);
  async function amend(assetId, version) {
    const planned = await post('/inventory/imports/evidence/' + id + '/amendment-plan', { assetId }); assert.equal(planned.statusCode, 200, planned.body);
    const plan = planned.json(); assert.equal(plan.valid, true, planned.body);
    const saved = await post('/inventory/imports/evidence/' + id + '/amendments', { requestId: randomUUID(), expectedEvidenceVersion: version,
      expectedBatchVersion: plan.batchVersion, expectedSourceRevision: plan.sourceRevision, amendmentPlanId: plan.amendmentPlanId,
      confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId, note: 'Explicit archival link interpretation', evidenceReference: 'Original archival proof' }); assert.equal(saved.statusCode, 201, saved.body);
    return saved.json().event;
  }
  await amend(f.originalAsset.id, 0);
  assert.equal((await post(f.url, input)).json().code, 'EVIDENCE_VERSION_CONFLICT');
  f.input.operations[0].expectedEvidenceVersion = 1;
  const linked = await post(f.url, await acknowledged(f)); assert.equal(linked.json().operations[0].blockers.includes('EVIDENCE_LINKED_TO_ANOTHER_ASSET'), true);
  const unlinked = await amend(null, 1); f.input.operations[0].expectedEvidenceVersion = 2;
  const result = await post(f.url, await acknowledged(f)); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().planValidationComplete, true);
  assert.equal(result.json().operations[0].currentAssetId, null); assert.equal(result.json().operations[0].capturedAssetId, null);
  assert.equal(result.json().operations[0].amendmentId, unlinked.id); assert.equal(result.json().operations[0].assetApplicationReview.evidenceVersion, 0);
});

test('group history fails clearly for missing storage, bounded context or corrupted persisted receipt', async () => {
  const f = await prepare();
  const missing = database.$extends({ query: { importIdentityGroupApplication: { async findFirst() {
    throw new Prisma.PrismaClientKnownRequestError('Missing group applications', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportIdentityGroupApplication' } });
  } } } }); const missingApp = buildApp(missing);
  try { const response = await post(f.url, f.input, 'JEFE', true, missingApp); assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY'); }
  finally { await missingApp.close(); }
  const corrupt = database.$extends({ query: { importIdentityGroupApplication: { async findFirst({ args, query }) {
    const result = await query(args); return { ...result, requestDigest: 'e'.repeat(64) };
  } } } }); const corruptApp = buildApp(corrupt);
  try { const response = await post(f.url, f.input, 'JEFE', true, corruptApp); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'INVALID_IDENTITY_GROUP_APPLICATION'); }
  finally { await corruptApp.close(); }
  const oversized = database.$extends({ query: { importHistoricalEvidence: { async findMany({ args, query }) { const rows = await query(args); return Array(101).fill(rows[0]); } } } });
  await assert.rejects(planGroupHistoryLink(oversized, f.batch.id, f.review.id, f.application.id, f.item.id, identityGroupHistoryPlanSchema.parse(f.input)), (error) => error.code === 'GROUP_HISTORY_PLAN_LIMIT');
});

after(async () => { await app.close(); });
