import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PrismaClient, ProductTrackingMode, Role } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();
const app = buildApp(prisma);
const password = 'Valid-password-123';
const suffix = randomUUID().slice(0, 8);
const users = {};
let product;

function cookieFrom(response) {
  const header = response.headers['set-cookie'];
  return (Array.isArray(header) ? header[0] : header).split(';')[0];
}

async function login(username) {
  const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
  return cookieFrom(response);
}

async function csrf(cookie) {
  const response = await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } });
  return JSON.parse(response.body).csrfToken;
}

async function mutate(method, url, cookie, payload) {
  return app.inject({ method, url, headers: { cookie, 'x-csrf-token': await csrf(cookie) }, payload });
}

before(async () => {
  await prisma.$connect();
  users.jefe = await prisma.user.create({ data: { username: `inventory-jefe-${suffix}`, email: `inventory-jefe-${suffix}@example.com`, displayName: 'Inventory jefe', passwordHash: hashPassword(password), role: Role.JEFE } });
  users.coordinator = await prisma.user.create({ data: { username: `inventory-coordinator-${suffix}`, email: `inventory-coordinator-${suffix}@example.com`, displayName: 'Inventory coordinator', passwordHash: hashPassword(password), role: Role.COORDINADOR } });
  users.support = await prisma.user.create({ data: { username: `inventory-support-${suffix}`, email: `inventory-support-${suffix}@example.com`, displayName: 'Inventory support', passwordHash: hashPassword(password), role: Role.SOPORTE } });
  product = await prisma.product.create({ data: { name: `Inventory product ${suffix}`, trackingMode: ProductTrackingMode.QUANTITY } });
});

test('inventory endpoints require authentication and location endpoints are gone', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/inventory/stock' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/locations' })).statusCode, 404);
  const jefe = await login(users.jefe.username);
  assert.equal((await mutate('POST', '/inventory/movements/transfer', jefe, {})).statusCode, 404);
});

test('initial, entry, exit, return and adjustment update one product stock atomically', async () => {
  const jefe = await login(users.jefe.username);
  const initial = await mutate('POST', '/inventory/movements/initial', jefe, { productId: product.id, quantity: 10 });
  assert.equal(initial.statusCode, 200);
  assert.equal((await mutate('POST', '/inventory/movements/initial', jefe, { productId: product.id, quantity: 1 })).statusCode, 409);
  assert.equal((await mutate('POST', '/inventory/movements/entry', jefe, { productId: product.id, quantity: 5 })).statusCode, 200);
  assert.equal((await mutate('POST', '/inventory/movements/exit', jefe, { productId: product.id, quantity: 3 })).statusCode, 200);
  assert.equal((await mutate('POST', '/inventory/movements/return', jefe, { productId: product.id, quantity: 2 })).statusCode, 200);
  assert.equal((await mutate('POST', '/inventory/movements/adjustment', jefe, { productId: product.id, quantity: -2, reason: 'Count correction' })).statusCode, 200);
  const positiveAdjustment = await mutate('POST', '/inventory/movements/adjustment', jefe, { productId: product.id, quantity: 3, reason: 'Positive count correction' });
  assert.equal(positiveAdjustment.statusCode, 200);
  assert.equal(JSON.parse(positiveAdjustment.body).movement.quantity, 3);
  assert.equal(JSON.parse(positiveAdjustment.body).movement.reason, 'Positive count correction');
  const stock = await app.inject({ method: 'GET', url: `/inventory/stock/${product.id}`, headers: { cookie: jefe } });
  assert.equal(JSON.parse(stock.body).stock[0].quantity, 15);
  assert.equal('locationId' in JSON.parse(stock.body).stock[0], false);
});

test('movement permissions remain role-based without a location payload', async () => {
  const coordinator = await login(users.coordinator.username);
  const support = await login(users.support.username);
  assert.equal((await mutate('POST', '/inventory/movements/entry', coordinator, { productId: product.id, quantity: 1 })).statusCode, 200);
  assert.equal((await mutate('POST', '/inventory/movements/exit', support, { productId: product.id, quantity: 1 })).statusCode, 200);
  assert.equal((await mutate('POST', '/inventory/movements/adjustment', support, { productId: product.id, quantity: 1, reason: 'Denied' })).statusCode, 403);
  assert.equal((await mutate('POST', '/inventory/movements/adjustment', coordinator, { productId: product.id, quantity: 1 })).statusCode, 400);
});

test('inactive products and asset products are rejected for quantity movements', async () => {
  const jefe = await login(users.jefe.username);
  const inactiveProduct = await prisma.product.create({ data: { name: `Inactive inventory product ${suffix}`, trackingMode: ProductTrackingMode.QUANTITY, isActive: false } });
  assert.equal((await mutate('POST', '/inventory/movements/entry', jefe, { productId: inactiveProduct.id, quantity: 1 })).statusCode, 409);
  const assetProduct = await prisma.product.create({ data: { name: `Asset inventory product ${suffix}`, trackingMode: ProductTrackingMode.ASSET } });
  assert.equal((await mutate('POST', '/inventory/movements/entry', jefe, { productId: assetProduct.id, quantity: 1 })).statusCode, 409);
});

test('stock cannot become negative and concurrent exits serialize on the product stock row', async () => {
  const jefe = await login(users.jefe.username);
  const concurrentProduct = await prisma.product.create({ data: { name: `Concurrent inventory product ${suffix}`, trackingMode: ProductTrackingMode.QUANTITY } });
  assert.equal((await mutate('POST', '/inventory/movements/initial', jefe, { productId: concurrentProduct.id, quantity: 5 })).statusCode, 200);
  const token = await csrf(jefe);
  const requests = [1, 2].map(() => app.inject({ method: 'POST', url: '/inventory/movements/exit', headers: { cookie: jefe, 'x-csrf-token': token }, payload: { productId: concurrentProduct.id, quantity: 4 } }));
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  const stock = await prisma.inventoryStock.findUnique({ where: { productId: concurrentProduct.id } });
  assert.equal(stock?.quantity, 1);
  assert.equal(await prisma.inventoryMovement.count({ where: { productId: concurrentProduct.id } }), 2);
});

test('a movement creation failure rolls back its stock update', async () => {
  const rollbackProduct = await prisma.product.create({ data: { name: `Rollback inventory product ${suffix}`, trackingMode: ProductTrackingMode.QUANTITY } });
  const jefe = await login(users.jefe.username);
  assert.equal((await mutate('POST', '/inventory/movements/initial', jefe, { productId: rollbackProduct.id, quantity: 7 })).statusCode, 200);
  const beforeStock = await prisma.inventoryStock.findUnique({ where: { productId: rollbackProduct.id } });
  const beforeMovements = await prisma.inventoryMovement.count({ where: { productId: rollbackProduct.id } });

  await assert.rejects(
    prisma.$transaction(async (transaction) => {
      const updated = await transaction.inventoryStock.update({ where: { id: beforeStock.id }, data: { quantity: beforeStock.quantity + 4 } });
      assert.equal(updated.quantity, 11);
      await transaction.inventoryMovement.create({ data: { productId: rollbackProduct.id, movementType: 'ENTRY', quantity: 4, performedById: randomUUID(), effectiveAt: new Date() } });
    }),
    /Foreign key constraint|violates foreign key/i,
  );

  const afterStock = await prisma.inventoryStock.findUnique({ where: { id: beforeStock.id } });
  assert.equal(afterStock?.quantity, beforeStock.quantity);
  assert.equal(await prisma.inventoryMovement.count({ where: { productId: rollbackProduct.id } }), beforeMovements);
});

test('invalid CSRF and unknown products have no inventory side effects', async () => {
  const jefe = await login(users.jefe.username);
  const beforeStock = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
  const beforeMovements = await prisma.inventoryMovement.count({ where: { productId: product.id } });
  const invalidMovement = await app.inject({ method: 'POST', url: '/inventory/movements/entry', headers: { cookie: jefe, 'x-csrf-token': 'invalid-token' }, payload: { productId: product.id, quantity: 1 } });
  assert.equal(invalidMovement.statusCode, 403);
  const afterStock = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
  assert.equal(afterStock?.quantity, beforeStock?.quantity);
  assert.equal(await prisma.inventoryMovement.count({ where: { productId: product.id } }), beforeMovements);
  const missingProduct = await app.inject({ method: 'POST', url: '/inventory/movements/entry', headers: { cookie: jefe, 'x-csrf-token': await csrf(jefe) }, payload: { productId: randomUUID(), quantity: 1 } });
  assert.equal(missingProduct.statusCode, 404);
});

test('movement history supports product filters and has no location fields or mutation routes', async () => {
  const coordinator = await login(users.coordinator.username);
  const history = await app.inject({ method: 'GET', url: `/inventory/movements?productId=${product.id}&movementType=ENTRY`, headers: { cookie: coordinator } });
  assert.equal(history.statusCode, 200);
  const movements = JSON.parse(history.body).movements;
  assert.ok(movements.every((movement) => movement.productId === product.id && movement.movementType === 'ENTRY'));
  assert.equal('locationId' in movements[0], false);
  const csrfToken = await csrf(coordinator);
  const directUpdate = await app.inject({ method: 'PATCH', url: '/inventory/stock/not-an-edit-endpoint', headers: { cookie: coordinator, 'x-csrf-token': csrfToken }, payload: { quantity: 999 } });
  assert.equal(directUpdate.statusCode, 404);
});

test('movement reads expose correction eligibility metadata for quantity and asset movements', async () => {
  const support = await login(users.support.username);
  const coordinator = await login(users.coordinator.username);
  const original = await prisma.inventoryMovement.create({ data: { productId: product.id, movementType: 'ENTRY', quantity: 1, performedById: users.support.id } });
  const correctionResponse = await mutate('POST', `/inventory/movements/${original.id}/corrections`, support, { delta: 1, reason: 'Eligibility metadata' });
  assert.equal(correctionResponse.statusCode, 201);

  const quantityHistory = await app.inject({ method: 'GET', url: `/inventory/movements/${original.id}`, headers: { cookie: coordinator } });
  const quantityMovement = JSON.parse(quantityHistory.body).movement;
  assert.equal(quantityMovement.product.trackingMode, 'QUANTITY');
  assert.equal(quantityMovement.assetId, null);
  assert.equal('location' in quantityMovement, false);
  assert.equal(quantityMovement.correctionRequests.length, 1);
  assert.equal(quantityMovement.correctionRequests[0].status, 'PENDING');

  const assetProduct = await prisma.product.create({ data: { name: `Asset read product ${suffix}`, trackingMode: ProductTrackingMode.ASSET } });
  const asset = await prisma.asset.create({ data: { productId: assetProduct.id, assetTag: `READ-ASSET-${suffix}` } });
  const assetMovement = await prisma.inventoryMovement.create({ data: { productId: assetProduct.id, assetId: asset.id, movementType: 'ENTRY', quantity: 1, performedById: users.support.id } });
  const assetHistory = await app.inject({ method: 'GET', url: `/inventory/movements/${assetMovement.id}`, headers: { cookie: coordinator } });
  const assetMovementResponse = JSON.parse(assetHistory.body).movement;
  assert.equal(assetMovementResponse.product.trackingMode, 'ASSET');
  assert.equal(assetMovementResponse.assetId, asset.id);
  assert.deepEqual(assetMovementResponse.correctionRequests, []);
});

after(async () => {
  await app.close();
});
