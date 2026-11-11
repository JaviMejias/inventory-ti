import './require-test-database.js';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { deserialize, serialize } from 'node:v8';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { numberCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const database = new PrismaClient();
const app = buildApp(database);
const suffix = randomUUID().slice(0, 8);
const password = 'Preview-test-password-123';
const cookies = {};
let product;
let asset;
let input;

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `preview-${role.toLowerCase()}-${suffix}`;
    await database.user.create({ data: { username, displayName: `Preview ${role}`, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(login.statusCode, 200);
    const header = login.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Preview product ${suffix}`, trackingMode: 'ASSET' } });
  asset = await database.asset.create({ data: { productId: product.id, serialNumber: `PREVIEW-${suffix}`, assetTag: `TAG-${suffix}` } });
  input = workbook('Recepción', [receptionRow(4, asset.serialNumber, { G: textCell(asset.assetTag), H: numberCell(123456), K: textCell('Disponible') })]);
});

async function requestPreview(payload = input, role = 'JEFE', csrf = true) {
  const cookie = cookies[role];
  const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url: '/inventory/imports/preview', headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}

test('workbook preview requires JEFE authentication and CSRF', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/inventory/imports/preview', payload: input })).statusCode, 401);
  assert.equal((await requestPreview(input, 'COORDINADOR')).statusCode, 403);
  assert.equal((await requestPreview(input, 'SOPORTE')).statusCode, 403);
  assert.equal((await requestPreview(input, 'JEFE', false)).statusCode, 403);
  assert.equal((await requestPreview()).statusCode, 200);
});

test('workbook preview matches existing assets without modifying the operational domain', async () => {
  const beforeAsset = await database.asset.findUniqueOrThrow({ where: { id: asset.id } });
  const counts = () => Promise.all([
    database.asset.count({ where: { productId: product.id } }),
    database.assignment.count({ where: { assetId: asset.id } }),
    database.inventoryStock.count({ where: { productId: product.id } }),
    database.inventoryMovement.count({ where: { productId: product.id } }),
    database.auditLog.count({ where: { entityId: { in: [asset.id, product.id] } } })
  ]);
  const beforeCounts = await counts();
  const response = await requestPreview();
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.mode, 'PREVIEW');
  assert.equal(result.comparisonMode, 'DATABASE');
  assert.equal(result.canApply, false);
  assert.equal(result.persisted, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].proposal, 'REVIEW_EXISTING');
  assert.equal(result.candidates[0].existingAssets[0].id, asset.id);
  assert.equal(result.records[0].fields.incomingTicket, '123456');
  assert.equal(result.records[0].originalCells.H.type, 'number');
  assert.deepEqual(await counts(), beforeCounts);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), beforeAsset);
  assert.equal((await app.inject({ method: 'POST', url: '/inventory/imports/apply', headers: { cookie: cookies.JEFE }, payload: { previewId: result.previewId } })).statusCode, 404);
});

test('workbook preview refuses malformed envelopes and does not expose supplied data in errors', async () => {
  const secret = 'PRIVATE-WORKBOOK-VALUE';
  const invalid = { ...input, source: { ...input.source, fileName: '/private/source.xlsx' }, instructions: secret };
  const response = await requestPreview(invalid);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'VALIDATION_ERROR');
  assert.equal(response.body.includes(secret), false);
  const upload = await app.inject({ method: 'POST', url: '/inventory/imports/preview', headers: { cookie: cookies.JEFE, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, payload: Buffer.from('not-an-excel-file') });
  assert.equal(upload.statusCode, 415);
});

test('preview body limit is local to its JSON endpoint and default limits remain intact', async () => {
  const large = deserialize(serialize(input));
  for (let row = 5; row < 195; row += 1) large.sheets[0].rows.push(receptionRow(row, `LARGE-${row}`, { L: textCell('x'.repeat(8192)) }));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024);
  assert.equal((await requestPreview(large)).statusCode, 200);
  const defaultLimit = await app.inject({ method: 'POST', url: '/assets', headers: { cookie: cookies.JEFE }, payload: { notes: 'x'.repeat(1024 * 1024 + 1) } });
  assert.equal(defaultLimit.statusCode, 413);
  const oversized = await app.inject({ method: 'POST', url: '/inventory/imports/preview', headers: { 'content-type': 'application/json' }, payload: ' '.repeat(16 * 1024 * 1024 + 1) });
  assert.equal(oversized.statusCode, 413);
});

after(async () => { await app.close(); });
