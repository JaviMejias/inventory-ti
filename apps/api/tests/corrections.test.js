import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { MovementType, PrismaClient, ProductTrackingMode, Role } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();
const app = buildApp(prisma);
const password = 'Valid-password-123';
const suffix = randomUUID().slice(0, 8);
const users = {};
let assetProduct;

function parsed(response) { return JSON.parse(response.body); }
function cookieFrom(response) { const header = response.headers['set-cookie']; return (Array.isArray(header) ? header[0] : header).split(';')[0]; }
async function login(username) { return cookieFrom(await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } })); }
async function csrf(cookie) { return parsed(await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).csrfToken; }
async function mutate(method, url, cookie, payload, token) { return app.inject({ method, url, headers: { cookie, 'x-csrf-token': token ?? await csrf(cookie) }, ...(payload === undefined ? {} : { payload }) }); }

function databaseWithFailure(model, operation) {
  return new Proxy(prisma, {
    get(target, property) {
      if (property === '$disconnect') return async () => {};
      if (property === '$transaction') {
        return async (callback) => target.$transaction(async (transaction) => callback(new Proxy(transaction, {
          get(transactionTarget, transactionProperty) {
            if (transactionProperty === model) {
              return new Proxy(transactionTarget[transactionProperty], {
                get(delegate, delegateProperty) {
                  if (delegateProperty === operation) return async () => { throw new Error(`Forced ${model}.${operation} failure`); };
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

async function createFixture(stockQuantity = 10) {
  const product = await prisma.product.create({ data: { name: `Correction fixture ${randomUUID()}`, trackingMode: ProductTrackingMode.QUANTITY } });
  await prisma.inventoryStock.create({ data: { productId: product.id, quantity: stockQuantity } });
  const original = await prisma.inventoryMovement.create({ data: { productId: product.id, movementType: MovementType.ENTRY, quantity: stockQuantity, performedById: users.support.id, reason: 'Fixture movement' } });
  return { product, original };
}

async function requestCorrection(cookie, movementId, delta = -3, reason = 'Conteo físico corregido') {
  return mutate('POST', `/inventory/movements/${movementId}/corrections`, cookie, { delta, reason });
}

async function createCommittedCorrection(cookie, delta = -3) {
  const fixture = await createFixture();
  const response = await requestCorrection(cookie, fixture.original.id, delta);
  assert.equal(response.statusCode, 201);
  return { ...fixture, correction: parsed(response).correction };
}

before(async () => {
  await prisma.$connect();
  users.jefe = await prisma.user.create({ data: { username: `correction-jefe-${suffix}`, email: `correction-jefe-${suffix}@example.com`, displayName: 'Correction jefe', passwordHash: hashPassword(password), role: Role.JEFE } });
  users.secondJefe = await prisma.user.create({ data: { username: `correction-jefe-2-${suffix}`, email: `correction-jefe-2-${suffix}@example.com`, displayName: 'Second correction jefe', passwordHash: hashPassword(password), role: Role.JEFE } });
  users.coordinator = await prisma.user.create({ data: { username: `correction-coordinator-${suffix}`, email: `correction-coordinator-${suffix}@example.com`, displayName: 'Correction coordinator', passwordHash: hashPassword(password), role: Role.COORDINADOR } });
  users.support = await prisma.user.create({ data: { username: `correction-support-${suffix}`, email: `correction-support-${suffix}@example.com`, displayName: 'Correction support', passwordHash: hashPassword(password), role: Role.SOPORTE } });
  users.otherSupport = await prisma.user.create({ data: { username: `correction-other-${suffix}`, email: `correction-other-${suffix}@example.com`, displayName: 'Other support', passwordHash: hashPassword(password), role: Role.SOPORTE } });
  assetProduct = await prisma.product.create({ data: { name: `Correction asset ${suffix}`, trackingMode: ProductTrackingMode.ASSET } });
});

test('creates a pending correction with a non-zero delta without changing stock', async () => {
  const cookie = await login(users.support.username);
  const { original, product } = await createFixture();
  const beforeStock = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
  const response = await requestCorrection(cookie, original.id);
  assert.equal(response.statusCode, 201);
  assert.equal(parsed(response).correction.status, 'PENDING');
  assert.equal(parsed(response).correction.delta, -3);
  const afterStock = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
  assert.equal(afterStock?.quantity, beforeStock?.quantity);
  assert.equal(await prisma.auditLog.count({ where: { action: 'CORRECTION_REQUESTED', entityId: parsed(response).correction.id } }), 1);
});

test('validates correction reason/delta and rejects asset movements', async () => {
  const cookie = await login(users.support.username);
  const fixture = await createFixture();
  assert.equal((await requestCorrection(cookie, fixture.original.id, 0, '')).statusCode, 400);
  const asset = await prisma.asset.create({ data: { productId: assetProduct.id, assetTag: `COR-ASSET-${randomUUID()}` } });
  const movement = await prisma.inventoryMovement.create({ data: { productId: assetProduct.id, assetId: asset.id, movementType: MovementType.ENTRY, quantity: 1 } });
  assert.equal((await requestCorrection(cookie, movement.id)).statusCode, 409);
});

test('prevents duplicate correction requests, including concurrent requests', async () => {
  const cookie = await login(users.support.username);
  const fixture = await createFixture();
  const token = await csrf(cookie);
  const responses = await Promise.all([1, 2].map((delta) => mutate('POST', `/inventory/movements/${fixture.original.id}/corrections`, cookie, { delta, reason: `Concurrent ${delta}` }, token)));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(await prisma.correctionRequest.count({ where: { originalMovementId: fixture.original.id } }), 1);
});

test('lists all corrections for JEFE and only own corrections for other roles', async () => {
  const support = await login(users.support.username);
  const otherSupport = await login(users.otherSupport.username);
  const coordinator = await login(users.coordinator.username);
  const jefe = await login(users.jefe.username);
  const { correction } = await createCommittedCorrection(support);
  const { correction: coordinatorCorrection } = await createCommittedCorrection(coordinator);
  const own = await app.inject({ method: 'GET', url: '/corrections', headers: { cookie: support } });
  const other = await app.inject({ method: 'GET', url: '/corrections', headers: { cookie: otherSupport } });
  const coordinatorOnly = await app.inject({ method: 'GET', url: '/corrections', headers: { cookie: coordinator } });
  const all = await app.inject({ method: 'GET', url: '/corrections', headers: { cookie: jefe } });
  assert.ok(parsed(own).corrections.some((item) => item.id === correction.id));
  assert.equal(parsed(other).corrections.some((item) => item.id === correction.id), false);
  assert.equal(parsed(coordinatorOnly).corrections.some((item) => item.id === correction.id), false);
  assert.ok(parsed(coordinatorOnly).corrections.some((item) => item.id === coordinatorCorrection.id));
  assert.ok(parsed(all).corrections.some((item) => item.id === correction.id));
  assert.equal((await app.inject({ method: 'GET', url: `/corrections/${correction.id}`, headers: { cookie: otherSupport } })).statusCode, 404);
});

test('approves a correction atomically and creates one compensating adjustment', async () => {
  const requester = await login(users.support.username);
  const reviewer = await login(users.jefe.username);
  const { original, product, correction } = await createCommittedCorrection(requester, -3);
  const beforeOriginal = await prisma.inventoryMovement.findUniqueOrThrow({ where: { id: original.id } });
  const response = await mutate('POST', `/corrections/${correction.id}/approve`, reviewer);
  assert.equal(response.statusCode, 200);
  const approved = parsed(response).correction;
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.reviewedById, users.jefe.id);
  assert.equal(approved.compensatingMovement.movementType, 'ADJUSTMENT');
  assert.equal(approved.compensatingMovement.quantity, -3);
  assert.deepEqual(await prisma.inventoryMovement.findUniqueOrThrow({ where: { id: original.id } }), beforeOriginal);
  const stock = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
  assert.equal(stock?.quantity, 7);
  assert.equal(await prisma.auditLog.count({ where: { entityId: correction.id, action: 'CORRECTION_APPROVED' } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { entityId: approved.compensatingMovement.id, action: 'CORRECTION_MOVEMENT_CREATED' } }), 1);
});

test('rejects self-approval, SOPORTE approval, and processing after rejection', async () => {
  const requester = await login(users.support.username);
  const { correction } = await createCommittedCorrection(requester);
  assert.equal((await mutate('POST', `/corrections/${correction.id}/approve`, requester)).statusCode, 403);
  assert.equal((await mutate('POST', `/corrections/${correction.id}/reject`, requester)).statusCode, 403);
  const coordinator = await login(users.coordinator.username);
  assert.equal((await mutate('POST', `/corrections/${correction.id}/approve`, coordinator)).statusCode, 403);
  assert.equal((await mutate('POST', `/corrections/${correction.id}/reject`, coordinator)).statusCode, 403);
  const reviewer = await login(users.jefe.username);
  assert.equal((await mutate('POST', `/corrections/${correction.id}/reject`, reviewer)).statusCode, 200);
  assert.equal((await mutate('POST', `/corrections/${correction.id}/approve`, reviewer)).statusCode, 409);
  const stored = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: correction.id } });
  assert.equal(stored.status, 'REJECTED');
  assert.equal(stored.compensatingMovementId, null);
});

test('requires CSRF and leaves no effect when the token is invalid', async () => {
  const cookie = await login(users.support.username);
  const fixture = await createFixture();
  const before = await prisma.inventoryStock.findUnique({ where: { productId: fixture.product.id } });
  const response = await app.inject({ method: 'POST', url: `/inventory/movements/${fixture.original.id}/corrections`, headers: { cookie, 'x-csrf-token': 'invalid' }, payload: { delta: -1, reason: 'Should fail' } });
  assert.equal(response.statusCode, 403);
  const after = await prisma.inventoryStock.findUnique({ where: { productId: fixture.product.id } });
  assert.equal(after?.quantity, before?.quantity);
  assert.equal(await prisma.correctionRequest.count({ where: { originalMovementId: fixture.original.id } }), 0);
});

test('rejects approval when current stock would become negative', async () => {
  const requester = await login(users.support.username);
  const reviewer = await login(users.jefe.username);
  const { original, product } = await createFixture(10);
  assert.equal((await mutate('POST', '/inventory/movements/exit', requester, { productId: product.id, quantity: 8 })).statusCode, 200);
  const requested = await requestCorrection(requester, original.id, -3);
  const response = await mutate('POST', `/corrections/${parsed(requested).correction.id}/approve`, reviewer);
  assert.equal(response.statusCode, 409);
  const correction = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: parsed(requested).correction.id } });
  const stock = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
  assert.equal(correction.status, 'PENDING');
  assert.equal(correction.compensatingMovementId, null);
  assert.equal(stock?.quantity, 2);
});

test('serializes concurrent approvals into one approval and one compensating movement', async () => {
  const requester = await login(users.support.username);
  const reviewer = await login(users.jefe.username);
  const secondReviewer = await login(users.secondJefe.username);
  const { product, correction } = await createCommittedCorrection(requester, -2);
  const tokens = await Promise.all([csrf(reviewer), csrf(secondReviewer)]);
  const responses = await Promise.all([
    app.inject({ method: 'POST', url: `/corrections/${correction.id}/approve`, headers: { cookie: reviewer, 'x-csrf-token': tokens[0] } }),
    app.inject({ method: 'POST', url: `/corrections/${correction.id}/approve`, headers: { cookie: secondReviewer, 'x-csrf-token': tokens[1] } })
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal(await prisma.correctionRequest.count({ where: { id: correction.id, status: 'APPROVED' } }), 1);
  assert.equal(await prisma.inventoryMovement.count({ where: { reference: `correction:${correction.id}` } }), 1);
  const stock = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
  assert.equal(stock?.quantity, 8);
});

test('approval rolls back when movement, stock, or audit persistence fails', async () => {
  const requester = await login(users.support.username);
  const reviewer = await login(users.jefe.username);
  for (const failure of [{ model: 'inventoryMovement', operation: 'create' }, { model: 'inventoryStock', operation: 'update' }, { model: 'auditLog', operation: 'create' }]) {
    const { product, correction } = await createCommittedCorrection(requester, -1);
    const before = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    const faultyApp = buildApp(databaseWithFailure(failure.model, failure.operation));
    const response = await faultyApp.inject({ method: 'POST', url: `/corrections/${correction.id}/approve`, headers: { cookie: reviewer, 'x-csrf-token': await csrf(reviewer) } });
    assert.equal(response.statusCode, 500);
    await faultyApp.close();
    const after = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    const stored = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: correction.id } });
    assert.equal(after?.quantity, before?.quantity);
    assert.equal(stored.status, 'PENDING');
    assert.equal(stored.compensatingMovementId, null);
    assert.equal(await prisma.inventoryMovement.count({ where: { reference: `correction:${correction.id}` } }), 0);
  }
});

async function requestFinalQuantity(cookie, movementId, correctedQuantity, reason = 'Cantidad final corregida') {
  return mutate('POST', `/inventory/movements/${movementId}/corrections`, cookie, { correctedQuantity, reason });
}

async function readHistory(cookie, productId, query = '') {
  const response = await app.inject({ method: 'GET', url: `/inventory/products/${productId}/history${query}`, headers: { cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return parsed(response);
}

test('JEFE corrections apply immediately, retain the requested final quantity and audit self-review', async () => {
  const jefe = await login(users.jefe.username);
  const { product, original } = await createFixture();
  const response = await requestFinalQuantity(jefe, original.id, 7);
  assert.equal(response.statusCode, 201, response.body);
  const correction = parsed(response).correction;
  assert.equal(correction.status, 'APPROVED');
  assert.equal(correction.previousQuantity, 10);
  assert.equal(correction.correctedQuantity, 7);
  assert.equal(correction.delta, -3);
  assert.equal(correction.requestedById, users.jefe.id);
  assert.equal(correction.reviewedById, users.jefe.id);
  assert.ok(correction.reviewedAt);
  assert.equal(correction.compensatingMovement.quantity, -3);
  assert.equal((await prisma.inventoryStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity, 7);
  const approvalAudit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: correction.id, action: 'CORRECTION_APPROVED' } });
  assert.equal(approvalAudit.metadata.autoApplied, true);
  assert.equal((await mutate('POST', `/corrections/${correction.id}/approve`, jefe)).statusCode, 409);
  assert.equal((await mutate('POST', `/corrections/${correction.id}/reject`, jefe)).statusCode, 409);
});

test('COORDINADOR and SOPORTE final-quantity requests wait for JEFE and do not alter history until approval', async () => {
  const jefe = await login(users.jefe.username);
  for (const user of [users.coordinator, users.support]) {
    const operator = await login(user.username);
    const { product, original } = await createFixture();
    const response = await requestFinalQuantity(operator, original.id, 8);
    assert.equal(response.statusCode, 201, response.body);
    const correction = parsed(response).correction;
    assert.equal(correction.status, 'PENDING');
    assert.equal(correction.delta, -2);
    const pendingHistory = await readHistory(operator, product.id);
    assert.equal(pendingHistory.historyQuantity, 10);
    assert.equal(pendingHistory.movements[0].effectiveQuantity, 10);
    assert.equal((await mutate('POST', `/corrections/${correction.id}/approve`, jefe)).statusCode, 200);
    const approvedHistory = await readHistory(operator, product.id);
    assert.equal(approvedHistory.historyQuantity, 8);
    assert.equal(approvedHistory.isConsistent, true);
  }
});

test('replacing movement six recalculates later balances from four to five without rewriting or double counting', async () => {
  const jefe = await login(users.jefe.username);
  const product = await prisma.product.create({ data: { name: `Ledger fixture ${randomUUID()}`, trackingMode: ProductTrackingMode.QUANTITY } });
  const specifications = [
    { movementType: MovementType.INITIAL, quantity: 15 },
    ...Array.from({ length: 4 }, () => ({ movementType: MovementType.EXIT, quantity: 1 })),
    { movementType: MovementType.EXIT, quantity: 3 },
    ...Array.from({ length: 4 }, () => ({ movementType: MovementType.EXIT, quantity: 1 })),
    ...Array.from({ length: 10 }, (_, index) => ({ movementType: index % 2 === 0 ? MovementType.ENTRY : MovementType.EXIT, quantity: 1 }))
  ];
  const originals = [];
  for (const [index, specification] of specifications.entries()) {
    originals.push(await prisma.inventoryMovement.create({ data: { productId: product.id, performedById: users.support.id, ...specification, effectiveAt: new Date(Date.UTC(2026, 0, index + 1)) } }));
  }
  await prisma.inventoryStock.create({ data: { productId: product.id, quantity: 4 } });
  const before = await readHistory(jefe, product.id);
  assert.equal(before.historyQuantity, 4);
  assert.equal(before.movements.length, 20);
  const response = await requestFinalQuantity(jefe, originals[5].id, -2);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(parsed(response).correction.delta, 1);
  const after = await readHistory(jefe, product.id);
  assert.equal(after.stockQuantity, 5);
  assert.equal(after.historyQuantity, 5);
  assert.equal(after.isConsistent, true);
  assert.equal(after.hasNegativeBalance, false);
  assert.equal(after.movements.length, 20);
  assert.equal(after.compensatingMovements.length, 1);
  assert.equal(after.movements[5].originalQuantity, -3);
  assert.equal(after.movements[5].effectiveQuantity, -2);
  for (const [index, movement] of after.movements.entries()) {
    assert.equal(movement.balanceAfter, before.movements[index].balanceAfter + (index >= 5 ? 1 : 0));
    assert.equal(movement.effectiveQuantity, index === 5 ? -2 : before.movements[index].effectiveQuantity);
    assert.deepEqual(await prisma.inventoryMovement.findUniqueOrThrow({ where: { id: originals[index].id } }), originals[index]);
  }
  const filtered = await readHistory(jefe, product.id, '?from=2026-01-07T00:00:00Z&to=2026-01-10T00:00:00Z&movementType=EXIT');
  assert.equal(filtered.movements.length, 4);
  assert.equal(filtered.movements[0].balanceBefore, after.movements[6].balanceBefore);
  assert.equal(filtered.historyQuantity, 5);
  const again = await requestFinalQuantity(jefe, originals[5].id, -4);
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(parsed(again).correction.previousQuantity, -2);
  assert.equal(parsed(again).correction.delta, -2);
  const twice = await readHistory(jefe, product.id);
  assert.equal(twice.stockQuantity, 3);
  assert.equal(twice.historyQuantity, 3);
  assert.equal(twice.movements[5].effectiveQuantity, -4);
  assert.equal(twice.compensatingMovements.length, 2);
});

test('rejected requests allow retry and approved requests use the current corrected baseline', async () => {
  const operator = await login(users.support.username);
  const jefe = await login(users.jefe.username);
  const { product, original } = await createFixture();
  const first = parsed(await requestFinalQuantity(operator, original.id, 7)).correction;
  assert.equal((await mutate('POST', `/corrections/${first.id}/reject`, jefe)).statusCode, 200);
  const retry = await requestFinalQuantity(operator, original.id, 8);
  assert.equal(retry.statusCode, 201, retry.body);
  assert.equal((await mutate('POST', `/corrections/${parsed(retry).correction.id}/approve`, jefe)).statusCode, 200);
  const third = await requestCorrection(operator, original.id, 1);
  assert.equal(third.statusCode, 201, third.body);
  assert.equal(parsed(third).correction.previousQuantity, 8);
  assert.equal(parsed(third).correction.correctedQuantity, 9);
  assert.equal((await mutate('POST', `/corrections/${parsed(third).correction.id}/approve`, jefe)).statusCode, 200);
  assert.equal((await readHistory(jefe, product.id)).historyQuantity, 9);
  assert.equal(await prisma.correctionRequest.count({ where: { originalMovementId: original.id } }), 3);
});

test('final quantities reject ambiguity, no-op, incorrect direction, unsupported integers and compensating adjustments', async () => {
  const jefe = await login(users.jefe.username);
  const { product, original } = await createFixture();
  for (const payload of [
    { reason: 'Missing quantity' },
    { correctedQuantity: 7, delta: -3, reason: 'Ambiguous' },
    { correctedQuantity: null, reason: 'Null' },
    { correctedQuantity: '7', reason: 'String' },
    { correctedQuantity: 1.5, reason: 'Fraction' },
    { correctedQuantity: 2_147_483_648, reason: 'Overflow' },
    { correctedQuantity: 10, reason: 'No change' },
    { correctedQuantity: -1, reason: 'Wrong entry direction' }
  ]) {
    const response = await mutate('POST', `/inventory/movements/${original.id}/corrections`, jefe, payload);
    assert.equal(response.statusCode, 400, response.body);
  }
  const approved = parsed(await requestFinalQuantity(jefe, original.id, 7)).correction;
  assert.equal((await requestFinalQuantity(jefe, approved.compensatingMovementId, -1)).statusCode, 409);
  const exitResponse = await mutate('POST', '/inventory/movements/exit', jefe, { productId: product.id, quantity: 2 });
  const exit = parsed(exitResponse).movement;
  assert.equal((await requestFinalQuantity(jefe, exit.id, 1)).statusCode, 400);
  assert.equal((await requestFinalQuantity(jefe, exit.id, 0)).statusCode, 201);
  assert.equal((await readHistory(jefe, product.id)).stockQuantity, 7);
});

test('negative adjustments preserve their sign and can be corrected across zero', async () => {
  const jefe = await login(users.jefe.username);
  const { product } = await createFixture();
  const adjustment = parsed(await mutate('POST', '/inventory/movements/adjustment', jefe, { productId: product.id, quantity: -3, reason: 'Count' })).movement;
  const response = await requestFinalQuantity(jefe, adjustment.id, 2);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(parsed(response).correction.previousQuantity, -3);
  assert.equal(parsed(response).correction.delta, 5);
  const history = await readHistory(jefe, product.id);
  assert.equal(history.historyQuantity, 12);
  assert.equal(history.isConsistent, true);
  assert.equal(history.movements.find((movement) => movement.id === adjustment.id).effectiveQuantity, 2);
});

test('concurrent JEFE requests for the same final quantity apply only once', async () => {
  const jefe = await login(users.jefe.username);
  const { product, original } = await createFixture();
  const token = await csrf(jefe);
  const responses = await Promise.all([1, 2].map(() => mutate('POST', `/inventory/movements/${original.id}/corrections`, jefe, { correctedQuantity: 7, reason: 'Concurrent final quantity' }, token)));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 400]);
  const history = await readHistory(jefe, product.id);
  assert.equal(history.stockQuantity, 7);
  assert.equal(history.historyQuantity, 7);
  assert.equal(history.compensatingMovements.length, 1);
});

test('concurrent corrections to different movements cannot consume the same stock twice', async () => {
  const jefe = await login(users.jefe.username);
  const { product } = await createFixture();
  const exits = [];
  for (let index = 0; index < 2; index++) {
    exits.push(parsed(await mutate('POST', '/inventory/movements/exit', jefe, { productId: product.id, quantity: 2 })).movement);
  }
  const token = await csrf(jefe);
  const responses = await Promise.all(exits.map((exit) => mutate('POST', `/inventory/movements/${exit.id}/corrections`, jefe, { correctedQuantity: -6, reason: 'Concurrent stock consumption' }, token)));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  const history = await readHistory(jefe, product.id);
  assert.equal(history.stockQuantity, 2);
  assert.equal(history.historyQuantity, 2);
  assert.equal(history.compensatingMovements.length, 1);
});

test('JEFE auto-application rolls back the request, stock, movement and audits together on persistence failure', async () => {
  const jefe = await login(users.jefe.username);
  for (const failure of [
    { model: 'inventoryMovement', operation: 'create' },
    { model: 'inventoryStock', operation: 'update' },
    { model: 'correctionRequest', operation: 'update' },
    { model: 'auditLog', operation: 'create' }
  ]) {
    const { product, original } = await createFixture();
    const faultyApp = buildApp(databaseWithFailure(failure.model, failure.operation));
    const response = await faultyApp.inject({ method: 'POST', url: `/inventory/movements/${original.id}/corrections`, headers: { cookie: jefe, 'x-csrf-token': await csrf(jefe) }, payload: { correctedQuantity: 7, reason: 'Atomic auto-application' } });
    assert.equal(response.statusCode, 500);
    await faultyApp.close();
    assert.equal(await prisma.correctionRequest.count({ where: { originalMovementId: original.id } }), 0);
    assert.equal(await prisma.inventoryMovement.count({ where: { productId: product.id } }), 1);
    assert.equal((await prisma.inventoryStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity, 10);
    assert.equal(await prisma.auditLog.count({ where: { metadata: { path: ['originalMovementId'], equals: original.id } } }), 0);
  }
});

test('history requires authentication and reports historical negatives or materialized-stock divergence', async () => {
  const jefe = await login(users.jefe.username);
  const { product, original } = await createFixture();
  assert.equal((await app.inject({ method: 'GET', url: `/inventory/products/${product.id}/history` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: `/inventory/products/${assetProduct.id}/history`, headers: { cookie: jefe } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `/inventory/products/${randomUUID()}/history`, headers: { cookie: jefe } })).statusCode, 404);
  await prisma.inventoryMovement.create({ data: { productId: product.id, movementType: MovementType.EXIT, quantity: 1, effectiveAt: new Date(original.effectiveAt.getTime() - 86_400_000) } });
  const history = await readHistory(jefe, product.id);
  assert.equal(history.hasNegativeBalance, true);
  assert.equal(history.isConsistent, false);
  assert.equal(history.stockQuantity, 10);
  assert.equal(history.historyQuantity, 9);
});

test('legacy pending JEFE requests still require another JEFE for explicit review', async () => {
  const jefe = await login(users.jefe.username);
  const otherJefe = await login(users.secondJefe.username);
  const { product, original } = await createFixture();
  const pending = await prisma.correctionRequest.create({ data: { originalMovementId: original.id, requestedById: users.jefe.id, reason: 'Legacy pending request', delta: -3, correctedQuantity: 7 } });
  assert.equal((await mutate('POST', `/corrections/${pending.id}/approve`, jefe)).statusCode, 403);
  assert.equal((await mutate('POST', `/corrections/${pending.id}/reject`, jefe)).statusCode, 403);
  const response = await mutate('POST', `/corrections/${pending.id}/approve`, otherJefe);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(parsed(response).correction.previousQuantity, 10);
  assert.equal((await readHistory(jefe, product.id)).stockQuantity, 7);
});

test('stock overflow returns a conflict and rolls back immediate JEFE application', async () => {
  const jefe = await login(users.jefe.username);
  const { product, original } = await createFixture(2_147_483_646);
  assert.equal((await mutate('POST', '/inventory/movements/entry', jefe, { productId: product.id, quantity: 1 })).statusCode, 200);
  const response = await requestFinalQuantity(jefe, original.id, 2_147_483_647);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(parsed(response).code, 'STOCK_LIMIT_EXCEEDED');
  assert.equal(await prisma.correctionRequest.count({ where: { originalMovementId: original.id } }), 0);
  const history = await readHistory(jefe, product.id);
  assert.equal(history.stockQuantity, 2_147_483_647);
  assert.equal(history.historyQuantity, 2_147_483_647);
});

test('concurrent approval and a subsequent request finish without lock inversion or duplicate pending requests', async () => {
  const operator = await login(users.support.username);
  const jefe = await login(users.jefe.username);
  const { product, original, correction } = await createCommittedCorrection(operator, -3);
  const tokens = await Promise.all([csrf(jefe), csrf(operator)]);
  const [approved, next] = await Promise.all([
    mutate('POST', `/corrections/${correction.id}/approve`, jefe, undefined, tokens[0]),
    mutate('POST', `/inventory/movements/${original.id}/corrections`, operator, { correctedQuantity: 8, reason: 'Next correction' }, tokens[1])
  ]);
  assert.equal(approved.statusCode, 200, approved.body);
  assert.ok([201, 409].includes(next.statusCode), next.body);
  assert.equal(await prisma.correctionRequest.count({ where: { originalMovementId: original.id, status: 'PENDING' } }), next.statusCode === 201 ? 1 : 0);
  const history = await readHistory(jefe, product.id);
  assert.equal(history.stockQuantity, 7);
  assert.equal(history.historyQuantity, 7);
});

test('movement eligibility uses all correction states independently of requester visibility', async () => {
  const support = await login(users.support.username);
  const otherSupport = await login(users.otherSupport.username);
  const jefe = await login(users.jefe.username);
  const { original } = await createFixture();
  const readMovement = async (id) => parsed(await app.inject({ method: 'GET', url: `/inventory/movements/${id}`, headers: { cookie: otherSupport } })).movement;
  assert.equal((await readMovement(original.id)).canCorrect, true);
  const pending = parsed(await requestFinalQuantity(support, original.id, 7)).correction;
  assert.equal((await readMovement(original.id)).canCorrect, false);
  assert.equal((await readMovement(original.id)).effectiveQuantity, 10);
  assert.equal((await mutate('POST', `/corrections/${pending.id}/reject`, jefe)).statusCode, 200);
  assert.equal((await readMovement(original.id)).canCorrect, true);
  const approved = parsed(await requestFinalQuantity(jefe, original.id, 8)).correction;
  const movement = await readMovement(original.id);
  assert.equal(movement.canCorrect, true);
  assert.equal(movement.originalQuantity, 10);
  assert.equal(movement.effectiveQuantity, 8);
  const compensation = await readMovement(approved.compensatingMovementId);
  assert.equal(compensation.canCorrect, false);
  assert.equal(compensation.compensatingCorrectionId, approved.id);
});

after(async () => { await app.close(); });
