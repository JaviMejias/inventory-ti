import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { deserialize, serialize } from 'node:v8';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { groupClosedAssignmentFixture } from './fixtures/group-closed-assignment.js';

const productIds = []; const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
const clone = (value) => deserialize(serialize(value));
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'groupcorrection-' + role.toLowerCase() + '-' + randomUUID(); const password = 'Group-correction-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group correction ' + role, role, passwordHash: hashPassword(password) } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200, login.body);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group correction ' + randomUUID(), trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url) { return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } }); }
async function prepare(options = {}) {
  const f = await groupClosedAssignmentFixture({ database, product, post, get, ...options });
  if (options.activeBeforeApply) {
    const delivered = await post('/assets/' + f.asset.id + '/assignments', { personName: 'Custodian at import', effectiveAt: '2005-01-01T00:00:00Z' });
    assert.equal(delivered.statusCode, 201, delivered.body);
  }
  const first = await post(f.url, f.input); assert.equal(first.statusCode, 200, first.body);
  const input = { ...f.input, plan: { periods: f.input.plan.periods.map((period) => ({ ...period,
    acknowledgedWarnings: first.json().periods.find((entry) => entry.periodId === period.periodId).warnings.map((warning) => warning.id) })) } };
  const planned = await post(f.url, input); assert.equal(planned.json().planValidationComplete, true, planned.body);
  const applied = await post(f.url + '/apply', { requestId: randomUUID(), planId: planned.json().planId, confirmation: 'APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY', plan: input });
  assert.equal(applied.statusCode, 201, applied.body); const receipt = applied.json().application;
  const period = input.plan.periods[0]; const item = receipt.items.find((entry) => entry.periodId === period.periodId);
  const correction = { ...omit(period, ['periodId', 'confirmation']), start: omit(period.start, ['evidenceId']), end: omit(period.end, ['evidenceId']), note: 'Rectified historical note' };
  return { ...f, receipt, assignmentItem: item, correctionUrl: f.itemUrl + '/closed-assignment-applications/' + receipt.id + '/items/' + item.id + '/correction-plan',
    correctionInput: { expectedOriginPlanId: receipt.planId, reason: 'Correct against verified dispatch and return', supportingReference: 'Signed rectification record', correction } };
}
async function snapshot(f) {
  return {
    asset: await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }),
    assignments: await database.assignment.findMany({ where: { assetId: f.asset.id }, orderBy: { id: 'asc' } }),
    receipt: await database.importGroupAssignmentApplication.findUniqueOrThrow({ where: { id: f.receipt.id }, include: { items: { orderBy: { periodId: 'asc' }, include: { evidenceUses: { orderBy: { endpoint: 'asc' } } } } } }),
    history: await database.importGroupHistoryApplication.findMany({ where: { itemId: f.item.id }, orderBy: { id: 'asc' }, include: { links: { orderBy: { evidenceId: 'asc' } } } }),
    archive: await database.importHistoricalEvidence.findMany({ where: { captureId: f.capture.id }, orderBy: { id: 'asc' }, include: { amendments: true } }),
    rowUses: await database.importIdentityGroupRowUse.findMany({ where: { itemId: f.item.id }, orderBy: { recordId: 'asc' } }),
    audits: await database.auditLog.findMany({ where: { userId: users.JEFE.id }, orderBy: { id: 'asc' } }),
    stocks: await database.inventoryStock.findMany({ where: { productId: product.id } }), movements: await database.inventoryMovement.findMany({ where: { assetId: f.asset.id } })
  };
}
function code(response, status, expected) { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().code, expected, response.body); }
function blockers(response) { assert.equal(response.statusCode, 200, response.body); return response.json().blockers.map((entry) => entry.code); }
function transformReads(model, mutate) {
  return database.$extends({ query: { [model]: { async $allOperations({ operation, args, query }) {
    const result = await query(args); if (!operation.startsWith('find') || result === null) return result;
    const copy = clone(result); mutate(copy); return copy;
  } } } });
}

test('group correction planning is JEFE and CSRF only with strict parent, body and query contracts and applying requires explicit DTO', async () => {
  const f = await prepare(); const url = f.correctionUrl; const input = f.correctionInput;
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url + '?force=true', input)).statusCode, 400); assert.equal((await post(url + '/apply', input)).statusCode, 400);
  for (const payload of [{ ...input, assetId: f.asset.id }, { ...input, confirmation: 'APPLY' }, { ...input, reason: '' },
    { ...input, correction: { ...input.correction, periodId: f.assignmentItem.periodId } },
    { ...input, correction: { ...input.correction, start: { ...input.correction.start, evidenceId: f.evidence[0].id } } }]) {
    assert.equal((await post(url, payload)).statusCode, 400);
  }
});

test('reviewed correction returns separate origin, ownership and before after without any persisted change', async () => {
  const f = await prepare({ periodCount: 2, extraEvidence: true }); const original = await snapshot(f);
  const first = await post(f.correctionUrl, f.correctionInput); assert.equal(first.statusCode, 200, first.body); const plan = first.json();
  assert.equal(plan.scope, 'GROUP_CLOSED_ASSIGNMENT_CORRECTION_PLAN'); assert.equal(plan.planValidationComplete, true);
  assert.deepEqual(plan.changes, [{ field: 'note', before: f.assignmentItem.assignment.notes, after: 'Rectified historical note' }]);
  for (const flag of ['persisted', 'canApply', 'affectsCurrentState', 'operationalHistoryApplied', 'evidenceRelinked', 'correctionApplicationImplemented']) assert.equal(plan[flag], false);
  assert.equal(plan.assignmentId, f.assignmentItem.assignmentId); assert.equal(plan.assetId, f.asset.id); assert.equal(plan.ownership.length, 2);
  assert.equal(plan.originalAssignment.createdById, null); assert.equal(plan.proposed.assignedById, null);
  assert.equal((await post(f.correctionUrl, f.correctionInput)).json().correctionPlanId, plan.correctionPlanId);
  assert.deepEqual(await snapshot(f), original);
});

test('correcting only format or explanation does not turn unchanged historical values into a valid correction', async () => {
  const f = await prepare(); const input = clone(f.correctionInput); input.correction.note = f.assignmentItem.assignment.notes;
  input.correction.start.confirmedAt = f.assignmentItem.assignment.startedAt;
  assert.ok(blockers(await post(f.correctionUrl, input)).includes('GROUP_ASSIGNMENT_CORRECTION_UNCHANGED'));
});

test('correction preserves a newer open custodian and captures full current metadata in its hash', async () => {
  const f = await prepare(); const delivered = await post('/assets/' + f.asset.id + '/assignments', { personName: 'Current Custodian', effectiveAt: '2005-01-01T00:00:00Z' });
  assert.equal(delivered.statusCode, 201, delivered.body); const original = await snapshot(f);
  const first = await post(f.correctionUrl, f.correctionInput); assert.equal(first.statusCode, 200, first.body); assert.equal(first.json().planValidationComplete, true);
  assert.equal(first.json().currentAsset.status, 'ASSIGNED'); assert.equal(first.json().currentCustody[0].personName, 'Current Custodian');
  assert.deepEqual(await snapshot(f), original);
  await database.$executeRaw`UPDATE "Asset" SET "location" = 'Corrected current location' WHERE "id" = ${f.asset.id}::uuid`;
  const second = await post(f.correctionUrl, f.correctionInput); assert.equal(second.statusCode, 200, second.body);
  assert.notEqual(second.json().correctionPlanId, first.json().correctionPlanId); assert.notEqual(second.json().currentContextDigest, first.json().currentContextDigest);
});

test('terminal metadata and historical return condition remain unchanged while proposing recipient and effective instants', async () => {
  const f = await prepare(); await database.asset.update({ where: { id: f.asset.id }, data: { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2005-01-01') } });
  const original = await snapshot(f); const input = clone(f.correctionInput); input.correction.recipient = { type: 'PERSON', name: 'Correct Recipient' };
  input.correction.returnStatus = 'IN_REPAIR'; input.correction.start.confirmedAt = '2001-01-01T10:00:00-0300';
  const response = await post(f.correctionUrl, input); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().planValidationComplete, true);
  assert.equal(response.json().proposed.personName, 'Correct Recipient'); assert.equal(response.json().currentAsset.status, 'DECOMMISSIONED');
  assert.deepEqual(await snapshot(f), original);
});

test('unknown source dates stay null, date proof stays mandatory and same-source day mismatches remain blockers', async () => {
  const f = await prepare({ knownDay: false }); const input = clone(f.correctionInput); input.correction.start.confirmedAt = '2000-12-31T10:00:00Z';
  const first = await post(f.correctionUrl, input); assert.equal(first.statusCode, 200, first.body); assert.equal(first.json().planValidationComplete, true);
  assert.equal(first.json().sources.every((entry) => entry.effectiveDay === null && entry.datePrecision === 'UNKNOWN'), true);
  input.correction.start.dateEvidenceReference = null; assert.ok(blockers(await post(f.correctionUrl, input)).includes('EXACT_DATE_PROOF_REQUIRED'));
  const known = await prepare(); const changed = clone(known.correctionInput); changed.correction.start.confirmedAt = '2001-01-02T10:00:00Z';
  assert.ok(blockers(await post(known.correctionUrl, changed)).includes('SOURCE_DAY_MISMATCH'));
});

test('sibling periods are never exempted with the target and current or terminal boundaries still reject overlap', async () => {
  const f = await prepare({ periodCount: 2, knownDay: false }); const input = clone(f.correctionInput); input.correction.end.confirmedAt = '2003-06-01T12:00:00Z';
  const response = await post(f.correctionUrl, input); assert.ok(blockers(response).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
  assert.ok(response.json().blockers.some((entry) => entry.relatedId === f.receipt.items.find((item) => item.id !== f.assignmentItem.id).assignmentId));
  const delivered = await post('/assets/' + f.asset.id + '/assignments', { personName: 'Later Custodian', effectiveAt: '2005-01-01T00:00:00Z' }); assert.equal(delivered.statusCode, 201, delivered.body);
  input.correction.end.confirmedAt = '2006-01-01T12:00:00Z'; assert.ok(blockers(await post(f.correctionUrl, input)).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
});

test('origin fingerprints and every parent including assignment item are scoped before returning a plan', async () => {
  const f = await prepare(); code(await post(f.correctionUrl, { ...f.correctionInput, expectedOriginPlanId: 'a'.repeat(64) }), 409, 'GROUP_ASSIGNMENT_ORIGIN_CHANGED');
  for (const id of [f.batch.id, f.review.id, f.application.id, f.item.id, f.receipt.id, f.assignmentItem.id]) {
    assert.equal((await post(f.correctionUrl.replace(id, randomUUID()), f.correctionInput)).statusCode, 404);
  }
});

test('corrupt origin, assignment, permanent ownership or missing audits cannot grant a consumed endpoint exemption', async () => {
  const f = await prepare(); const original = await snapshot(f);
  for (const [model, mutate] of [
    ['importGroupAssignmentApplication', (receipt) => { receipt.requestDigest = 'a'.repeat(64); }],
    ['importGroupAssignmentApplication', (receipt) => { receipt.items[0].assignment.notes = 'Forged origin'; }],
    ['importGroupAssignmentApplication', (receipt) => { receipt.items[0].evidenceUses.pop(); }],
    ['importGroupAssignmentApplication', (receipt) => { receipt.items[0].snapshot = {}; }],
    ['importHistoricalEvidence', (evidence) => { evidence.find((entry) => entry.id === f.input.plan.periods[0].start.evidenceId).groupAssignmentUse = null; }],
    ['auditLog', (audits) => { audits.pop(); }]
  ]) {
    const instance = buildApp(transformReads(model, mutate));
    try { code(await post(f.correctionUrl, f.correctionInput, 'JEFE', true, instance), 409, 'INVALID_GROUP_ASSIGNMENT_APPLICATION'); }
    finally { await instance.close(); }
  }
  assert.deepEqual(await snapshot(f), original);
});

test('normal planning stays blocked after review and SQL origin plus raw assignment remain immutable', async () => {
  const f = await prepare(); assert.equal((await post(f.correctionUrl, f.correctionInput)).statusCode, 200);
  assert.ok((await post(f.url, f.input)).json().periods[0].blockers.some((entry) => entry.code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED'));
  await assert.rejects(database.assignment.update({ where: { id: f.assignmentItem.assignmentId }, data: { notes: 'Bypass correction preview' } }), /immutable/i);
  await assert.rejects(database.importGroupAssignmentItem.delete({ where: { id: f.assignmentItem.id } }), /immutable/i);
  assert.equal((await database.assignment.findUniqueOrThrow({ where: { id: f.assignmentItem.assignmentId } })).notes, f.assignmentItem.assignment.notes);
});

test('missing V25 tables and bounded context limits return explicit errors without truncated correction success', async () => {
  const f = await prepare();
  const missing = database.$extends({ query: { importGroupAssignmentApplication: { async findFirst() {
    throw new Prisma.PrismaClientKnownRequestError('Missing grouped receipts', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportGroupAssignmentApplication' } });
  } } } });
  const absent = buildApp(missing);
  try { code(await post(f.correctionUrl, f.correctionInput, 'JEFE', true, absent), 503, 'IMPORT_REVIEW_NOT_READY'); } finally { await absent.close(); }
  const limited = buildApp(transformReads('assignment', (assignments) => { while (assignments.length < 10001) assignments.push({ ...assignments[0] }); }));
  try { code(await post(f.correctionUrl, f.correctionInput, 'JEFE', true, limited), 409, 'GROUP_ASSIGNMENT_PLAN_LIMIT'); } finally { await limited.close(); }
});

test('correction planning sees one repeatable snapshot while current metadata changes concurrently', async () => {
  const f = await prepare(); const initial = await post(f.correctionUrl, f.correctionInput); assert.equal(initial.statusCode, 200, initial.body);
  let entered; const ready = new Promise((resolve) => { entered = resolve; }); let release; const gate = new Promise((resolve) => { release = resolve; });
  const paused = database.$extends({ query: { importGroupAssignmentApplication: { async findFirst({ args, query }) {
    const result = await query(args); entered(); await gate; return result;
  } } } });
  const instance = buildApp(paused); const running = post(f.correctionUrl, f.correctionInput, 'JEFE', true, instance);
  try {
    await ready; await database.asset.update({ where: { id: f.asset.id }, data: { location: 'Changed after snapshot began' } }); release();
    const stable = await running; assert.equal(stable.statusCode, 200, stable.body); assert.equal(stable.json().correctionPlanId, initial.json().correctionPlanId);
    assert.equal(stable.json().currentAsset.location, initial.json().currentAsset.location);
    const refreshed = await post(f.correctionUrl, f.correctionInput); assert.notEqual(refreshed.json().correctionPlanId, stable.json().correctionPlanId);
  } finally { release(); await running; await instance.close(); }
});

test('administrative cancellation does not release permanent endpoints or invalidate the saved correction origin', async () => {
  const f = await prepare();
  const released = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Administrative review complete' });
  assert.equal(released.statusCode, 201, released.body); const original = await snapshot(f);
  const reviewed = await post(f.correctionUrl, f.correctionInput); assert.equal(reviewed.statusCode, 200, reviewed.body); assert.equal(reviewed.json().planValidationComplete, true);
  assert.equal(reviewed.json().ownership.length, 2);
  code(await post('/assets/' + f.asset.id + '/imported-assignment-plan', f.input.plan), 409, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  assert.deepEqual(await snapshot(f), original);
});

test('a receipt captured under open custody stays valid after a later normal return changes current availability', async () => {
  const f = await prepare({ activeBeforeApply: true }); assert.equal(f.receipt.custodySnapshot.length, 1);
  const current = await database.assignment.findFirstOrThrow({ where: { assetId: f.asset.id, endedAt: null } });
  const returned = await post('/assets/' + f.asset.id + '/assignments/' + current.id + '/return', {}); assert.equal(returned.statusCode, 200, returned.body);
  const original = await snapshot(f); const response = await post(f.correctionUrl, f.correctionInput);
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().planValidationComplete, true);
  assert.equal(response.json().currentAsset.status, 'AVAILABLE'); assert.deepEqual(response.json().currentCustody, []);
  assert.deepEqual(await snapshot(f), original);
});

after(async () => { await app.close(); });
