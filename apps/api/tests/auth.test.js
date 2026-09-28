import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PrismaClient, Role } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { environment, parseEnvironment } from '../src/config/env.js';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();
const app = buildApp(prisma);
const password = 'Valid-password-123';
const suffix = randomUUID().slice(0, 8);
const users = {};

function cookieFrom(response) {
  const header = response.headers['set-cookie'];
  assert.ok(header);
  return (Array.isArray(header) ? header[0] : header).split(';')[0];
}

function cookieHeaderFrom(response) {
  const header = response.headers['set-cookie'];
  assert.ok(header);
  return Array.isArray(header) ? header[0] : header;
}

async function login(identifier, suppliedPassword = password) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier, password: suppliedPassword }
  });
  return { response, cookie: response.statusCode === 200 ? cookieFrom(response) : null };
}

async function csrf(cookie) {
  const response = await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  return JSON.parse(response.body).csrfToken;
}

before(async () => {
  await prisma.$connect();
  const definitions = [
    ['jefe', Role.JEFE],
    ['coordinator', Role.COORDINADOR],
    ['support', Role.SOPORTE],
    ['inactive', Role.SOPORTE]
  ];
  for (const [name, role] of definitions) {
    users[name] = await prisma.user.create({
      data: {
        username: `phase3-${name}-${suffix}`,
        email: `phase3-${name}-${suffix}@example.com`,
        displayName: name,
        passwordHash: hashPassword(password),
        role,
        isActive: name !== 'inactive'
      }
    });
  }
});

test('login creates a session and /auth/me never exposes passwordHash', async () => {
  const result = await login(users.jefe.username);
  assert.equal(result.response.statusCode, 200);
  assert.match(result.cookie, /inventory_ti_session=/);
  const rawSessionToken = result.cookie.split('=')[1];
  const storedSession = await prisma.session.findUnique({ where: { tokenHash: createHash('sha256').update(rawSessionToken).digest('hex') } });
  assert.ok(storedSession);
  assert.notEqual(storedSession.tokenHash, rawSessionToken);
  assert.equal('token' in JSON.parse(result.response.body), false);

  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: result.cookie } });
  assert.equal(me.statusCode, 200);
  const body = JSON.parse(me.body);
  assert.equal(body.user.role, Role.JEFE);
  assert.equal('passwordHash' in body.user, false);
});

test('invalid, unknown, and inactive credentials receive the same generic response', async () => {
  const wrongPassword = await login(users.jefe.username, 'Wrong-password-123');
  const unknownUser = await login(`unknown-${suffix}`);
  const inactive = await login(users.inactive.username);
  for (const result of [wrongPassword, unknownUser, inactive]) {
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(JSON.parse(result.response.body), {
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid username/email or password'
    });
  }
});

test('auth endpoints reject missing sessions and logout invalidates the session', async () => {
  const unauthenticated = await app.inject({ method: 'GET', url: '/auth/me' });
  assert.equal(unauthenticated.statusCode, 401);

  const result = await login(users.jefe.email);
  const token = await csrf(result.cookie);
  const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: result.cookie, 'x-csrf-token': token } });
  assert.equal(logout.statusCode, 200);

  const afterLogout = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: result.cookie } });
  assert.equal(afterLogout.statusCode, 401);
});

test('logout requires CSRF and does not invalidate the session when the token is missing', async () => {
  const result = await login(users.jefe.username);
  const rejected = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: result.cookie } });
  assert.equal(rejected.statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: result.cookie } })).statusCode, 200);
});

test('logout is safe when repeated or executed concurrently', async () => {
  const repeatedSession = await login(users.jefe.username);
  const repeatedToken = await csrf(repeatedSession.cookie);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: repeatedSession.cookie, 'x-csrf-token': repeatedToken } })).statusCode, 200);
  const repeated = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: repeatedSession.cookie, 'x-csrf-token': repeatedToken } });
  assert.equal(repeated.statusCode, 401);

  const concurrentSession = await login(users.jefe.username);
  const concurrentToken = await csrf(concurrentSession.cookie);
  const responses = await Promise.all([
    app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: concurrentSession.cookie, 'x-csrf-token': concurrentToken } }),
    app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: concurrentSession.cookie, 'x-csrf-token': concurrentToken } })
  ]);
  assert.ok(responses.every((response) => response.statusCode === 200 || response.statusCode === 401));
  assert.ok(responses.some((response) => response.statusCode === 200));
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: concurrentSession.cookie } })).statusCode, 401);
});

test('an authenticated request racing with logout never returns an internal error', async () => {
  const result = await login(users.jefe.username);
  const token = await csrf(result.cookie);
  const [me, logout] = await Promise.all([
    app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: result.cookie } }),
    app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: result.cookie, 'x-csrf-token': token } })
  ]);
  assert.ok(me.statusCode === 200 || me.statusCode === 401);
  assert.equal(logout.statusCode, 200);
  assert.notEqual(me.statusCode, 500);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: result.cookie } })).statusCode, 401);
});

test('missing sessions reject protected reads and mutations without leaking session state', async () => {
  const missing = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: 'inventory_ti_session=missing-session-token' } });
  assert.equal(missing.statusCode, 401);

  const result = await login(users.jefe.username);
  const token = await csrf(result.cookie);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: result.cookie, 'x-csrf-token': token } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/users', headers: { cookie: result.cookie } })).statusCode, 401);
  const mutation = await app.inject({ method: 'POST', url: '/users', headers: { cookie: result.cookie, 'x-csrf-token': token }, payload: { username: `after-logout-${suffix}`, displayName: 'Should not exist', email: `after-logout-${suffix}@example.com`, phone: '+56 9 1111 1111', role: Role.SOPORTE } });
  assert.equal(mutation.statusCode, 401);
});

test('a new session can be created after logout', async () => {
  const first = await login(users.jefe.username);
  const token = await csrf(first.cookie);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: first.cookie, 'x-csrf-token': token } })).statusCode, 200);

  const second = await login(users.jefe.username);
  assert.equal(second.response.statusCode, 200);
  assert.notEqual(second.cookie, first.cookie);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: second.cookie } })).statusCode, 200);
});

test('CSRF is required for user mutations and JEFE can create users', async () => {
  const jefe = await login(users.jefe.username);
  const withoutCsrf = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { cookie: jefe.cookie },
    payload: { username: `created-${suffix}`, displayName: 'Created user', email: `created-${suffix}@example.com`, phone: '+56 9 2222 2222', role: Role.SOPORTE }
  });
  assert.equal(withoutCsrf.statusCode, 403);

  const token = await csrf(jefe.cookie);
  const created = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { cookie: jefe.cookie, 'x-csrf-token': token },
    payload: { username: `created-${suffix}`, displayName: 'Created user', email: `created-${suffix}@example.com`, phone: '+56 9 2222 2222', role: Role.SOPORTE }
  });
  assert.equal(created.statusCode, 201);
  assert.equal('passwordHash' in JSON.parse(created.body).user, false);
});

test('role authorization is enforced by the backend', async () => {
  const jefe = await login(users.jefe.username);
  const coordinator = await login(users.coordinator.username);
  const support = await login(users.support.username);

  assert.equal((await app.inject({ method: 'GET', url: '/users', headers: { cookie: jefe.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/users', headers: { cookie: coordinator.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/users', headers: { cookie: support.cookie } })).statusCode, 403);
});

test('session cookies have the expected development security attributes and production rejects insecure cookies', async () => {
  const result = await login(users.jefe.username);
  const cookie = cookieHeaderFrom(result.response);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, new RegExp(`SameSite=${environment.COOKIE_SAME_SITE[0].toUpperCase()}${environment.COOKIE_SAME_SITE.slice(1)}`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Expires=/);
  if (environment.COOKIE_SECURE) assert.match(cookie, /; Secure/);
  else assert.doesNotMatch(cookie, /; Secure/);

  const expires = cookie.match(/Expires=([^;]+)/)?.[1];
  assert.ok(expires);
  assert.ok(Date.parse(expires) > Date.now());
  const productionBase = { DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/inventory_ti', NODE_ENV: 'production', SESSION_SECRET: 'production-session-secret-with-at-least-32-characters' };
  assert.throws(() => parseEnvironment({ ...productionBase, SESSION_SECRET: undefined }), /SESSION_SECRET/);
  assert.throws(() => parseEnvironment({ ...productionBase, COOKIE_SECURE: 'false' }), /COOKIE_SECURE must be true in production/);
  assert.equal(parseEnvironment({ ...productionBase, COOKIE_SECURE: 'true' }).COOKIE_SECURE, true);
  assert.equal(parseEnvironment({ ...productionBase, COOKIE_SECURE: 'true', COOKIE_SAME_SITE: 'none' }).COOKIE_SAME_SITE, 'none');
  assert.throws(() => parseEnvironment({ ...productionBase, COOKIE_SECURE: 'false', COOKIE_SAME_SITE: 'none' }), /COOKIE_SAME_SITE=none requires COOKIE_SECURE=true/);
});

test('expired sessions are rejected and removed from PostgreSQL', async () => {
  const token = `expired-${randomUUID()}`;
  const session = await prisma.session.create({
    data: {
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId: users.jefe.id,
      expiresAt: new Date(Date.now() - 1_000)
    }
  });

  const response = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `inventory_ti_session=${token}` } });
  assert.equal(response.statusCode, 401);
  assert.equal(await prisma.session.findUnique({ where: { id: session.id } }), null);
});

test('deactivating a user invalidates an existing session and activation restores access', async () => {
  const jefe = await login(users.jefe.username);
  const coordinator = await login(users.coordinator.username);
  const jefeCsrf = await csrf(jefe.cookie);

  const deactivated = await app.inject({ method: 'POST', url: `/users/${users.coordinator.id}/deactivate`, headers: { cookie: jefe.cookie, 'x-csrf-token': jefeCsrf } });
  assert.equal(deactivated.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: coordinator.cookie } })).statusCode, 401);

  const activation = await app.inject({ method: 'POST', url: `/users/${users.coordinator.id}/activate`, headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) } });
  assert.equal(activation.statusCode, 200);
  assert.equal((await login(users.coordinator.username)).response.statusCode, 200);
});

test('invalid CSRF tokens are rejected for every user mutation', async () => {
  const jefe = await login(users.jefe.username);
  const invalidHeaders = { cookie: jefe.cookie, 'x-csrf-token': 'invalid-token' };

  const patchResponse = await app.inject({ method: 'PATCH', url: `/users/${users.coordinator.id}`, headers: invalidHeaders, payload: { displayName: 'Should not update' } });
  const activateResponse = await app.inject({ method: 'POST', url: `/users/${users.coordinator.id}/activate`, headers: invalidHeaders });
  const deactivateResponse = await app.inject({ method: 'POST', url: `/users/${users.coordinator.id}/deactivate`, headers: invalidHeaders });

  assert.equal(patchResponse.statusCode, 403);
  assert.equal(activateResponse.statusCode, 403);
  assert.equal(deactivateResponse.statusCode, 403);
});

test('JEFE can update users, roles, activation state, and creates audit records atomically with each mutation', async () => {
  const jefe = await login(users.jefe.username);
  const token = await csrf(jefe.cookie);
  const username = `mutation-${suffix}`;
  const created = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { cookie: jefe.cookie, 'x-csrf-token': token },
    payload: { username, email: `${username}@example.com`, displayName: 'Mutation user', phone: '+56 9 3333 3333', role: Role.SOPORTE }
  });
  assert.equal(created.statusCode, 201);
  const createdUser = JSON.parse(created.body).user;
  const activationCode = JSON.parse(created.body).activationCode;
  const firstActivation = await app.inject({ method: 'POST', url: '/auth/activate', payload: { identifier: username, activationCode, password, passwordConfirmation: password } });
  assert.equal(firstActivation.statusCode, 200);

  const updated = await app.inject({
    method: 'PATCH',
    url: `/users/${createdUser.id}`,
    headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) },
    payload: { displayName: 'Updated mutation user', role: Role.COORDINADOR }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(JSON.parse(updated.body).user.role, Role.COORDINADOR);

  const genericStatusChange = await app.inject({
    method: 'PATCH',
    url: `/users/${createdUser.id}`,
    headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) },
    payload: { isActive: false }
  });
  assert.equal(genericStatusChange.statusCode, 400);
  assert.equal((await prisma.user.findUnique({ where: { id: createdUser.id }, select: { isActive: true } }))?.isActive, true);

  const deactivated = await app.inject({ method: 'POST', url: `/users/${createdUser.id}/deactivate`, headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) } });
  assert.equal((await login(username)).response.statusCode, 401);
  const activated = await app.inject({ method: 'POST', url: `/users/${createdUser.id}/activate`, headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) } });
  assert.equal(deactivated.statusCode, 200);
  assert.equal(activated.statusCode, 200);
  assert.equal((await login(username)).response.statusCode, 200);

  const audit = await prisma.auditLog.findMany({ where: { entityType: 'User', entityId: createdUser.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audit.map((entry) => entry.action), ['USER_CREATED', 'USER_ACTIVATED', 'PASSWORD_SETUP', 'USER_UPDATED', 'USER_DEACTIVATED', 'USER_ACTIVATED']);
  assert.equal(await prisma.user.findUnique({ where: { id: createdUser.id } }).then((user) => user?.passwordHash !== null), true);
});

test('duplicate username and email conflicts are rejected', async () => {
  const jefe = await login(users.jefe.username);
  const payload = { username: `duplicate-${suffix}`, email: `duplicate-${suffix}@example.com`, displayName: 'Duplicate user', phone: '+56 9 4444 4444', role: Role.SOPORTE };
  const first = await app.inject({ method: 'POST', url: '/users', headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) }, payload });
  assert.equal(first.statusCode, 201);

  const duplicateUsername = await app.inject({ method: 'POST', url: '/users', headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) }, payload: { ...payload, email: `other-${suffix}@example.com` } });
  const duplicateEmail = await app.inject({ method: 'POST', url: '/users', headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) }, payload: { ...payload, username: `other-${suffix}` } });
  assert.equal(duplicateUsername.statusCode, 409);
  assert.equal(duplicateEmail.statusCode, 409);
  assert.equal(duplicateUsername.json().details?.field, 'username');
  assert.equal(duplicateEmail.json().details?.field, 'email');
});

test('activation, password change, administrative reset, and code concurrency are enforced', async () => {
  const jefe = await login(users.jefe.username);
  const jefeToken = await csrf(jefe.cookie);
  const username = `lifecycle-${suffix}`;
  const created = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { cookie: jefe.cookie, 'x-csrf-token': jefeToken },
    payload: { username, email: `${username}@example.com`, displayName: 'Lifecycle user', phone: '+56 9 5555 5555', role: Role.SOPORTE }
  });
  assert.equal(created.statusCode, 201);
  const createdBody = JSON.parse(created.body);
  assert.ok(createdBody.activationCode);
  const listed = JSON.parse((await app.inject({ method: 'GET', url: `/users?search=${encodeURIComponent(username)}`, headers: { cookie: jefe.cookie } })).body).users.find((user) => user.username === username);
  assert.ok(listed);
  assert.equal('activationCode' in listed, false);
  assert.equal((await prisma.user.findUnique({ where: { id: createdBody.user.id } }))?.passwordHash, null);

  const pendingLogin = await login(username);
  assert.equal(pendingLogin.response.statusCode, 403);
  assert.equal(JSON.parse(pendingLogin.response.body).code, 'ACCOUNT_PENDING');
  const storedCode = await prisma.activationCode.findUnique({ where: { codeHash: createHash('sha256').update(createdBody.activationCode).digest('hex') } });
  assert.ok(storedCode);
  assert.notEqual(storedCode.codeHash, createdBody.activationCode);

  const activationPayload = { identifier: username, activationCode: createdBody.activationCode, password, passwordConfirmation: password };
  const activationResponses = await Promise.all([
    app.inject({ method: 'POST', url: '/auth/activate', payload: activationPayload }),
    app.inject({ method: 'POST', url: '/auth/activate', payload: activationPayload })
  ]);
  assert.equal(activationResponses.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(activationResponses.filter((response) => response.statusCode === 400).length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/activate', payload: activationPayload })).statusCode, 400);
  assert.equal((await login(username)).response.statusCode, 200);

  const ownSession = await login(username);
  const withoutCsrf = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: ownSession.cookie }, payload: { currentPassword: password, newPassword: 'New-valid-password-456' } });
  assert.equal(withoutCsrf.statusCode, 403);
  const ownCsrf = await csrf(ownSession.cookie);
  const wrongCurrent = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: ownSession.cookie, 'x-csrf-token': ownCsrf }, payload: { currentPassword: 'Wrong-password-123', newPassword: 'New-valid-password-456' } });
  assert.equal(wrongCurrent.statusCode, 401);
  const changed = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: ownSession.cookie, 'x-csrf-token': ownCsrf }, payload: { currentPassword: password, newPassword: 'New-valid-password-456' } });
  assert.equal(changed.statusCode, 200);
  assert.equal((await login(username, password)).response.statusCode, 401);
  assert.equal((await login(username, 'New-valid-password-456')).response.statusCode, 200);

  const targetSession = await login(username, 'New-valid-password-456');
  const reset = await app.inject({ method: 'POST', url: `/users/${createdBody.user.id}/reset-access`, headers: { cookie: jefe.cookie, 'x-csrf-token': await csrf(jefe.cookie) } });
  assert.equal(reset.statusCode, 200);
  const resetBody = JSON.parse(reset.body);
  assert.ok(resetBody.activationCode);
  assert.notEqual(resetBody.activationCode, createdBody.activationCode);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: targetSession.cookie } })).statusCode, 401);
  assert.equal((await login(username, 'New-valid-password-456')).response.statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/activate', payload: { ...activationPayload, password: 'New-valid-password-456', passwordConfirmation: 'New-valid-password-456' } })).statusCode, 400);
  const reactivated = await app.inject({ method: 'POST', url: '/auth/activate', payload: { identifier: username, activationCode: resetBody.activationCode, password: 'Reset-valid-password-789', passwordConfirmation: 'Reset-valid-password-789' } });
  assert.equal(reactivated.statusCode, 200);
  assert.equal((await login(username, 'Reset-valid-password-789')).response.statusCode, 200);

  const audit = await prisma.auditLog.findMany({ where: { entityType: 'User', entityId: createdBody.user.id }, orderBy: { createdAt: 'asc' } });
  assert.ok(audit.some((entry) => entry.action === 'PASSWORD_CHANGED'));
  assert.ok(audit.some((entry) => entry.action === 'ACCESS_RESET_REQUESTED'));
  assert.equal(JSON.stringify(audit).includes(createdBody.activationCode), false);
});
test('login is rate limited after ten failed attempts from one source IP', async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await login(users.jefe.username, 'Wrong-password-123');
    assert.equal(response.response.statusCode, 401);
  }
  const limited = await login(users.jefe.username, 'Wrong-password-123');
  assert.equal(limited.response.statusCode, 429);
});

after(async () => {
  await prisma.user.deleteMany({ where: { username: { startsWith: `phase3-` } } });
  await prisma.user.deleteMany({ where: { username: { endsWith: suffix } } });
  await app.close();
});
