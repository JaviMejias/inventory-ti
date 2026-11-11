import './require-test-database.js';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { appendReviewDecision, createImportBatch } from '../src/imports/review-service.js';
import { hashPassword } from '../src/lib/password.js';
import { mergeWorkbooks, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8);
const fixtureProductIds = [];
// Keep real PostgreSQL behavior, but isolate snapshot reads from other files' concurrent fixtures.
const database = new PrismaClient().$extends({ query: { asset: {
  async findMany({ args, query }) {
    return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: fixtureProductIds } }] } });
  }
} } });
const app = buildApp(database);
const password = 'Import-review-password-123';
const cookies = {};
const users = {};
let existingAsset;

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `review-${role.toLowerCase()}-${suffix}`;
    users[role] = await database.user.create({ data: { username, displayName: `Review ${role}`, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(login.statusCode, 200);
    const header = login.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  const product = await database.product.create({ data: { name: `Review fixture ${suffix}`, trackingMode: 'ASSET' } });
  fixtureProductIds.push(product.id);
  existingAsset = await database.asset.create({ data: { productId: product.id, serialNumber: `REVIEW-${suffix}`, assetTag: `TAG-${suffix}` } });
});

async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role];
  const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}

function read(url, role = 'JEFE') {
  return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } });
}

async function prepare(extraRows = [], standalone = false) {
  const input = workbook('Recepción', [receptionRow(4, existingAsset.serialNumber, { G: textCell(existingAsset.assetTag) }), receptionRow(5, `NEW-${randomUUID()}`), ...extraRows]);
  const complete = standalone ? mergeWorkbooks(input, workbook('Tintas', [{ row: 4, cells: { C: textCell('PRINTER-01'), D: textCell('Cyan') } }]), workbook('Disponible', [{ row: 3, cells: { B: textCell('Notebook'), C: { type: 'number', value: 11 } } }])) : input;
  const previewResponse = await post('/inventory/imports/preview', complete);
  assert.equal(previewResponse.statusCode, 200);
  const preview = previewResponse.json();
  const saved = await post('/inventory/imports/batches', { workbook: complete, previewId: preview.previewId });
  assert.equal(saved.statusCode, 201, saved.body);
  return { input: complete, preview, batch: saved.json().batch };
}

function decision(target, overrides = {}) {
  return { expectedVersion: 1, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: target.id, action: 'HOLD', note: 'Pending review', ...overrides };
}

test('staging and review routes require JEFE; writes require CSRF', async () => {
  const prepared = await prepare();
  const body = { workbook: prepared.input, previewId: prepared.preview.previewId };
  assert.equal((await app.inject({ method: 'POST', url: '/inventory/imports/batches', payload: body })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) {
    assert.equal((await post('/inventory/imports/batches', body, role)).statusCode, 403);
    for (const path of ['', `/${prepared.batch.id}`, `/${prepared.batch.id}/preview`, `/${prepared.batch.id}/freshness`, `/${prepared.batch.id}/decisions`]) assert.equal((await read('/inventory/imports/batches' + path, role)).statusCode, 403);
    assert.equal((await post(`/inventory/imports/batches/${prepared.batch.id}/decisions`, decision(prepared.preview.candidates[0]), role)).statusCode, 403);
  }
  assert.equal((await post('/inventory/imports/batches', body, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(`/inventory/imports/batches/${prepared.batch.id}/decisions`, decision(prepared.preview.candidates[0]), 'JEFE', false)).statusCode, 403);
});

test('a staged source is immutable, recoverable and saved only once for the same preview', async () => {
  const prepared = await prepare([], true);
  const replay = await post('/inventory/imports/batches', { workbook: prepared.input, previewId: prepared.preview.previewId });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().reused, true);
  assert.equal(replay.json().batch.id, prepared.batch.id);
  assert.equal(prepared.batch.version, 1);
  assert.equal(prepared.batch.targetCount, 4);
  assert.equal(prepared.batch.canApply, false);
  assert.equal(prepared.batch.persisted, true);
  const snapshot = await read(`/inventory/imports/batches/${prepared.batch.id}/preview`);
  assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(snapshot.json().snapshot, prepared.preview);
  const detail = (await read(`/inventory/imports/batches/${prepared.batch.id}`)).json();
  assert.equal(detail.reviewSummary.unreviewedCount, 4);
  assert.equal(detail.reviewSummary.decisionCoverageComplete, false);
  assert.equal(detail.snapshot, undefined);
  assert.equal(await database.auditLog.count({ where: { entityId: prepared.batch.id, action: 'IMPORT_BATCH_STAGED' } }), 1);
  await assert.rejects(database.importBatch.update({ where: { id: prepared.batch.id }, data: { sourceFileName: 'Altered.xlsx' } }));
  await assert.rejects(database.importBatch.delete({ where: { id: prepared.batch.id } }));
});

test('creation is idempotent under simultaneous saves and refuses a modified payload', async () => {
  const input = workbook('Recepción', [receptionRow(4, `CONCURRENT-${randomUUID()}`)]);
  const preview = (await post('/inventory/imports/preview', input)).json();
  const results = await Promise.all([post('/inventory/imports/batches', { workbook: input, previewId: preview.previewId }), post('/inventory/imports/batches', { workbook: input, previewId: preview.previewId })]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 201]);
  assert.equal(results[0].json().batch.id, results[1].json().batch.id);
  assert.equal(await database.auditLog.count({ where: { entityId: results[0].json().batch.id } }), 1);
  input.sheets[0].rows[1].cells.E.value = 'Changed model';
  assert.equal((await post('/inventory/imports/batches', { workbook: input, previewId: preview.previewId })).json().code, 'PREVIEW_PAYLOAD_CONFLICT');
});

test('staging accepts a bounded large source but list/detail metadata do not repeat its cell contents', async () => {
  const rows = Array.from({ length: 190 }, (_, index) => receptionRow(index + 6, `BULK-${suffix}-${index}`, { L: textCell('x'.repeat(8192)) }));
  const prepared = await prepare(rows);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.input)) > 1024 * 1024);
  assert.equal(prepared.batch.targetCount, 192);
  const detail = (await read(`/inventory/imports/batches/${prepared.batch.id}`)).json();
  assert.equal(detail.reviewSummary.unreviewedCount, 192);
  assert.equal(detail.batch.workbook, undefined);
  assert.equal(detail.batch.preview, undefined);
  assert.equal(detail.snapshot, undefined);
});

test('revisions are append-only, latest/history are paginated and duplicate requests do not append', async () => {
  const { batch, preview } = await prepare();
  const body = decision(preview.candidates[0]);
  const first = await post(`/inventory/imports/batches/${batch.id}/decisions`, body);
  assert.equal(first.statusCode, 201, first.body);
  const replay = await post(`/inventory/imports/batches/${batch.id}/decisions`, body);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().decision.id, first.json().decision.id);
  const changedKey = await post(`/inventory/imports/batches/${batch.id}/decisions`, { ...body, note: 'Different intent' });
  assert.equal(changedKey.json().code, 'IDEMPOTENCY_KEY_REUSED');
  const second = await post(`/inventory/imports/batches/${batch.id}/decisions`, { ...body, requestId: randomUUID(), expectedVersion: 2, action: 'EXCLUDE', note: 'Do not load this group' });
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().batch.version, 3);
  const latest = (await read(`/inventory/imports/batches/${batch.id}/decisions`)).json();
  assert.equal(latest.total, 1);
  assert.equal(latest.decisions[0].action, 'EXCLUDE');
  const history = (await read(`/inventory/imports/batches/${batch.id}/decisions?mode=history&limit=1`)).json();
  assert.equal(history.total, 2);
  assert.equal(history.hasMore, true);
  const page2 = (await read(`/inventory/imports/batches/${batch.id}/decisions?mode=history&limit=1&offset=1`)).json();
  assert.equal(page2.decisions[0].id, first.json().decision.id);
  const detail = (await read(`/inventory/imports/batches/${batch.id}`)).json();
  assert.equal(detail.reviewSummary.excludedCount, 1);
  assert.equal(detail.reviewSummary.holdCount, 0);
  assert.equal(detail.reviewSummary.pendingTargetCount, 1);
  await assert.rejects(database.importReviewDecision.update({ where: { id: first.json().decision.id }, data: { note: 'Rewritten history' } }));
  await assert.rejects(database.importReviewDecision.delete({ where: { id: first.json().decision.id } }));
});

test('two writers cannot overwrite the same review version', async () => {
  const { batch, preview } = await prepare();
  const responses = await Promise.all(preview.candidates.map((candidate) => post(`/inventory/imports/batches/${batch.id}/decisions`, decision(candidate))));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'REVIEW_VERSION_CONFLICT');
  assert.equal(await database.importReviewDecision.count({ where: { batchId: batch.id } }), 1);
  assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).version, 2);
});

test('stand-alone tintas and summaries support hold/exclude, not fake assets or overlapping record decisions', async () => {
  const { batch, preview } = await prepare([], true);
  const record = preview.records.find((record) => record.kind === 'CONSUMABLE_REVIEW');
  const response = await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(record, { targetType: 'RECORD', action: 'EXCLUDE', note: 'Unit not confirmed' }));
  assert.equal(response.statusCode, 201);
  const invalid = await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(record, { targetType: 'RECORD', action: 'PROPOSE_NEW', expectedVersion: 2 }));
  assert.equal(invalid.statusCode, 400);
  const physicalRecord = preview.records.find((record) => record.kind === 'ASSET_OBSERVATION');
  assert.equal((await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(physicalRecord, { targetType: 'RECORD', expectedVersion: 2 }))).json().code, 'INVALID_REVIEW_TARGET');
  assert.equal((await post(`/inventory/imports/batches/${batch.id}/decisions`, decision({ id: 'f'.repeat(64) }, { expectedVersion: 2 }))).json().code, 'INVALID_REVIEW_TARGET');
});

test('identity proposals stay separate from operational assets, assignments and stock', async () => {
  const { batch, preview } = await prepare();
  const matched = preview.candidates.find((candidate) => candidate.existingAssets.length === 1);
  const newCandidate = preview.candidates.find((candidate) => candidate.existingAssets.length === 0);
  const beforeAsset = await database.asset.findUniqueOrThrow({ where: { id: existingAsset.id } });
  const counts = () => Promise.all([
    database.asset.count({ where: { productId: existingAsset.productId } }), database.assignment.count({ where: { assetId: existingAsset.id } }),
    database.inventoryStock.count({ where: { productId: existingAsset.productId } }), database.inventoryMovement.count({ where: { productId: existingAsset.productId } })
  ]);
  const beforeCounts = await counts();
  assert.equal((await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(matched, { action: 'PROPOSE_NEW' }))).json().code, 'NEW_ASSET_PROPOSAL_CONFLICT');
  assert.equal((await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(matched, { action: 'LINK_EXISTING', linkedAssetId: randomUUID() }))).json().code, 'ASSET_NOT_SUGGESTED');
  const linked = await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(matched, { action: 'LINK_EXISTING', linkedAssetId: existingAsset.id, note: 'Identity linked for later review' }));
  assert.equal(linked.statusCode, 201, linked.body);
  const proposed = await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(newCandidate, { expectedVersion: 2, action: 'PROPOSE_NEW' }));
  assert.equal(proposed.statusCode, 201, proposed.body);
  const detail = (await read(`/inventory/imports/batches/${batch.id}`)).json();
  assert.equal(detail.reviewSummary.decisionCoverageComplete, true);
  assert.equal(detail.batch.canApply, false);
  assert.deepEqual(await counts(), beforeCounts);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: existingAsset.id } }), beforeAsset);
  assert.equal((await post('/inventory/imports/apply', { batchId: batch.id })).statusCode, 404);
});

test('a changed inventory snapshot blocks identity proposals but retains earlier evidence and save retries', async () => {
  const { batch, preview, input } = await prepare();
  const candidate = preview.candidates.find((candidate) => candidate.existingAssets.length === 1);
  await database.asset.update({ where: { id: existingAsset.id }, data: { notes: 'Operational change after preview' } });
  const freshness = (await read(`/inventory/imports/batches/${batch.id}/freshness`)).json();
  assert.equal(freshness.stale, true);
  assert.equal(freshness.databaseChanged, true);
  const recovered = await post('/inventory/imports/batches', { workbook: input, previewId: preview.previewId });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().batch.id, batch.id);
  assert.equal(recovered.json().reused, true);
  const blocked = await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(candidate, { action: 'LINK_EXISTING', linkedAssetId: existingAsset.id }));
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, 'BATCH_SNAPSHOT_STALE');
  const hold = await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(candidate, { note: 'Snapshot outdated; keep pending' }));
  assert.equal(hold.statusCode, 201);
  assert.deepEqual((await read(`/inventory/imports/batches/${batch.id}/preview`)).json().snapshot, preview);
});

test('an unstaged preview cannot be saved after a database change', async () => {
  const input = workbook('Recepción', [receptionRow(4, `UNSTAGED-${randomUUID()}`)]);
  const preview = (await post('/inventory/imports/preview', input)).json();
  await database.asset.update({ where: { id: existingAsset.id }, data: { notes: 'Changed before staging' } });
  const rejected = await post('/inventory/imports/batches', { workbook: input, previewId: preview.previewId });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, 'PREVIEW_STALE');
  assert.equal(await database.importBatch.count({ where: { previewId: preview.previewId } }), 0);
});

test('database guards require a review event for each increment and validate decision targets', async () => {
  const { batch, preview } = await prepare();
  await assert.rejects(database.importBatch.update({ where: { id: batch.id }, data: { version: { increment: 1 } } }));
  assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).version, 1);
  await assert.rejects(database.$transaction(async (transaction) => {
    await transaction.importBatch.update({ where: { id: batch.id }, data: { version: { increment: 1 } } });
    await transaction.importReviewDecision.create({ data: { batchId: batch.id, batchVersion: 2, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: 'f'.repeat(64), action: 'HOLD', note: 'Invalid direct target', reviewedById: users.JEFE.id } });
  }));
  const response = await post(`/inventory/imports/batches/${batch.id}/decisions`, decision(preview.candidates[0]));
  assert.equal(response.statusCode, 201);
});

function failingAuditDatabase() {
  return new Proxy(database, { get(target, property) {
    if (property === '$transaction') return (operation, options) => target.$transaction((transaction) => operation(new Proxy(transaction, { get(inner, key) {
      if (key === 'auditLog') return { create: async () => { throw new Error('Simulated audit failure'); } };
      const value = Reflect.get(inner, key);
      return typeof value === 'function' ? value.bind(inner) : value;
    } })), options);
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('audit failures roll back both staged creation and appended review/version', async () => {
  const { batch, preview } = await prepare();
  await assert.rejects(appendReviewDecision(failingAuditDatabase(), batch.id, decision(preview.candidates[0]), users.JEFE.id), /Simulated audit failure/);
  assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).version, 1);
  assert.equal(await database.importReviewDecision.count({ where: { batchId: batch.id } }), 0);
  const input = workbook('Recepción', [receptionRow(4, `ROLLBACK-${randomUUID()}`)]);
  const freshPreview = (await post('/inventory/imports/preview', input)).json();
  await assert.rejects(createImportBatch(failingAuditDatabase(), { workbook: input, previewId: freshPreview.previewId }, users.JEFE.id), /Simulated audit failure/);
  assert.equal(await database.importBatch.count({ where: { previewId: freshPreview.previewId } }), 0);
});

test('batch lists, decision filters and missing resources have bounded explicit contracts', async () => {
  const { batch } = await prepare();
  const listed = await read(`/inventory/imports/batches?sourceHash=${batch.sourceHash}&limit=1`);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().batches.length, 1);
  assert.equal(listed.json().hasMore, true);
  assert.equal(listed.json().batches[0].preview, undefined);
  assert.equal((await read('/inventory/imports/batches?limit=101')).statusCode, 400);
  assert.equal((await read(`/inventory/imports/batches/${batch.id}/decisions?targetId=${'a'.repeat(64)}`)).statusCode, 400);
  for (const path of ['', '/preview', '/freshness', '/decisions']) assert.equal((await read(`/inventory/imports/batches/${randomUUID()}${path}`)).statusCode, 404);
});

after(async () => { await app.close(); });
