import './require-test-database.js';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PrismaClient, Role } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { maximumQuantity, minimumQuantity } from '../src/lib/quantity.js';
import { hashPassword } from '../src/lib/password.js';
import { quarantineTestUsers } from '../src/lib/test-user-quarantine.js';

const database = new PrismaClient();
const app = buildApp(database);
const password = 'Valid-password-123';
let administrator;
let headers;

function wrappedClient(client, overrides) {
  return new Proxy(client, {
    get(target, property) {
      if (property in overrides) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function createUser(role = Role.SOPORTE) {
  const id = randomUUID();
  return database.user.create({ data: { username: `hardening-${id}`, displayName: 'Hardening operator', role, passwordHash: hashPassword(password) } });
}

async function createProduct(trackingMode = 'QUANTITY') {
  return database.product.create({ data: { name: `Hardening product ${randomUUID()}`, trackingMode } });
}

async function signIn(targetApp, username, suppliedPassword = password, options = {}) {
  return targetApp.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password: suppliedPassword }, ...options });
}

async function sessionHeaders(response) {
  assert.equal(response.statusCode, 200, response.body);
  const cookie = response.headers['set-cookie'].split(';')[0];
  const csrf = await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } });
  assert.equal(csrf.statusCode, 200, csrf.body);
  return { cookie, 'x-csrf-token': csrf.json().csrfToken };
}

function mutate(url, payload, method = 'POST') {
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

before(async () => {
  administrator = await createUser(Role.JEFE);
  headers = await sessionHeaders(await signIn(app, administrator.username));
});

after(async () => { await app.close(); });

for (const operation of ['reset', 'password change']) {
  test(`a login verified before ${operation} cannot create a session afterwards`, async () => {
    const user = await createUser();
    const ownHeaders = await sessionHeaders(await signIn(app, user.username));
    let release;
    let entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const paused = new Promise((resolve) => { entered = resolve; });
    const userModel = wrappedClient(database.user, {
      findFirst: async (query) => {
        const found = await database.user.findFirst(query);
        entered();
        await waiting;
        return found;
      }
    });
    const racingApp = buildApp(wrappedClient(database, { user: userModel, $disconnect: async () => {} }));
    const pending = signIn(racingApp, user.username);
    try {
      await paused;
      const changed = operation === 'reset'
        ? await mutate(`/users/${user.id}/reset-access`)
        : await app.inject({ method: 'POST', url: '/auth/password', headers: ownHeaders, payload: { currentPassword: password, newPassword: 'Changed-password-456' } });
      assert.equal(changed.statusCode, 200, changed.body);
      release();
      const response = await pending;
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(await database.session.count({ where: { userId: user.id } }), operation === 'reset' ? 0 : 1);
    } finally {
      release();
      await pending;
      await racingApp.close();
    }
  });
}

test('reset after a completed login invalidates its existing session', async () => {
  const user = await createUser();
  const ownHeaders = await sessionHeaders(await signIn(app, user.username));
  assert.equal((await mutate(`/users/${user.id}/reset-access`)).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: ownHeaders })).statusCode, 401);
});

test('an unactivated account cannot authenticate even with a persisted session', async () => {
  const user = await createUser();
  await database.user.update({ where: { id: user.id }, data: { passwordHash: null } });
  const token = randomUUID();
  await database.session.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60_000) } });
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `inventory_ti_session=${token}` } })).statusCode, 401);
  assert.equal(await database.session.count({ where: { userId: user.id } }), 0);
});

test('twenty parallel failed logins cannot exceed ten admitted attempts', async () => {
  const options = { remoteAddress: '192.0.2.10' };
  const responses = await Promise.all(Array.from({ length: 20 }, () => signIn(app, administrator.username, 'Wrong-password-123', options)));
  assert.equal(responses.filter((response) => response.statusCode === 401).length, 10);
  assert.equal(responses.filter((response) => response.statusCode === 429).length, 10);
  assert.equal((await signIn(app, administrator.username, password, options)).statusCode, 429);
});

test('twenty parallel invalid activation attempts share the same reservation limit', async () => {
  const responses = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'POST', url: '/auth/activate', remoteAddress: '192.0.2.11', payload: { identifier: 'unknown', activationCode: 'a'.repeat(32), password } })));
  assert.equal(responses.filter((response) => response.statusCode === 400).length, 10);
  assert.equal(responses.filter((response) => response.statusCode === 429).length, 10);
});

test('trusted local proxies keep independent login buckets for forwarded clients', async () => {
  for (let index = 0; index < 10; index += 1) {
    const response = await signIn(app, administrator.username, 'Wrong-password-123', { remoteAddress: '127.0.0.9', headers: { 'x-forwarded-for': '198.51.100.10' } });
    assert.equal(response.statusCode, 401);
  }
  assert.equal((await signIn(app, administrator.username, password, { remoteAddress: '127.0.0.9', headers: { 'x-forwarded-for': '198.51.100.11' } })).statusCode, 200);
});

test('untrusted clients cannot bypass login limits by spoofing forwarded IPs', async () => {
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await signIn(app, administrator.username, 'Wrong-password-123', { remoteAddress: '192.0.2.12', headers: { 'x-forwarded-for': `198.51.100.${index + 20}` } })).statusCode, 401);
  }
  assert.equal((await signIn(app, administrator.username, password, { remoteAddress: '192.0.2.12', headers: { 'x-forwarded-for': '198.51.100.99' } })).statusCode, 429);
});

test('rate-limit state belongs to each app instance', async () => {
  const other = buildApp(wrappedClient(database, { $disconnect: async () => {} }));
  try {
    assert.equal((await signIn(other, administrator.username, password, { remoteAddress: '192.0.2.10' })).statusCode, 200);
  } finally { await other.close(); }
});

test('a tracking mode can change only before stock, movement or assets exist', async () => {
  const unused = await createProduct();
  assert.equal((await mutate(`/products/${unused.id}`, { trackingMode: 'ASSET' }, 'PATCH')).statusCode, 200);
  assert.equal((await mutate(`/products/${unused.id}`, { trackingMode: 'QUANTITY' }, 'PATCH')).statusCode, 200);
  for (const relation of ['stock', 'movement', 'asset']) {
    const product = await createProduct(relation === 'asset' ? 'ASSET' : 'QUANTITY');
    if (relation === 'stock') await database.inventoryStock.create({ data: { productId: product.id, quantity: 0 } });
    if (relation === 'movement') await database.inventoryMovement.create({ data: { productId: product.id, movementType: 'ENTRY', quantity: 1, performedById: administrator.id } });
    if (relation === 'asset') await database.asset.create({ data: { productId: product.id } });
    const trackingMode = relation === 'asset' ? 'QUANTITY' : 'ASSET';
    const response = await mutate(`/products/${product.id}`, { trackingMode }, 'PATCH');
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'PRODUCT_TRACKING_MODE_LOCKED');
    await assert.rejects(database.product.update({ where: { id: product.id }, data: { trackingMode } }));
    assert.equal((await mutate(`/products/${product.id}`, { lowStockThreshold: 2 }, 'PATCH')).statusCode, 200);
  }
});

test('concurrent tracking-mode change and first stock entry cannot create mixed inventory', async () => {
  const product = await createProduct();
  const [updated, entry] = await Promise.all([
    mutate(`/products/${product.id}`, { trackingMode: 'ASSET' }, 'PATCH'),
    mutate('/inventory/movements/entry', { productId: product.id, quantity: 20 })
  ]);
  assert.deepEqual([updated.statusCode, entry.statusCode].sort(), [200, 409]);
  const current = await database.product.findUnique({ where: { id: product.id }, include: { stocks: true, movements: true } });
  assert.equal(current.stocks.length, current.trackingMode === 'QUANTITY' ? 1 : 0);
  assert.equal(current.movements.length, current.trackingMode === 'QUANTITY' ? 1 : 0);
});

test('concurrent tracking-mode change and first asset cannot cross tracking modes', async () => {
  const product = await createProduct('ASSET');
  const [updated, created] = await Promise.all([
    mutate(`/products/${product.id}`, { trackingMode: 'QUANTITY' }, 'PATCH'),
    mutate('/assets', { productId: product.id })
  ]);
  assert.ok((updated.statusCode === 200 && created.statusCode === 409) || (updated.statusCode === 409 && created.statusCode === 201), `${updated.body}; ${created.body}`);
  const current = await database.product.findUnique({ where: { id: product.id }, include: { assets: true } });
  assert.equal(current.assets.length, current.trackingMode === 'ASSET' ? 1 : 0);
});

test('case-insensitive SKU uniqueness survives concurrent creation and direct database writes', async () => {
  const sku = `Hardening-${randomUUID()}`;
  const responses = await Promise.all([sku, sku.toUpperCase()].map((value) => mutate('/products', { name: `SKU product ${randomUUID()}`, sku: value, trackingMode: 'QUANTITY' })));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  await assert.rejects(database.product.create({ data: { name: `Direct SKU ${randomUUID()}`, sku: ` ${sku.toLowerCase()} `, trackingMode: 'ASSET' } }), { code: 'P2002' });
  const other = await createProduct();
  assert.equal((await mutate(`/products/${other.id}`, { sku: sku.toLowerCase() }, 'PATCH')).statusCode, 409);
  assert.equal((await mutate(`/products/${other.id}`, { sku: null }, 'PATCH')).statusCode, 200);
});

test('malformed, oversized and unsupported bodies keep their client-error status', async () => {
  const malformed = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: '{' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, 'VALIDATION_ERROR');
  const oversized = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: 'a'.repeat(1_100_000), password } });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().code, 'PAYLOAD_TOO_LARGE');
  const unsupported = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/octet-stream' }, payload: 'test' });
  assert.equal(unsupported.statusCode, 415);
});

test('unexpected server errors remain sanitized 500 responses', async () => {
  const faulty = buildApp(wrappedClient(database, { $disconnect: async () => {} }));
  faulty.get('/unexpected-test-error', async () => { throw new Error('Private database details'); });
  try {
    const response = await faulty.inject({ method: 'GET', url: '/unexpected-test-error' });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { code: 'INTERNAL_ERROR', message: 'Internal server error' });
  } finally { await faulty.close(); }
});

test('out-of-range movement quantities and thresholds are rejected before writes', async () => {
  const product = await createProduct();
  for (const operation of ['initial', 'entry', 'exit', 'return', 'adjustment']) {
    assert.equal((await mutate(`/inventory/movements/${operation}`, { productId: product.id, quantity: maximumQuantity + 1, reason: 'Range test' })).statusCode, 400);
  }
  assert.equal((await mutate('/inventory/movements/adjustment', { productId: product.id, quantity: minimumQuantity - 1, reason: 'Range test' })).statusCode, 400);
  assert.equal((await mutate(`/products/${product.id}`, { lowStockThreshold: maximumQuantity + 1 }, 'PATCH')).statusCode, 400);
  assert.equal(await database.inventoryMovement.count({ where: { productId: product.id } }), 0);
  assert.equal(await database.inventoryStock.count({ where: { productId: product.id } }), 0);
});

test('stock overflow returns a conflict and rolls back movement creation', async () => {
  const product = await createProduct();
  assert.equal((await mutate('/inventory/movements/entry', { productId: product.id, quantity: maximumQuantity })).statusCode, 200);
  for (const operation of ['initial', 'entry', 'return', 'adjustment']) {
    const response = await mutate(`/inventory/movements/${operation}`, { productId: product.id, quantity: 1, reason: 'Overflow test' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'STOCK_LIMIT_EXCEEDED');
  }
  assert.equal((await database.inventoryStock.findUnique({ where: { productId: product.id } })).quantity, maximumQuantity);
  assert.equal(await database.inventoryMovement.count({ where: { productId: product.id } }), 1);
});

test('concurrent entries at the integer limit serialize without server errors', async () => {
  const product = await createProduct();
  assert.equal((await mutate('/inventory/movements/initial', { productId: product.id, quantity: maximumQuantity - 1 })).statusCode, 200);
  const responses = await Promise.all(Array.from({ length: 2 }, () => mutate('/inventory/movements/entry', { productId: product.id, quantity: 1 })));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal((await database.inventoryStock.findUnique({ where: { productId: product.id } })).quantity, maximumQuantity);
  assert.equal(await database.inventoryMovement.count({ where: { productId: product.id } }), 2);
});

test('a correction and a normal stock entry complete without a lock-order deadlock', async () => {
  const product = await createProduct();
  const original = await mutate('/inventory/movements/initial', { productId: product.id, quantity: 20 });
  const [correction, entry] = await Promise.all([
    mutate(`/inventory/movements/${original.json().movement.id}/corrections`, { correctedQuantity: 21, reason: 'Concurrent correction' }),
    mutate('/inventory/movements/entry', { productId: product.id, quantity: 2 })
  ]);
  assert.equal(correction.statusCode, 201, correction.body);
  assert.equal(entry.statusCode, 200, entry.body);
  assert.equal((await database.inventoryStock.findUnique({ where: { productId: product.id } })).quantity, 23);
});

test('test-account quarantine revokes access and preserves users and their movement history', async () => {
  const username = `inventory-jefe-${randomUUID().slice(0, 8)}`;
  const fixture = await database.user.create({ data: { username, email: `${username}@example.com`, displayName: 'Inventory jefe', role: Role.JEFE, passwordHash: hashPassword(password) } });
  const ownHeaders = await sessionHeaders(await signIn(app, fixture.username));
  const product = await createProduct();
  const movement = await app.inject({ method: 'POST', url: '/inventory/movements/entry', headers: ownHeaders, payload: { productId: product.id, quantity: 1 } });
  assert.equal(movement.statusCode, 200);
  await database.activationCode.create({ data: { userId: fixture.id, codeHash: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date(Date.now() + 60_000) } });
  const result = await quarantineTestUsers(database, [fixture.id]);
  assert.deepEqual(result, { users: 1, sessions: 1, activationCodes: 1 });
  const current = await database.user.findUnique({ where: { id: fixture.id } });
  assert.equal(current.isActive, false);
  assert.equal(current.passwordHash, null);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: ownHeaders })).statusCode, 401);
  assert.equal(await database.inventoryMovement.count({ where: { performedById: fixture.id } }), 1);
  assert.equal(await database.auditLog.count({ where: { entityId: fixture.id, action: 'TEST_ACCOUNT_QUARANTINED' } }), 1);
  assert.deepEqual(await quarantineTestUsers(database, [fixture.id]), { users: 0, sessions: 0, activationCodes: 0 });
});

test('quarantine refuses to remove the last usable administrator and leaves all access unchanged', async () => {
  const username = `asset-jefe-${randomUUID().slice(0, 8)}`;
  const fixture = await database.user.create({ data: { username, email: `${username}@example.com`, displayName: 'Asset jefe', role: Role.JEFE, passwordHash: hashPassword(password) } });
  const client = wrappedClient(database, { $transaction: (callback, options) => database.$transaction((transaction) => callback(wrappedClient(transaction, { user: wrappedClient(transaction.user, { count: async () => 0 }) })), options) });
  await assert.rejects(quarantineTestUsers(client, [fixture.id]), /activate a real JEFE/);
  assert.equal((await database.user.findUnique({ where: { id: fixture.id } })).isActive, true);
  assert.equal(await database.auditLog.count({ where: { entityId: fixture.id, action: 'TEST_ACCOUNT_QUARANTINED' } }), 0);
});

test('quarantine leaves original users and fixture-like accounts with private passwords untouched', async () => {
  const original = await createUser(Role.JEFE);
  const username = `inventory-jefe-${randomUUID().slice(0, 8)}`;
  const changed = await database.user.create({ data: { username, email: `${username}@example.com`, displayName: 'Inventory jefe', role: Role.JEFE, passwordHash: hashPassword('Private-password-789') } });
  assert.deepEqual(await quarantineTestUsers(database, [original.id, changed.id]), { users: 0, sessions: 0, activationCodes: 0 });
  for (const user of [original, changed]) {
    const current = await database.user.findUnique({ where: { id: user.id } });
    assert.equal(current.isActive, true);
    assert.equal(current.passwordHash, user.passwordHash);
  }
});
