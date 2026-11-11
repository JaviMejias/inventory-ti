import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { identityGroupApplyDigest, identityGroupApplySchema } from '../src/imports/identity-group-apply-schemas.js';
import { applyIdentityGroupPilot } from '../src/imports/identity-group-apply-service.js';
import { hashPassword } from '../src/lib/password.js';
import { dateCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'SECOND_JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'groupapply-' + role.toLowerCase() + '-' + suffix; const password = 'Group-apply-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group application ' + role, passwordHash: hashPassword(password), role: role === 'SECOND_JEFE' ? 'JEFE' : role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group apply ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
async function refresh(f) { const response = await get(f.reviewUrl + '/effective-preview'); assert.equal(response.statusCode, 200, response.body); f.projection = response.json(); }
async function decide(f, index = 0, action = 'PROPOSE_NEW', assetId = null) {
  await refresh(f); const current = (await get(f.reviewUrl + '/decisions')).json(); const group = f.projection.groups[index];
  const response = await post(f.reviewUrl + '/decisions', { requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
    expectedDecisionVersion: current.decisionVersion, expectedBatchVersion: f.projection.batchVersion, expectedSourceRevision: f.projection.sourceRevision,
    projectionId: f.projection.projectionId, groupKey: group.groupKey, action, ...(assetId ? { linkedAssetId: assetId } : {}),
    note: 'Verified group intent', evidenceReference: 'Physical asset labels', evidenceReviews: group.evidence.map((entry) => ({
      evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion, disposition: 'EXCLUDE_FROM_GROUP_PILOT', note: 'Archive remains separate', evidenceReference: 'Archive reviewed independently' })) });
  assert.equal(response.statusCode, 201, response.body); f.decisionVersion = response.json().decisionVersion;
  f.decisions = [...f.decisions.filter((entry) => entry.groupKey !== group.groupKey), response.json().decision];
}
async function prepare({ count = 1, merged = false, extra = {}, existing = false } = {}) {
  const serial = ('GROUP-APPLY-ORIGINAL-' + randomUUID()).toUpperCase();
  const source = workbook('Recepción', Array.from({ length: count }, (_, i) => receptionRow(i + 4, serial, { K: textCell('Disponible'), ...extra })));
  source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json(); const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch; const base = '/inventory/imports/batches/' + batch.id;
  const proposal = { expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS', candidateIds: preview.candidates.map((entry) => entry.id),
    note: 'Physical groups verified', groups: preview.records.filter((entry) => entry.kind === 'ASSET_OBSERVATION').map((record) => ({
      groupId: randomUUID(), recordIds: [record.id], serialNumber: ('GROUP-APPLY-VERIFIED-' + randomUUID()).toUpperCase(), assetTag: record.tagKey, evidenceReference: 'Physical labels' })) };
  if (merged) proposal.groups = [{ ...proposal.groups[0], recordIds: proposal.groups.flatMap((group) => group.recordIds) }];
  const planned = await post(base + '/identity-group-plan', proposal); assert.equal(planned.statusCode, 200, planned.body);
  const saved = await post(base + '/identity-group-reviews', { requestId: randomUUID(), planId: planned.json().planId, confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: proposal }); assert.equal(saved.statusCode, 201, saved.body);
  const review = saved.json().review; const reviewUrl = base + '/identity-group-reviews/' + review.id;
  const f = { source, preview, batch, base, proposal, review, reviewUrl, decisions: [], decisionVersion: 0, url: reviewUrl + '/pilot-plan/apply' };
  await refresh(f);
  if (existing) f.asset = await database.asset.create({ data: { productId: product.id, serialNumber: f.projection.groups[0].serialNumber, location: 'Old location' } });
  for (let i = 0; i < f.projection.groups.length; i++) await decide(f, i, existing && i === 0 ? 'LINK_EXISTING' : 'PROPOSE_NEW', existing && i === 0 ? f.asset.id : null);
  return f;
}
function planInput(f, indices = f.projection.groups.map((_, i) => i)) {
  return { expectedBatchVersion: f.projection.batchVersion, expectedSourceRevision: f.projection.sourceRevision, expectedDecisionVersion: f.decisionVersion,
    projectionId: f.projection.projectionId, operations: indices.map((index) => { const group = f.projection.groups[index]; const decision = f.decisions.find((entry) => entry.groupKey === group.groupKey);
      return decision.action === 'LINK_EXISTING'
        ? { type: 'UPDATE_METADATA', groupKey: group.groupKey, decisionId: decision.id, assetId: decision.linkedAssetId, note: 'Verified metadata', values: { location: 'New location', notes: null } }
        : { type: 'CREATE_ASSET', groupKey: group.groupKey, decisionId: decision.id, note: 'Available unassigned equipment', confirmation: 'AVAILABLE_UNASSIGNED',
          values: { productId: product.id, serialNumber: group.serialNumber, assetTag: group.assetTag, location: 'Bodega' } };
    }) };
}
async function applicationInput(f, selected) {
  const plan = planInput(f, selected); const response = await post(f.reviewUrl + '/pilot-plan', plan); assert.equal(response.statusCode, 200, response.body);
  f.plan = response.json(); return { requestId: randomUUID(), planId: f.plan.planId, confirmation: 'APPLY_IDENTITY_GROUP_ASSET_PILOT', plan };
}
function release(f) { return post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Release only administrative reservations' }); }
async function state(f) {
  return { assets: await database.asset.count({ where: { productId: product.id } }), applications: await database.importIdentityGroupApplication.count({ where: { reviewId: f.review.id } }),
    items: await database.importIdentityGroupApplicationItem.count({ where: { application: { reviewId: f.review.id } } }),
    rows: await database.importIdentityGroupRowUse.count({ where: { sourceHash: f.source.source.sha256 } }),
    audit: await database.auditLog.count(), batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }) };
}

test('group application DTO requires its own confirmation and canonical retry intent', async () => {
  const f = await prepare({ count: 2 }); const input = await applicationInput(f);
  const parsed = identityGroupApplySchema.parse(input);
  assert.equal(identityGroupApplySchema.parse({ ...input, requestId: input.requestId.toUpperCase() }).requestId, input.requestId);
  for (const extra of [{ confirmation: 'APPLY_ASSET_PILOT' }, { force: true }, { planId: 'bad' }, { requestId: null }]) assert.equal(identityGroupApplySchema.safeParse({ ...input, ...extra }).success, false);
  assert.equal(identityGroupApplyDigest(parsed), identityGroupApplyDigest({ ...parsed, plan: { ...parsed.plan, operations: [...parsed.plan.operations].reverse() } }));
  assert.notEqual(identityGroupApplyDigest(parsed), identityGroupApplyDigest({ ...parsed, plan: { ...parsed.plan, operations: [{ ...parsed.plan.operations[0], note: 'Different intent' }, parsed.plan.operations[1]] } }));
});

test('group application requires JEFE, CSRF, strict query and review ownership for application and receipts', async () => {
  const f = await prepare(); const input = await applicationInput(f);
  assert.equal((await app.inject({ method: 'POST', url: f.url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) {
    assert.equal((await post(f.url, input, role)).statusCode, 403);
    assert.equal((await get(f.reviewUrl + '/applications', role)).statusCode, 403);
    assert.equal((await get(f.reviewUrl + '/applications/' + randomUUID(), role)).statusCode, 403);
  }
  assert.equal((await post(f.url, input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(f.url + '?force=true', input)).statusCode, 400);
  assert.equal((await post(f.url, { ...input, force: true })).statusCode, 400);
  assert.equal((await post(f.url.replace(f.batch.id, randomUUID()), input)).statusCode, 404);
  assert.equal((await get(f.reviewUrl + '/applications?limit=101')).statusCode, 400);
  assert.equal((await get(f.reviewUrl + '/applications?force=true')).statusCode, 400);
});

test('group application creates one asset from every observation of a merged group with atomic provenance and audit', async () => {
  const f = await prepare({ count: 2, merged: true }); const input = await applicationInput(f); const beforeState = await state(f);
  const response = await post(f.url, input); assert.equal(response.statusCode, 201, response.body); const result = response.json();
  assert.equal(result.affectsCurrentState, true); assert.equal(result.evidenceRelinked, false); assert.equal(result.reused, false);
  assert.deepEqual(result.application.plan, f.plan); assert.equal(result.application.items.length, 1); assert.equal(result.application.items[0].rows.length, 2);
  const item = result.application.items[0]; assert.equal(item.result.status, 'AVAILABLE'); assert.equal(item.result.isActive, true);
  assert.equal(item.operation.source.length, 2); assert.equal(item.operation.decisionId, f.decisions[0].id);
  assert.equal(await database.asset.count({ where: { productId: product.id } }), beforeState.assets + 1);
  assert.equal(await database.assignment.count({ where: { assetId: item.assetId } }), 0);
  assert.equal(await database.inventoryMovement.count({ where: { productId: product.id } }), 0);
  assert.equal(await database.auditLog.count({ where: { entityId: item.assetId, action: 'ASSET_CREATED' } }), 1);
  assert.equal(await database.auditLog.count({ where: { entityId: result.application.id, action: 'IMPORT_IDENTITY_GROUP_PILOT_APPLIED' } }), 1);
  assert.deepEqual((await state(f)).batch, beforeState.batch);
  assert.equal((await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { rows: true } })).rows.every((row) => row.isReserved), true);
});

test('group application returns immutable paginated receipts without expanding other reviews', async () => {
  const f = await prepare(); const input = await applicationInput(f); const response = await post(f.url, input); assert.equal(response.statusCode, 201, response.body);
  const receipt = response.json().application; const url = f.reviewUrl + '/applications/' + receipt.id;
  assert.deepEqual((await get(url)).json().application, receipt);
  assert.equal((await get(url + '?force=true')).statusCode, 400);
  assert.equal((await get(url.replace(f.batch.id, randomUUID()))).statusCode, 404);
  assert.equal((await get(url.replace(f.review.id, randomUUID()))).statusCode, 404);
  const page = (await get(f.reviewUrl + '/applications?limit=1')).json(); assert.equal(page.total, 1); assert.equal(page.hasMore, false);
  assert.equal(page.applications[0].plan, undefined); assert.equal(page.applications[0].items, undefined);
  for (const [model, key] of [[database.importIdentityGroupApplication, { id: receipt.id }], [database.importIdentityGroupApplicationItem, { id: receipt.items[0].id }]]) {
    await assert.rejects(model.update({ where: key, data: { id: randomUUID() } })); await assert.rejects(model.delete({ where: key }));
  }
  const row = receipt.items[0].rows[0]; const where = { sourceHash_recordId: { sourceHash: row.sourceHash, recordId: row.recordId } };
  await assert.rejects(database.importIdentityGroupRowUse.update({ where, data: { originalCandidateId: 'e'.repeat(64) } }));
  await assert.rejects(database.importIdentityGroupRowUse.delete({ where }));
});

test('group application concurrent retries return one receipt and reject another actor, intent or request key', async () => {
  const f = await prepare({ count: 2 }); const input = await applicationInput(f);
  const responses = await Promise.all([post(f.url, input), post(f.url, { ...input, plan: { ...input.plan, operations: [...input.plan.operations].reverse() } })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]); assert.equal(responses[0].json().application.id, responses[1].json().application.id);
  assert.equal((await state(f)).applications, 1); assert.equal((await state(f)).rows, 2);
  assert.equal((await post(f.url, input, 'SECOND_JEFE')).json().code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await post(f.url, { ...input, planId: 'e'.repeat(64) })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await post(f.url, { ...input, requestId: randomUUID() })).json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
});

test('group application metadata preserves identity, product and active custody and recovers original receipt after later edits', async () => {
  const f = await prepare({ existing: true });
  const assigned = await post('/assets/' + f.asset.id + '/assignments', { personName: 'Verified recipient' }); assert.equal(assigned.statusCode, 201, assigned.body);
  await decide(f, 0, 'LINK_EXISTING', f.asset.id); const input = await applicationInput(f);
  const beforeAsset = await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } });
  const beforeAssignments = await database.assignment.findMany({ where: { assetId: f.asset.id } });
  const response = await post(f.url, input); assert.equal(response.statusCode, 201, response.body); const receipt = response.json().application;
  const current = await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }); assert.equal(current.location, 'New location'); assert.equal(current.notes, null);
  for (const field of ['productId', 'serialNumber', 'assetTag', 'status', 'isActive', 'decommissionedAt']) assert.equal(current[field], beforeAsset[field]);
  assert.deepEqual(await database.assignment.findMany({ where: { assetId: f.asset.id } }), beforeAssignments);
  await database.asset.update({ where: { id: f.asset.id }, data: { location: 'Later normal edit' } });
  assert.equal((await release(f)).statusCode, 201);
  const replay = await post(f.url, input); assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json().application, receipt);
  assert.equal((await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } })).location, 'Later normal edit');
});

test('group application partial selection consumes only selected rows and remaining groups require fresh decisions', async () => {
  const f = await prepare({ count: 2 }); const input = await applicationInput(f, [0]);
  const first = await post(f.url, input); assert.equal(first.statusCode, 201, first.body); assert.equal((await state(f)).rows, 1);
  await refresh(f); const consumedPlan = await post(f.reviewUrl + '/pilot-plan', planInput(f, [0])); assert.equal(consumedPlan.statusCode, 200, consumedPlan.body);
  assert.equal(consumedPlan.json().operations[0].blockers.some((entry) => entry.code === 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED'), true);
  const secondIndex = f.projection.groups.findIndex((group) => group.groupKey !== input.plan.operations[0].groupKey);
  await decide(f, secondIndex); const remaining = await applicationInput(f, [secondIndex]);
  const second = await post(f.url, remaining); assert.equal(second.statusCode, 201, second.body);
  assert.equal((await state(f)).applications, 2); assert.equal((await state(f)).rows, 2);
});

test('group application cancellation does not undo consumption or reopen legacy candidates and regrouping', async () => {
  const f = await prepare(); const input = await applicationInput(f); const response = await post(f.url, input); assert.equal(response.statusCode, 201, response.body);
  assert.equal((await release(f)).statusCode, 201); assert.equal((await state(f)).rows, 1);
  const review = await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { rows: true } }); assert.equal(review.rows[0].isReserved, false);
  const legacy = await post(f.base + '/plan', { expectedVersion: 1, expectedSourceRevision: 0, operations: [{ type: 'CREATE_ASSET', candidateId: f.preview.candidates[0].id,
    note: 'Cannot reload a consumed source', confirmation: 'AVAILABLE_UNASSIGNED', values: { productId: product.id, serialNumber: 'LEGACY' } }] });
  assert.equal(legacy.json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  const sourceCorrection = await post(f.base + '/source-revisions', { requestId: randomUUID(), expectedBatchVersion: 1, expectedRevision: 0,
    note: 'Cannot reinterpret consumed source', evidenceReference: 'Physical document', changes: [{ recordId: f.preview.records[0].id, field: 'brand', action: 'REPLACE', value: 'Dell' }] });
  assert.equal(sourceCorrection.json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  const otherPreview = (await post('/inventory/imports/preview', f.source)).json();
  const otherBatch = await post('/inventory/imports/batches', { workbook: f.source, previewId: otherPreview.previewId }); assert.equal(otherBatch.statusCode, 201, otherBatch.body);
  const crossBatch = await post('/inventory/imports/batches/' + otherBatch.json().batch.id + '/identity-group-plan', f.proposal);
  assert.equal(crossBatch.json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  const regrouped = await post(f.base + '/identity-group-plan', f.proposal); assert.equal(regrouped.json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  await assert.rejects(database.$transaction((transaction) => transaction.$queryRaw`SELECT assert_import_identity_unreserved(${f.source.source.sha256}, ${f.preview.candidates[0].id}, NULL)`));
  assert.deepEqual((await post(f.url, input)).json().application, response.json().application);
});

test('group application rejects cancelled, stale or changed plans without operational effects', async () => {
  const f = await prepare(); const input = await applicationInput(f); const original = await state(f);
  assert.equal((await post(f.url, { ...input, planId: '0'.repeat(64) })).json().code, 'IDENTITY_GROUP_PILOT_CHANGED');
  assert.deepEqual(await state(f), original);
  await decide(f, 0, 'HOLD'); const afterHold = await state(f);
  assert.equal((await post(f.url, input)).json().code, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT'); assert.deepEqual(await state(f), afterHold);
  const held = await applicationInput(f); assert.equal((await post(f.url, held)).json().code, 'IDENTITY_GROUP_PILOT_BLOCKED');
  assert.equal((await release(f)).statusCode, 201); const cancelled = await state(f);
  const result = await post(f.url, held); assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'IDENTITY_GROUP_ALREADY_RELEASED'); assert.deepEqual(await state(f), cancelled);
});

test('group application catalog changes and unsupported source use cannot bypass blockers', async () => {
  const f = await prepare(); const input = await applicationInput(f);
  await database.product.update({ where: { id: product.id }, data: { model: 'Mismatch' } }); const beforeState = await state(f);
  assert.equal((await post(f.url, input)).json().code, 'IDENTITY_GROUP_PILOT_BLOCKED'); assert.deepEqual(await state(f), beforeState);
  await database.product.update({ where: { id: product.id }, data: { model: 'Model G9' } });
  const used = await prepare({ extra: { P: textCell('Historical recipient') } }); const usedInput = await applicationInput(used); const usedState = await state(used);
  assert.equal((await post(used.url, usedInput)).json().code, 'IDENTITY_GROUP_PILOT_BLOCKED'); assert.deepEqual(await state(used), usedState);
});

test('group application rollback includes earlier assets, receipt, row consumption and audit after a later write fails', async () => {
  const f = await prepare({ count: 2 }); const input = await applicationInput(f); const original = await state(f); let writes = 0;
  const failing = database.$extends({ query: { asset: { async create({ args, query }) { if (++writes === 2) throw new Error('Injected second asset write failure'); return query(args); } } } });
  await assert.rejects(applyIdentityGroupPilot(failing, f.batch.id, f.review.id, identityGroupApplySchema.parse(input), users.JEFE.id), /Injected second asset/);
  assert.deepEqual(await state(f), original);
  assert.equal((await post(f.url, input)).statusCode, 201);
});

test('group application final audit failure rolls back receipt, assets and every consumed row with safe retry', async () => {
  const f = await prepare({ count: 2 }); const input = await applicationInput(f); const original = await state(f);
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_IDENTITY_GROUP_PILOT_APPLIED') throw new Error('Injected group application audit failure'); return query(args);
  } } } });
  await assert.rejects(applyIdentityGroupPilot(failing, f.batch.id, f.review.id, identityGroupApplySchema.parse(input), users.JEFE.id), /Injected group application audit/);
  assert.deepEqual(await state(f), original); assert.equal((await post(f.url, input)).statusCode, 201);
});

test('group application SQL guards reject incomplete receipts and missing row provenance atomically', async () => {
  const f = await prepare({ count: 2, merged: true }); const input = await applicationInput(f); const original = await state(f);
  const receiptData = { batchId: f.batch.id, reviewId: f.review.id, sourceHash: f.source.source.sha256, requestId: input.requestId,
    requestDigest: identityGroupApplyDigest(identityGroupApplySchema.parse(input)), planId: f.plan.planId, plan: f.plan, appliedById: users.JEFE.id };
  await assert.rejects(database.$transaction((transaction) => transaction.importIdentityGroupApplication.create({ data: receiptData })));
  await assert.rejects(database.$transaction((transaction) => transaction.importIdentityGroupApplication.create({ data: { ...receiptData, appliedById: users.SOPORTE.id } })));
  const wrongIdentity = JSON.parse(JSON.stringify(f.plan)); wrongIdentity.operations[0].values.serialNumber = 'UNREVIEWED-IDENTITY';
  await assert.rejects(database.$transaction((transaction) => transaction.importIdentityGroupApplication.create({ data: { ...receiptData, plan: wrongIdentity } })), /exact verified identity/);
  const missingRows = database.$extends({ query: { importIdentityGroupRowUse: { async createMany({ args, query }) { return query({ ...args, data: args.data.slice(0, 1) }); } } } });
  await assert.rejects(applyIdentityGroupPilot(missingRows, f.batch.id, f.review.id, identityGroupApplySchema.parse(input), users.JEFE.id));
  assert.deepEqual(await state(f), original);
});

test('group application busy inventory produces recoverable conflict without partial writes', async () => {
  const f = await prepare(); const input = await applicationInput(f); const original = await state(f);
  let ready; const locked = new Promise((resolve) => { ready = resolve; }); let releaseLock; const done = new Promise((resolve) => { releaseLock = resolve; });
  const holder = database.$transaction(async (transaction) => { await transaction.$executeRawUnsafe('LOCK TABLE "Asset" IN ROW EXCLUSIVE MODE'); ready(); await done; }, { timeout: 10000 });
  await locked;
  try { const result = await post(f.url, input); assert.equal(result.statusCode, 409, result.body); assert.equal(result.json().code, 'IDENTITY_GROUP_APPLY_BUSY'); assert.deepEqual(await state(f), original); }
  finally { releaseLock(); await holder; }
  assert.equal((await post(f.url, input)).statusCode, 201);
});

test('group application missing storage returns 503 without operational writes', async () => {
  const f = await prepare(); const input = await applicationInput(f);
  const missing = database.$extends({ query: { importIdentityGroupApplication: { async findUnique() {
    const { Prisma } = await import('@prisma/client'); throw new Prisma.PrismaClientKnownRequestError('Missing storage', { code: 'P2021', clientVersion: '6.19.3', meta: { modelName: 'ImportIdentityGroupApplication' } });
  } } } });
  const instance = buildApp(missing);
  try { const response = await post(f.url, input, 'JEFE', true, instance); assert.equal(response.statusCode, 503, response.body); }
  finally { await instance.close(); }
  const migration = readFileSync(new URL('../../../prisma/migrations/0025_import_identity_group_application/migration.sql', import.meta.url), 'utf8');
  assert.equal(migration.startsWith('BEGIN;'), true); assert.equal(migration.trim().endsWith('COMMIT;'), true);
  assert.equal(/^\s*(DELETE|TRUNCATE|DROP TABLE)\b/m.test(migration), false);
  assert.ok(await database.asset.count()); assert.ok(await database.importIdentityGroupReview.count());
});

test('group application retains archived evidence and explicit null links without applying or amending history', async () => {
  const f = await prepare({ extra: { A: dateCell('2001-01-01'), H: textCell('IN-RECEIPT') } }); const history = await get(f.base + '/history-preview'); assert.equal(history.statusCode, 200, history.body);
  assert.ok(history.json().observations.length);
  const captured = await post(f.base + '/history-captures', { requestId: randomUUID(), expectedVersion: 1, expectedSourceRevision: 0,
    historyPreviewId: history.json().historyPreviewId, confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Retain receipt observation',
    evidenceReference: 'Receiving records', records: history.json().observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: null })) });
  assert.equal(captured.statusCode, 201, captured.body); await decide(f);
  const beforeEvidence = await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' } });
  const input = await applicationInput(f); const result = await post(f.url, input); assert.equal(result.statusCode, 201, result.body);
  const evidence = result.json().application.items[0].operation.evidence; assert.ok(evidence.length); assert.equal(evidence.every((entry) => entry.currentAssetId === null && entry.appliedByThisPlan === false), true);
  assert.deepEqual(await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' } }), beforeEvidence);
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: { in: beforeEvidence.map((entry) => entry.id) } } }), 0);
});

test('group application and cancellation serialize without losing receipt recovery or permanent consumption', async () => {
  const f = await prepare(); const input = await applicationInput(f);
  let reached; const ready = new Promise((resolve) => { reached = resolve; }); let proceed; const proceedPromise = new Promise((resolve) => { proceed = resolve; });
  const gated = database.$extends({ query: { importIdentityGroupApplication: { async create({ args, query }) { reached(); await proceedPromise; return query(args); } } } });
  const applying = applyIdentityGroupPilot(gated, f.batch.id, f.review.id, identityGroupApplySchema.parse(input), users.JEFE.id);
  await ready; const releasing = release(f); proceed();
  const result = await applying; assert.equal((await releasing).statusCode, 201); assert.equal(result.application.items.length, 1);
  assert.equal((await state(f)).rows, 1); assert.equal((await post(f.url, input)).statusCode, 200);
});

test('group application SQL guard rejects snapshot-isolated writes without consuming source', async () => {
  const f = await prepare(); const input = await applicationInput(f); const original = await state(f);
  await assert.rejects(database.$transaction((transaction) => transaction.importIdentityGroupApplication.create({ data: { batchId: f.batch.id, reviewId: f.review.id,
    sourceHash: f.source.source.sha256, requestId: input.requestId, requestDigest: identityGroupApplyDigest(identityGroupApplySchema.parse(input)),
    planId: f.plan.planId, plan: f.plan, appliedById: users.JEFE.id } }), { isolationLevel: 'RepeatableRead' }), /require READ COMMITTED/);
  assert.deepEqual(await state(f), original);
});

test('group application migration is additive on populated inventory and reviews with complete rollback of the test schema', async () => {
  const f = await prepare(); const original = await state(f);
  const migration = readFileSync(new URL('../../../prisma/migrations/0025_import_identity_group_application/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  await assert.rejects(database.$transaction(async (transaction) => {
    const schema = 'group_application_migration_' + randomUUID().replaceAll('-', ''); await transaction.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    const tables = ['User', 'Product', 'Asset', 'Assignment', 'ImportBatch', 'ImportIdentityGroupReview', 'ImportIdentityGroupRow', 'ImportIdentityGroupRelease',
      'ImportIdentityGroupDecision', 'ImportSourceRevision', 'ImportApplicationItem', 'ImportHistoricalEvidence', 'ImportAssignmentEvidenceUse', 'ImportRetirementApplication'];
    for (const table of tables) {
      await transaction.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await transaction.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await transaction.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '", public');
    const beforeRows = await transaction.$queryRaw`SELECT (SELECT count(*) FROM "Asset") AS assets, (SELECT count(*) FROM "ImportIdentityGroupReview") AS reviews,
      (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "isReserved") AS reserved, (SELECT count(*) FROM "ImportIdentityGroupDecision") AS decisions`;
    const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
    assert.ok(statements.length > 20); for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    assert.deepEqual(await transaction.$queryRaw`SELECT (SELECT count(*) FROM "Asset") AS assets, (SELECT count(*) FROM "ImportIdentityGroupReview") AS reviews,
      (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "isReserved") AS reserved, (SELECT count(*) FROM "ImportIdentityGroupDecision") AS decisions`, beforeRows);
    assert.deepEqual(await transaction.$queryRaw`SELECT count(*)::integer AS rows FROM "ImportIdentityGroupRowUse"`, [{ rows: 0 }]);
    throw new RollbackTest();
  }, { timeout: 15000 }), (error) => error instanceof RollbackTest);
  assert.deepEqual(await state(f), original);
});

after(async () => { await app.close(); });
