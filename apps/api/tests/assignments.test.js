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
  return app.inject({ method, url, headers: { cookie, 'x-csrf-token': await csrf(cookie) }, ...(payload === undefined ? {} : { payload }) });
}

async function createAsset(cookie, overrides = {}) {
  return mutate('POST', '/assets', cookie, {
    productId: assetProduct.id,
    assetTag: `ASSIGN-ASSET-${randomUUID()}`,
    serialNumber: `ASSIGN-SERIAL-${randomUUID()}`,
    ...overrides
  });
}

function parsed(response) {
  return JSON.parse(response.body);
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

async function createCommittedAssignment() {
  const product = await prisma.product.create({ data: { name: `Trigger product ${randomUUID()}`, trackingMode: ProductTrackingMode.ASSET } });
  const person = await prisma.user.create({ data: { username: `trigger-person-${randomUUID().slice(0, 8)}`, displayName: 'Trigger person', role: Role.SOPORTE } });
  const actor = await prisma.user.create({ data: { username: `trigger-actor-${randomUUID().slice(0, 8)}`, displayName: 'Trigger actor', role: Role.JEFE } });
  const asset = await prisma.asset.create({ data: { productId: product.id, assetTag: `TRIGGER-${randomUUID()}` } });
  const assignment = await prisma.$transaction(async (transaction) => {
    const created = await transaction.assignment.create({ data: { assetId: asset.id, personId: person.id, personName: person.displayName, createdById: actor.id, startedAt: new Date() } });
    await transaction.asset.update({ where: { id: asset.id }, data: { status: AssetStatus.ASSIGNED } });
    return created;
  });
  return { asset, assignment, person, actor };
}

before(async () => {
  await prisma.$connect();
  users.jefe = await prisma.user.create({ data: { username: `assignment-jefe-${suffix}`, email: `assignment-jefe-${suffix}@example.com`, displayName: 'Assignment jefe', passwordHash: hashPassword(password), role: Role.JEFE } });
  users.coordinator = await prisma.user.create({ data: { username: `assignment-coordinator-${suffix}`, email: `assignment-coordinator-${suffix}@example.com`, displayName: 'Assignment coordinator', passwordHash: hashPassword(password), role: Role.COORDINADOR } });
  users.support = await prisma.user.create({ data: { username: `assignment-support-${suffix}`, email: `assignment-support-${suffix}@example.com`, displayName: 'Assignment support', passwordHash: hashPassword(password), role: Role.SOPORTE } });
  users.inactive = await prisma.user.create({ data: { username: `assignment-inactive-${suffix}`, displayName: 'Assignment inactive', role: Role.SOPORTE, isActive: false } });
  assetProduct = await prisma.product.create({ data: { name: `Assignment product ${suffix}`, trackingMode: ProductTrackingMode.ASSET } });
  quantityProduct = await prisma.product.create({ data: { name: `Assignment quantity ${suffix}`, trackingMode: ProductTrackingMode.QUANTITY } });
});

test('assignment reads and the active-user directory require authentication and expose safe fields', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/assignments' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/assignment-users' })).statusCode, 401);
  for (const user of Object.values(users).filter((item) => item.isActive !== false)) {
    const cookie = await login(user.username);
    const directory = await app.inject({ method: 'GET', url: `/assignment-users?search=${encodeURIComponent('Assignment')}`, headers: { cookie } });
    assert.equal(directory.statusCode, 200);
    assert.ok(parsed(directory).users.some((person) => person.id === users.support.id));
    assert.equal(directory.body.includes('passwordHash'), false);
    assert.equal(directory.body.includes(users.inactive.username), false);
  }
});

test('JEFE, COORDINADOR and SOPORTE can assign active ASSET products atomically', async () => {
  const actors = [users.jefe, users.coordinator, users.support];
  const stockBefore = await prisma.inventoryStock.count({ where: { productId: assetProduct.id } });
  const movementsBefore = await prisma.inventoryMovement.count({ where: { productId: assetProduct.id } });
  const managerCookie = await login(users.jefe.username);
  for (const [index, actor] of actors.entries()) {
    const cookie = await login(actor.username);
    const asset = parsed(await createAsset(managerCookie)).asset;
    const response = await mutate('POST', `/assets/${asset.id}/assignments`, cookie, { personId: users.support.id });
    assert.equal(response.statusCode, 201);
    const body = parsed(response);
    assert.equal(body.asset.status, AssetStatus.ASSIGNED);
    assert.equal(body.assignment.createdBy.id, actor.id);
    assert.equal(body.assignment.person.id, users.support.id);
    assert.ok(new Date(body.assignment.startedAt).getTime() <= Date.now());
    assert.equal((await prisma.assignment.count({ where: { assetId: asset.id, endedAt: null } })), 1);
    assert.equal(index >= 0, true);
  }
  assert.equal(await prisma.inventoryStock.count({ where: { productId: assetProduct.id } }), stockBefore);
  assert.equal(await prisma.inventoryMovement.count({ where: { productId: assetProduct.id } }), movementsBefore);
  assert.equal(await prisma.auditLog.count({ where: { action: 'ASSET_ASSIGNED', entityType: 'Assignment' } }) >= 3, true);
});

test('assign accepts a required free-text recipient name without a system user', async () => {
  const jefe = await login(users.jefe.username);
  const asset = parsed(await createAsset(jefe)).asset;
  const response = await mutate('POST', `/assets/${asset.id}/assignments`, jefe, { personName: 'Daniela González' });
  assert.equal(response.statusCode, 201);
  const body = parsed(response);
  assert.equal(body.assignment.personName, 'Daniela González');
  assert.equal(body.assignment.person, null);
  assert.equal(body.asset.status, AssetStatus.ASSIGNED);
});

test('assign rejects inactive or missing users, missing/inactive assets and non-ASSET products', async () => {
  const jefe = await login(users.jefe.username);
  const created = parsed(await createAsset(jefe)).asset;
  assert.equal((await mutate('POST', `/assets/${created.id}/assignments`, jefe, { personId: users.inactive.id })).statusCode, 409);
  assert.equal((await mutate('POST', `/assets/${created.id}/assignments`, jefe, { personId: randomUUID() })).statusCode, 404);
  assert.equal((await mutate('POST', `/assets/${randomUUID()}/assignments`, jefe, { personId: users.support.id })).statusCode, 404);
  const decommissioned = parsed(await createAsset(jefe)).asset;
  assert.equal((await mutate('POST', `/assets/${decommissioned.id}/decommission`, jefe)).statusCode, 200);
  assert.equal((await mutate('POST', `/assets/${decommissioned.id}/assignments`, jefe, { personId: users.support.id })).statusCode, 409);
  const quantityAsset = await prisma.asset.create({ data: { productId: quantityProduct.id, assetTag: `QUANTITY-ASSET-${randomUUID()}` } });
  assert.equal((await mutate('POST', `/assets/${quantityAsset.id}/assignments`, jefe, { personId: users.support.id })).statusCode, 409);
  for (const status of [AssetStatus.RESERVED, AssetStatus.UNDER_REVIEW, AssetStatus.IN_REPAIR, AssetStatus.IN_WARRANTY, AssetStatus.LOST]) {
    const asset = parsed(await createAsset(jefe)).asset;
    assert.equal((await mutate('POST', `/assets/${asset.id}/status`, jefe, { status })).statusCode, 200);
    assert.equal((await mutate('POST', `/assets/${asset.id}/assignments`, jefe, { personId: users.support.id })).statusCode, 409);
  }
});

test('two concurrent assignments serialize on the Asset and create one active assignment and audit', async () => {
  const jefe = await login(users.jefe.username);
  const coordinator = await login(users.coordinator.username);
  const asset = parsed(await createAsset(jefe)).asset;
  const [jefeCsrf, coordinatorCsrf] = await Promise.all([csrf(jefe), csrf(coordinator)]);
  const beforeStock = await prisma.inventoryStock.count({ where: { productId: assetProduct.id } });
  const beforeMovements = await prisma.inventoryMovement.count({ where: { productId: assetProduct.id } });
  const beforeAudit = await prisma.auditLog.count({ where: { action: 'ASSET_ASSIGNED', entityId: { not: null } } });
  const responses = await Promise.all([
    app.inject({ method: 'POST', url: `/assets/${asset.id}/assignments`, headers: { cookie: jefe, 'x-csrf-token': jefeCsrf }, payload: { personId: users.support.id } }),
    app.inject({ method: 'POST', url: `/assets/${asset.id}/assignments`, headers: { cookie: coordinator, 'x-csrf-token': coordinatorCsrf }, payload: { personId: users.coordinator.id } })
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(await prisma.assignment.count({ where: { assetId: asset.id, endedAt: null } }), 1);
  assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status, AssetStatus.ASSIGNED);
  assert.equal(await prisma.auditLog.count({ where: { action: 'ASSET_ASSIGNED', entityId: { not: null } } }), beforeAudit + 1);
  assert.equal(await prisma.inventoryStock.count({ where: { productId: assetProduct.id } }), beforeStock);
  assert.equal(await prisma.inventoryMovement.count({ where: { productId: assetProduct.id } }), beforeMovements);
});

test('return closes the assignment, records the actor, preserves history and leaves stock untouched', async () => {
  const jefe = await login(users.jefe.username);
  const coordinator = await login(users.coordinator.username);
  const asset = parsed(await createAsset(jefe)).asset;
  const assigned = parsed(await mutate('POST', `/assets/${asset.id}/assignments`, jefe, { personId: users.support.id }));
  const stockBefore = await prisma.inventoryStock.count({ where: { productId: assetProduct.id } });
  const movementsBefore = await prisma.inventoryMovement.count({ where: { productId: assetProduct.id } });
  const historyBefore = await app.inject({ method: 'GET', url: `/assets/${asset.id}/assignments`, headers: { cookie: jefe } });
  assert.equal(parsed(historyBefore).currentAssignment.id, assigned.assignment.id);
  const returned = await mutate('POST', `/assets/${asset.id}/assignments/${assigned.assignment.id}/return`, coordinator);
  assert.equal(returned.statusCode, 200);
  const body = parsed(returned);
  assert.equal(body.asset.status, AssetStatus.AVAILABLE);
  assert.equal(body.assignment.endedBy.id, users.coordinator.id);
  assert.ok(new Date(body.assignment.endedAt) > new Date(body.assignment.startedAt));
  const history = parsed(await app.inject({ method: 'GET', url: `/assets/${asset.id}/assignments`, headers: { cookie: jefe } }));
  assert.equal(history.currentAssignment, null);
  assert.equal(history.assignments.length, 1);
  assert.equal(history.assignments[0].id, assigned.assignment.id);
  assert.equal((await app.inject({ method: 'GET', url: `/assignments/${assigned.assignment.id}`, headers: { cookie: jefe } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/assignments?assetId=${asset.id}&active=false`, headers: { cookie: jefe } })).statusCode, 200);
  assert.equal(await prisma.inventoryStock.count({ where: { productId: assetProduct.id } }), stockBefore);
  assert.equal(await prisma.inventoryMovement.count({ where: { productId: assetProduct.id } }), movementsBefore);
  assert.equal(await prisma.auditLog.count({ where: { action: 'ASSET_RETURNED', entityId: assigned.assignment.id } }), 1);
});

test('return rejects closed, missing and cross-Asset Assignments', async () => {
  const jefe = await login(users.jefe.username);
  const first = parsed(await createAsset(jefe)).asset;
  const second = parsed(await createAsset(jefe)).asset;
  const assignment = parsed(await mutate('POST', `/assets/${first.id}/assignments`, jefe, { personId: users.support.id })).assignment;
  assert.equal((await mutate('POST', `/assets/${second.id}/assignments/${assignment.id}/return`, jefe)).statusCode, 404);
  assert.equal((await mutate('POST', `/assets/${first.id}/assignments/${randomUUID()}/return`, jefe)).statusCode, 404);
  assert.equal((await mutate('POST', `/assets/${first.id}/assignments/${assignment.id}/return`, jefe)).statusCode, 200);
  assert.equal((await mutate('POST', `/assets/${first.id}/assignments/${assignment.id}/return`, jefe)).statusCode, 409);
});

test('CSRF is required for assign and return without partial effects', async () => {
  const jefe = await login(users.jefe.username);
  const asset = parsed(await createAsset(jefe)).asset;
  const countBefore = await prisma.assignment.count({ where: { assetId: asset.id } });
  const missing = await app.inject({ method: 'POST', url: `/assets/${asset.id}/assignments`, headers: { cookie: jefe }, payload: { personId: users.support.id } });
  const invalid = await app.inject({ method: 'POST', url: `/assets/${asset.id}/assignments`, headers: { cookie: jefe, 'x-csrf-token': 'invalid' }, payload: { personId: users.support.id } });
  assert.equal(missing.statusCode, 403);
  assert.equal(invalid.statusCode, 403);
  assert.equal(await prisma.assignment.count({ where: { assetId: asset.id } }), countBefore);
  assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status, AssetStatus.AVAILABLE);
  assert.equal((await app.inject({ method: 'POST', url: `/assets/${asset.id}/assignments`, headers: { cookie: jefe, 'x-csrf-token': await csrf(jefe) }, payload: { personId: users.support.id } })).statusCode, 201);
  const current = await prisma.assignment.findFirstOrThrow({ where: { assetId: asset.id, endedAt: null } });
  const returnMissing = await app.inject({ method: 'POST', url: `/assets/${asset.id}/assignments/${current.id}/return`, headers: { cookie: jefe }, payload: {} });
  const returnInvalid = await app.inject({ method: 'POST', url: `/assets/${asset.id}/assignments/${current.id}/return`, headers: { cookie: jefe, 'x-csrf-token': 'invalid' }, payload: {} });
  assert.equal(returnMissing.statusCode, 403);
  assert.equal(returnInvalid.statusCode, 403);
  assert.equal((await prisma.assignment.findUniqueOrThrow({ where: { id: current.id } })).endedAt, null);
});

test('assign and return roll back completely when AuditLog creation fails', async () => {
  const jefe = await login(users.jefe.username);
  const faultyApp = buildApp(databaseWithFailingAudit());
  const asset = parsed(await createAsset(jefe)).asset;
  const response = await faultyApp.inject({ method: 'POST', url: `/assets/${asset.id}/assignments`, headers: { cookie: jefe, 'x-csrf-token': await csrf(jefe) }, payload: { personId: users.support.id } });
  assert.equal(response.statusCode, 500);
  assert.equal(await prisma.assignment.count({ where: { assetId: asset.id } }), 0);
  assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status, AssetStatus.AVAILABLE);
  const assigned = parsed(await mutate('POST', `/assets/${asset.id}/assignments`, jefe, { personId: users.support.id })).assignment;
  const returnResponse = await faultyApp.inject({ method: 'POST', url: `/assets/${asset.id}/assignments/${assigned.id}/return`, headers: { cookie: jefe, 'x-csrf-token': await csrf(jefe) }, payload: {} });
  assert.equal(returnResponse.statusCode, 500);
  assert.equal((await prisma.assignment.findUniqueOrThrow({ where: { id: assigned.id } })).endedAt, null);
  assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status, AssetStatus.ASSIGNED);
  await faultyApp.close();
});

test('general status changes and decommission cannot bypass an active assignment', async () => {
  const jefe = await login(users.jefe.username);
  const asset = parsed(await createAsset(jefe)).asset;
  const assignment = parsed(await mutate('POST', `/assets/${asset.id}/assignments`, jefe, { personId: users.support.id })).assignment;
  assert.equal((await mutate('POST', `/assets/${asset.id}/status`, jefe, { status: 'AVAILABLE' })).statusCode, 409);
  assert.equal((await mutate('POST', `/assets/${asset.id}/decommission`, jefe)).statusCode, 409);
  assert.equal((await mutate('POST', `/assets/${asset.id}/assignments/${assignment.id}/return`, jefe)).statusCode, 200);
});

test('concurrent assign/status/decommission/return operations remain consistent', async () => {
  const jefe = await login(users.jefe.username);
  const coordinator = await login(users.coordinator.username);

  const statusAsset = parsed(await createAsset(jefe)).asset;
  const statusTokens = await Promise.all([csrf(jefe), csrf(coordinator)]);
  const statusResults = await Promise.all([
    app.inject({ method: 'POST', url: `/assets/${statusAsset.id}/assignments`, headers: { cookie: jefe, 'x-csrf-token': statusTokens[0] }, payload: { personId: users.support.id } }),
    app.inject({ method: 'POST', url: `/assets/${statusAsset.id}/status`, headers: { cookie: coordinator, 'x-csrf-token': statusTokens[1] }, payload: { status: 'RESERVED' } })
  ]);
  assert.equal(statusResults.filter((response) => response.statusCode === 201).length + statusResults.filter((response) => response.statusCode === 200).length, 1);
  const statusStored = await prisma.asset.findUniqueOrThrow({ where: { id: statusAsset.id } });
  assert.equal(await prisma.assignment.count({ where: { assetId: statusAsset.id, endedAt: null } }), statusStored.status === AssetStatus.ASSIGNED ? 1 : 0);

  const decommissionAsset = parsed(await createAsset(jefe)).asset;
  const decommissionTokens = await Promise.all([csrf(jefe), csrf(coordinator)]);
  const decommissionResults = await Promise.all([
    app.inject({ method: 'POST', url: `/assets/${decommissionAsset.id}/assignments`, headers: { cookie: jefe, 'x-csrf-token': decommissionTokens[0] }, payload: { personId: users.support.id } }),
    app.inject({ method: 'POST', url: `/assets/${decommissionAsset.id}/decommission`, headers: { cookie: coordinator, 'x-csrf-token': decommissionTokens[1] } })
  ]);
  assert.equal(decommissionResults.filter((response) => response.statusCode === 201).length + decommissionResults.filter((response) => response.statusCode === 200).length, 1);
  const decommissionStored = await prisma.asset.findUniqueOrThrow({ where: { id: decommissionAsset.id } });
  assert.equal(await prisma.assignment.count({ where: { assetId: decommissionAsset.id, endedAt: null } }), decommissionStored.status === AssetStatus.ASSIGNED ? 1 : 0);

  const returnAsset = parsed(await createAsset(jefe)).asset;
  const assigned = parsed(await mutate('POST', `/assets/${returnAsset.id}/assignments`, jefe, { personId: users.support.id })).assignment;
  const returnTokens = await Promise.all([csrf(jefe), csrf(coordinator)]);
  const returnResults = await Promise.all([
    app.inject({ method: 'POST', url: `/assets/${returnAsset.id}/assignments/${assigned.id}/return`, headers: { cookie: jefe, 'x-csrf-token': returnTokens[0] }, payload: {} }),
    app.inject({ method: 'POST', url: `/assets/${returnAsset.id}/decommission`, headers: { cookie: coordinator, 'x-csrf-token': returnTokens[1] } })
  ]);
  assert.equal(returnResults.filter((response) => response.statusCode === 200).length >= 1, true);
  const returnStored = await prisma.asset.findUniqueOrThrow({ where: { id: returnAsset.id } });
  assert.equal(await prisma.assignment.count({ where: { assetId: returnAsset.id, endedAt: null } }), returnStored.status === AssetStatus.ASSIGNED ? 1 : 0);
});

test('office loan returns roll back references and status when audit persistence fails', async () => {
  const jefe = await login(users.jefe.username);
  const asset = parsed(await createAsset(jefe)).asset;
  const created = await mutate('POST', `/assets/${asset.id}/assignments`, jefe, { recipientType: 'OFFICE', officeName: 'Pucon', assignmentType: 'LOAN' });
  assert.equal(created.statusCode, 201);
  const assignment = parsed(created).assignment;
  const faultyApp = buildApp(databaseWithFailingAudit());
  try {
    const response = await faultyApp.inject({ method: 'POST', url: `/assets/${asset.id}/assignments/${assignment.id}/return`, headers: { cookie: jefe, 'x-csrf-token': await csrf(jefe) }, payload: { returnStatus: 'UNDER_REVIEW', ticketReference: 'RETURN-1', notes: 'Must roll back' } });
    assert.equal(response.statusCode, 500);
    const stored = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    assert.equal(stored.endedAt, null);
    assert.equal(stored.returnTicketReference, null);
    assert.equal(stored.returnNotes, null);
    assert.equal(stored.returnRecordedAt, null);
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status, AssetStatus.ASSIGNED);
  } finally {
    await faultyApp.close();
  }
});

test('PostgreSQL protects Assignment history and Asset/Assignment consistency', async () => {
  const committed = await createCommittedAssignment();
  await assert.rejects(prisma.assignment.delete({ where: { id: committed.assignment.id } }));
  const anotherPerson = await prisma.user.create({ data: { username: `trigger-other-${randomUUID().slice(0, 8)}`, displayName: 'Another person', role: Role.SOPORTE } });
  await assert.rejects(prisma.assignment.update({ where: { id: committed.assignment.id }, data: { personId: anotherPerson.id } }));

  const closed = await prisma.$transaction(async (transaction) => {
    const endedAt = new Date(Date.now() + 10);
    const updated = await transaction.assignment.update({ where: { id: committed.assignment.id }, data: { endedAt, endedById: committed.actor.id } });
    await transaction.asset.update({ where: { id: committed.asset.id }, data: { status: AssetStatus.AVAILABLE } });
    return updated;
  });
  assert.ok(closed.endedAt);
  await assert.rejects(prisma.assignment.update({ where: { id: committed.assignment.id }, data: { endedAt: null, endedById: null } }));

  const product = await prisma.product.create({ data: { name: `Mismatch product ${randomUUID()}`, trackingMode: ProductTrackingMode.ASSET } });
  const asset = await prisma.asset.create({ data: { productId: product.id, assetTag: `MISMATCH-${randomUUID()}` } });
  const person = await prisma.user.create({ data: { username: `mismatch-person-${randomUUID().slice(0, 8)}`, displayName: 'Mismatch person', role: Role.SOPORTE } });
  await assert.rejects(prisma.$transaction(async (transaction) => {
    await transaction.assignment.create({ data: { assetId: asset.id, personId: person.id, personName: person.displayName, createdById: committed.actor.id, startedAt: new Date() } });
  }));
  await assert.rejects(prisma.asset.update({ where: { id: asset.id }, data: { status: AssetStatus.ASSIGNED } }));
});

after(async () => {
  await app.close();
});
