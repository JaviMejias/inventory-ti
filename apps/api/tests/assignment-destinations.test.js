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
const password = 'Destinations-password-123';
const users = {};
const cookies = {};
let product;

before(async () => {
  product = await database.product.create({ data: { name: `Destination product ${suffix}`, trackingMode: 'ASSET' } });
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    users[role] = await database.user.create({ data: { username: `destination-${role.toLowerCase()}-${suffix}`, displayName: `Destination ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: users[role].username, password } });
    assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
});

function asset() {
  return database.asset.create({ data: { productId: product.id, assetTag: `DEST-${randomUUID()}`, location: 'Bodega 2' } });
}

async function mutate(url, payload, role = 'JEFE') {
  const cookie = cookies[role];
  const csrf = (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
  return app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrf }, ...(payload === undefined ? {} : { payload }) });
}

function read(url) {
  return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } });
}

test('office loans support every operator without creating person accounts or stock', async () => {
  const officeName = `Pucon ${suffix}`;
  const people = await database.user.count({ where: { displayName: officeName } });
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const equipment = await asset();
    const expectedReturnAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const response = await mutate(`/assets/${equipment.id}/assignments`, { recipientType: 'OFFICE', officeName: ` ${officeName} `, assignmentType: 'LOAN', expectedReturnAt, ticketReference: '1258508', otReference: 'OT-20', notes: 'Contingencia' }, role);
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.assignment.officeName, officeName);
    assert.equal(body.assignment.recipientType, 'OFFICE');
    assert.equal(body.assignment.personName, null);
    assert.equal(body.assignment.personId, null);
    assert.equal(body.assignment.person, null);
    assert.equal(body.assignment.expectedReturnAt, expectedReturnAt);
    assert.equal(body.asset.status, 'ASSIGNED');
    assert.equal(body.asset.location, 'Bodega 2');
    assert.equal(body.assignment.createdBy.id, users[role].id);
    const closed = await mutate(`/assets/${equipment.id}/assignments/${body.assignment.id}/return`, undefined, role);
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().asset.status, 'AVAILABLE');
    assert.equal(closed.json().assignment.returnStatus, 'AVAILABLE');
    assert.ok(closed.json().assignment.returnRecordedAt);
  }
  assert.equal(await database.user.count({ where: { displayName: officeName } }), people);
  assert.equal(await database.inventoryStock.count({ where: { productId: product.id } }), 0);
  assert.equal(await database.inventoryMovement.count({ where: { productId: product.id } }), 0);
});

test('assignment destinations preserve legacy person defaults and return requests', async () => {
  const equipment = await asset();
  const created = await mutate(`/assets/${equipment.id}/assignments`, { personName: 'Daniela González' });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().assignment.recipientType, 'PERSON');
  assert.equal(created.json().assignment.assignmentType, 'STANDARD');
  assert.equal(created.json().assignment.officeName, null);
  assert.equal((await mutate(`/assets/${equipment.id}/assignments/${created.json().assignment.id}/return`, {})).statusCode, 200);
});

test('assignment destination history preserves outgoing and return references and effective dates', async () => {
  const equipment = await asset();
  const created = await mutate(`/assets/${equipment.id}/assignments`, {
    recipientType: 'OFFICE', officeName: `Temuco ${suffix}`, assignmentType: 'LOAN', effectiveAt: '2026-01-01T10:00:00-03:00',
    expectedReturnAt: '2026-02-01T13:00:00Z', ticketReference: 'OUT-1', otReference: 'OUT-OT', notes: 'Sent'
  }, 'COORDINADOR');
  assert.equal(created.statusCode, 201);
  const assignment = created.json().assignment;
  const closed = await mutate(`/assets/${equipment.id}/assignments/${assignment.id}/return`, {
    effectiveAt: '2026-02-01T13:00:00Z', returnStatus: 'UNDER_REVIEW', ticketReference: 'IN-1', otReference: 'IN-OT', notes: 'Needs evaluation'
  });
  assert.equal(closed.statusCode, 200);
  const returned = closed.json();
  assert.equal(returned.asset.status, 'UNDER_REVIEW');
  assert.equal(returned.assignment.ticketReference, 'OUT-1');
  assert.equal(returned.assignment.returnTicketReference, 'IN-1');
  assert.equal(returned.assignment.notes, 'Sent');
  assert.equal(returned.assignment.returnNotes, 'Needs evaluation');
  const history = (await read(`/assets/${equipment.id}/history`)).json().events.filter((event) => event.kind === 'assignment');
  assert.equal(history.length, 2);
  const start = history.find((event) => event.action === 'ASSET_ASSIGNED');
  const end = history.find((event) => event.action === 'ASSET_RETURNED');
  assert.equal(start.person, null);
  assert.equal(start.recipientName, `Temuco ${suffix}`);
  assert.equal(start.ticketReference, 'OUT-1');
  assert.equal(start.otReference, 'OUT-OT');
  assert.equal(start.effectiveAt, '2026-01-01T13:00:00.000Z');
  assert.ok(new Date(start.recordedAt) > new Date(start.effectiveAt));
  assert.equal(end.ticketReference, 'IN-1');
  assert.equal(end.notes, 'Needs evaluation');
  assert.equal(end.returnStatus, 'UNDER_REVIEW');
  assert.ok(new Date(end.recordedAt) > new Date(end.effectiveAt));
  const global = (await read(`/assignments?recipientType=OFFICE&assignmentType=LOAN&officeName=${suffix}&active=false`)).json();
  assert.ok(global.assignments.some((row) => row.id === assignment.id));
  const filtered = (await read(`/assets/${equipment.id}/assignments?active=true`)).json();
  assert.deepEqual(filtered.assignments, []);
  assert.equal(filtered.currentAssignment, null);
});

test('assignment dates reject future, unauthorized and overlapping dates without side effects', async () => {
  const equipment = await asset();
  const url = `/assets/${equipment.id}/assignments`;
  const recipient = { recipientType: 'OFFICE', officeName: 'CE' };
  assert.equal((await mutate(url, { ...recipient, effectiveAt: '2026-01-01T13:00:00Z' }, 'SOPORTE')).statusCode, 403);
  assert.equal((await mutate(url, { ...recipient, effectiveAt: new Date(Date.now() + 86400000).toISOString() })).statusCode, 400);
  assert.equal((await mutate(url, { ...recipient, assignmentType: 'LOAN', effectiveAt: '2026-02-01T13:00:00Z', expectedReturnAt: '2026-01-01T13:00:00Z' })).statusCode, 400);
  assert.equal(await database.assignment.count({ where: { assetId: equipment.id } }), 0);
  const created = (await mutate(url, { ...recipient, effectiveAt: '2026-01-01T13:00:00Z' })).json().assignment;
  const returnUrl = `${url}/${created.id}/return`;
  const invalid = await mutate(returnUrl, { effectiveAt: '2026-01-01T12:00:00Z' });
  assert.equal(invalid.statusCode, 409);
  assert.equal(invalid.json().code, 'ASSIGNMENT_DATE_CONFLICT');
  assert.equal((await mutate(returnUrl, { effectiveAt: '2026-02-01T13:00:00Z' }, 'SOPORTE')).statusCode, 403);
  assert.equal((await mutate(returnUrl, { returnStatus: 'ASSIGNED' })).statusCode, 400);
  assert.equal((await mutate(returnUrl, { effectiveAt: new Date(Date.now() + 86400000).toISOString() })).statusCode, 400);
  assert.equal((await database.assignment.findUniqueOrThrow({ where: { id: created.id } })).endedAt, null);
  assert.equal((await mutate(returnUrl, { effectiveAt: '2026-02-01T13:00:00Z' })).statusCode, 200);
  const overlap = await mutate(url, { ...recipient, effectiveAt: '2026-01-15T13:00:00Z' });
  assert.equal(overlap.statusCode, 409);
  assert.equal(overlap.json().code, 'ASSIGNMENT_DATE_CONFLICT');
  assert.equal((await mutate(url, { ...recipient, effectiveAt: '2026-02-01T13:00:00Z' })).statusCode, 201);
});

test('office assignments serialize concurrent recipients and preserve one active destination', async () => {
  const equipment = await asset();
  const responses = await Promise.all(['Pucon', 'Temuco'].map((officeName) => mutate(`/assets/${equipment.id}/assignments`, { recipientType: 'OFFICE', officeName, assignmentType: 'LOAN' })));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(await database.assignment.count({ where: { assetId: equipment.id, endedAt: null } }), 1);
  const assignment = responses.find((response) => response.statusCode === 201).json().assignment;
  const returned = await mutate(`/assets/${equipment.id}/assignments/${assignment.id}/return`, { returnStatus: 'IN_REPAIR', notes: 'Damaged' }, 'SOPORTE');
  assert.equal(returned.statusCode, 200);
  assert.equal(returned.json().asset.status, 'IN_REPAIR');
  assert.equal((await mutate(`/assets/${equipment.id}/assignments`, { personName: 'Daniela González' })).statusCode, 409);
});

test('PostgreSQL protects office recipient metadata and closed assignment history', async () => {
  const equipment = await asset();
  const url = `/assets/${equipment.id}/assignments`;
  const assignment = (await mutate(url, { recipientType: 'OFFICE', officeName: 'Pucon', assignmentType: 'LOAN', notes: 'Original' })).json().assignment;
  for (const change of [
    { officeName: 'Temuco' }, { notes: 'Changed' }, { assignmentType: 'STANDARD' },
    { expectedReturnAt: new Date(Date.now() + 86400000) }, { ticketReference: 'Changed' }
  ]) {
    await assert.rejects(database.$transaction(async (transaction) => {
      await transaction.assignment.update({ where: { id: assignment.id }, data: { ...change, endedAt: new Date(Date.now() + 10), endedById: users.JEFE.id } });
      await transaction.asset.update({ where: { id: equipment.id }, data: { status: 'AVAILABLE' } });
    }), /Assignment history fields cannot be modified/);
  }
  assert.equal((await database.assignment.findUniqueOrThrow({ where: { id: assignment.id } })).endedAt, null);
  await mutate(`${url}/${assignment.id}/return`, {});
  await assert.rejects(database.assignment.update({ where: { id: assignment.id }, data: { returnNotes: 'Changed' } }), /Closed Assignment records cannot be modified/);
  const fresh = await asset();
  for (const data of [
    { recipientType: 'OFFICE', officeName: 'CE', personName: 'Invalid person' },
    { recipientType: 'OFFICE', officeName: null, personName: null },
    { recipientType: 'PERSON', personName: null },
    { recipientType: 'PERSON', personName: 'Daniela González', returnStatus: 'AVAILABLE' }
  ]) await assert.rejects(database.assignment.create({ data: { assetId: fresh.id, createdById: users.JEFE.id, startedAt: new Date(), ...data } }));
});

test('assignment history keeps unknown legacy return capture dates null', async () => {
  const equipment = await asset();
  const created = (await mutate(`/assets/${equipment.id}/assignments`, { personName: 'Legacy Person', effectiveAt: '2026-01-01T13:00:00Z' })).json().assignment;
  await database.$transaction(async (transaction) => {
    await transaction.assignment.update({ where: { id: created.id }, data: { endedAt: new Date('2026-02-01T13:00:00Z'), endedById: users.JEFE.id } });
    await transaction.asset.update({ where: { id: equipment.id }, data: { status: 'AVAILABLE' } });
  });
  const event = (await read(`/assets/${equipment.id}/history`)).json().events.find((row) => row.action === 'ASSET_RETURNED');
  assert.equal(event.person, 'Legacy Person');
  assert.equal(event.recipientName, 'Legacy Person');
  assert.equal(event.recordedAt, null);
  assert.equal(event.returnStatus, null);
});

test('assignment destination migration preserves legacy person history without inventing return metadata', async () => {
  const migration = readFileSync(new URL('../../../prisma/migrations/0014_assignment_destinations/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `destination_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      await transaction.$executeRawUnsafe('CREATE TABLE "Assignment" ("id" uuid PRIMARY KEY, "personName" varchar(150) NOT NULL, "personId" uuid, "startedAt" timestamp NOT NULL, "endedAt" timestamp)');
      const id = randomUUID();
      await transaction.$executeRaw`INSERT INTO "Assignment" VALUES (${id}::uuid, 'Legacy Person', NULL, '2026-01-01', '2026-02-01')`;
      const statements = migration.match(/CREATE TYPE[^;]+;|ALTER TABLE[\s\S]*?;|CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g);
      assert.equal(statements.length, 5);
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
      const [row] = await transaction.$queryRaw`SELECT * FROM "Assignment"`;
      assert.equal(row.id, id);
      assert.equal(row.personName, 'Legacy Person');
      assert.equal(row.recipientType, 'PERSON');
      assert.equal(row.assignmentType, 'STANDARD');
      assert.equal(row.officeName, null);
      assert.equal(row.returnStatus, null);
      assert.equal(row.returnRecordedAt, null);
      assert.equal(row.endedAt.toISOString(), '2026-02-01T00:00:00.000Z');
      throw new RollbackTest();
    });
  } catch (error) {
    if (!(error instanceof RollbackTest)) throw error;
  }
});

after(async () => { await app.close(); });
