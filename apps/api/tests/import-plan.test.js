import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
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
let product;

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `pilot-${role.toLowerCase()}-${suffix}`;
    const password = 'Pilot-password-123';
    await database.user.create({ data: { username, displayName: `Pilot ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Pilot ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});

async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role];
  const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}

async function prepare(existing = false) {
  const serial = `PILOT-${randomUUID()}`;
  const asset = existing ? await database.asset.create({ data: { productId: product.id, serialNumber: serial, location: 'Old storage' } }) : null;
  const source = workbook('Recepción', [receptionRow(4, serial, { K: textCell('Disponible') })]);
  const preview = (await post('/inventory/imports/preview', source)).json();
  const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId });
  assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch;
  const candidate = preview.candidates[0];
  const review = { expectedVersion: 1, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: candidate.id,
    action: existing ? 'LINK_EXISTING' : 'PROPOSE_NEW', ...(existing ? { linkedAssetId: asset.id } : {}), note: 'Physical identity checked' };
  const reviewed = await post(`/inventory/imports/batches/${batch.id}/decisions`, review);
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  const input = { expectedVersion: 2, operations: [existing
    ? { type: 'UPDATE_METADATA', candidateId: candidate.id, assetId: asset.id, note: 'Verified location', values: { location: 'New storage' } }
    : { type: 'CREATE_ASSET', candidateId: candidate.id, confirmation: 'AVAILABLE_UNASSIGNED', note: 'Availability checked', values: { productId: product.id, serialNumber: serial } }] };
  return { batch, candidate, asset, input, url: `/inventory/imports/batches/${batch.id}/plan` };
}

test('pilot route requires JEFE and CSRF, rejects invented operations and unknown batches', async () => {
  const { input, url } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url, { ...input, canApply: true })).statusCode, 400);
  assert.equal((await post(url, { ...input, operations: [{ ...input.operations[0], candidateId: 'f'.repeat(64) }] })).json().code, 'INVALID_REVIEW_TARGET');
  assert.equal((await post(`/inventory/imports/batches/${randomUUID()}/plan`, input)).statusCode, 404);
});

test('new asset pilot is deterministic and strictly read-only including staging/audit', async () => {
  const { input, url, batch } = await prepare();
  const counts = async () => Promise.all([
    database.asset.count({ where: { productId: product.id } }), database.assignment.count({ where: { asset: { productId: product.id } } }),
    database.inventoryStock.count({ where: { productId: product.id } }), database.inventoryMovement.count({ where: { productId: product.id } }),
    database.importBatch.count({ where: { id: batch.id } }), database.importReviewDecision.count({ where: { batchId: batch.id } }),
    database.auditLog.count({ where: { entityId: batch.id } })
  ]);
  const before = await counts();
  const response = await post(url, input);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.planValidationComplete, true);
  assert.equal(result.canApply, false);
  assert.equal(result.persisted, false);
  assert.equal(result.summary.createCount, 1);
  assert.equal((await post(url, input)).json().planId, result.planId);
  assert.deepEqual(await counts(), before);
  assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).version, 2);
});

test('metadata pilot reports before/after without changing the linked asset or status', async () => {
  const { input, url, asset } = await prepare(true);
  const before = await database.asset.findUniqueOrThrow({ where: { id: asset.id } });
  const response = await post(url, input);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().planValidationComplete, true);
  assert.deepEqual(response.json().operations[0].changes, [{ field: 'location', before: 'Old storage', after: 'New storage' }]);
  assert.equal(response.json().operations[0].resultingStatus, before.status);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), before);
  assert.equal((await post(url, { ...input, operations: [{ ...input.operations[0], values: { serialNumber: 'new' } }] })).statusCode, 400);
});

test('a later exclusion replaces an older proposal and invalidates old review versions', async () => {
  const { batch, candidate, input, url } = await prepare();
  const response = await post(`/inventory/imports/batches/${batch.id}/decisions`, { expectedVersion: 2, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: candidate.id, action: 'EXCLUDE', note: 'Removed from pilot' });
  assert.equal(response.statusCode, 201);
  assert.equal((await post(url, input)).json().code, 'REVIEW_VERSION_CONFLICT');
  const current = (await post(url, { ...input, expectedVersion: 3 })).json();
  assert.equal(current.planValidationComplete, false);
  assert.ok(current.operations[0].blockers.some((entry) => entry.code === 'NEW_ASSET_REVIEW_REQUIRED'));
});

test('catalog state changes affect plan fingerprint even when the preview identity snapshot is unchanged', async () => {
  const { input, url } = await prepare();
  const first = (await post(url, input)).json();
  await database.product.update({ where: { id: product.id }, data: { isActive: false } });
  try {
    const blocked = (await post(url, input)).json();
    assert.equal(blocked.planValidationComplete, false);
    assert.notEqual(blocked.planId, first.planId);
    assert.ok(blocked.operations[0].blockers.some((entry) => entry.code === 'PRODUCT_INACTIVE'));
  } finally {
    await database.product.update({ where: { id: product.id }, data: { isActive: true } });
  }
});

test('changed operational metadata makes an old snapshot stale and changes the dry-run fingerprint', async () => {
  const { input, url, asset } = await prepare(true);
  const first = (await post(url, input)).json();
  await database.asset.update({ where: { id: asset.id }, data: { location: 'Concurrently changed', updatedAt: new Date(Date.now() + 1000) } });
  const response = await post(url, input);
  assert.equal(response.statusCode, 200);
  const blocked = response.json();
  assert.equal(blocked.freshness.databaseChanged, true);
  assert.equal(blocked.planValidationComplete, false);
  assert.notEqual(blocked.planId, first.planId);
  assert.equal(blocked.operations[0].changes[0].before, 'Concurrently changed');
  assert.ok(blocked.operations[0].blockers.some((entry) => entry.code === 'BATCH_SNAPSHOT_STALE'));
});

after(async () => { await app.close(); });
