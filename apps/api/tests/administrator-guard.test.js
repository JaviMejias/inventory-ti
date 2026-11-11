import './require-test-database.js';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { PrismaClient, Role } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { ensureAdministratorRemains, lockAdministratorChanges } from '../src/auth/administrator-guard.js';
import { hashPassword } from '../src/lib/password.js';

// Other suites create JEFE fixtures in public. Isolate the administrator floor
// in a private schema inside the runner's disposable database, never the real DB.
const schema = `administrators_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', schema);
const database = new PrismaClient({ datasources: { db: { url: url.href } } });
const otherDatabase = new PrismaClient({ datasources: { db: { url: url.href } } });
const app = buildApp(database);
const otherApp = buildApp(otherDatabase);
const password = 'Valid-password-123';
const passwordHash = hashPassword(password);
let administrator;
let headers;

async function createUser(changes = {}) {
  return database.user.create({ data: { username: `guard-${randomUUID()}`, displayName: 'Guard operator', role: Role.JEFE, passwordHash, ...changes } });
}

async function signIn(user, targetApp = app) {
  const response = await targetApp.inject({ method: 'POST', url: '/auth/login', payload: { identifier: user.username, password } });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = response.headers['set-cookie'].split(';')[0];
  const csrf = await targetApp.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } });
  assert.equal(csrf.statusCode, 200, csrf.body);
  return { cookie, 'x-csrf-token': csrf.json().csrfToken };
}

function mutate(user, action, ownHeaders = headers, targetApp = app) {
  const demote = action === 'demote';
  return targetApp.inject({ method: demote ? 'PATCH' : 'POST', url: `/users/${user.id}${demote ? '' : `/${action}`}`, headers: ownHeaders, ...(demote ? { payload: { role: Role.SOPORTE } } : {}) });
}

async function countAdministrators() {
  return database.user.count({ where: { role: Role.JEFE, isActive: true, passwordHash: { not: null } } });
}

function wrappedClient(client, overrides) {
  return new Proxy(client, {
    get(target, property) {
      if (property in overrides) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

before(() => {
  execFileSync(process.execPath, ['./node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', '../../prisma/schema.prisma'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: url.href },
    stdio: 'pipe'
  });
});

beforeEach(async () => {
  await database.user.deleteMany();
  administrator = await createUser();
  headers = await signIn(administrator);
});

after(async () => { await Promise.all([app.close(), otherApp.close()]); });

for (const action of ['deactivate', 'demote']) {
  test(`the last activated JEFE cannot ${action}, even with pending or inactive replacements`, async () => {
    await createUser({ passwordHash: null });
    await createUser({ isActive: false });
    const auditCount = await database.auditLog.count();
    const response = await mutate(administrator, action);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'LAST_ADMIN_REQUIRED');
    assert.equal(await countAdministrators(), 1);
    assert.equal(await database.auditLog.count(), auditCount);
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers })).statusCode, 200);
  });
}

test('resetting the last usable administrator is rejected before changing credentials or sessions', async () => {
  await assert.rejects(database.$transaction(async (transaction) => {
    await lockAdministratorChanges(transaction);
    const current = await transaction.user.findUniqueOrThrow({ where: { id: administrator.id } });
    await ensureAdministratorRemains(transaction, current, { passwordHash: null });
  }), { code: 'LAST_ADMIN_REQUIRED', statusCode: 409 });
  assert.equal((await database.user.findUniqueOrThrow({ where: { id: administrator.id } })).passwordHash, passwordHash);
  assert.equal(await database.session.count({ where: { userId: administrator.id } }), 1);
  const selfReset = await mutate(administrator, 'reset-access');
  assert.equal(selfReset.statusCode, 403, selfReset.body);
  assert.equal(selfReset.json().code, 'SELF_ACCESS_RESET');
});

test('the last JEFE can edit a profile and retain the same role', async () => {
  const response = await app.inject({ method: 'PATCH', url: `/users/${administrator.id}`, headers, payload: { displayName: 'Updated operator', role: Role.JEFE } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(await countAdministrators(), 1);
});

for (const action of ['deactivate', 'demote', 'reset-access']) {
  test(`a JEFE can ${action} another administrator when a usable JEFE remains`, async () => {
    const other = await createUser();
    const otherHeaders = await signIn(other);
    const response = await mutate(other, action);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await countAdministrators(), 1);
    if (action !== 'demote') assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: otherHeaders })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers })).statusCode, 200);
  });
}

for (const actions of [['deactivate', 'deactivate'], ['demote', 'demote'], ['deactivate', 'demote']]) {
  test(`concurrent ${actions.join(' / ')} in separate app instances preserves one administrator`, async () => {
    const other = await createUser();
    const otherHeaders = await signIn(other, otherApp);
    const responses = await Promise.all([mutate(administrator, actions[0]), mutate(other, actions[1], otherHeaders, otherApp)]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409], responses.map((response) => response.body).join('\n'));
    assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'LAST_ADMIN_REQUIRED');
    assert.equal(await countAdministrators(), 1);
  });
}

test('concurrent mutual access resets recheck the actor after acquiring the administrator lock', async () => {
  const other = await createUser();
  const otherHeaders = await signIn(other, otherApp);
  const responses = await Promise.all([mutate(other, 'reset-access'), mutate(administrator, 'reset-access', otherHeaders, otherApp)]);
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 1, responses.map((response) => response.body).join('\n'));
  assert.ok(responses.some((response) => [401, 403].includes(response.statusCode)));
  assert.equal(await countAdministrators(), 1);
  assert.equal(await database.activationCode.count({ where: { usedAt: null } }), 1);
});

for (const action of ['create', 'edit', 'activate', 'deactivate', 'reset-access']) {
  test(`a ${action} request admitted before its actor loses JEFE permissions cannot commit later`, async () => {
    const other = await createUser();
    const otherHeaders = await signIn(other);
    let release;
    let entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const paused = new Promise((resolve) => { entered = resolve; });
    const racingApp = buildApp(wrappedClient(database, {
      $disconnect: async () => {},
      $transaction: (callback) => database.$transaction((transaction) => callback(wrappedClient(transaction, {
        $executeRaw: async (...arguments_) => {
          entered();
          await waiting;
          return transaction.$executeRaw(...arguments_);
        }
      })))
    }));
    const pending = racingApp.inject({
      method: action === 'edit' ? 'PATCH' : 'POST',
      url: action === 'create' ? '/users' : `/users/${administrator.id}${action === 'edit' ? '' : `/${action}`}`,
      headers: otherHeaders,
      ...(action === 'create' ? { payload: { username: `new-${randomUUID()}`, email: `new-${randomUUID()}@example.test`, phone: '+56912345678', displayName: 'New operator', role: Role.SOPORTE } } : action === 'edit' ? { payload: { displayName: 'Unauthorized edit' } } : {})
    });
    try {
      await Promise.race([paused, pending.then((response) => { throw new Error(`Request finished before the race gate: ${response.statusCode} ${response.body}`); })]);
      assert.equal((await mutate(other, 'demote')).statusCode, 200);
      const auditCount = await database.auditLog.count();
      release();
      const response = await pending;
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().code, 'FORBIDDEN');
      assert.equal(await database.user.count(), 2);
      assert.equal(await database.auditLog.count(), auditCount);
      assert.equal(await countAdministrators(), 1);
      assert.equal(await database.activationCode.count(), 0);
      assert.equal((await database.user.findUniqueOrThrow({ where: { id: administrator.id } })).displayName, administrator.displayName);
    } finally {
      release();
      await pending;
      await racingApp.close();
    }
  });
}
