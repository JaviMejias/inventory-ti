import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { groupClosedAssignmentApplyDigest, groupClosedAssignmentApplySchema } from '../src/imports/group-assignment-apply-schemas.js';
import { applyGroupClosedAssignments } from '../src/imports/group-assignment-apply-service.js';
import { hashPassword } from '../src/lib/password.js';
import { groupClosedAssignmentFixture } from './fixtures/group-closed-assignment.js';
import { dateCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const users = {}; const cookies = {}; let product;
const auditActions = ['IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED', 'IMPORT_GROUP_CLOSED_ASSIGNMENT_ADDED'];

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE', 'OTHER_JEFE']) {
    const username = 'groupassignmentapply-' + role.toLowerCase() + '-' + suffix; const password = 'Group-assignment-apply-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group assignment apply ' + role,
      passwordHash: hashPassword(password), role: role === 'OTHER_JEFE' ? 'JEFE' : role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(login.statusCode, 200, login.body);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group assignment apply ' + suffix,
    trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});

async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role];
  const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function prepare(options = {}) { return groupClosedAssignmentFixture({ database, product, post, get, ...options }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function receipts(f) { return f.itemUrl + '/closed-assignment-applications'; }
function apply(f, input, instance = app) { return post(f.url + '/apply', input, 'JEFE', true, instance); }
function execute(client, f, input, actorId = users.JEFE.id) {
  return applyGroupClosedAssignments(client, f.batch.id, f.review.id, f.application.id, f.item.id,
    groupClosedAssignmentApplySchema.parse(input), actorId);
}
function conflict(response, code) {
  assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, code, response.body);
}
async function confirmation(f, input = f.input, requestId = randomUUID(), valid = true) {
  const first = await post(f.url, input); assert.equal(first.statusCode, 200, first.body);
  const acknowledged = { ...input, plan: { periods: input.plan.periods.map((period) => ({ ...period,
    acknowledgedWarnings: first.json().periods.find((entry) => entry.periodId === period.periodId).warnings.map((warning) => warning.id) })) } };
  const planned = await post(f.url, acknowledged); assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json().planValidationComplete, valid, planned.body);
  return { requestId, planId: planned.json().planId, confirmation: 'APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY', plan: acknowledged };
}
function selection(f, periods) {
  const ids = periods.flatMap((period) => [period.start.evidenceId, period.end.evidenceId]);
  return { ...f.input, links: f.input.links.filter((link) => ids.includes(link.evidenceId)), plan: { periods } };
}
async function stored(f) {
  return {
    applications: await database.importGroupAssignmentApplication.count({ where: { itemId: f.item.id } }),
    items: await database.importGroupAssignmentItem.count({ where: { application: { itemId: f.item.id } } }),
    uses: await database.importGroupAssignmentEvidenceUse.count({ where: { evidenceId: { in: f.evidence.map((entry) => entry.id) } } }),
    assignments: await database.assignment.count({ where: { assetId: f.asset.id, importedHistory: true } }),
    audits: await database.auditLog.count({ where: { action: { in: auditActions }, metadata: { path: ['itemId'], equals: f.item.id } } })
  };
}
const emptyStorage = { applications: 0, items: 0, uses: 0, assignments: 0, audits: 0 };
async function preserved(f) {
  const evidenceIds = f.evidence.map((entry) => entry.id);
  return {
    asset: await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }),
    product: await database.product.findUniqueOrThrow({ where: { id: product.id } }),
    currentAssignments: await database.assignment.findMany({ where: { assetId: f.asset.id, importedHistory: false }, orderBy: { id: 'asc' } }),
    capture: await database.importHistoryCapture.findUniqueOrThrow({ where: { id: f.capture.id }, include: { items: { orderBy: { id: 'asc' } } } }),
    currentEvidence: await database.$queryRaw`SELECT * FROM "ImportHistoricalEvidenceCurrent" WHERE "sourceHash" = ${f.source.source.sha256} ORDER BY "id"`,
    amendments: await database.importEvidenceAmendment.findMany({ where: { evidenceId: { in: evidenceIds } }, orderBy: { id: 'asc' } }),
    batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }),
    revisions: await database.importSourceRevision.findMany({ where: { batchId: f.batch.id }, orderBy: { revision: 'asc' } }),
    review: await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { release: true,
      rows: { orderBy: { recordId: 'asc' } }, decisions: { orderBy: { version: 'asc' } } } }),
    pilot: await database.importIdentityGroupApplication.findUniqueOrThrow({ where: { id: f.application.id }, include: {
      items: { orderBy: { id: 'asc' }, include: { rows: { orderBy: { recordId: 'asc' } } } } } }),
    history: await database.importGroupHistoryApplication.findMany({ where: { itemId: f.item.id }, orderBy: { id: 'asc' },
      include: { links: { orderBy: { evidenceId: 'asc' } } } }),
    rowUses: await database.importIdentityGroupRowUse.findMany({ where: { itemId: f.item.id }, orderBy: { recordId: 'asc' } }),
    legacyApplications: await database.importAssignmentApplication.findMany({ where: { assetId: f.asset.id }, orderBy: { id: 'asc' } }),
    legacyUses: await database.importAssignmentEvidenceUse.findMany({ where: { evidenceId: { in: evidenceIds } }, orderBy: { evidenceId: 'asc' } }),
    retirements: await database.importRetirementApplication.findMany({ where: { assetId: f.asset.id }, orderBy: { id: 'asc' } }),
    stocks: await database.inventoryStock.findMany({ where: { productId: product.id }, orderBy: { id: 'asc' } }),
    movements: await database.inventoryMovement.findMany({ where: { productId: product.id }, orderBy: { id: 'asc' } })
  };
}
function transformReads(model, transform) {
  return database.$extends({ query: { [model]: { async $allOperations({ operation, args, query }) {
    const result = await query(args);
    return operation.startsWith('find') && result !== null ? transform(clone(result)) : result;
  } } } });
}
function transactionAfter(callback, options = {}, before) {
  return new Proxy(database, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (operation, transactionOptions) => database.$transaction(async (tx) => {
      if (before) await before(tx);
      const result = await operation(tx); await callback(tx, result); return result;
    }, { ...transactionOptions, ...options });
  } });
}

test('group closed application enforces JEFE, CSRF, strict nested DTO and its own explicit confirmation', async () => {
  const f = await prepare(); const input = await confirmation(f);
  assert.equal((await app.inject({ method: 'POST', url: f.url + '/apply', payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(f.url + '/apply', input, role)).statusCode, 403);
  assert.equal((await post(f.url + '/apply', input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(f.url + '/apply?force=true', input)).statusCode, 400);
  for (const change of [{ requestId: 'bad' }, { planId: 'bad' }, { confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY' },
    { confirmation: 'SAVE_GROUP_HISTORY_LINKS_ONLY' }, { force: true }, { assetId: f.asset.id }, { assetSnapshot: {} }, { appliedAt: '2001-01-01' }]) {
    assert.equal((await apply(f, { ...input, ...change })).statusCode, 400);
  }
  const invalid = [
    { ...input, plan: { ...input.plan, importedHistory: true } },
    { ...input, plan: { ...input.plan, links: [input.plan.links[0], input.plan.links[0]] } },
    { ...input, plan: { ...input.plan, plan: { periods: [{ ...input.plan.plan.periods[0], createdById: users.JEFE.id }] } } }
  ];
  for (const payload of invalid) assert.equal((await apply(f, payload)).statusCode, 400);
  assert.deepEqual(await stored(f), emptyStorage);
});

test('full multi-period application creates closed assignments, exact endpoint ownership, complete receipts and atomic audits', async () => {
  const f = await prepare({ periodCount: 2 }); const input = await confirmation(f); const original = await preserved(f);
  const planned = (await post(f.url, input.plan)).json(); const response = await apply(f, input);
  assert.equal(response.statusCode, 201, response.body); const result = response.json(); const application = result.application;
  assert.equal(result.scope, 'GROUP_CLOSED_ASSIGNMENT_HISTORY'); assert.equal(result.mode, 'APPLIED');
  for (const flag of ['persisted', 'operationalHistoryApplied']) assert.equal(result[flag], true, flag);
  for (const flag of ['affectsCurrentState', 'evidenceRelinked', 'canApply', 'reused']) assert.equal(result[flag], false, flag);
  assert.equal(application.itemId, f.item.id); assert.equal(application.assetId, f.asset.id); assert.equal(application.requestId, input.requestId);
  assert.equal(application.requestDigest, groupClosedAssignmentApplyDigest(groupClosedAssignmentApplySchema.parse(input)));
  assert.equal(application.planId, input.planId); assert.equal(application.rulesVersion, 'mda-group-closed-assignment-application-1');
  assert.deepEqual(application.plan, planned); assert.equal(application.appliedById, users.JEFE.id);
  assert.equal(application.assetSnapshot.id, f.asset.id); assert.equal(application.assetSnapshot.status, original.asset.status);
  assert.deepEqual(application.custodySnapshot, []); assert.equal(application.items.length, 2);
  for (const item of application.items) {
    const period = planned.periods.find((entry) => entry.periodId === item.periodId); const assignment = item.assignment;
    assert.equal(item.applicationId, application.id); assert.equal(item.assignmentId, assignment.id); assert.deepEqual(item.snapshot, period);
    assert.equal(assignment.assetId, f.asset.id); assert.equal(assignment.importedHistory, true);
    for (const field of ['createdById', 'endedById', 'personId', 'expectedReturnAt']) assert.equal(assignment[field], null, field);
    assert.equal(assignment.startedAt, period.proposedAssignment.startedAt); assert.equal(assignment.endedAt, period.proposedAssignment.endedAt);
    assert.equal(assignment.createdAt, application.appliedAt); assert.equal(assignment.returnRecordedAt, application.appliedAt);
    assert.equal(assignment.returnStatus, 'UNDER_REVIEW'); assert.equal(assignment.officeName, period.recipient.name);
    assert.equal(assignment.ticketReference, period.proposedAssignment.ticketReference);
    assert.equal(assignment.returnTicketReference, period.proposedAssignment.returnTicketReference);
    assert.equal(item.evidenceUses.length, 2);
    for (const [endpoint, field] of [['START', 'start'], ['END', 'end']]) {
      const use = item.evidenceUses.find((entry) => entry.endpoint === endpoint);
      const pin = input.plan.links.find((entry) => entry.evidenceId === period[field].evidenceId);
      assert.deepEqual(use, { evidenceId: pin.evidenceId, linkId: pin.linkId, itemId: item.id, endpoint });
      assert.equal(item[field + 'LinkId'], pin.linkId);
    }
    assert.equal(await database.auditLog.count({ where: { entityId: assignment.id, userId: users.JEFE.id,
      action: 'IMPORT_GROUP_CLOSED_ASSIGNMENT_ADDED' } }), 1);
  }
  assert.equal(await database.auditLog.count({ where: { entityId: application.id, userId: users.JEFE.id,
    action: 'IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED' } }), 1);
  assert.deepEqual(await stored(f), { applications: 1, items: 2, uses: 4, assignments: 2, audits: 3 });
  assert.deepEqual(await preserved(f), original);
});

test('partial selection leaves omitted evidence available and applies a later period only after a fresh plan', async () => {
  const f = await prepare({ periodCount: 2, extraEvidence: true }); const original = await preserved(f);
  const first = await confirmation(f, selection(f, [f.input.plan.periods[0]]));
  const staleSecond = await confirmation(f, selection(f, [f.input.plan.periods[1]]));
  const saved = await apply(f, first); assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().application.plan.summary.selectedEndpointCount, 2);
  assert.equal(saved.json().application.plan.summary.omittedLinkCount, 3);
  assert.deepEqual(await stored(f), { applications: 1, items: 1, uses: 2, assignments: 1, audits: 2 });
  conflict(await apply(f, staleSecond), 'GROUP_ASSIGNMENT_PLAN_CHANGED');
  const fresh = await confirmation(f, staleSecond.plan, staleSecond.requestId); assert.notEqual(fresh.planId, staleSecond.planId);
  const planned = (await post(f.url, fresh.plan)).json();
  assert.equal(planned.unselectedHistoryLinks.filter((link) => link.groupAssignmentUse).length, 2);
  const second = await apply(f, fresh); assert.equal(second.statusCode, 201, second.body);
  assert.notEqual(second.json().application.id, saved.json().application.id);
  assert.equal(await database.importGroupAssignmentEvidenceUse.count({ where: {
    evidenceId: { in: f.evidence.filter((entry) => !f.input.links.some((link) => link.evidenceId === entry.id)).map((entry) => entry.id) }
  } }), 0);
  assert.deepEqual(await stored(f), { applications: 2, items: 2, uses: 4, assignments: 2, audits: 4 });
  assert.deepEqual(await preserved(f), original);
});

test('receipt metadata pagination omits snapshots and detail plus every parent is scoped to authenticated JEFE', async () => {
  const f = await prepare({ periodCount: 2 }); const applications = [];
  for (const period of f.input.plan.periods) {
    const saved = await apply(f, await confirmation(f, selection(f, [period])));
    assert.equal(saved.statusCode, 201, saved.body); applications.push(saved.json().application);
  }
  const list = await get(receipts(f) + '?limit=1&offset=0'); assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().total, 2); assert.equal(list.json().limit, 1); assert.equal(list.json().offset, 0); assert.equal(list.json().hasMore, true);
  const metadata = list.json().applications[0]; assert.equal(metadata._count.items, 1);
  for (const field of ['plan', 'items', 'assetSnapshot', 'custodySnapshot']) assert.equal(field in metadata, false, field);
  const next = await get(receipts(f) + '?limit=1&offset=1'); assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().hasMore, false); assert.notEqual(next.json().applications[0].id, metadata.id);
  assert.deepEqual((await get(receipts(f) + '?offset=2')).json().applications, []);
  const detail = receipts(f) + '/' + applications[0].id;
  assert.deepEqual((await get(detail)).json().application, applications[0]);
  for (const url of [receipts(f), detail]) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await get(url, role)).statusCode, 403);
    assert.equal((await get(url + '?force=true')).statusCode, 400);
  }
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=2147483648']) {
    assert.equal((await get(receipts(f) + '?' + query)).statusCode, 400);
  }
  const usedInput = await confirmation(f, selection(f, [f.input.plan.periods[0]]), randomUUID(), false);
  for (const id of [f.batch.id, f.review.id, f.application.id, f.item.id]) {
    assert.equal((await get(receipts(f).replace(id, randomUUID()))).statusCode, 404);
    assert.equal((await get(detail.replace(id, randomUUID()))).statusCode, 404);
    assert.equal((await post(f.url.replace(id, randomUUID()) + '/apply', usedInput)).statusCode, 404);
  }
  assert.equal((await get(receipts(f) + '/' + randomUUID())).statusCode, 404);
  assert.equal((await get(receipts(f) + '/invalid-group-application-id')).statusCode, 400);
  const other = await prepare(); assert.equal((await get(receipts(other) + '/' + applications[0].id)).statusCode, 404);
});

test('assignment and timeline reads preserve current custody and expose unknown historical actors with the actual importer', async () => {
  const f = await prepare();
  const delivered = await post('/assets/' + f.asset.id + '/assignments', { personName: 'Current Custodian', effectiveAt: '2005-01-01T00:00:00Z' });
  assert.equal(delivered.statusCode, 201, delivered.body);
  const original = await preserved(f); const input = await confirmation(f); const saved = await apply(f, input);
  assert.equal(saved.statusCode, 201, saved.body); const application = saved.json().application; const item = application.items[0];
  assert.equal(application.custodySnapshot.length, 1); assert.equal(application.custodySnapshot[0].id, original.currentAssignments[0].id);
  const assignments = await get('/assets/' + f.asset.id + '/assignments'); assert.equal(assignments.statusCode, 200, assignments.body);
  assert.equal(assignments.json().currentAssignment.id, original.currentAssignments[0].id);
  const imported = assignments.json().assignments.find((entry) => entry.id === item.assignmentId);
  assert.equal(imported.createdBy, null); assert.equal(imported.endedBy, null); assert.equal(imported.importHistory, null);
  assert.equal(imported.groupImportHistory.id, item.id); assert.equal(imported.groupImportHistory.applicationId, application.id);
  assert.equal(imported.groupImportHistory.application.itemId, f.item.id);
  assert.equal(imported.groupImportHistory.application.appliedById, users.JEFE.id);
  const history = await get('/assets/' + f.asset.id + '/history'); assert.equal(history.statusCode, 200, history.body);
  const events = history.json().events.filter((event) => event.importScope === 'GROUP_CLOSED_ASSIGNMENT_HISTORY'); assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.source, 'IMPORTED_HISTORY');
    assert.equal(event.importScope, 'GROUP_CLOSED_ASSIGNMENT_HISTORY'); assert.equal(event.importGroupItemId, f.item.id);
    assert.equal(event.importApplicationId, application.id); assert.equal(event.actor, null);
    assert.equal(event.recordedById, users.JEFE.id); assert.equal(event.recordedAt, application.appliedAt);
  }
  assert.deepEqual(events.map((event) => event.effectiveAt).sort(), [item.assignment.startedAt, item.assignment.endedAt].sort());
  assert.deepEqual(await preserved(f), original);
  const returned = await post('/assets/' + f.asset.id + '/assignments/' + original.currentAssignments[0].id + '/return', {});
  assert.equal(returned.statusCode, 200, returned.body); assert.equal(returned.json().assignment.endedById, users.JEFE.id);
});

test('group history application retains terminal status and never reapplies historical return condition to the asset', async () => {
  const f = await prepare(); const retired = await post('/assets/' + f.asset.id + '/decommission'); assert.equal(retired.statusCode, 200, retired.body);
  const original = await preserved(f); const saved = await apply(f, await confirmation(f)); assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().application.items[0].assignment.returnStatus, 'UNDER_REVIEW');
  assert.equal(saved.json().application.assetSnapshot.status, 'DECOMMISSIONED');
  assert.equal((await get('/assets/' + f.asset.id + '/assignments')).json().currentAssignment, null);
  assert.deepEqual(await preserved(f), original);
});

test('independently proven exact instants persist while unknown source dates and historical actors remain unknown', async () => {
  const f = await prepare({ knownDay: false }); const original = await preserved(f);
  const saved = await apply(f, await confirmation(f)); assert.equal(saved.statusCode, 201, saved.body);
  const application = saved.json().application; const item = application.items[0];
  assert.equal(item.assignment.startedAt, '2001-01-01T12:00:00.000Z'); assert.equal(item.assignment.endedAt, '2002-01-01T13:00:00.000Z');
  assert.notEqual(item.assignment.startedAt, application.appliedAt); assert.notEqual(item.assignment.endedAt, application.appliedAt);
  assert.equal(item.assignment.createdById, null); assert.equal(item.assignment.endedById, null);
  for (const source of item.snapshot.sources) { assert.equal(source.effectiveDay, null); assert.equal(source.datePrecision, 'UNKNOWN'); }
  for (const link of application.plan.historyLinks) {
    assert.equal(link.projection.effectiveDay, null); assert.equal(link.projection.historicalActorId, null);
  }
  assert.deepEqual(await preserved(f), original);
});

test('group application retains pre-capture source corrections without changing its revision digest', async () => {
  const f = await prepare({ sourceCorrection: true }); const original = await preserved(f);
  assert.equal((await database.importSourceRevision.findMany({ where: { batchId: f.batch.id } })).length, 1);
  const saved = await apply(f, await confirmation(f)); assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().application.plan.periods[0].sources.every((source) => source.sourceRevision === 1), true);
  assert.deepEqual(await preserved(f), original);
});

test('every accepted minute, second, fractional and compact-offset timestamp format applies consistently with planning', async () => {
  for (const [start, end] of [
    ['2001-01-01T09:00-03:00', '2002-01-01T10:00Z'],
    ['2001-01-01T09:00-0300', '2002-01-01T10:00:00-0300'],
    ['2001-01-01T09:00:00.123Z', '2002-01-01T10:00:00.1-0300']
  ]) {
    const f = await prepare(); const input = clone(f.input);
    input.plan.periods[0].start.confirmedAt = start; input.plan.periods[0].end.confirmedAt = end;
    const saved = await apply(f, await confirmation(f, input)); assert.equal(saved.statusCode, 201, saved.body);
    const assignment = saved.json().application.items[0].assignment;
    assert.equal(assignment.startedAt, new Date(start).toISOString()); assert.equal(assignment.endedAt, new Date(end).toISOString());
  }
});

test('same-key concurrent requests normalize link, period and acknowledgement order and recover before live revalidation', async () => {
  const f = await prepare({ periodCount: 2 }); const input = await confirmation(f); const reordered = clone(input);
  reordered.requestId = reordered.requestId.toUpperCase(); reordered.plan.links.reverse(); reordered.plan.plan.periods.reverse();
  for (const period of reordered.plan.plan.periods) period.acknowledgedWarnings.reverse();
  const results = await Promise.all([apply(f, input), apply(f, reordered)]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 201], results.map((response) => response.body).join('\n'));
  const application = results[0].json().application; assert.deepEqual(results[1].json().application, application);
  assert.equal(results.find((response) => response.statusCode === 200).json().reused, true);
  const released = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Release administrative reservation' });
  assert.equal(released.statusCode, 201, released.body);
  await database.asset.update({ where: { id: f.asset.id }, data: { serialNumber: 'CHANGED-' + randomUUID(), location: 'Later metadata' } });
  const custody = await post('/assets/' + f.asset.id + '/assignments', { personName: 'Later Custodian', effectiveAt: '2009-01-01T00:00:00Z' });
  assert.equal(custody.statusCode, 201, custody.body);
  const recovered = await apply(f, reordered); assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().reused, true); assert.deepEqual(recovered.json().application, application);
  assert.deepEqual((await get(receipts(f) + '/' + application.id)).json().application, application);
  assert.deepEqual(await stored(f), { applications: 1, items: 2, uses: 4, assignments: 2, audits: 3 });
});

test('request reuse binds the JEFE and every part of the confirmed intent', async () => {
  const f = await prepare(); const input = await confirmation(f); const saved = await apply(f, input); assert.equal(saved.statusCode, 201, saved.body);
  conflict(await post(f.url + '/apply', input, 'OTHER_JEFE'), 'IDEMPOTENCY_KEY_REUSED');
  const changes = [
    (value) => { value.planId = 'f'.repeat(64); },
    (value) => { value.plan.links[0].expectedEvidenceVersion++; },
    (value) => { value.plan.plan.periods[0].note = 'Different intended history'; },
    (value) => { value.plan.plan.periods[0].start.dateEvidenceReference = 'Different date proof'; }
  ];
  for (const change of changes) { const changed = clone(input); change(changed); conflict(await apply(f, changed), 'IDEMPOTENCY_KEY_REUSED'); }
  assert.deepEqual(await stored(f), { applications: 1, items: 1, uses: 2, assignments: 1, audits: 2 });
});

test('competing request keys cannot consume the same endpoints and V24 planning reports their permanent ownership', async () => {
  const f = await prepare(); const input = await confirmation(f);
  const results = await Promise.all([apply(f, input), apply(f, { ...input, requestId: randomUUID() })]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [201, 409], results.map((response) => response.body).join('\n'));
  conflict(results.find((response) => response.statusCode === 409), 'GROUP_ASSIGNMENT_EVIDENCE_ALREADY_APPLIED');
  conflict(await apply(f, { ...input, requestId: randomUUID() }), 'GROUP_ASSIGNMENT_EVIDENCE_ALREADY_APPLIED');
  const replanned = await post(f.url, input.plan); assert.equal(replanned.statusCode, 200, replanned.body);
  assert.equal(replanned.json().planValidationComplete, false);
  assert.ok(replanned.json().periods[0].blockers.some((blocker) => blocker.code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED'));
  assert.equal(replanned.json().historyLinks.every((link) => link.groupAssignmentUse), true);
  assert.deepEqual(await stored(f), { applications: 1, items: 1, uses: 2, assignments: 1, audits: 2 });
});

test('stale plan fingerprints, changed current context and unresolved business blockers reject writes', async () => {
  const f = await prepare(); const input = await confirmation(f);
  conflict(await apply(f, { ...input, planId: 'f'.repeat(64) }), 'GROUP_ASSIGNMENT_PLAN_CHANGED');
  const incomplete = clone(input.plan); incomplete.plan.periods[0].recipient = null;
  conflict(await apply(f, await confirmation(f, incomplete, randomUUID(), false)), 'GROUP_ASSIGNMENT_PLAN_BLOCKED');
  const missingProof = clone(input.plan); missingProof.plan.periods[0].start.dateEvidenceReference = null;
  conflict(await apply(f, await confirmation(f, missingProof, randomUUID(), false)), 'GROUP_ASSIGNMENT_PLAN_BLOCKED');
  await database.asset.update({ where: { id: f.asset.id }, data: { location: 'Changed after planning' } });
  conflict(await apply(f, input), 'GROUP_ASSIGNMENT_PLAN_CHANGED');
  const refreshed = await confirmation(f, input.plan, input.requestId);
  const delivered = await post('/assets/' + f.asset.id + '/assignments', { personName: 'New Custodian', effectiveAt: '2005-01-01T00:00:00Z' });
  assert.equal(delivered.statusCode, 201, delivered.body);
  conflict(await apply(f, refreshed), 'GROUP_ASSIGNMENT_PLAN_CHANGED');
  const original = await preserved(f); const overlapping = clone(input.plan); overlapping.plan.periods[0].end.confirmedAt = '2006-01-01T00:00:00Z';
  conflict(await apply(f, await confirmation(f, overlapping, randomUUID(), false)), 'GROUP_ASSIGNMENT_PLAN_BLOCKED');
  assert.deepEqual(await stored(f), emptyStorage); assert.deepEqual(await preserved(f), original);
});

test('V21 fingerprints, saved-link and evidence versions plus whole receipt proofs retain their specific errors', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await preserved(f);
  for (const [field, value, code] of [
    ['expectedApplicationPlanId', 'f'.repeat(64), 'IDENTITY_GROUP_APPLICATION_CHANGED'],
    ['expectedLinkVersion', 2, 'GROUP_HISTORY_LINK_VERSION_CONFLICT'], ['expectedEvidenceVersion', 1, 'EVIDENCE_VERSION_CONFLICT']
  ]) {
    const changed = clone(input);
    if (field === 'expectedApplicationPlanId') changed.plan[field] = value; else changed.plan.links[0][field] = value;
    conflict(await apply(f, changed), code);
  }
  for (const mutate of [
    (receipts) => { receipts[0].requestDigest = 'f'.repeat(64); },
    (receipts) => { receipts[0].links[0].projection.effective.serialKey = 'FORGED-IDENTITY'; },
    (receipts) => { receipts[0].links.pop(); }
  ]) {
    const altered = transformReads('importGroupHistoryApplication', (values) => { mutate(values); return values; });
    await assert.rejects(execute(altered, f, input), (error) => error.statusCode === 409 && error.code === 'INVALID_GROUP_HISTORY_APPLICATION');
  }
  const altered = transformReads('importIdentityGroupApplication', (value) => { value.requestDigest = 'e'.repeat(64); return value; });
  await assert.rejects(execute(altered, f, input), (error) => error.statusCode === 409 && error.code === 'INVALID_IDENTITY_GROUP_APPLICATION');
  assert.deepEqual(await stored(f), emptyStorage); assert.deepEqual(await preserved(f), original);
});

test('administrative cancellation preserves V25 consumption, receipts and legacy reader exclusions', async () => {
  const f = await prepare(); const input = await confirmation(f);
  const released = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Release only the administrative reservation' });
  assert.equal(released.statusCode, 201, released.body); const original = await preserved(f);
  assert.equal(original.review.rows.every((row) => !row.isReserved), true); assert.equal(original.rowUses.length, 2);
  const saved = await apply(f, input); assert.equal(saved.statusCode, 201, saved.body);
  const legacy = '/assets/' + f.asset.id + '/imported-assignment-plan';
  conflict(await post(legacy, input.plan.plan), 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  conflict(await post(legacy + '/apply', { requestId: randomUUID(), planId: input.planId,
    confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: input.plan.plan }), 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  const retry = await apply(f, input); assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json().application, saved.json().application);
  assert.deepEqual(await preserved(f), original);
});

test('later assignment, item, evidence-use or audit failures roll back all periods and leave the request key reusable', async () => {
  for (const failure of ['assignment', 'importGroupAssignmentItem', 'importGroupAssignmentEvidenceUse', 'auditLog']) {
    const f = await prepare({ periodCount: 2 }); const input = await confirmation(f); const original = await preserved(f); let writes = 0;
    const failing = database.$extends({ query: { [failure]: { async $allOperations({ operation, args, query }) {
      const write = ['create', 'createMany'].includes(operation);
      const target = failure !== 'auditLog' || args.data.action === 'IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED';
      if (write && target && ++writes === (failure === 'auditLog' ? 1 : 2)) throw new Error('Injected later grouped history failure');
      return query(args);
    } } } });
    await assert.rejects(execute(failing, f, input), /Injected later grouped history failure/);
    assert.deepEqual(await stored(f), emptyStorage, failure); assert.deepEqual(await preserved(f), original, failure);
    const recovered = await apply(f, input); assert.equal(recovered.statusCode, 201, recovered.body); assert.equal(recovered.json().reused, false);
    assert.deepEqual(await stored(f), { applications: 1, items: 2, uses: 4, assignments: 2, audits: 3 });
  }
});

test('SQL guards reject orphan history, incomplete receipts, forged proposals and missing endpoint or audit coverage', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await preserved(f);
  await assert.rejects(database.assignment.create({ data: { assetId: f.asset.id, recipientType: 'OFFICE', officeName: 'Orphan historical office',
    importedHistory: true, createdById: null, endedById: null, startedAt: new Date('1901-01-01'), endedAt: new Date('1902-01-01'),
    returnStatus: 'AVAILABLE', returnRecordedAt: new Date() } }), /receipt|origin/i);
  const planned = (await post(f.url, input.plan)).json();
  const [snapshots] = await database.$queryRaw`SELECT to_jsonb(a) AS "assetSnapshot", '[]'::jsonb AS "custodySnapshot" FROM "Asset" a WHERE a."id" = ${f.asset.id}::uuid`;
  const data = { itemId: f.item.id, assetId: f.asset.id, requestId: input.requestId,
    requestDigest: groupClosedAssignmentApplyDigest(groupClosedAssignmentApplySchema.parse(input)), planId: input.planId,
    rulesVersion: 'mda-group-closed-assignment-application-1', plan: planned, ...snapshots, appliedById: users.JEFE.id };
  await assert.rejects(database.$transaction((tx) => tx.importGroupAssignmentApplication.create({ data })), /period|receipt|item/i);
  await assert.rejects(database.$transaction((tx) => tx.importGroupAssignmentApplication.create({ data: { ...data, appliedById: users.SOPORTE.id } })), /JEFE/i);
  await assert.rejects(database.$transaction((tx) => tx.importGroupAssignmentApplication.create({ data }), { isolationLevel: 'RepeatableRead' }), /READ COMMITTED/i);
  const forged = database.$extends({ query: { assignment: { async create({ args, query }) {
    return query({ ...args, data: { ...args.data, notes: 'Forged historical note' } });
  } } } });
  const wrongEndpoints = database.$extends({ query: { importGroupAssignmentEvidenceUse: { async createMany({ args, query }) {
    return query({ ...args, data: args.data.map((use) => ({ ...use, endpoint: use.endpoint === 'START' ? 'END' : 'START' })) });
  } } } });
  const missingEndpoint = database.$extends({ query: { importGroupAssignmentEvidenceUse: { async createMany({ args, query }) {
    return query({ ...args, data: args.data.slice(0, 1) });
  } } } });
  const forgedTransaction = database.$extends({ query: { importGroupAssignmentApplication: { async create({ args, query }) {
    return query({ ...args, data: { ...args.data, createdTransactionId: '0' } });
  } } } });
  await assert.rejects(execute(forgedTransaction, f, input), /creating transaction/i);
  for (const client of [forged, wrongEndpoints, missingEndpoint]) {
    await assert.rejects(execute(client, f, input), /histor|receipt|period|assignment|endpoint|snapshot|proposal/i);
    assert.deepEqual(await stored(f), emptyStorage); assert.deepEqual(await preserved(f), original);
  }
  for (const action of auditActions) {
    const unaudited = database.$extends({ query: { auditLog: { async create({ args, query }) {
      return args.data.action === action ? { id: randomUUID(), ...args.data } : query(args);
    } } } });
    await assert.rejects(execute(unaudited, f, input), /audit/i);
    assert.deepEqual(await stored(f), emptyStorage); assert.deepEqual(await preserved(f), original);
  }
  assert.equal((await apply(f, input)).statusCode, 201);
});

test('SQL guards freeze every receipt layer and raw assignment and reject current-state changes in the application transaction', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await preserved(f);
  for (const mutate of [
    (tx) => tx.asset.update({ where: { id: f.asset.id }, data: { location: 'Changed within import transaction' } }),
    (tx) => tx.assignment.create({ data: { assetId: f.asset.id, personName: 'Injected Current Custodian', createdById: users.JEFE.id,
      startedAt: new Date('2005-01-01T00:00:00Z') } })
  ]) {
    for (const immediate of [false, true]) {
      await assert.rejects(execute(transactionAfter(async (tx) => {
        if (immediate) await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await mutate(tx);
      }), f, input), /asset|custody|current|construct|snapshot/i);
      assert.deepEqual(await stored(f), emptyStorage); assert.deepEqual(await preserved(f), original);
    }
  }
  const saved = await apply(f, input); assert.equal(saved.statusCode, 201, saved.body);
  const application = saved.json().application; const item = application.items[0]; const use = item.evidenceUses[0];
  const raw = await database.assignment.findUniqueOrThrow({ where: { id: item.assignmentId } });
  for (const operation of [
    () => database.importGroupAssignmentApplication.update({ where: { id: application.id }, data: { planId: 'f'.repeat(64) } }),
    () => database.importGroupAssignmentApplication.delete({ where: { id: application.id } }),
    () => database.importGroupAssignmentItem.update({ where: { id: item.id }, data: { snapshot: {} } }),
    () => database.importGroupAssignmentItem.delete({ where: { id: item.id } }),
    () => database.importGroupAssignmentEvidenceUse.update({ where: { evidenceId: use.evidenceId }, data: { endpoint: use.endpoint } }),
    () => database.importGroupAssignmentEvidenceUse.delete({ where: { evidenceId: use.evidenceId } }),
    () => database.assignment.update({ where: { id: item.assignmentId }, data: { officeName: 'Forged office' } }),
    () => database.assignment.update({ where: { id: item.assignmentId }, data: { returnStatus: 'AVAILABLE' } }),
    () => database.assignment.delete({ where: { id: item.assignmentId } })
  ]) await assert.rejects(operation(), /immutable|closed assignment|imported.*histor/i);
  assert.deepEqual(await database.assignment.findUniqueOrThrow({ where: { id: item.assignmentId } }), raw);
  assert.deepEqual((await get(receipts(f) + '/' + application.id)).json().application, application);
  assert.deepEqual(await preserved(f), original);
});

test('transaction custody guards survive released savepoints and leave no marker after savepoint rollback', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await preserved(f);
  await assert.rejects(execute(transactionAfter(async (tx) => {
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT group_history_receipt');
    await tx.asset.update({ where: { id: f.asset.id }, data: { location: 'After released savepoint' } });
  }, {}, (tx) => tx.$executeRawUnsafe('SAVEPOINT group_history_receipt')), f, input), /current asset/i);
  assert.deepEqual(await stored(f), emptyStorage); assert.deepEqual(await preserved(f), original);
  await execute(transactionAfter(async (tx) => {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT group_history_receipt');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT group_history_receipt');
    await tx.asset.update({ where: { id: f.asset.id }, data: { location: 'Legitimate after rolled-back receipt' } });
  }, {}, (tx) => tx.$executeRawUnsafe('SAVEPOINT group_history_receipt')), f, input);
  assert.deepEqual(await stored(f), emptyStorage);
  assert.equal((await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } })).location, 'Legitimate after rolled-back receipt');
  assert.equal((await apply(f, await confirmation(f, input.plan, input.requestId))).statusCode, 201);
});

test('a later legacy receipt cannot add a second origin to an already committed grouped assignment', async () => {
  const f = await prepare(); const saved = await apply(f, await confirmation(f)); assert.equal(saved.statusCode, 201, saved.body);
  const grouped = saved.json().application; const assignment = grouped.items[0].assignment; const original = await preserved(f);
  const source = workbook('Recepción', [
    receptionRow(4, f.asset.serialNumber, { M: dateCell('2001-01-01'), N: textCell('OUT-2001'), O: textCell('OT-OUT-2001') }),
    receptionRow(5, f.asset.serialNumber, { A: dateCell('2002-01-01'), H: textCell('IN-2002'), B: textCell('OT-IN-2002') })
  ]); source.source.sha256 = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const preview = (await post('/inventory/imports/preview', source)).json();
  const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
  const base = '/inventory/imports/batches/' + staged.json().batch.id;
  const decision = await post(base + '/decisions', { requestId: randomUUID(), expectedVersion: 1, expectedSourceRevision: 0,
    targetType: 'CANDIDATE', targetId: preview.candidates[0].id, action: 'LINK_EXISTING', linkedAssetId: f.asset.id, note: 'Independent physical source' });
  assert.equal(decision.statusCode, 201, decision.body);
  const history = (await get(base + '/history-preview')).json();
  const captured = await post(base + '/history-captures', { requestId: randomUUID(), expectedVersion: 2, expectedSourceRevision: 0,
    historyPreviewId: history.historyPreviewId, confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Independent archival endpoints',
    evidenceReference: 'Other source documents', records: history.observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: f.asset.id })) });
  assert.equal(captured.statusCode, 201, captured.body);
  const endpoints = captured.json().capture.items;
  const period = { ...clone(f.input.plan.periods[0]), periodId: randomUUID(), start: { ...f.input.plan.periods[0].start,
    evidenceId: endpoints.find((entry) => entry.kind === 'USAGE_OBSERVATION').id }, end: { ...f.input.plan.periods[0].end,
    evidenceId: endpoints.find((entry) => entry.kind === 'RECEIPT_OBSERVATION').id } };
  const planned = await post('/assets/' + f.asset.id + '/imported-assignment-plan', { periods: [period] }); assert.equal(planned.statusCode, 200, planned.body);
  const plan = planned.json(); plan.planValidationComplete = true; plan.periods[0].valid = true; plan.periods[0].blockers = [];
  await assert.rejects(database.$transaction(async (tx) => {
    const legacy = await tx.importAssignmentApplication.create({ data: { assetId: f.asset.id, requestId: randomUUID(), requestDigest: 'a'.repeat(64),
      planId: plan.planId, rulesVersion: plan.planRulesVersion, plan, appliedById: users.JEFE.id, appliedAt: new Date(grouped.appliedAt) } });
    await tx.importAssignmentItem.create({ data: { applicationId: legacy.id, periodId: period.periodId, assignmentId: assignment.id,
      startEvidenceId: period.start.evidenceId, endEvidenceId: period.end.evidenceId, snapshot: plan.periods[0] } });
  }), /two origin receipts/i);
  assert.equal(await database.importAssignmentItem.count({ where: { assignmentId: assignment.id } }), 0);
  assert.deepEqual(await preserved(f), original);
});

test('busy inventory locks return a recoverable conflict without partial writes and the same request succeeds after release', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await preserved(f);
  let entered; const ready = new Promise((resolve) => { entered = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const holder = database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "Asset" IN ROW EXCLUSIVE MODE'); entered(); await gate;
  }, { timeout: 10000 });
  await ready;
  try {
    conflict(await apply(f, input), 'GROUP_ASSIGNMENT_APPLY_BUSY');
    assert.deepEqual(await stored(f), emptyStorage); assert.deepEqual(await preserved(f), original);
  } finally { release(); await holder; }
  const recovered = await apply(f, input); assert.equal(recovered.statusCode, 201, recovered.body); assert.equal(recovered.json().reused, false);
});

test('missing V25 storage returns deployment 503 and a uniqueness race returns its dedicated conflict, both before any write survives', async () => {
  const f = await prepare(); const input = await confirmation(f); const original = await preserved(f);
  const missing = database.$extends({ query: { importGroupAssignmentApplication: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing grouped historical application storage', { code: 'P2021',
      clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportGroupAssignmentApplication' } });
  } } } });
  const instance = buildApp(missing);
  try {
    const response = await apply(f, input, instance); assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
  } finally { await instance.close(); }
  const conflictClient = database.$extends({ query: { importGroupAssignmentItem: { async create() {
    throw new Prisma.PrismaClientKnownRequestError('Concurrent grouped history ownership', { code: 'P2002',
      clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportGroupAssignmentItem', target: ['assignmentId'] } });
  } } } });
  await assert.rejects(execute(conflictClient, f, input), (error) => error.statusCode === 409 && error.code === 'GROUP_ASSIGNMENT_APPLICATION_CONFLICT');
  assert.deepEqual(await stored(f), emptyStorage); assert.deepEqual(await preserved(f), original);
  assert.equal((await apply(f, input)).statusCode, 201);
});

after(async () => { await app.close(); });
