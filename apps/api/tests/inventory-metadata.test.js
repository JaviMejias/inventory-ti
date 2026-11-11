import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';

const database = new PrismaClient();
const app = buildApp(database);
const suffix = randomUUID().slice(0, 8);
const password = 'Metadata-password-123';
const cookies = {};

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `metadata-${role.toLowerCase()}-${suffix}`;
    await database.user.create({ data: { username, displayName: `Metadata ${role}`, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(login.statusCode, 200);
    const header = login.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
});

async function mutate(method, url, role, payload) {
  const cookie = cookies[role];
  const csrf = (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
  return app.inject({ method, url, headers: { cookie, 'x-csrf-token': csrf }, payload });
}

function read(url, role = 'JEFE') {
  return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } });
}

test('inventory metadata product CRUD exposes structured fields and supports legacy clients', async () => {
  const response = await mutate('POST', '/products', 'JEFE', {
    name: `Structured ${suffix}`, trackingMode: 'ASSET', equipmentType: ' Notebook ', brand: 'HP', model: `840-${suffix}`
  });
  assert.equal(response.statusCode, 201);
  const product = response.json().product;
  assert.equal(product.equipmentType, 'Notebook');
  assert.equal(product.brand, 'HP');
  assert.equal(product.active, true);
  const filtered = await read(`/products?brand=hp&equipmentType=note&model=${suffix}`);
  assert.ok(filtered.json().products.some((row) => row.id === product.id));
  assert.ok((await read(`/products?search=840-${suffix}`)).json().products.some((row) => row.id === product.id));
  const cleared = await mutate('PATCH', `/products/${product.id}`, 'JEFE', { brand: null, model: '' });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().product.brand, null);
  assert.equal(cleared.json().product.model, null);
  assert.equal(cleared.json().product.equipmentType, 'Notebook');
  const audit = await database.auditLog.findFirstOrThrow({ where: { entityId: product.id, action: 'PRODUCT_UPDATED' } });
  assert.deepEqual(audit.metadata.before, { brand: 'HP', model: `840-${suffix}` });
  assert.deepEqual(audit.metadata.after, { brand: null, model: null });
  const legacy = await mutate('POST', '/products', 'JEFE', { name: `Legacy metadata ${suffix}`, trackingMode: 'QUANTITY' });
  assert.equal(legacy.statusCode, 201);
  assert.equal(legacy.json().product.brand, null);
  assert.equal((await mutate('PATCH', `/products/${product.id}`, 'COORDINADOR', { brand: 'Other' })).statusCode, 403);
});

test('inventory metadata asset edits preserve operational state and audit before/after values', async () => {
  const product = await database.product.create({ data: { name: `Metadata asset ${suffix}`, trackingMode: 'ASSET', brand: 'Fortinet', model: `60F-${suffix}`, equipmentType: 'Firewall' } });
  const response = await mutate('POST', '/assets', 'COORDINADOR', {
    productId: product.id, serialNumber: `META-${suffix}`, technicalCondition: ' Revisar ', usagePurpose: 'Contingencia',
    location: 'Bodega 2', sector: 'A1', ipAddress: '10.72.40.254', hostname: 'FW-01', loanCode: 'KIT-01', notes: 'Pendiente de evaluación'
  });
  assert.equal(response.statusCode, 201);
  const asset = response.json().asset;
  assert.equal(asset.status, 'AVAILABLE');
  assert.equal(asset.technicalCondition, 'Revisar');
  assert.equal(asset.product.brand, 'Fortinet');
  const changed = await mutate('PATCH', `/assets/${asset.id}`, 'JEFE', { location: 'CE', notes: null });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().asset.notes, null);
  assert.equal(changed.json().asset.technicalCondition, 'Revisar');
  assert.equal(changed.json().asset.status, 'AVAILABLE');
  const audit = await database.auditLog.findFirstOrThrow({ where: { entityId: asset.id, action: 'ASSET_UPDATED' } });
  assert.deepEqual(audit.metadata.before, { location: 'Bodega 2', notes: 'Pendiente de evaluación' });
  assert.deepEqual(audit.metadata.after, { location: 'CE', notes: null });
  assert.equal((await mutate('PATCH', `/assets/${asset.id}`, 'SOPORTE', { location: 'Denied' })).statusCode, 403);
  assert.equal((await mutate('PATCH', `/assets/${asset.id}`, 'JEFE', { status: 'ASSIGNED' })).statusCode, 400);
  assert.equal((await mutate('PATCH', `/assets/${asset.id}`, 'JEFE', { ipAddress: '10.72.40' })).statusCode, 400);
  const list = await read(`/assets?brand=fortinet&model=${suffix}&location=ce&usagePurpose=contingencia&technicalCondition=revisar&sector=a1`);
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().assets.some((row) => row.id === asset.id));
  assert.ok((await read('/assets?search=FW-01')).json().assets.some((row) => row.id === asset.id));
  assert.equal(await database.inventoryStock.count({ where: { productId: product.id } }), 0);
  assert.equal(await database.inventoryMovement.count({ where: { productId: product.id } }), 0);
  assert.equal(await database.assignment.count({ where: { assetId: asset.id } }), 0);
  assert.equal((await mutate('POST', `/assets/${asset.id}/decommission`, 'JEFE')).statusCode, 200);
  assert.equal((await mutate('PATCH', `/assets/${asset.id}`, 'JEFE', { notes: 'Denied after retirement' })).statusCode, 409);
});

test('asset availability counts only active operational assets and includes zero-stock products', async () => {
  const product = await database.product.create({ data: { name: `Availability A ${suffix}`, trackingMode: 'ASSET', brand: `Availability-${suffix}`, lowStockThreshold: 1 } });
  const empty = await database.product.create({ data: { name: `Availability B ${suffix}`, trackingMode: 'ASSET', brand: product.brand, lowStockThreshold: 2 } });
  await database.product.createMany({ data: [
    { name: `Availability inactive ${suffix}`, trackingMode: 'ASSET', brand: product.brand, isActive: false },
    { name: `Availability quantity ${suffix}`, trackingMode: 'QUANTITY', brand: product.brand }
  ] });
  await database.asset.createMany({ data: [
    { productId: product.id, status: 'AVAILABLE' },
    { productId: product.id, status: 'RESERVED' },
    { productId: product.id, status: 'IN_REPAIR' },
    { productId: product.id, status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date() },
    { productId: product.id, status: 'AVAILABLE', isActive: false }
  ] });
  assert.equal((await app.inject({ method: 'GET', url: '/assets/availability' })).statusCode, 401);
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const response = await read(`/assets/availability?brand=${product.brand}&limit=1`, role);
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.total, 2);
    assert.equal(body.hasMore, true);
    const summary = body.products[0];
    assert.equal(summary.product.id, product.id);
    assert.equal(summary.activeCount, 3);
    assert.equal(summary.availableCount, 1);
    assert.equal(summary.lowStock, true);
    assert.equal(summary.statusCounts.RESERVED, 1);
    assert.equal(summary.statusCounts.DECOMMISSIONED, 0);
  }
  const next = (await read(`/assets/availability?brand=${product.brand}&limit=1&offset=1`)).json();
  assert.equal(next.products[0].product.id, empty.id);
  assert.equal(next.products[0].activeCount, 0);
  assert.equal(next.products[0].availableCount, 0);
  assert.equal(next.products[0].lowStock, true);
  assert.equal(next.hasMore, false);
  const beyond = (await read(`/assets/availability?brand=${product.brand}&offset=100`)).json();
  assert.deepEqual(beyond.products, []);
  assert.equal(beyond.total, 2);
  assert.equal((await read('/assets/availability?limit=101')).statusCode, 400);
  const detail = (await read(`/assets/availability?productId=${product.id}`)).json();
  assert.equal(detail.total, 1);
  await database.product.update({ where: { id: product.id }, data: { lowStockThreshold: 0 } });
  assert.equal((await read(`/assets/availability?productId=${product.id}`)).json().products[0].lowStock, false);
});

test('inventory metadata migration preserves existing rows and adds nullable columns', async () => {
  const migration = readFileSync(new URL('../../../prisma/migrations/0013_inventory_metadata/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `metadata_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await transaction.$executeRawUnsafe('CREATE TABLE "Product" ("id" uuid PRIMARY KEY, "name" text NOT NULL)');
      await transaction.$executeRawUnsafe('CREATE TABLE "Asset" ("id" uuid PRIMARY KEY, "productId" uuid NOT NULL, "status" text NOT NULL)');
      const productId = randomUUID();
      const assetId = randomUUID();
      await transaction.$executeRaw`INSERT INTO "Product" VALUES (${productId}::uuid, 'Legacy')`;
      await transaction.$executeRaw`INSERT INTO "Asset" VALUES (${assetId}::uuid, ${productId}::uuid, 'AVAILABLE')`;
      for (const statement of migration.match(/ALTER TABLE[\s\S]*?;/g)) await transaction.$executeRawUnsafe(statement);
      const [product] = await transaction.$queryRaw`SELECT * FROM "Product"`;
      const [asset] = await transaction.$queryRaw`SELECT * FROM "Asset"`;
      assert.deepEqual(product, { id: productId, name: 'Legacy', equipmentType: null, brand: null, model: null });
      assert.equal(asset.id, assetId);
      assert.equal(asset.status, 'AVAILABLE');
      for (const field of ['technicalCondition', 'usagePurpose', 'location', 'sector', 'ipAddress', 'hostname', 'loanCode', 'notes']) assert.equal(asset[field], null);
      throw new RollbackTest();
    });
  } catch (error) {
    if (!(error instanceof RollbackTest)) throw error;
  }
});

after(async () => { await app.close(); });
