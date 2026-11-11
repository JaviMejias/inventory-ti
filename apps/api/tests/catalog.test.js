import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PrismaClient, Role } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();
const app = buildApp(prisma);
const password = 'Valid-password-123';
const suffix = randomUUID().slice(0, 8);
const users = {};

async function login(identifier) {
  const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier, password } });
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header).split(';')[0];
  return { response, cookie };
}

async function csrf(cookie) {
  const response = await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } });
  return JSON.parse(response.body).csrfToken;
}

async function mutate(method, url, cookie, payload) {
  return app.inject({ method, url, headers: { cookie, 'x-csrf-token': await csrf(cookie) }, ...(payload ? { payload } : {}) });
}

before(async () => {
  await prisma.$connect();
  users.jefe = await prisma.user.create({ data: { username: `catalog-jefe-${suffix}`, email: `catalog-jefe-${suffix}@example.com`, displayName: 'Catalog jefe', passwordHash: hashPassword(password), role: Role.JEFE } });
  users.coordinator = await prisma.user.create({ data: { username: `catalog-coordinator-${suffix}`, email: `catalog-coordinator-${suffix}@example.com`, displayName: 'Catalog coordinator', passwordHash: hashPassword(password), role: Role.COORDINADOR } });
  users.support = await prisma.user.create({ data: { username: `catalog-support-${suffix}`, email: `catalog-support-${suffix}@example.com`, displayName: 'Catalog support', passwordHash: hashPassword(password), role: Role.SOPORTE } });
});

test('product reads require authentication and JEFE controls mutations', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/products' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/categories' })).statusCode, 404);
  const coordinator = await login(users.coordinator.username);
  assert.equal((await mutate('POST', '/products', coordinator.cookie, { name: `Forbidden-${suffix}`, trackingMode: 'QUANTITY', lowStockThreshold: 0 })).statusCode, 403);
  const support = await login(users.support.username);
  assert.equal((await mutate('POST', '/products', support.cookie, { name: 'Forbidden', trackingMode: 'QUANTITY', lowStockThreshold: 0 })).statusCode, 403);
});

test('JEFE can create, filter, update, deactivate and activate a product', async () => {
  const jefe = await login(users.jefe.username);
  const payload = { name: `Laptop-${suffix}`, sku: `SKU-${suffix}`, trackingMode: 'ASSET', lowStockThreshold: 2 };
  const created = await mutate('POST', '/products', jefe.cookie, payload);
  assert.equal(created.statusCode, 201);
  const product = JSON.parse(created.body).product;
  assert.equal(product.active, true);
  assert.equal(product.category, undefined);
  assert.equal(product.categoryId, undefined);

  const filtered = await app.inject({ method: 'GET', url: `/products?search=${payload.name}&limit=1&offset=0`, headers: { cookie: jefe.cookie } });
  assert.equal(filtered.statusCode, 200);
  const filteredBody = JSON.parse(filtered.body);
  assert.equal(filteredBody.total, 1);
  assert.equal(filteredBody.products[0].id, product.id);

  assert.equal((await mutate('PATCH', `/products/${product.id}`, jefe.cookie, { name: `Laptop Updated-${suffix}` })).statusCode, 200);
  assert.equal((await mutate('POST', `/products/${product.id}/deactivate`, jefe.cookie)).statusCode, 200);
  assert.equal((await mutate('POST', `/products/${product.id}/activate`, jefe.cookie)).statusCode, 200);
});

test('product creation validates global name uniqueness, SKU, threshold and tracking mode', async () => {
  const jefe = await login(users.jefe.username);
  const payload = { name: `Unique laptop-${suffix}`, sku: `Unique SKU-${suffix}`, trackingMode: 'ASSET', lowStockThreshold: 2 };
  assert.equal((await mutate('POST', '/products', jefe.cookie, payload)).statusCode, 201);
  assert.equal((await mutate('POST', '/products', jefe.cookie, { ...payload, name: payload.name.toUpperCase(), sku: `Other-${suffix}` })).statusCode, 409);
  assert.equal((await mutate('POST', '/products', jefe.cookie, { ...payload, name: `Other-${suffix}` })).statusCode, 409);
  assert.equal((await mutate('POST', '/products', jefe.cookie, { ...payload, name: `Invalid-${suffix}`, sku: `Other SKU-${suffix}`, lowStockThreshold: -1 })).statusCode, 400);
  assert.equal((await mutate('POST', '/products', jefe.cookie, { ...payload, name: `Invalid mode-${suffix}`, sku: `Other mode-${suffix}`, trackingMode: 'INVALID' })).statusCode, 400);
  assert.equal((await mutate('POST', '/products', jefe.cookie, { ...payload, name: `Legacy category-${suffix}`, sku: `Legacy-${suffix}`, categoryId: randomUUID() })).statusCode, 400);
});

test('product lifecycle is independent of category state', async () => {
  const jefe = await login(users.jefe.username);
  const productResponse = await mutate('POST', '/products', jefe.cookie, { name: `Lifecycle Product-${suffix}`, sku: ' ', trackingMode: 'QUANTITY', lowStockThreshold: 0 });
  const product = JSON.parse(productResponse.body).product;
  assert.equal(product.sku, null);
  const updated = await mutate('PATCH', `/products/${product.id}`, jefe.cookie, { name: `Lifecycle Product Updated-${suffix}`, sku: ' ', lowStockThreshold: 4 });
  assert.equal(updated.statusCode, 200);
  assert.equal(JSON.parse(updated.body).product.sku, null);
  assert.equal((await mutate('POST', `/products/${product.id}/deactivate`, jefe.cookie)).statusCode, 200);
  assert.equal((await mutate('POST', `/products/${product.id}/activate`, jefe.cookie)).statusCode, 200);
  const audit = await prisma.auditLog.findMany({ where: { entityType: 'Catalog', entityId: product.id } });
  assert.deepEqual(new Set(audit.map((entry) => entry.action)), new Set(['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DEACTIVATED', 'PRODUCT_ACTIVATED']));
});

test('catalog mutations require CSRF and missing resources return 404', async () => {
  const jefe = await login(users.jefe.username);
  assert.equal((await app.inject({ method: 'POST', url: '/products', headers: { cookie: jefe.cookie, 'x-csrf-token': 'invalid' }, payload: { name: `Invalid-${suffix}`, trackingMode: 'QUANTITY', lowStockThreshold: 0 } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/products/${randomUUID()}`, headers: { cookie: jefe.cookie } })).statusCode, 404);
  assert.equal((await mutate('PATCH', `/products/${randomUUID()}`, jefe.cookie, { name: 'Missing' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/products?categoryId=${randomUUID()}`, headers: { cookie: jefe.cookie } })).statusCode, 400);
});

test('product mutations create audit records without category metadata', async () => {
  const jefe = await login(users.jefe.username);
  const productResponse = await mutate('POST', '/products', jefe.cookie, { name: `Audited Product-${suffix}`, trackingMode: 'QUANTITY', lowStockThreshold: 0 });
  const productId = JSON.parse(productResponse.body).product.id;
  const actions = await prisma.auditLog.findMany({ where: { entityType: 'Catalog', entityId: productId } });
  assert.deepEqual(new Set(actions.map((entry) => entry.action)), new Set(['PRODUCT_CREATED']));
  assert.equal(actions[0].metadata.categoryId, undefined);
});

after(async () => {
  await prisma.product.deleteMany({ where: { name: { endsWith: suffix } } });
  await prisma.user.deleteMany({ where: { username: { endsWith: suffix } } });
  await app.close();
});
