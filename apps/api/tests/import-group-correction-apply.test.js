import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { deserialize, serialize } from 'node:v8';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { applyGroupAssignmentCorrection } from '../src/imports/group-correction-apply-service.js';
import { groupCorrectionApplySchema, groupCorrectionRequestDigest } from '../src/imports/group-correction-apply-schemas.js';
import { correctionEnvelope } from '../src/imports/group-correction-chain.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { hashPassword } from '../src/lib/password.js';
import { groupClosedAssignmentFixture } from './fixtures/group-closed-assignment.js';
import { verifiedRetirementFixture } from './fixtures/verified-retirement-import.js';

const productIds = []; const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const users = {}; const cookies = {}; let product;
const clone = (value) => deserialize(serialize(value));
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
before(async () => {
  for (const role of ['JEFE', 'OTHER_JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'correctionapply-' + randomUUID(); const password = 'Correction-apply-password-123';
    users[role] = await database.user.create({ data: { username, displayName: role, role: role === 'OTHER_JEFE' ? 'JEFE' : role, passwordHash: hashPassword(password) } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200, login.body);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Correction apply ' + randomUUID(), trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
async function prepare(options = {}) {
  const f = await groupClosedAssignmentFixture({ database, product, post, get, ...options });
  const originalPlan = await post(f.url, f.input); assert.equal(originalPlan.statusCode, 200, originalPlan.body);
  let groupInput = { ...f.input, plan: { periods: f.input.plan.periods.map((period) => ({ ...period,
    acknowledgedWarnings: originalPlan.json().periods.find((entry) => entry.periodId === period.periodId).warnings.map((warning) => warning.id) })) } };
  if (options.partialFirst) {
    const first = groupInput.plan.periods[0]; const ids = [first.start.evidenceId, first.end.evidenceId];
    groupInput = { ...groupInput, links: groupInput.links.filter((link) => ids.includes(link.evidenceId)), plan: { periods: [first] } };
  }
  const planned = await post(f.url, groupInput); assert.equal(planned.json().planValidationComplete, true, planned.body);
  const applied = await post(f.url + '/apply', { requestId: randomUUID(), planId: planned.json().planId, confirmation: 'APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY', plan: groupInput });
  assert.equal(applied.statusCode, 201, applied.body); const receipt = applied.json().application; const period = groupInput.plan.periods[0];
  const target = receipt.items.find((item) => item.periodId === period.periodId);
  const base = f.itemUrl + '/closed-assignment-applications/' + receipt.id + '/items/' + target.id;
  const parents = { batchId: f.batch.id, reviewId: f.review.id, applicationId: f.application.id, itemId: f.item.id, groupApplicationId: receipt.id, assignmentItemId: target.id };
  const plan = { expectedOriginPlanId: receipt.planId, expectedCorrectionVersion: 0, reason: 'Verified transcription correction', supportingReference: 'Signed rectification',
    correction: { ...omit(period, ['periodId', 'confirmation']), start: omit(period.start, ['evidenceId']), end: omit(period.end, ['evidenceId']), note: 'Corrected period note' } };
  return { ...f, receipt, target, base, parents, plan, planUrl: base + '/correction-plan', applyUrl: base + '/correction-plan/apply' };
}
async function confirm(f, plan = f.plan, requestId = randomUUID()) {
  const reviewed = await post(f.planUrl, plan); assert.equal(reviewed.statusCode, 200, reviewed.body); assert.equal(reviewed.json().planValidationComplete, true, reviewed.body);
  return { requestId, correctionPlanId: reviewed.json().correctionPlanId, confirmation: 'APPLY_GROUP_ASSIGNMENT_CORRECTION', plan };
}
function expectCode(response, status, code) { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().code, code, response.body); }
async function preserved(f) {
  return { asset: await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }),
    assignments: await database.assignment.findMany({ where: { assetId: f.asset.id }, orderBy: { id: 'asc' } }),
    origin: await database.importGroupAssignmentApplication.findUniqueOrThrow({ where: { id: f.receipt.id }, include: { items: { orderBy: { periodId: 'asc' }, include: { evidenceUses: { orderBy: { endpoint: 'asc' } } } } } }),
    source: await database.importHistoricalEvidence.findMany({ where: { captureId: f.capture.id }, orderBy: { id: 'asc' }, include: { amendments: true } }),
    rows: await database.importIdentityGroupRowUse.findMany({ where: { itemId: f.item.id }, orderBy: { recordId: 'asc' } }),
    history: await database.importGroupHistoryLink.findMany({ where: { application: { itemId: f.item.id } }, orderBy: { id: 'asc' } }),
    movements: await database.inventoryMovement.findMany({ where: { assetId: f.asset.id } }) };
}
function execute(client, f, input) { return applyGroupAssignmentCorrection(client, f.parents, groupCorrectionApplySchema.parse(input), users.JEFE.id); }
function afterTransaction(callback, before) {
  return new Proxy(database, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (operation, options) => database.$transaction(async (tx) => { if (before) await before(tx); const result = await operation(tx); await callback(tx, result); return result; }, options);
  } });
}

test('group correction apply persists one audited immutable version and shows effective history without modifying original state', async () => {
  const f = await prepare(); const original = await preserved(f); const input = await confirm(f);
  const response = await post(f.applyUrl, input); assert.equal(response.statusCode, 201, response.body); const correction = response.json().correction;
  assert.equal(correction.version, 1); assert.equal(correction.previousId, null); assert.equal(correction.correctedById, users.JEFE.id);
  assert.equal(await database.auditLog.count({ where: { entityId: correction.id, action: 'IMPORT_GROUP_ASSIGNMENT_CORRECTED' } }), 1);
  assert.deepEqual(await preserved(f), original);
  const detail = await get('/assignments/' + f.target.assignmentId); assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().assignment.notes, 'Corrected period note'); assert.equal(detail.json().assignment.originalAssignment.notes, f.target.assignment.notes);
  assert.equal(detail.json().assignment.historyCorrection.id, correction.id);
  const timeline = (await get('/assets/' + f.asset.id + '/history')).json().events.filter((entry) => entry.historyCorrection);
  assert.equal(timeline.length, 2); assert.equal(timeline.every((entry) => entry.actor === null && entry.recordedById === f.receipt.appliedById), true);
});

test('group correction apply enforces authenticated JEFE, CSRF and its own strict confirmation DTO', async () => {
  const f = await prepare(); const input = await confirm(f);
  assert.equal((await app.inject({ method: 'POST', url: f.applyUrl, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(f.applyUrl, input, role)).statusCode, 403);
  assert.equal((await post(f.applyUrl, input, 'JEFE', false)).statusCode, 403);
  for (const extra of [{ confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY' }, { assetId: f.asset.id }, { correctedAt: new Date().toISOString() }, { force: true }]) {
    assert.equal((await post(f.applyUrl, { ...input, ...extra })).statusCode, 400);
  }
  assert.equal((await post(f.applyUrl + '?force=true', input)).statusCode, 400);
});

test('sequential corrections use latest values, version checks and append-only original source', async () => {
  const f = await prepare(); const original = await preserved(f); const first = await post(f.applyUrl, await confirm(f)); assert.equal(first.statusCode, 201, first.body);
  expectCode(await post(f.planUrl, f.plan), 409, 'GROUP_CORRECTION_VERSION_CONFLICT');
  const next = clone(f.plan); next.expectedCorrectionVersion = 1; next.correction.note = 'Second corrected note'; next.correction.recipient = { type: 'PERSON', name: 'Correct Recipient' };
  const plan = await post(f.planUrl, next); assert.equal(plan.statusCode, 200, plan.body); assert.equal(plan.json().before.note, 'Corrected period note');
  const second = await post(f.applyUrl, await confirm(f, next)); assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().correction.version, 2); assert.equal(second.json().correction.previousId, first.json().correction.id);
  const listed = await get('/assignments?assetId=' + f.asset.id + '&recipientType=PERSON'); assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().total, 1); assert.equal(listed.json().assignments[0].personName, 'Correct Recipient');
  assert.deepEqual(await preserved(f), original);
});

test('same-key concurrent retries recover exact receipt while other actors and intents cannot reuse it', async () => {
  const f = await prepare(); const input = await confirm(f);
  const pair = await Promise.all([post(f.applyUrl, input), post(f.applyUrl, input)]);
  assert.deepEqual(pair.map((response) => response.statusCode).sort(), [200, 201], pair.map((response) => response.body).join('\n'));
  assert.equal(pair[0].json().correction.id, pair[1].json().correction.id);
  expectCode(await post(f.applyUrl, input, 'OTHER_JEFE'), 409, 'IDEMPOTENCY_KEY_REUSED');
  expectCode(await post(f.applyUrl, { ...input, plan: { ...input.plan, reason: 'Another reason' } }), 409, 'IDEMPOTENCY_KEY_REUSED');
  await database.asset.update({ where: { id: f.asset.id }, data: { location: 'Later state' } });
  assert.equal((await post(f.applyUrl, input)).statusCode, 200);
  const [version] = await database.importGroupAssignmentCorrection.findMany({ where: { itemId: f.target.id } }); assert.equal(version.version, 1);
});

test('stale plans and competing keys cannot overwrite current correction version', async () => {
  const f = await prepare(); const input = await confirm(f);
  const results = await Promise.all([post(f.applyUrl, input), post(f.applyUrl, { ...input, requestId: randomUUID() })]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409], results.map((result) => result.body).join('\n'));
  expectCode(results.find((result) => result.statusCode === 409), 409, 'GROUP_CORRECTION_VERSION_CONFLICT');
  const next = clone(f.plan); next.expectedCorrectionVersion = 1; next.correction.note = 'Another correction'; const pending = await confirm(f, next);
  await database.asset.update({ where: { id: f.asset.id }, data: { location: 'After review' } });
  expectCode(await post(f.applyUrl, pending), 409, 'GROUP_CORRECTION_PLAN_CHANGED');
});

test('effective timestamps protect SQL, new deliveries and later correction overlap with siblings', async () => {
  const f = await prepare({ knownDay: false, periodCount: 2 }); const input = clone(f.plan); input.correction.end.confirmedAt = '2002-06-01T12:00:00Z';
  const response = await post(f.applyUrl, await confirm(f, input)); assert.equal(response.statusCode, 201, response.body);
  const assignment = (await get('/assignments/' + f.target.assignmentId)).json().assignment;
  assert.equal(assignment.endedAt, '2002-06-01T12:00:00.000Z'); assert.equal(assignment.originalAssignment.endedAt, '2002-01-01T13:00:00.000Z');
  await assert.rejects(database.$transaction(async (tx) => {
    await tx.assignment.create({ data: { assetId: f.asset.id, recipientType: 'OFFICE', officeName: 'Overlapping SQL custody', createdById: users.JEFE.id,
      startedAt: new Date('2002-02-01'), endedAt: new Date('2002-03-01'), endedById: users.JEFE.id, returnStatus: 'AVAILABLE', returnRecordedAt: new Date() } });
  }), /overlap/i);
  await assert.rejects(database.asset.update({ where: { id: f.asset.id }, data: { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2002-04-01') } }), /effective custody/i);
  const blocked = clone(input); blocked.expectedCorrectionVersion = 1; blocked.correction.end.confirmedAt = '2003-06-01T12:00:00Z';
  const plan = await post(f.planUrl, blocked); assert.equal(plan.statusCode, 200, plan.body); assert.ok(plan.json().blockers.some((entry) => entry.code === 'OPERATIONAL_ASSIGNMENT_OVERLAP'));
});

test('corrected shorter history frees its old interval for new valid custody and retains original proof', async () => {
  const f = await prepare({ knownDay: false }); const plan = clone(f.plan); plan.correction.end.confirmedAt = '2001-06-01T12:00:00Z';
  const saved = await post(f.applyUrl, await confirm(f, plan)); assert.equal(saved.statusCode, 201, saved.body);
  const delivered = await post('/assets/' + f.asset.id + '/assignments', { personName: 'New Custodian', effectiveAt: '2001-07-01T12:00:00Z' }); assert.equal(delivered.statusCode, 201, delivered.body);
  const next = clone(plan); next.expectedCorrectionVersion = 1; next.correction.note = 'After new current custody';
  const refreshed = await post(f.planUrl, next); assert.equal(refreshed.statusCode, 200, refreshed.body); assert.equal(refreshed.json().planValidationComplete, true);
});

test('audit and correction failures roll back and preserve a reusable request key', async () => {
  const f = await prepare(); const input = await confirm(f); const original = await preserved(f);
  const unaudited = database.$extends({ query: { auditLog: { async create({ args, query }) {
    return args.data.action === 'IMPORT_GROUP_ASSIGNMENT_CORRECTED' ? { ...args.data, id: randomUUID() } : query(args);
  } } } });
  await assert.rejects(execute(unaudited, f, input), /audit/i);
  assert.equal(await database.importGroupAssignmentCorrection.count({ where: { itemId: f.target.id } }), 0); assert.deepEqual(await preserved(f), original);
  assert.equal((await post(f.applyUrl, input)).statusCode, 201);
});

test('SQL guards preserve immutable receipts and current state after early constraints and savepoints', async () => {
  const f = await prepare(); const input = await confirm(f); const original = await preserved(f);
  for (const savepoint of [false, true]) {
    await assert.rejects(execute(afterTransaction(async (tx) => {
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); if (savepoint) await tx.$executeRawUnsafe('RELEASE SAVEPOINT correction_receipt');
      await tx.asset.update({ where: { id: f.asset.id }, data: { location: 'Forbidden after validation' } });
    }, savepoint ? (tx) => tx.$executeRawUnsafe('SAVEPOINT correction_receipt') : undefined), f, input), /current asset|custody/i);
    assert.equal(await database.importGroupAssignmentCorrection.count({ where: { itemId: f.target.id } }), 0); assert.deepEqual(await preserved(f), original);
  }
  const response = await post(f.applyUrl, input); assert.equal(response.statusCode, 201, response.body); const correction = response.json().correction;
  await assert.rejects(database.importGroupAssignmentCorrection.update({ where: { id: correction.id }, data: { reason: 'Rewrite' } }), /immutable/i);
  await assert.rejects(database.importGroupAssignmentCorrection.delete({ where: { id: correction.id } }), /immutable/i);
  await assert.rejects(database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('TRUNCATE TABLE "ImportGroupAssignmentCorrection"');
    throw new Error('Truncate unexpectedly succeeded; roll back isolated test data');
  }), /immutable/i);
  await assert.rejects(database.assignment.update({ where: { id: f.target.assignmentId }, data: { notes: 'Rewrite origin' } }), /immutable/i);
});

test('correction receipts are paginated and scoped to every original parent and item', async () => {
  const f = await prepare(); const response = await post(f.applyUrl, await confirm(f)); assert.equal(response.statusCode, 201, response.body); const correction = response.json().correction;
  const page = await get(f.base + '/corrections?limit=1&offset=0'); assert.equal(page.statusCode, 200, page.body); assert.equal(page.json().total, 1);
  assert.equal('plan' in page.json().corrections[0], false);
  const detail = await get(f.base + '/corrections/' + correction.id); assert.equal(detail.statusCode, 200, detail.body); assert.deepEqual(detail.json().correction, correction);
  for (const id of [f.batch.id, f.review.id, f.application.id, f.item.id, f.receipt.id, f.target.id]) assert.equal((await get((f.base + '/corrections/' + correction.id).replace(id, randomUUID()))).statusCode, 404);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await get(f.base + '/corrections', role)).statusCode, 403);
});

test('missing correction storage and occupied inventory locks fail clearly without partial correction writes', async () => {
  const f = await prepare(); const input = await confirm(f);
  const missing = database.$extends({ query: { importGroupAssignmentCorrection: { async findUnique() { throw new Prisma.PrismaClientKnownRequestError('Missing corrections',
    { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportGroupAssignmentCorrection' } }); } } } });
  const instance = buildApp(missing); try { expectCode(await post(f.applyUrl, input, 'JEFE', true, instance), 503, 'IMPORT_REVIEW_NOT_READY'); } finally { await instance.close(); }
  let entered; const ready = new Promise((resolve) => { entered = resolve; }); let release; const gate = new Promise((resolve) => { release = resolve; });
  const holder = database.$transaction(async (tx) => { await tx.$executeRawUnsafe('LOCK TABLE "Asset" IN ROW EXCLUSIVE MODE'); entered(); await gate; }, { timeout: 10000 });
  await ready; try { expectCode(await post(f.applyUrl, input), 409, 'GROUP_CORRECTION_BUSY'); } finally { release(); await holder; }
  assert.equal((await post(f.applyUrl, input)).statusCode, 201);
});

test('SQL rejects false actors, transaction markers and current snapshots even with a valid application request', async () => {
  const f = await prepare(); const input = await confirm(f); const original = await preserved(f);
  for (const extra of [{ correctedById: users.SOPORTE.id }, { createdTransactionId: '0' }, { assetSnapshot: {} },
    { custodySnapshot: [{ id: randomUUID() }] }, { version: 2 }, { previousId: randomUUID() }]) {
    const forged = database.$extends({ query: { importGroupAssignmentCorrection: { async create({ args, query }) {
      return query({ ...args, data: { ...args.data, ...extra } });
    } } } });
    await assert.rejects(execute(forged, f, input), /Correction|constraint/i);
    assert.equal(await database.importGroupAssignmentCorrection.count({ where: { itemId: f.target.id } }), 0);
  }
  assert.deepEqual(await preserved(f), original); assert.equal((await post(f.applyUrl, input)).statusCode, 201);
});

test('SQL source rules reject a recomputed correction hash and intent that contradict the known source day', async () => {
  const f = await prepare(); const input = await confirm(f);
  const forged = database.$extends({ query: { importGroupAssignmentCorrection: { async create({ args, query }) {
    const plan = clone(args.data.plan); const confirmedAt = '2001-01-02T09:00:00-03:00';
    plan.proposedPeriod.start.confirmedAt = confirmedAt; plan.proposedPeriod.proposedAssignment.startedAt = new Date(confirmedAt).toISOString();
    plan.proposed.startedAt = plan.proposedPeriod.proposedAssignment.startedAt;
    plan.changes = Object.entries(plan.proposed).filter(([key, value]) => importPlanDigest(value) !== importPlanDigest(plan.before[key]))
      .map(([field, after]) => ({ field, before: plan.before[field], after }));
    plan.correctionPlanId = importPlanDigest(Object.fromEntries(Object.entries(plan).filter(([key]) => !correctionEnvelope.has(key))));
    const intent = groupCorrectionApplySchema.parse({ ...input, correctionPlanId: plan.correctionPlanId, plan: { ...input.plan,
      correction: { ...input.plan.correction, start: { ...input.plan.correction.start, confirmedAt } } } });
    return query({ ...args, data: { ...args.data, plan, correctionPlanId: plan.correctionPlanId, requestDigest: groupCorrectionRequestDigest(intent) } });
  } } } });
  await assert.rejects(execute(forged, f, input), /source local day/i);
  assert.equal(await database.importGroupAssignmentCorrection.count({ where: { itemId: f.target.id } }), 0);
});

test('correction commit cannot create current custody after forcing constraints, while later normal custody remains supported', async () => {
  const f = await prepare(); const input = await confirm(f);
  await assert.rejects(execute(afterTransaction(async (tx) => {
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.assignment.create({ data: { assetId: f.asset.id, personName: 'Injected custody', createdById: users.JEFE.id, startedAt: new Date('2005-01-01') } });
  }), f, input), /current asset or custody/i);
  assert.equal(await database.importGroupAssignmentCorrection.count({ where: { itemId: f.target.id } }), 0);
  assert.equal((await post(f.applyUrl, input)).statusCode, 201);
  const delivered = await post('/assets/' + f.asset.id + '/assignments', { personName: 'Later normal custodian', effectiveAt: '2005-01-01T12:00:00Z' }); assert.equal(delivered.statusCode, 201, delivered.body);
  const current = (await get('/assets/' + f.asset.id + '/assignments')).json().currentAssignment;
  assert.equal(current.personName, 'Later normal custodian');
  const next = clone(f.plan); next.expectedCorrectionVersion = 1; next.correction.note = 'Correction under current custody';
  const original = await preserved(f); const corrected = await post(f.applyUrl, await confirm(f, next)); assert.equal(corrected.statusCode, 201, corrected.body);
  assert.deepEqual(await preserved(f), original);
  const returned = await post('/assets/' + f.asset.id + '/assignments/' + current.id + '/return', {}); assert.equal(returned.statusCode, 200, returned.body);
});

test('SQL history writers cannot use a stale repeatable snapshot after a correction', async () => {
  const f = await prepare({ knownDay: false }); const plan = clone(f.plan); plan.correction.end.confirmedAt = '2002-06-01T12:00:00Z';
  const input = await confirm(f, plan);
  let entered; const ready = new Promise((resolve) => { entered = resolve; }); let release; const gate = new Promise((resolve) => { release = resolve; });
  const stale = database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Assignment" WHERE "id" = ${f.target.assignmentId}::uuid`; entered(); await gate;
    await tx.assignment.create({ data: { assetId: f.asset.id, personName: 'Stale snapshot custodian', createdById: users.JEFE.id, startedAt: new Date('2002-02-01') } });
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 });
  const rejected = assert.rejects(stale, /READ COMMITTED/i);
  try { await ready; const response = await post(f.applyUrl, input); assert.equal(response.statusCode, 201, response.body); }
  finally { release(); await rejected; }
});

test('a later grouped import fingerprints effective previous history and retains independent source ownership', async () => {
  const f = await prepare({ periodCount: 2, knownDay: false, partialFirst: true });
  const correctionPlan = clone(f.plan); correctionPlan.correction.end.confirmedAt = '2002-06-01T12:00:00Z';
  const corrected = await post(f.applyUrl, await confirm(f, correctionPlan)); assert.equal(corrected.statusCode, 201, corrected.body);
  const remaining = f.input.plan.periods[1]; const ids = [remaining.start.evidenceId, remaining.end.evidenceId];
  const intent = { ...f.input, links: f.input.links.filter((link) => ids.includes(link.evidenceId)), plan: { periods: [remaining] } };
  const first = await post(f.url, intent); assert.equal(first.statusCode, 200, first.body);
  intent.plan.periods[0] = { ...remaining, acknowledgedWarnings: first.json().periods[0].warnings.map((warning) => warning.id) };
  const reviewed = await post(f.url, intent); assert.equal(reviewed.json().planValidationComplete, true, reviewed.body);
  const applied = await post(f.url + '/apply', { requestId: randomUUID(), planId: reviewed.json().planId, confirmation: 'APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY', plan: intent });
  assert.equal(applied.statusCode, 201, applied.body); assert.equal(applied.json().application.items.length, 1);
  assert.equal(await database.importGroupAssignmentEvidenceUse.count({ where: { item: { application: { itemId: f.item.id } } } }), 4);
});

test('retirement planning and SQL share corrected temporal bounds and allow a later valid terminal date', async () => {
  const f = await prepare({ knownDay: false }); const correctionPlan = clone(f.plan); correctionPlan.correction.end.confirmedAt = '2006-01-01T12:00:00Z';
  const corrected = await post(f.applyUrl, await confirm(f, correctionPlan)); assert.equal(corrected.statusCode, 201, corrected.body);
  const retired = await verifiedRetirementFixture({ database, product, actorId: users.JEFE.id, post, get, existingAsset: f.asset });
  assert.equal(retired.plan.planValidationComplete, false); assert.ok(retired.plan.blockers.some((entry) => entry.code === 'ASSIGNMENT_AFTER_RETIREMENT'));
  const forged = clone(retired.plan); forged.planValidationComplete = true; forged.blockers = [];
  const appliedAt = new Date();
  await assert.rejects(database.importRetirementApplication.create({ data: { assetId: f.asset.id, evidenceId: retired.evidence.id,
    evidenceVersion: 0, amendmentId: null, sourceRevision: 0, decommissionedAt: new Date(forged.proposedRetirement.decommissionedAt), requestId: randomUUID(),
    requestDigest: 'a'.repeat(64), planId: forged.planId, rulesVersion: forged.planRulesVersion, plan: forged, appliedById: users.JEFE.id, appliedAt,
    result: { id: f.asset.id, productId: product.id, serialNumber: f.asset.serialNumber, assetTag: f.asset.assetTag, status: 'DECOMMISSIONED', isActive: false,
      decommissionedAt: forged.proposedRetirement.decommissionedAt, updatedAt: appliedAt.toISOString() } } }), /contradict assignment history/i);
  const later = { ...retired.input.plan, confirmedAt: '2007-01-01T12:00:00Z' };
  const reviewed = await post(retired.planUrl, later); assert.equal(reviewed.json().planValidationComplete, true, reviewed.body);
  const applied = await post(retired.url, { ...retired.input, requestId: randomUUID(), planId: reviewed.json().planId, plan: later }); assert.equal(applied.statusCode, 201, applied.body);
  const invalid = clone(f.plan); invalid.expectedCorrectionVersion = 1; invalid.correction.end.confirmedAt = '2008-01-01T12:00:00Z';
  const terminal = await post(f.planUrl, invalid); assert.equal(terminal.statusCode, 200, terminal.body);
  assert.ok(terminal.json().blockers.some((entry) => entry.code === 'HISTORICAL_PERIOD_AFTER_DECOMMISSION'));
  const valid = clone(correctionPlan); valid.expectedCorrectionVersion = 1; valid.correction.note = 'Correction after valid retirement';
  const terminalBefore = await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } });
  const final = await post(f.applyUrl, await confirm(f, valid)); assert.equal(final.statusCode, 201, final.body);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }), terminalBefore);
});

after(async () => { await app.close(); });
