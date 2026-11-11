import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { groupClosedAssignmentPlanSchema } from '../src/imports/group-assignment-plan-schemas.js';
import { planGroupClosedAssignments } from '../src/imports/group-assignment-plan-service.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { hashPassword } from '../src/lib/password.js';
import { groupClosedAssignmentFixture } from './fixtures/group-closed-assignment.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'groupclosed-' + role.toLowerCase() + '-' + suffix; const password = 'Group-closed-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group closed ' + role, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200, login.body);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group closed ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url) { return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } }); }
function prepare(options = {}) { return groupClosedAssignmentFixture({ database, product, post, get, ...options }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function codes(response) {
  assert.equal(response.statusCode, 200, response.body);
  return response.json().periods.flatMap((period) => period.blockers.map((blocker) => blocker.code));
}
function conflict(response, code) { assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, code, response.body); }
async function confirmed(f, input = f.input) {
  const first = await post(f.url, input); assert.equal(first.statusCode, 200, first.body);
  const acknowledged = { ...input, plan: { periods: input.plan.periods.map((period) => ({ ...period,
    acknowledgedWarnings: first.json().periods.find((entry) => entry.periodId === period.periodId).warnings.map((warning) => warning.id) })) } };
  const response = await post(f.url, acknowledged); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().planValidationComplete, true, response.body);
  return { input: acknowledged, plan: response.json() };
}
function read(client, f, input = f.input) {
  return planGroupClosedAssignments(client, f.batch.id, f.review.id, f.application.id, f.item.id, groupClosedAssignmentPlanSchema.parse(input));
}
function altered(model, transform) {
  return database.$extends({ query: { [model]: { async $allOperations({ operation, args, query }) {
    const result = await query(args);
    return operation.startsWith('find') && result !== null ? transform(clone(result)) : result;
  } } } });
}
async function snapshot(f) {
  const evidenceIds = f.evidence.map((entry) => entry.id);
  return {
    asset: await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }),
    product: await database.product.findUniqueOrThrow({ where: { id: product.id } }),
    assignments: await database.assignment.findMany({ where: { assetId: f.asset.id }, orderBy: { id: 'asc' } }),
    assignmentApplications: await database.importAssignmentApplication.findMany({ where: { assetId: f.asset.id }, include: { items: true }, orderBy: { id: 'asc' } }),
    retirementApplications: await database.importRetirementApplication.findMany({ where: { assetId: f.asset.id }, orderBy: { id: 'asc' } }),
    evidenceUses: await database.importAssignmentEvidenceUse.findMany({ where: { evidenceId: { in: evidenceIds } }, orderBy: { evidenceId: 'asc' } }),
    capture: await database.importHistoryCapture.findUniqueOrThrow({ where: { id: f.capture.id }, include: { items: { orderBy: { id: 'asc' } } } }),
    current: await database.$queryRaw`SELECT * FROM "ImportHistoricalEvidenceCurrent" WHERE "sourceHash" = ${f.source.source.sha256} ORDER BY "id"`,
    amendments: await database.importEvidenceAmendment.findMany({ where: { evidenceId: { in: evidenceIds } }, orderBy: { id: 'asc' } }),
    batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }),
    sourceRevisions: await database.importSourceRevision.findMany({ where: { batchId: f.batch.id }, orderBy: { revision: 'asc' } }),
    review: await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { release: true,
      rows: { orderBy: { recordId: 'asc' } }, decisions: { orderBy: { version: 'asc' } } } }),
    application: await database.importIdentityGroupApplication.findUniqueOrThrow({ where: { id: f.application.id }, include: {
      items: { orderBy: { id: 'asc' }, include: { rows: { orderBy: { recordId: 'asc' } } } } } }),
    history: await database.importGroupHistoryApplication.findMany({ where: { itemId: f.item.id }, orderBy: { id: 'asc' }, include: { links: { orderBy: { evidenceId: 'asc' } } } }),
    rowUses: await database.importIdentityGroupRowUse.findMany({ where: { itemId: f.item.id }, orderBy: { recordId: 'asc' } }),
    stocks: await database.inventoryStock.findMany({ where: { productId: product.id }, orderBy: { id: 'asc' } }),
    movements: await database.inventoryMovement.findMany({ where: { productId: product.id }, orderBy: { id: 'asc' } }),
    users: await database.user.findMany({ where: { id: { in: Object.values(users).map((user) => user.id) } }, orderBy: { id: 'asc' } }),
    audits: await database.auditLog.findMany({ where: { userId: { in: Object.values(users).map((user) => user.id) } }, orderBy: { id: 'asc' } })
  };
}

test('group closed planning requires JEFE and CSRF, strict DTO and exact distinct endpoint pins, and applying requires its explicit DTO', async () => {
  const f = await prepare();
  assert.equal((await app.inject({ method: 'POST', url: f.url, payload: f.input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(f.url, f.input, role)).statusCode, 403);
  assert.equal((await post(f.url, f.input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(f.url + '?force=true', f.input)).statusCode, 400);
  assert.equal((await post(f.url + '/apply', f.input)).statusCode, 400);
  const period = f.input.plan.periods[0]; const pin = f.input.links[0];
  const invalid = [
    { ...f.input, force: true }, { ...f.input, canApply: true }, { ...f.input, expectedApplicationPlanId: 'bad' },
    { ...f.input, plan: { ...f.input.plan, assetId: f.asset.id } },
    { ...f.input, plan: { periods: [{ ...period, start: { ...period.start, assetId: f.asset.id } }] } },
    { ...f.input, links: [pin] }, { ...f.input, links: [pin, pin] }, { ...f.input, links: Array(51).fill(pin) },
    { ...f.input, links: [{ ...pin, evidenceId: randomUUID() }, f.input.links[1]] },
    { ...f.input, links: [{ ...pin, version: 1 }, f.input.links[1]] },
    ...[-1, 1001, 0.5].map((expectedEvidenceVersion) => ({ ...f.input, links: [{ ...pin, expectedEvidenceVersion }, f.input.links[1]] })),
    { ...f.input, links: [{ ...pin, expectedLinkVersion: 0 }, f.input.links[1]] }
  ];
  for (const input of invalid) assert.equal((await post(f.url, input)).statusCode, 400);
  const uppercase = { ...f.input, links: f.input.links.map((link) => ({ ...link, evidenceId: link.evidenceId.toUpperCase(), linkId: link.linkId.toUpperCase() })),
    plan: { periods: [{ ...period, periodId: period.periodId.toUpperCase(), start: { ...period.start, evidenceId: period.start.evidenceId.toUpperCase() },
      end: { ...period.end, evidenceId: period.end.evidenceId.toUpperCase() } }] } };
  assert.deepEqual(groupClosedAssignmentPlanSchema.parse(uppercase), groupClosedAssignmentPlanSchema.parse(f.input));
  const canonical = await post(f.url, f.input); const normalized = await post(f.url, uppercase);
  assert.equal(canonical.statusCode, 200, canonical.body); assert.equal(normalized.statusCode, 200, normalized.body);
  assert.equal(normalized.json().planId, canonical.json().planId);
});

test('group closed plan is deterministic, preserves complete provenance and leaves all archive, operational and audit state unchanged', async () => {
  const f = await prepare({ extraEvidence: true }); const beforeState = await snapshot(f);
  const first = await post(f.url, f.input); assert.equal(first.statusCode, 200, first.body);
  if (first.json().periods[0].warnings.length > 0) assert.ok(codes(first).includes('WARNINGS_NOT_ACKNOWLEDGED'));
  const { input, plan } = await confirmed(f);
  assert.equal(plan.scope, 'GROUP_CLOSED_ASSIGNMENT_HISTORY_PLAN'); assert.equal(plan.rulesVersion, 'mda-group-closed-assignment-plan-1');
  for (const flag of ['persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'operationalHistoryApplied', 'closedAssignmentApplicationImplemented']) assert.equal(plan[flag], false, flag);
  assert.match(plan.planId, /^[a-f0-9]{64}$/); assert.notEqual(plan.planId, f.application.planId); assert.notEqual(plan.planId, f.historyApplication.planId);
  const envelope = new Set(['planId', 'persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'operationalHistoryApplied',
    'closedAssignmentApplicationImplemented', 'planValidationComplete', 'summary']);
  assert.equal(plan.planId, importPlanDigest(Object.fromEntries(Object.entries(plan).filter(([key]) => !envelope.has(key)))));
  assert.equal(plan.summary.selectedEndpointCount, 2); assert.equal(plan.summary.omittedLinkCount, 1); assert.equal(plan.summary.unlinkedEvidenceCount, 1);
  assert.equal(plan.summary.periodCount, 1); assert.equal(plan.summary.validCount, 1); assert.equal(plan.summary.blockingCount, 0);
  assert.equal(plan.historyLinks.length, 2); assert.equal(plan.unselectedHistoryLinks.length, 1); assert.equal(plan.unlinkedEvidence.length, 1);
  const proposed = plan.periods[0].proposedAssignment;
  assert.equal(proposed.assetId, f.asset.id); assert.equal(proposed.assignedById, null); assert.equal(proposed.returnedById, null);
  assert.equal(proposed.startedAt, '2001-01-01T12:00:00.000Z'); assert.equal(proposed.endedAt, '2002-01-01T13:00:00.000Z');
  assert.equal(proposed.ticketReference, 'OUT-2001'); assert.equal(proposed.returnTicketReference, 'IN-2002');
  for (const source of plan.periods[0].sources) {
    const link = f.historyApplication.links.find((entry) => entry.evidenceId === source.evidenceId);
    const archival = f.evidence.find((entry) => entry.id === source.evidenceId);
    assert.equal(source.groupHistoryLinkId, link.id); assert.equal(source.groupHistoryLinkVersion, 1);
    assert.equal(source.historyApplicationId, f.historyApplication.id); assert.equal(source.historyLinkPlanId, f.historyApplication.planId);
    const selected = plan.historyLinks.find((entry) => entry.id === link.id);
    assert.deepEqual(selected.projection, link.projection); assert.deepEqual(selected.operation, link.operation);
    assert.deepEqual(selected.currentSnapshot, archival.snapshot); assert.deepEqual(selected.projection.original, archival.snapshot.original);
    assert.equal(selected.currentAssetId, null); assert.equal(selected.capturedAssetId, null);
    assert.equal(selected.projection.effective.serialKey, f.asset.serialNumber);
    assert.notEqual(selected.currentSnapshot.effective.serialKey, selected.projection.effective.serialKey);
    assert.equal(source.fields.serialNumber, f.asset.serialNumber);
  }
  assert.equal(plan.unselectedHistoryLinks[0].projection, undefined); assert.equal(plan.unlinkedEvidence[0].snapshot, undefined);
  const retry = await post(f.url, { ...input, links: [...input.links].reverse() }); assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().planId, plan.planId); assert.deepEqual(await snapshot(f), beforeState);
});

test('group historical planning retains live custody and terminal state while enforcing operational overlap and terminal dates', async () => {
  const assigned = await prepare();
  const delivery = await post('/assets/' + assigned.asset.id + '/assignments', { personName: 'Current Custodian', effectiveAt: '2005-01-01T00:00:00Z' });
  assert.equal(delivery.statusCode, 201, delivery.body);
  const assignedBefore = await snapshot(assigned); const historical = await confirmed(assigned);
  assert.equal(historical.plan.assetBefore.status, 'ASSIGNED');
  const period = historical.input.plan.periods[0];
  const overlap = await post(assigned.url, { ...historical.input, plan: { periods: [{ ...period,
    end: { ...period.end, confirmedAt: '2006-01-01T00:00:00Z' } }] } });
  assert.ok(codes(overlap).includes('OPERATIONAL_ASSIGNMENT_OVERLAP')); assert.equal(overlap.json().planValidationComplete, false);
  assert.deepEqual(await snapshot(assigned), assignedBefore);
  const terminal = await prepare(); const retired = await post('/assets/' + terminal.asset.id + '/decommission'); assert.equal(retired.statusCode, 200, retired.body);
  const terminalBefore = await snapshot(terminal); const planned = await confirmed(terminal);
  assert.equal(planned.plan.assetBefore.status, 'DECOMMISSIONED'); assert.equal(planned.plan.assetBefore.isActive, false);
  const terminalPeriod = planned.input.plan.periods[0]; const afterRetirement = new Date(terminalBefore.asset.decommissionedAt.getTime() + 1000).toISOString();
  const late = await post(terminal.url, { ...planned.input, plan: { periods: [{ ...terminalPeriod, end: { ...terminalPeriod.end, confirmedAt: afterRetirement } }] } });
  assert.ok(codes(late).includes('HISTORICAL_PERIOD_AFTER_DECOMMISSION')); assert.deepEqual(await snapshot(terminal), terminalBefore);
});

test('unknown source days remain unknown and missing exact dates or proof, invalid order and source day mismatch block periods', async () => {
  const f = await prepare({ knownDay: false }); const period = f.input.plan.periods[0];
  const missing = await post(f.url, { ...f.input, plan: { periods: [{ ...period, start: { evidenceId: period.start.evidenceId }, end: { evidenceId: period.end.evidenceId } }] } });
  assert.ok(codes(missing).includes('EXACT_DATE_REQUIRED')); assert.ok(codes(missing).includes('EXACT_DATE_PROOF_REQUIRED'));
  assert.equal(missing.json().planValidationComplete, false);
  const { input, plan } = await confirmed(f);
  assert.ok(plan.periods[0].sources.every((source) => source.effectiveDay === null && source.datePrecision === 'UNKNOWN'));
  assert.ok(plan.historyLinks.every((link) => link.projection.effectiveDay === null && link.projection.historicalActorId === null));
  const reversed = await post(f.url, { ...input, plan: { periods: [{ ...input.plan.periods[0], end: { ...period.end, confirmedAt: '2000-01-01T00:00:00Z' } }] } });
  assert.ok(codes(reversed).includes('HISTORICAL_PERIOD_ORDER_INVALID'));
  const dated = await prepare(); const mismatch = await post(dated.url, { ...dated.input, plan: { periods: [{ ...dated.input.plan.periods[0],
    start: { ...dated.input.plan.periods[0].start, confirmedAt: '2001-01-02T00:00:00Z' } }] } });
  assert.ok(codes(mismatch).includes('SOURCE_DAY_MISMATCH'));
});

test('separate historical periods reject proposed overlap and new persisted history changes the plan hash', async () => {
  const f = await prepare({ periodCount: 2, knownDay: false }); const { input, plan } = await confirmed(f);
  const overlapping = clone(input); overlapping.plan.periods[1].start.confirmedAt = '2001-06-01T00:00:00Z';
  const proposal = await post(f.url, overlapping); assert.ok(codes(proposal).includes('PROPOSED_PERIOD_OVERLAP'));
  assert.equal(proposal.json().periods.every((period) => period.blockers.some((blocker) => blocker.code === 'PROPOSED_PERIOD_OVERLAP')), true);
  await database.assignment.create({ data: { assetId: f.asset.id, recipientType: 'OFFICE', officeName: 'Prior office',
    startedAt: new Date('2000-01-01'), endedAt: new Date('2002-06-01'), returnStatus: 'AVAILABLE', createdById: users.JEFE.id, endedById: users.JEFE.id } });
  const beforeState = await snapshot(f); const changed = await post(f.url, input);
  assert.ok(codes(changed).includes('OPERATIONAL_ASSIGNMENT_OVERLAP')); assert.notEqual(changed.json().planId, plan.planId);
  assert.deepEqual(await snapshot(f), beforeState);
});

test('every parent and selected link is scoped and foreign, unconfirmed or mismatched endpoint links return 404', async () => {
  const f = await prepare({ extraEvidence: true }); const foreign = await prepare();
  for (const id of [f.batch.id, f.review.id, f.application.id, f.item.id]) assert.equal((await post(f.url.replace(id, randomUUID()), f.input)).statusCode, 404);
  const foreignSelection = await post(f.url, { ...foreign.input, expectedApplicationPlanId: f.application.planId }); assert.equal(foreignSelection.statusCode, 404, foreignSelection.body);
  const nonexistent = clone(f.input); nonexistent.links[0].linkId = randomUUID();
  assert.equal((await post(f.url, nonexistent)).statusCode, 404);
  const swapped = clone(f.input); [swapped.links[0].linkId, swapped.links[1].linkId] = [swapped.links[1].linkId, swapped.links[0].linkId];
  assert.equal((await post(f.url, swapped)).statusCode, 404);
  const unlinked = f.evidence.find((entry) => !f.historyApplication.links.some((link) => link.evidenceId === entry.id));
  const unconfirmed = clone(f.input); const previousId = unconfirmed.links[0].evidenceId; unconfirmed.links[0].evidenceId = unlinked.id;
  for (const endpoint of ['start', 'end']) if (unconfirmed.plan.periods[0][endpoint].evidenceId === previousId) unconfirmed.plan.periods[0][endpoint].evidenceId = unlinked.id;
  assert.equal((await post(f.url, unconfirmed)).statusCode, 404);
});

test('V21 hash, saved link version and current evidence version are pinned with specific recoverable conflicts', async () => {
  const f = await prepare(); const beforeState = await snapshot(f);
  conflict(await post(f.url, { ...f.input, expectedApplicationPlanId: 'f'.repeat(64) }), 'IDENTITY_GROUP_APPLICATION_CHANGED');
  const wrongLinkVersion = clone(f.input); wrongLinkVersion.links[0].expectedLinkVersion = 2;
  conflict(await post(f.url, wrongLinkVersion), 'GROUP_HISTORY_LINK_VERSION_CONFLICT');
  const wrongEvidenceVersion = clone(f.input); wrongEvidenceVersion.links[0].expectedEvidenceVersion = 1;
  conflict(await post(f.url, wrongEvidenceVersion), 'EVIDENCE_VERSION_CONFLICT');
  assert.deepEqual(await snapshot(f), beforeState);
});

test('administrative cancellation preserves saved history and consumption and leaves both legacy assignment readers blocked', async () => {
  const f = await prepare(); const { input } = await confirmed(f);
  const released = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Release administrative reservation only' });
  assert.equal(released.statusCode, 201, released.body); const beforeState = await snapshot(f);
  assert.ok(beforeState.review.rows.every((row) => row.isReserved === false)); assert.equal(beforeState.rowUses.length, 2);
  const result = await post(f.url, input); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().planValidationComplete, true);
  const legacyUrl = '/assets/' + f.asset.id + '/imported-assignment-plan';
  conflict(await post(legacyUrl, input.plan), 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  conflict(await post(legacyUrl + '/apply', { requestId: randomUUID(), planId: result.json().planId,
    confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: input.plan }), 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  assert.deepEqual(await snapshot(f), beforeState);
});

test('whole V23 receipts and V21 ownership proofs reject corrupt digests, requests, projections and omitted membership without writes', async () => {
  const f = await prepare({ extraEvidence: true }); const beforeState = await snapshot(f);
  const corruptions = [
    (receipt) => { receipt.planId = 'f'.repeat(64); },
    (receipt) => { receipt.requestDigest = 'f'.repeat(64); },
    (receipt) => { receipt.requestId = randomUUID(); },
    (receipt) => { receipt.plan.operations[0].note = 'Tampered saved intent'; },
    (receipt) => { receipt.links.pop(); },
    (receipt) => { receipt.links.push(clone(receipt.links[0])); },
    (receipt) => { receipt.links[0].operation.note = 'Tampered link operation'; },
    (receipt) => { receipt.links[0].projection.effective.serialKey = 'UNRELATED-IDENTITY'; },
    (receipt) => { receipt.links.find((link) => !f.input.links.some((pin) => pin.linkId === link.id)).projection.assetId = randomUUID(); },
    (receipt) => { receipt.rulesVersion = 'unknown-history-rules'; }
  ];
  for (const corrupt of corruptions) {
    const extended = altered('importGroupHistoryApplication', (receipts) => { corrupt(receipts[0]); return receipts; });
    await assert.rejects(read(extended, f), (error) => error.statusCode === 409 && error.code === 'INVALID_GROUP_HISTORY_APPLICATION');
  }
  for (const corrupt of [
    (application) => { application.requestDigest = 'f'.repeat(64); },
    (application) => { application.items[0].rows.pop(); }
  ]) {
    const extended = altered('importIdentityGroupApplication', (application) => { corrupt(application); return application; });
    await assert.rejects(read(extended, f), (error) => error.statusCode === 409 && error.code === 'INVALID_IDENTITY_GROUP_APPLICATION');
  }
  assert.deepEqual(await snapshot(f), beforeState);
});

test('missing group history storage returns 503 and oversized evidence, receipts, revisions or assignments fail without truncation', async () => {
  const f = await prepare();
  const missing = database.$extends({ query: { importGroupHistoryApplication: { async findMany() {
    throw new Prisma.PrismaClientKnownRequestError('Missing group history storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client,
      meta: { modelName: 'ImportGroupHistoryApplication' } });
  } } } });
  const isolated = buildApp(missing);
  try {
    const response = await post(f.url, f.input, 'JEFE', true, isolated); assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
  } finally { await isolated.close(); }
  for (const [model, take] of [['importHistoricalEvidence', 101], ['importGroupHistoryApplication', 101], ['assignment', 10001], ['importSourceRevision', 1001]]) {
    const oversized = database.$extends({ query: { [model]: { async findMany({ args, query }) {
      assert.equal(args.take, take); const actual = await query(args); return Array.from({ length: take }, () => actual[0] ?? {});
    } } } });
    await assert.rejects(read(oversized, f), (error) => error.statusCode === 409 && error.code === 'GROUP_ASSIGNMENT_PLAN_LIMIT');
  }
});

test('current identity and archived evidence changes block planning and both legacy assignment and retirement evidence uses remain consumed', async () => {
  const f = await prepare(); const { input } = await confirmed(f);
  await database.asset.update({ where: { id: f.asset.id }, data: { serialNumber: 'CHANGED-' + randomUUID() } });
  const identity = await post(f.url, input); assert.ok(codes(identity).includes('GROUP_ASSET_IDENTITY_CHANGED'));
  await database.asset.update({ where: { id: f.asset.id }, data: { serialNumber: f.asset.serialNumber } });
  const beforeState = await snapshot(f);
  const changed = altered('importHistoricalEvidence', (entries) => entries.map((entry) => ({ ...entry,
    snapshot: { ...entry.snapshot, effective: { ...entry.snapshot.effective, fields: { ...entry.snapshot.effective.fields, incomingTicket: 'ALTERED-ARCHIVE' } } } })));
  const changedPlan = await read(changed, f, input); assert.equal(changedPlan.planValidationComplete, false);
  assert.ok(changedPlan.periods[0].blockers.some((blocker) => blocker.code === 'GROUP_HISTORY_EVIDENCE_CHANGED'));
  for (const use of ['assignmentUse', 'retirementUse']) {
    const used = altered('importHistoricalEvidence', (entries) => entries.map((entry) => ({ ...entry,
      [use]: use === 'assignmentUse' ? { itemId: randomUUID(), endpoint: 'START' } : { id: randomUUID(), assetId: f.asset.id } })));
    const result = await read(used, f, input); assert.equal(result.planValidationComplete, false);
    assert.ok(result.periods[0].blockers.some((blocker) => blocker.code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED'));
  }
  assert.deepEqual(await snapshot(f), beforeState);
});

test('group planning reads one repeatable snapshot while a concurrent committed assignment changes subsequent plans', async () => {
  const f = await prepare(); const { input, plan: baseline } = await confirmed(f); let updated = false;
  const concurrent = database.$extends({ query: { asset: { async findUnique({ args, query }) {
    const asset = await query(args);
    if (!updated && args.where.id === f.asset.id) {
      updated = true;
      await database.$transaction(async (transaction) => {
        await transaction.asset.update({ where: { id: f.asset.id }, data: { status: 'ASSIGNED' } });
        await transaction.assignment.create({ data: { assetId: f.asset.id, personName: 'Concurrent Custodian', startedAt: new Date('2001-06-01'), createdById: users.JEFE.id } });
      });
    }
    return asset;
  } } } });
  const during = await read(concurrent, f, input); assert.equal(updated, true); assert.equal(during.planValidationComplete, true);
  assert.equal(during.assetBefore.status, 'AVAILABLE'); assert.equal(during.planId, baseline.planId);
  const afterState = await snapshot(f); assert.equal(afterState.asset.status, 'ASSIGNED'); assert.equal(afterState.assignments.length, 1);
  const subsequent = await post(f.url, input); assert.ok(codes(subsequent).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
  assert.equal(subsequent.json().assetBefore.status, 'ASSIGNED'); assert.notEqual(subsequent.json().planId, during.planId);
  assert.deepEqual(await snapshot(f), afterState);
});

after(async () => { await app.close(); });
