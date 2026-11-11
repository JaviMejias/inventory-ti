import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { applyGroupHistoryLinks, buildGroupHistoryProjection } from '../src/imports/identity-group-history-apply-service.js';
import { groupHistoryApplyDigest, groupHistoryApplySchema } from '../src/imports/identity-group-history-apply-schemas.js';
import { hashPassword } from '../src/lib/password.js';
import { appliedGroupHistoryFixture } from './fixtures/applied-group-history.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE', 'OTHER_JEFE']) {
    const username = 'historyapply-' + role.toLowerCase() + '-' + suffix; const password = 'History-apply-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'History apply ' + role, passwordHash: hashPassword(password), role: role === 'OTHER_JEFE' ? 'JEFE' : role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'History apply ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function prepare(options = {}) { return appliedGroupHistoryFixture({ post, get, database, product, ...options }); }
async function confirmation(f, all = false) {
  let input = f.input;
  if (all) input = { ...input, operations: f.evidence.map((entry) => ({ ...input.operations[0], evidenceId: entry.id })) };
  const first = await post(f.url, input); assert.equal(first.statusCode, 200, first.body);
  input = { ...input, operations: input.operations.map((operation) => ({ ...operation,
    acknowledgedWarnings: first.json().operations.find((entry) => entry.evidenceId === operation.evidenceId).warnings.map((entry) => entry.id) })) };
  const response = await post(f.url, input); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  assert.equal(plan.planValidationComplete, true, response.body);
  return { requestId: randomUUID(), historyLinkPlanId: plan.historyLinkPlanId, confirmation: 'SAVE_GROUP_HISTORY_LINKS_ONLY', plan: input };
}
function receipts(f) { return f.url.replace('/history-link-plan', '/history-link-applications'); }
async function operational(f) {
  return { asset: await database.asset.findUniqueOrThrow({ where: { id: f.item.assetId } }),
    evidence: await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' } }),
    current: await database.$queryRaw`SELECT * FROM "ImportHistoricalEvidenceCurrent" WHERE "sourceHash" = ${f.source.source.sha256} ORDER BY "id"`,
    amendments: await database.importEvidenceAmendment.findMany({ where: { evidenceId: { in: f.evidence.map((entry) => entry.id) } } }),
    assignments: await database.assignment.findMany({ where: { assetId: f.item.assetId } }), stock: await database.inventoryStock.count({ where: { productId: product.id } }),
    movements: await database.inventoryMovement.count({ where: { productId: product.id } }),
    rows: await database.importIdentityGroupRowUse.findMany({ where: { itemId: f.item.id }, orderBy: { recordId: 'asc' } }),
    batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }) };
}
async function stored(f) {
  return { receipts: await database.importGroupHistoryApplication.count({ where: { itemId: f.item.id } }),
    links: await database.importGroupHistoryLink.count({ where: { evidenceId: { in: f.evidence.map((entry) => entry.id) } } }),
    audits: await database.auditLog.count({ where: { action: 'IMPORT_GROUP_HISTORY_LINKS_SAVED', metadata: { path: ['itemId'], equals: f.item.id } } }) };
}
async function apply(f, input, instance = app) { return post(f.url + '/apply', input, 'JEFE', true, instance); }

test('group history persistence requires authenticated JEFE, CSRF, strict DTO and explicit new confirmation', async () => {
  const f = await prepare(); const input = await confirmation(f);
  assert.equal((await app.inject({ method: 'POST', url: f.url + '/apply', payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(f.url + '/apply', input, role)).statusCode, 403);
  assert.equal((await post(f.url + '/apply', input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ confirmation: 'APPLY_IDENTITY_GROUP_ASSET_PILOT' }, { force: true }, { assetId: f.item.assetId }, { projection: {} }, { confirmedAt: '2001-01-01' }]) {
    assert.equal((await apply(f, { ...input, ...change })).statusCode, 400);
  }
  assert.equal((await post(f.url + '/apply?force=true', input)).statusCode, 400);
  assert.deepEqual(await stored(f), { receipts: 0, links: 0, audits: 0 });
});

test('group history saves a partial immutable projection and atomic audit without changing archive, inventory, custody or consumption', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await operational(f);
  const response = await apply(f, input); assert.equal(response.statusCode, 201, response.body); const result = response.json();
  assert.equal(result.affectsCurrentState, false); assert.equal(result.persisted, true); assert.equal(result.evidenceRelinked, false);
  assert.equal(result.historyProjectionPersisted, true); assert.equal(result.operationalHistoryApplied, false);
  assert.equal(result.application.links.length, 1); const link = result.application.links[0];
  assert.equal(link.assetId, f.item.assetId); assert.equal(link.evidenceVersion, 0); assert.equal(link.version, 1); assert.equal(link.amendmentId, null);
  assert.equal(link.projection.assetId, f.item.assetId); assert.equal(link.projection.historicalActorId, null);
  assert.equal(link.projection.effectiveDay, '2001-01-01'); assert.deepEqual(link.projection.original, link.operation.originalSnapshot.original);
  assert.equal(link.projection.effective.serialKey, f.item.result.serialNumber); assert.equal(link.operation.currentAssetId, null);
  assert.deepEqual(await operational(f), original); assert.deepEqual(await stored(f), { receipts: 1, links: 1, audits: 1 });
  const planned = await post(f.url, input.plan); assert.equal(planned.statusCode, 200, planned.body);
  assert.ok(planned.json().operations[0].blockers.includes('GROUP_HISTORY_LINK_ALREADY_SAVED'));
  assert.equal(planned.json().operations[0].savedGroupLink.id, link.id);
});

test('group history receipt detail and metadata pages remain scoped, paginated and recoverable after cancellation and asset changes', async () => {
  const f = await prepare(); const input = await confirmation(f); const response = await apply(f, input); assert.equal(response.statusCode, 201, response.body);
  const application = response.json().application; const list = await get(receipts(f) + '?limit=1&offset=0'); assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().total, 1); assert.equal(list.json().applications[0]._count.links, 1); assert.equal(list.json().applications[0].plan, undefined);
  assert.equal((await get(receipts(f) + '?offset=1')).json().applications.length, 0);
  for (const role of ['SOPORTE', 'COORDINADOR']) assert.equal((await get(receipts(f), role)).statusCode, 403);
  const detail = receipts(f) + '/' + application.id;
  for (const id of [f.batch.id, f.review.id, f.application.id, f.item.id, application.id]) assert.equal((await get(detail.replace(id, randomUUID()))).statusCode, 404);
  assert.equal((await get(detail + '?force=true')).statusCode, 400);
  assert.equal((await get(receipts(f) + '?limit=101')).statusCode, 400);
  assert.equal((await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Release administrative reservation' })).statusCode, 201);
  await database.asset.update({ where: { id: f.item.assetId }, data: { serialNumber: 'LATER-' + randomUUID(), location: 'Changed after confirmation' } });
  assert.deepEqual((await get(detail)).json().application, application);
  const retry = await apply(f, input); assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().reused, true); assert.deepEqual(retry.json().application, application);
});

test('group history idempotency binds actor and full intent and competing requests cannot duplicate evidence', async () => {
  const f = await prepare(); const input = await confirmation(f, true);
  const results = await Promise.all([apply(f, input), apply(f, { ...input, plan: { ...input.plan, operations: [...input.plan.operations].reverse() } })]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 201], results.map((response) => response.body).join('\n'));
  assert.deepEqual(await stored(f), { receipts: 1, links: 2, audits: 1 });
  assert.equal((await post(f.url + '/apply', input, 'OTHER_JEFE')).json().code, 'IDEMPOTENCY_KEY_REUSED');
  const changed = { ...input, plan: { ...input.plan, operations: [{ ...input.plan.operations[0], note: 'Other intent' }] } };
  assert.equal((await apply(f, changed)).json().code, 'IDEMPOTENCY_KEY_REUSED');
  const duplicate = await apply(f, { ...input, requestId: randomUUID() }); assert.equal(duplicate.statusCode, 409, duplicate.body); assert.equal(duplicate.json().code, 'GROUP_HISTORY_LINK_BLOCKED');
});

test('group history independently confirms omitted evidence later using a fresh plan without duplicating previous links', async () => {
  const f = await prepare(); const first = await confirmation(f); assert.equal((await apply(f, first)).statusCode, 201);
  const other = f.evidence.find((entry) => entry.id !== f.input.operations[0].evidenceId);
  f.input = { ...f.input, operations: [{ ...f.input.operations[0], evidenceId: other.id }] };
  const second = await confirmation(f); const result = await apply(f, second); assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.json().application.plan.omittedEvidence[0].savedGroupLink.version, 1);
  assert.deepEqual(await stored(f), { receipts: 2, links: 2, audits: 2 });
});

test('group history competing request keys serialize overlapping evidence into one confirmation', async () => {
  const f = await prepare(); const input = await confirmation(f);
  const results = await Promise.all([apply(f, input), apply(f, { ...input, requestId: randomUUID() })]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [201, 409], results.map((response) => response.body).join('\n'));
  assert.equal(results.find((response) => response.statusCode === 409).json().code, 'GROUP_HISTORY_LINK_BLOCKED');
  assert.deepEqual(await stored(f), { receipts: 1, links: 1, audits: 1 });
});

test('group history persists unknown dates and actors without substituting the confirmation timestamp', async () => {
  const f = await prepare({ knownDay: false }); const input = await confirmation(f); const original = await operational(f);
  const response = await apply(f, input); assert.equal(response.statusCode, 201, response.body); const link = response.json().application.links[0];
  assert.equal(link.projection.effectiveDay, null); assert.equal(link.projection.datePrecision, 'UNKNOWN'); assert.equal(link.projection.historicalActorId, null);
  assert.deepEqual(await operational(f), original);
});

test('group history may confirm a projection for an assigned or terminal target without changing current custody or terminal date', async () => {
  const assigned = await prepare();
  const delivered = await post('/assets/' + assigned.item.assetId + '/assignments', { personName: 'Current Custodian' }); assert.equal(delivered.statusCode, 201, delivered.body);
  const assignedState = await operational(assigned); assert.equal(assignedState.asset.status, 'ASSIGNED');
  const linkedAssigned = await apply(assigned, await confirmation(assigned)); assert.equal(linkedAssigned.statusCode, 201, linkedAssigned.body);
  assert.deepEqual(await operational(assigned), assignedState);
  const terminal = await prepare(); const retired = await post('/assets/' + terminal.item.assetId + '/decommission'); assert.equal(retired.statusCode, 200, retired.body);
  const terminalState = await operational(terminal); assert.equal(terminalState.asset.status, 'DECOMMISSIONED');
  const linkedTerminal = await apply(terminal, await confirmation(terminal)); assert.equal(linkedTerminal.statusCode, 201, linkedTerminal.body);
  assert.deepEqual(await operational(terminal), terminalState);
});

test('group history apply scopes every parent and rejects foreign split-group evidence before persisting', async () => {
  const f = await prepare({ split: true }); const input = await confirmation(f);
  for (const id of [f.batch.id, f.review.id, f.application.id, f.item.id]) assert.equal((await post(f.url.replace(id, randomUUID()) + '/apply', input)).statusCode, 404);
  const other = f.capture.items.find((entry) => !f.item.rows.some((row) => row.recordId === entry.recordId));
  const response = await apply(f, { ...input, plan: { ...input.plan, operations: [{ ...input.plan.operations[0], evidenceId: other.id }] } });
  assert.equal(response.statusCode, 404, response.body); assert.deepEqual(await stored(f), { receipts: 0, links: 0, audits: 0 });
});

test('group history validates warnings, current asset context and plan fingerprint again inside the write transaction', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await stored(f);
  const unacknowledged = { ...input, plan: { ...input.plan, operations: [{ ...input.plan.operations[0], acknowledgedWarnings: [] }] } };
  assert.equal((await apply(f, unacknowledged)).json().code, 'GROUP_HISTORY_LINK_BLOCKED');
  assert.equal((await apply(f, { ...input, historyLinkPlanId: 'f'.repeat(64) })).json().code, 'GROUP_HISTORY_LINK_PLAN_CHANGED');
  await database.asset.update({ where: { id: f.item.assetId }, data: { location: 'Requires fresh confirmation' } });
  assert.equal((await apply(f, input)).json().code, 'GROUP_HISTORY_LINK_PLAN_CHANGED');
  await database.asset.update({ where: { id: f.item.assetId }, data: { serialNumber: 'OTHER-' + randomUUID() } });
  assert.equal((await apply(f, input)).json().code, 'GROUP_HISTORY_LINK_BLOCKED'); assert.deepEqual(await stored(f), original);
});

test('group history can be confirmed after administrative cancellation without reopening candidate importers', async () => {
  const f = await prepare(); assert.equal((await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Release reservations only' })).statusCode, 201);
  const original = await operational(f); const response = await apply(f, await confirmation(f)); assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(await operational(f), original);
  const legacy = await post(f.base + '/plan', { expectedVersion: 1, expectedSourceRevision: 0, operations: [{ type: 'CREATE_ASSET', candidateId: f.preview.candidates[0].id,
    note: 'Not a bypass', confirmation: 'AVAILABLE_UNASSIGNED', values: { productId: product.id, serialNumber: 'LEGACY' } }] });
  assert.equal(legacy.json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
});

test('group history preserves current explicit-null amendment and rejects stale versions before creating a projection', async () => {
  const f = await prepare({ originalLink: true }); const id = f.evidence[0].id; const old = await confirmation(f);
  async function amend(assetId, version) {
    const plan = (await post('/inventory/imports/evidence/' + id + '/amendment-plan', { assetId })).json(); assert.equal(plan.valid, true);
    const response = await post('/inventory/imports/evidence/' + id + '/amendments', { requestId: randomUUID(), expectedEvidenceVersion: version,
      expectedBatchVersion: plan.batchVersion, expectedSourceRevision: plan.sourceRevision, amendmentPlanId: plan.amendmentPlanId,
      confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId, note: 'Reviewed archive link', evidenceReference: 'Archive documents' }); assert.equal(response.statusCode, 201, response.body);
    return response.json().event;
  }
  await amend(f.originalAsset.id, 0); assert.equal((await apply(f, old)).json().code, 'EVIDENCE_VERSION_CONFLICT');
  const amendment = await amend(null, 1); f.input.operations[0].expectedEvidenceVersion = 2;
  const original = await operational(f); const response = await apply(f, await confirmation(f)); assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().application.links[0].amendmentId, amendment.id); assert.equal(response.json().application.links[0].evidenceVersion, 2);
  assert.equal(response.json().application.links[0].operation.currentAssetId, null); assert.deepEqual(await operational(f), original);
  const blocked = await post('/inventory/imports/evidence/' + id + '/amendment-plan', { assetId: f.originalAsset.id });
  assert.ok(blocked.json().blockers.includes('GROUP_HISTORY_LINK_ALREADY_SAVED'));
  await assert.rejects(database.importEvidenceAmendment.create({ data: { ...amendment, id: randomUUID(), version: 3, previousAmendmentId: amendment.id, requestId: randomUUID() } }), /separate history correction/);
});

test('group history rolls back every projection and receipt if a later link or audit fails, keeping retry usable', async () => {
  const f = await prepare(); const input = await confirmation(f, true); const original = await operational(f);
  let created = 0;
  const failingLink = database.$extends({ query: { importGroupHistoryLink: { async create({ args, query }) {
    if (++created === 2) throw new Error('Second link failed'); return query(args);
  } } } });
  await assert.rejects(applyGroupHistoryLinks(failingLink, f.batch.id, f.review.id, f.application.id, f.item.id, groupHistoryApplySchema.parse(input), users.JEFE.id), /Second link failed/);
  const failingAudit = database.$extends({ query: { auditLog: { async create() { throw new Error('Audit failed'); } } } });
  await assert.rejects(applyGroupHistoryLinks(failingAudit, f.batch.id, f.review.id, f.application.id, f.item.id, groupHistoryApplySchema.parse(input), users.JEFE.id), /Audit failed/);
  assert.deepEqual(await stored(f), { receipts: 0, links: 0, audits: 0 }); assert.deepEqual(await operational(f), original);
  assert.equal((await apply(f, input)).statusCode, 201);
});

test('group history SQL guards reject missing coverage, missing audit and forged projection data without trusting API validation', async () => {
  const f = await prepare(); const input = await confirmation(f, true); const original = await operational(f);
  const invoke = (client) => applyGroupHistoryLinks(client, f.batch.id, f.review.id, f.application.id, f.item.id, groupHistoryApplySchema.parse(input), users.JEFE.id);
  let count = 0;
  const missing = database.$extends({ query: { importGroupHistoryLink: { async create({ args, query }) { return ++count === 2 ? null : query(args); } } } });
  await assert.rejects(invoke(missing), /exactly one immutable history link/);
  const noAudit = database.$extends({ query: { auditLog: { async create() { return null; } } } });
  await assert.rejects(invoke(noAudit), /atomic audit record/);
  for (const corrupt of [
    (data) => ({ ...data, assetId: randomUUID() }),
    (data) => ({ ...data, evidenceVersion: 1 }),
    (data) => ({ ...data, projection: { ...data.projection, historicalActorId: users.JEFE.id } }),
    (data) => ({ ...data, projection: { ...data.projection, effectiveDay: '2026-01-01' } }),
    (data) => ({ ...data, projection: { ...data.projection, original: {} } })
  ]) {
    const client = database.$extends({ query: { importGroupHistoryLink: { async create({ args, query }) { return query({ ...args, data: corrupt(args.data) }); } } } });
    await assert.rejects(invoke(client));
  }
  assert.deepEqual(await operational(f), original); assert.deepEqual(await stored(f), { receipts: 0, links: 0, audits: 0 });
});

test('group history SQL receipts and links are immutable and direct empty or unauthorized receipts cannot commit', async () => {
  const f = await prepare(); const input = await confirmation(f); const saved = await apply(f, input); assert.equal(saved.statusCode, 201, saved.body);
  const receipt = saved.json().application; const link = receipt.links[0];
  await assert.rejects(database.importGroupHistoryApplication.update({ where: { id: receipt.id }, data: { appliedById: users.OTHER_JEFE.id } }), /immutable/);
  await assert.rejects(database.importGroupHistoryApplication.delete({ where: { id: receipt.id } }), /immutable/);
  await assert.rejects(database.importGroupHistoryLink.update({ where: { id: link.id }, data: { version: 1 } }), /immutable/);
  await assert.rejects(database.importGroupHistoryLink.delete({ where: { id: link.id } }), /immutable/);
  const other = await prepare(); const otherInput = await confirmation(other); const plan = (await post(other.url, otherInput.plan)).json();
  const data = { itemId: other.item.id, requestId: randomUUID(), requestDigest: 'e'.repeat(64), planId: plan.historyLinkPlanId,
    rulesVersion: 'mda-group-history-link-application-1', plan, appliedById: users.JEFE.id };
  await assert.rejects(database.$transaction((tx) => tx.importGroupHistoryApplication.create({ data })), /exactly one immutable/);
  await assert.rejects(database.$transaction((tx) => tx.importGroupHistoryApplication.create({ data: { ...data, appliedById: users.SOPORTE.id } })), /configured JEFE/);
  await assert.rejects(database.$transaction((tx) => tx.importGroupHistoryApplication.create({ data }), { isolationLevel: 'RepeatableRead' }), /require READ COMMITTED/);
});

test('group history deferred guard detects context mutations later in its own transaction and rolls them back', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await operational(f);
  const plan = (await post(f.url, input.plan)).json();
  await assert.rejects(database.$transaction(async (tx) => {
    const receipt = await tx.importGroupHistoryApplication.create({ data: { itemId: f.item.id, requestId: input.requestId,
      requestDigest: groupHistoryApplyDigest(groupHistoryApplySchema.parse(input)), planId: plan.historyLinkPlanId,
      rulesVersion: 'mda-group-history-link-application-1', plan, appliedById: users.JEFE.id } });
    const operation = plan.operations[0];
    await tx.importGroupHistoryLink.create({ data: { historyApplicationId: receipt.id, evidenceId: operation.evidenceId, assetId: f.item.assetId,
      evidenceVersion: 0, amendmentId: null, sourceRevision: 0, operation, projection: buildGroupHistoryProjection(operation, f.item.id) } });
    await tx.auditLog.create({ data: { userId: users.JEFE.id, action: 'IMPORT_GROUP_HISTORY_LINKS_SAVED', entityType: 'ImportGroupHistoryApplication', entityId: receipt.id } });
    await tx.asset.update({ where: { id: f.item.assetId }, data: { location: 'Changed while constructing receipt' } });
  }), /cannot change while constructing/);
  assert.deepEqual(await operational(f), original); assert.deepEqual(await stored(f), { receipts: 0, links: 0, audits: 0 });
});

test('group history busy inventory is recoverable without partial writes and missing storage returns 503', async () => {
  const f = await prepare(); const input = await confirmation(f);
  let ready; const locked = new Promise((resolve) => { ready = resolve; }); let release; const done = new Promise((resolve) => { release = resolve; });
  const holder = database.$transaction(async (tx) => { await tx.$executeRawUnsafe('LOCK TABLE "Asset" IN ROW EXCLUSIVE MODE'); ready(); await done; }, { timeout: 10000 });
  await locked;
  try { const result = await apply(f, input); assert.equal(result.statusCode, 409, result.body); assert.equal(result.json().code, 'GROUP_HISTORY_LINK_BUSY'); }
  finally { release(); await holder; }
  const missing = database.$extends({ query: { importGroupHistoryApplication: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing history storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportGroupHistoryApplication' } });
  } } } }); const instance = buildApp(missing);
  try { const result = await apply(f, input, instance); assert.equal(result.statusCode, 503, result.body); assert.equal(result.json().code, 'IMPORT_REVIEW_NOT_READY'); }
  finally { await instance.close(); }
  assert.deepEqual(await stored(f), { receipts: 0, links: 0, audits: 0 }); assert.equal((await apply(f, input)).statusCode, 201);
});

test('group history locks prevent concurrent archive amendments and do not rewrite pinned explicit-null versions', async () => {
  const f = await prepare({ originalLink: true }); const input = await confirmation(f);
  let reached; const ready = new Promise((resolve) => { reached = resolve; }); let proceed; const gate = new Promise((resolve) => { proceed = resolve; });
  const gated = database.$extends({ query: { importGroupHistoryApplication: { async create({ args, query }) { reached(); await gate; return query(args); } } } });
  const applying = applyGroupHistoryLinks(gated, f.batch.id, f.review.id, f.application.id, f.item.id, groupHistoryApplySchema.parse(input), users.JEFE.id);
  await ready;
  const amendmentPlan = (await post('/inventory/imports/evidence/' + f.evidence[0].id + '/amendment-plan', { assetId: f.originalAsset.id })).json();
  const amending = post('/inventory/imports/evidence/' + f.evidence[0].id + '/amendments', { requestId: randomUUID(), expectedEvidenceVersion: 0,
    expectedBatchVersion: amendmentPlan.batchVersion, expectedSourceRevision: amendmentPlan.sourceRevision, amendmentPlanId: amendmentPlan.amendmentPlanId,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: f.originalAsset.id, note: 'Concurrent archive intent', evidenceReference: 'Original archive' });
  proceed(); const result = await applying; assert.equal(result.application.links[0].evidenceVersion, 0);
  const rejected = await amending; assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: f.evidence[0].id } }), 0);
});

test('group history amendment guard rejects an old repeatable-read snapshot after a concurrent link commits', async () => {
  const f = await prepare({ originalLink: true }); const input = await confirmation(f); const id = f.evidence[0].id;
  const planned = await post('/inventory/imports/evidence/' + id + '/amendment-plan', { assetId: f.originalAsset.id });
  assert.equal(planned.statusCode, 200, planned.body); const plan = planned.json(); assert.equal(plan.valid, true);
  let reached; const ready = new Promise((resolve) => { reached = resolve; }); let proceed; const gate = new Promise((resolve) => { proceed = resolve; });
  const amending = database.$transaction(async (tx) => {
    const previous = await tx.importGroupHistoryLink.count({ where: { evidenceId: id } }); assert.equal(previous, 0); reached(); await gate;
    return tx.importEvidenceAmendment.create({ data: { evidenceId: id, version: 1, previousAmendmentId: null,
      batchVersion: plan.batchVersion, sourceRevision: plan.sourceRevision, requestId: randomUUID(), requestDigest: 'e'.repeat(64),
      amendmentPlanId: plan.amendmentPlanId, rulesVersion: 'mda-history-amendment-1', assetId: f.originalAsset.id,
      effectiveDay: plan.proposed.effectiveDay, snapshot: plan.proposed, note: 'Old snapshot cannot override group projection',
      evidenceReference: 'Concurrent archive review', amendedById: users.JEFE.id } });
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 });
  const rejected = assert.rejects(amending, /require READ COMMITTED/);
  await ready;
  try { const saved = await apply(f, input); assert.equal(saved.statusCode, 201, saved.body); }
  finally { proceed(); }
  await rejected; assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
  assert.deepEqual(await stored(f), { receipts: 1, links: 1, audits: 1 });
});

test('group history migration is additive over populated legacy tables and leaves the old evidence view unchanged', async () => {
  const f = await prepare(); const original = await operational(f);
  const migration = readFileSync(new URL('../../../prisma/migrations/0026_import_group_history_links/migration.sql', import.meta.url), 'utf8');
  assert.ok(migration.startsWith('BEGIN;')); assert.ok(migration.trim().endsWith('COMMIT;'));
  assert.equal(/^\s*(DELETE|TRUNCATE|DROP|CREATE OR REPLACE VIEW)\b/m.test(migration), false);
  class RollbackTest extends Error {}
  await assert.rejects(database.$transaction(async (tx) => {
    const schema = 'group_history_migration_' + randomUUID().replaceAll('-', ''); await tx.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    for (const table of ['User', 'Asset', 'ImportIdentityGroupApplicationItem', 'ImportHistoricalEvidence', 'ImportEvidenceAmendment']) {
      await tx.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await tx.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await tx.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '", public');
    const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
    assert.equal(statements.length, 16); for (const statement of statements) await tx.$executeRawUnsafe(statement);
    assert.deepEqual(await tx.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportGroupHistoryApplication") AS receipts, (SELECT count(*)::integer FROM "ImportGroupHistoryLink") AS links`, [{ receipts: 0, links: 0 }]);
    throw new RollbackTest();
  }, { timeout: 15000 }), (error) => error instanceof RollbackTest);
  assert.deepEqual(await operational(f), original);
});

after(async () => { await app.close(); });
