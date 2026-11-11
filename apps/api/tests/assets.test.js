import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { AssetStatus, PrismaClient, ProductTrackingMode, Role } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();
const app = buildApp(prisma);
const password = 'Valid-password-123';
const suffix = randomUUID().slice(0, 8);
const users = {};
let assetProduct;
let secondAssetProduct;
let quantityProduct;

function cookieFrom(response) {
  const header = response.headers['set-cookie'];
  return (Array.isArray(header) ? header[0] : header).split(';')[0];
}

async function login(username) {
  return cookieFrom(await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }));
}

async function csrf(cookie) {
  const response = await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } });
  return JSON.parse(response.body).csrfToken;
}

async function mutate(method, url, cookie, payload) {
  return app.inject({ method, url, headers: { cookie, 'x-csrf-token': await csrf(cookie) }, ...(payload ? { payload } : {}) });
}

async function createAsset(cookie, overrides = {}) {
  return mutate('POST', '/assets', cookie, { productId: assetProduct.id, assetTag: `ASSET-${randomUUID()}`, serialNumber: `SERIAL-${randomUUID()}`, ...overrides });
}

function databaseWithFailingAudit() {
  return new Proxy(prisma, {
    get(target, property) {
      if (property === '$disconnect') return async () => {};
      if (property === '$transaction') {
        return async (callback) => target.$transaction(async (transaction) => callback(new Proxy(transaction, {
          get(transactionTarget, transactionProperty) {
            if (transactionProperty === 'auditLog') {
              return new Proxy(transactionTarget.auditLog, {
                get(delegate, delegateProperty) {
                  if (delegateProperty === 'create') return async () => { throw new Error('Forced audit failure'); };
                  const value = Reflect.get(delegate, delegateProperty, delegate);
                  return typeof value === 'function' ? value.bind(delegate) : value;
                }
              });
            }
            const value = Reflect.get(transactionTarget, transactionProperty, transactionTarget);
            return typeof value === 'function' ? value.bind(transactionTarget) : value;
          }
        })));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

before(async () => {
  await prisma.$connect();
  users.jefe = await prisma.user.create({ data: { username: `asset-jefe-${suffix}`, email: `asset-jefe-${suffix}@example.com`, displayName: 'Asset jefe', passwordHash: hashPassword(password), role: Role.JEFE } });
  users.coordinator = await prisma.user.create({ data: { username: `asset-coordinator-${suffix}`, email: `asset-coordinator-${suffix}@example.com`, displayName: 'Asset coordinator', passwordHash: hashPassword(password), role: Role.COORDINADOR } });
  users.support = await prisma.user.create({ data: { username: `asset-support-${suffix}`, email: `asset-support-${suffix}@example.com`, displayName: 'Asset support', passwordHash: hashPassword(password), role: Role.SOPORTE } });
  assetProduct = await prisma.product.create({ data: { name: `Asset product ${suffix}`, trackingMode: ProductTrackingMode.ASSET } });
  secondAssetProduct = await prisma.product.create({ data: { name: `Second asset product ${suffix}`, trackingMode: ProductTrackingMode.ASSET } });
  quantityProduct = await prisma.product.create({ data: { name: `Quantity product ${suffix}`, trackingMode: ProductTrackingMode.QUANTITY } });
});

test('asset reads require authentication and are available to every authenticated role', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/assets' })).statusCode, 401);
  for (const user of Object.values(users)) {
    const cookie = await login(user.username);
    assert.equal((await app.inject({ method: 'GET', url: '/assets', headers: { cookie } })).statusCode, 200);
  }
});

test('JEFE and COORDINADOR create AVAILABLE assets without materialized stock effects', async () => {
  const jefe = await login(users.jefe.username);
  const coordinator = await login(users.coordinator.username);
  const stockBefore = await prisma.inventoryStock.count({ where: { productId: assetProduct.id } });
  const jefeCreated = await createAsset(jefe, { assetTag: ' ', serialNumber: '' });
  assert.equal(jefeCreated.statusCode, 201);
  const jefeAsset = JSON.parse(jefeCreated.body).asset;
  assert.equal(jefeAsset.status, AssetStatus.AVAILABLE);
  assert.equal(jefeAsset.assetTag, null);
  assert.equal(jefeAsset.serialNumber, null);
  const coordinatorCreated = await createAsset(coordinator);
  assert.equal(coordinatorCreated.statusCode, 201);
  const coordinatorAsset = JSON.parse(coordinatorCreated.body).asset;
  assert.equal(await prisma.inventoryStock.count({ where: { productId: assetProduct.id } }), stockBefore);
  assert.equal(await prisma.auditLog.count({ where: { entityType: 'Asset', action: 'ASSET_CREATED', entityId: { in: [jefeAsset.id, coordinatorAsset.id] } } }), 2);
});

test('asset creation validates product and identifier uniqueness', async () => {
  const jefe = await login(users.jefe.username);
  assert.equal((await createAsset(jefe, { productId: quantityProduct.id })).statusCode, 409);
  assert.equal((await createAsset(jefe, { productId: randomUUID() })).statusCode, 404);
  const inactiveProduct = await prisma.product.create({ data: { name: `Inactive asset product ${suffix}`, trackingMode: ProductTrackingMode.ASSET, isActive: false } });
  assert.equal((await createAsset(jefe, { productId: inactiveProduct.id })).statusCode, 409);

  const uniqueTag = `UNIQUE-TAG-${suffix}`;
  const uniqueSerial = `UNIQUE-SERIAL-${suffix}`;
  assert.equal((await createAsset(jefe, { assetTag: uniqueTag, serialNumber: uniqueSerial })).statusCode, 201);
  const duplicateTag = await createAsset(jefe, { assetTag: uniqueTag });
  assert.equal(duplicateTag.statusCode, 409);
  assert.equal(duplicateTag.json().details?.field, 'assetTag');
  const duplicateSerial = await createAsset(jefe, { serialNumber: uniqueSerial });
  assert.equal(duplicateSerial.statusCode, 409);
  assert.equal(duplicateSerial.json().details?.field, 'serialNumber');
  assert.equal((await createAsset(jefe, { productId: secondAssetProduct.id, serialNumber: uniqueSerial })).statusCode, 201);
});

test('asset metadata edits are audited and unavailable for support or decommissioned assets', async () => {
  const jefe = await login(users.jefe.username);
  const coordinator = await login(users.coordinator.username);
  const support = await login(users.support.username);
  const created = JSON.parse((await createAsset(jefe)).body).asset;
  const updated = await mutate('PATCH', `/assets/${created.id}`, coordinator, { assetTag: `EDITED-${suffix}`, serialNumber: ' ' });
  assert.equal(updated.statusCode, 200);
  assert.equal(JSON.parse(updated.body).asset.assetTag, `EDITED-${suffix}`);
  assert.equal(JSON.parse(updated.body).asset.serialNumber, null);
  assert.equal((await mutate('PATCH', `/assets/${created.id}`, support, { assetTag: 'DENIED' })).statusCode, 403);
  assert.equal((await mutate('PATCH', `/assets/${randomUUID()}`, jefe, { assetTag: 'MISSING' })).statusCode, 404);
  assert.equal(await prisma.auditLog.count({ where: { entityId: created.id, action: 'ASSET_UPDATED' } }), 1);
  assert.equal((await mutate('POST', `/assets/${created.id}/decommission`, jefe)).statusCode, 200);
  assert.equal((await mutate('PATCH', `/assets/${created.id}`, jefe, { assetTag: 'TOO-LATE' })).statusCode, 409);
});

test('status changes enforce valid values, support limits and assignment boundaries', async () => {
  const jefe = await login(users.jefe.username);
  const support = await login(users.support.username);
  const created = JSON.parse((await createAsset(jefe)).body).asset;
  assert.equal((await mutate('POST', `/assets/${created.id}/status`, support, { status: 'IN_REPAIR' })).statusCode, 200);
  assert.equal((await mutate('POST', `/assets/${created.id}/status`, support, { status: 'LOST' })).statusCode, 403);
  assert.equal((await mutate('POST', `/assets/${created.id}/status`, jefe, { status: 'LOST' })).statusCode, 200);
  assert.equal((await mutate('POST', `/assets/${created.id}/status`, jefe, { status: 'ASSIGNED' })).statusCode, 409);
  assert.equal((await mutate('POST', `/assets/${created.id}/status`, jefe, { status: 'DECOMMISSIONED' })).statusCode, 409);
  assert.equal((await mutate('POST', `/assets/${created.id}/status`, jefe, { status: 'UNKNOWN' })).statusCode, 400);
  assert.equal(await prisma.auditLog.count({ where: { entityId: created.id, action: 'ASSET_STATUS_CHANGED' } }), 2);
});

test('asset location mutation endpoint is removed', async () => {
  const jefe = await login(users.jefe.username);
  const created = JSON.parse((await createAsset(jefe)).body).asset;
  assert.equal((await mutate('POST', `/assets/${created.id}/move`, jefe, {})).statusCode, 404);
});

test('decommission is JEFE-only, terminal and serialized under concurrency', async () => {
  const jefe = await login(users.jefe.username);
  const coordinator = await login(users.coordinator.username);
  const support = await login(users.support.username);
  const created = JSON.parse((await createAsset(jefe)).body).asset;
  assert.equal((await mutate('POST', `/assets/${created.id}/decommission`, coordinator)).statusCode, 403);
  assert.equal((await mutate('POST', `/assets/${created.id}/decommission`, support)).statusCode, 403);
  const token = await csrf(jefe);
  const responses = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/assets/${created.id}/decommission`, headers: { cookie: jefe, 'x-csrf-token': token } })));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  const stored = await prisma.asset.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(stored.status, AssetStatus.DECOMMISSIONED);
  assert.equal(stored.isActive, false);
  assert.ok(stored.decommissionedAt instanceof Date);
  assert.equal((await mutate('POST', `/assets/${created.id}/move`, jefe, {})).statusCode, 404);
  assert.equal((await mutate('POST', `/assets/${created.id}/status`, jefe, { status: 'AVAILABLE' })).statusCode, 409);
});

test('missing or invalid CSRF rejects asset mutations without side effects', async () => {
  const jefe = await login(users.jefe.username);
  const countBefore = await prisma.asset.count({ where: { productId: assetProduct.id } });
  const missing = await app.inject({ method: 'POST', url: '/assets', headers: { cookie: jefe }, payload: { productId: assetProduct.id, assetTag: `NO-CSRF-${suffix}` } });
  const invalid = await app.inject({ method: 'POST', url: '/assets', headers: { cookie: jefe, 'x-csrf-token': 'invalid' }, payload: { productId: assetProduct.id, assetTag: `BAD-CSRF-${suffix}` } });
  assert.equal(missing.statusCode, 403);
  assert.equal(invalid.statusCode, 403);
  assert.equal(await prisma.asset.count({ where: { productId: assetProduct.id } }), countBefore);
});

test('asset status changes roll back when AuditLog creation fails', async () => {
  const jefe = await login(users.jefe.username);
  const created = JSON.parse((await createAsset(jefe)).body).asset;
  const faultyApp = buildApp(databaseWithFailingAudit());
  const token = await csrf(jefe);
  const statusResponse = await faultyApp.inject({ method: 'POST', url: `/assets/${created.id}/status`, headers: { cookie: jefe, 'x-csrf-token': token }, payload: { status: 'RESERVED' } });
  assert.equal(statusResponse.statusCode, 500);
  assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: created.id } })).status, AssetStatus.AVAILABLE);
  await faultyApp.close();
});

test('structured asset metadata rolls back when audit persistence fails', async () => {
  const jefe = await login(users.jefe.username);
  const created = JSON.parse((await createAsset(jefe, { location: 'Bodega 2', notes: 'Original metadata' })).body).asset;
  const faultyApp = buildApp(databaseWithFailingAudit());
  try {
    const token = await csrf(jefe);
    const response = await faultyApp.inject({ method: 'PATCH', url: `/assets/${created.id}`, headers: { cookie: jefe, 'x-csrf-token': token }, payload: { location: 'CE', notes: 'Must roll back' } });
    assert.equal(response.statusCode, 500);
    const stored = await prisma.asset.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(stored.location, 'Bodega 2');
    assert.equal(stored.notes, 'Original metadata');
    assert.equal(await prisma.auditLog.count({ where: { entityId: created.id, action: 'ASSET_UPDATED' } }), 0);
  } finally {
    await faultyApp.close();
  }
});

test('asset listing supports all approved filters and detail contains no user secrets', async () => {
  const jefe = await login(users.jefe.username);
  const created = JSON.parse((await createAsset(jefe, { assetTag: `FILTER-${suffix}`, serialNumber: `FILTER-SERIAL-${suffix}` })).body).asset;
  const query = new globalThis.URLSearchParams({ productId: assetProduct.id, status: 'AVAILABLE', assetTag: 'filter', serialNumber: 'serial', isActive: 'true', search: suffix });
  const list = await app.inject({ method: 'GET', url: `/assets?${query}`, headers: { cookie: jefe } });
  assert.equal(list.statusCode, 200);
  assert.ok(JSON.parse(list.body).assets.some((asset) => asset.id === created.id));
  const detail = await app.inject({ method: 'GET', url: `/assets/${created.id}`, headers: { cookie: jefe } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.includes('passwordHash'), false);
  assert.equal((await app.inject({ method: 'GET', url: `/assets/${randomUUID()}`, headers: { cookie: jefe } })).statusCode, 404);
});

after(async () => {
  await app.close();
});
