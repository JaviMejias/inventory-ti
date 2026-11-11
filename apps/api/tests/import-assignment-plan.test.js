import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { closedAssignmentPlanSchema } from '../src/imports/assignment-plan-schemas.js';
import { planClosedAssignments } from '../src/imports/assignment-plan-service.js';
import { hashPassword } from '../src/lib/password.js';
import { dateCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8);
const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: {
  async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } }); }
} } });
const app = buildApp(database);
const cookies = {};
const users = {};
let product;

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `period-${role.toLowerCase()}-${suffix}`; const password = 'Period-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Period ${role}`, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(login.statusCode, 200); const header = login.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Period product ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role]; const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url) { return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } }); }
async function prepare({ unlinked = false, unknownDates = false, active = false, retired = false } = {}) {
  const asset = await database.$transaction(async (transaction) => {
    const created = await transaction.asset.create({ data: { productId: product.id, serialNumber: `PERIOD-${randomUUID()}`,
      ...(active ? { status: 'ASSIGNED' } : {}), ...(retired ? { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2005-01-01') } : {}) } });
    if (active) await transaction.assignment.create({ data: { assetId: created.id, personName: 'Current recipient', createdById: users.JEFE.id, startedAt: new Date('2005-01-01') } });
    return created;
  });
  const source = workbook('Recepción', [receptionRow(4, asset.serialNumber, { ...(unknownDates ? {} : { M: dateCell('2001-01-01') }), N: textCell('OUT-TK'), O: textCell('OUT-OT') }),
    receptionRow(5, asset.serialNumber, { ...(unknownDates ? {} : { A: dateCell('2002-01-01') }), H: textCell('IN-TK'), B: textCell('IN-OT') })]);
  source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json(); const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId });
  assert.equal(staged.statusCode, 201, staged.body); const batch = staged.json().batch; const base = `/inventory/imports/batches/${batch.id}`;
  const reviewed = await post(base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: preview.candidates[0].id, action: 'LINK_EXISTING', linkedAssetId: asset.id, note: 'Historical identity reviewed' });
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  const history = (await get(base + '/history-preview')).json();
  const captured = await post(base + '/history-captures', { expectedVersion: 2, expectedSourceRevision: 0, requestId: randomUUID(), historyPreviewId: history.historyPreviewId,
    confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Closed assignment source retained', evidenceReference: 'Receiving and dispatch documents',
    records: history.observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: unlinked ? null : asset.id })) });
  assert.equal(captured.statusCode, 201, captured.body); const capture = captured.json().capture;
  const start = capture.items.find((entry) => entry.kind === 'USAGE_OBSERVATION'); const end = capture.items.find((entry) => entry.kind === 'RECEIPT_OBSERVATION');
  const input = { periods: [{ periodId: randomUUID(), confirmation: 'VERIFIED_CLOSED_ASSIGNMENT',
    start: { evidenceId: start.id, confirmedAt: '2001-01-01T09:00:00-03:00', dateEvidenceReference: 'Delivery signed timestamp' },
    end: { evidenceId: end.id, confirmedAt: '2002-01-01T10:00:00-03:00', dateEvidenceReference: 'Return signed timestamp' },
    recipient: { type: 'OFFICE', name: 'Central office' }, assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW',
    note: 'Closed historical period confirmed separately from current custody', evidenceReference: 'Signed delivery and return records' }] };
  return { asset, source, batch, base, capture, start, end, input, url: `/assets/${asset.id}/imported-assignment-plan` };
}
const codes = (response) => response.json().periods.flatMap((period) => period.blockers.map((entry) => entry.code));

test('closed assignment plan requires JEFE and CSRF and rejects invented effects and missing resources', async () => {
  const { input, url } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url, { ...input, canApply: true })).statusCode, 400);
  assert.equal((await post(`/assets/${randomUUID()}/imported-assignment-plan`, input)).statusCode, 404);
  assert.equal((await post(url, { periods: [{ ...input.periods[0], start: { ...input.periods[0].start, evidenceId: randomUUID() } }] })).statusCode, 404);
  assert.equal((await post(url + '/apply', input)).statusCode, 400);
});

test('confirmed history planning is deterministic and leaves evidence, review, assets, assignments, users and audits unchanged', async () => {
  const { asset, batch, capture, input, url } = await prepare();
  const snapshot = async () => ({ asset: await database.asset.findUniqueOrThrow({ where: { id: asset.id } }),
    assignments: await database.assignment.findMany({ where: { assetId: asset.id }, orderBy: { id: 'asc' } }),
    capture: await database.importHistoryCapture.findUniqueOrThrow({ where: { id: capture.id }, include: { items: { orderBy: { id: 'asc' } } } }),
    batch: await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }),
    users: await database.user.findMany({ where: { id: { in: Object.values(users).map((user) => user.id) } }, orderBy: { id: 'asc' } }),
    auditCount: await database.auditLog.count({ where: { entityId: { in: [asset.id, batch.id, capture.id] } } }),
    movementCount: await database.inventoryMovement.count({ where: { assetId: asset.id } }) });
  const before = await snapshot(); const response = await post(url, input); assert.equal(response.statusCode, 200, response.body);
  const plan = response.json(); assert.equal(plan.planValidationComplete, true); assert.equal(plan.canApply, false); assert.equal(plan.persisted, false); assert.equal(plan.affectsCurrentState, false);
  assert.equal(plan.periods[0].proposedAssignment.assignedById, null); assert.equal(plan.periods[0].proposedAssignment.returnedById, null);
  assert.equal(plan.periods[0].proposedAssignment.returnTicketReference, 'IN-TK'); assert.equal(plan.periods[0].sources.length, 2);
  assert.equal((await post(url, input)).json().planId, plan.planId); assert.deepEqual(await snapshot(), before);
});

test('history earlier than a live assignment can be planned without closing or changing that assignment', async () => {
  const { asset, input, url } = await prepare({ active: true });
  const before = await database.assignment.findMany({ where: { assetId: asset.id } });
  const response = await post(url, input); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().planValidationComplete, true);
  assert.equal(response.json().assetBefore.status, 'ASSIGNED');
  assert.deepEqual(await database.assignment.findMany({ where: { assetId: asset.id } }), before);
  const overlap = await post(url, { periods: [{ ...input.periods[0], end: { ...input.periods[0].end, confirmedAt: '2006-01-01T00:00:00Z' } }] });
  assert.ok(codes(overlap).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
});

test('terminal assets retain their terminal state, and periods ending after decommission are blocked', async () => {
  const { asset, input, url } = await prepare({ retired: true });
  const response = await post(url, input); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().planValidationComplete, true);
  const late = await post(url, { periods: [{ ...input.periods[0], end: { ...input.periods[0].end, confirmedAt: '2005-01-02T00:00:00Z' } }] });
  assert.ok(codes(late).includes('HISTORICAL_PERIOD_AFTER_DECOMMISSION'));
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
});

test('unlinked and cross-asset evidence cannot acquire an assignment link through the planner', async () => {
  const unlinked = await prepare({ unlinked: true });
  const result = await post(unlinked.url, unlinked.input); assert.equal(result.statusCode, 200, result.body);
  assert.ok(codes(result).includes('EVIDENCE_ASSET_LINK_REQUIRED'));
  const other = await prepare();
  const mismatch = await post(other.url, unlinked.input); assert.ok(codes(mismatch).includes('EVIDENCE_ASSET_LINK_REQUIRED'));
  const linked = await prepare(); const crossed = await post(other.url, linked.input);
  assert.ok(codes(crossed).includes('EVIDENCE_ASSET_MISMATCH'));
});

test('unknown source days stay unknown unless exact instants are explicitly supplied with timestamp proof', async () => {
  const { input, url } = await prepare({ unknownDates: true });
  const period = input.periods[0]; const incomplete = await post(url, { periods: [{ ...period, start: { evidenceId: period.start.evidenceId }, end: { evidenceId: period.end.evidenceId } }] });
  assert.ok(codes(incomplete).includes('EXACT_DATE_REQUIRED')); assert.ok(codes(incomplete).includes('EXACT_DATE_PROOF_REQUIRED'));
  const confirmed = await post(url, input); assert.equal(confirmed.json().planValidationComplete, true);
  assert.equal(confirmed.json().periods[0].sources.every((entry) => entry.effectiveDay === null), true);
  assert.equal(confirmed.json().periods[0].proposedAssignment.startedAt, '2001-01-01T12:00:00.000Z');
});

test('new operational history changes the plan fingerprint and overlapping persisted history blocks the proposal', async () => {
  const { asset, input, url } = await prepare(); const baseline = (await post(url, input)).json();
  const created = await post(`/assets/${asset.id}/assignments`, { recipientType: 'OFFICE', officeName: 'Old office', effectiveAt: '2000-01-01T00:00:00Z' });
  assert.equal(created.statusCode, 201, created.body);
  const returned = await post(`/assets/${asset.id}/assignments/${created.json().assignment.id}/return`, { effectiveAt: '2005-01-01T00:00:00Z' });
  assert.equal(returned.statusCode, 200, returned.body);
  const changed = await post(url, input); assert.equal(changed.statusCode, 200, changed.body);
  assert.notEqual(changed.json().planId, baseline.planId); assert.ok(codes(changed).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
});

test('corrections after capture mark affected evidence stale without changing its archived snapshot', async () => {
  const { base, batch, start, input, url } = await prepare(); const baseline = (await post(url, input)).json();
  const revised = await post(base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(),
    note: 'Catalog evidence checked again', evidenceReference: 'Original equipment label',
    changes: [{ recordId: start.recordId, field: 'model', action: 'REPLACE', value: 'Model G10' }] });
  assert.equal(revised.statusCode, 201, revised.body);
  const changed = await post(url, input); assert.equal(changed.statusCode, 200, changed.body); assert.ok(codes(changed).includes('EVIDENCE_SOURCE_REVISED'));
  assert.notEqual(changed.json().planId, baseline.planId);
  assert.deepEqual((await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: start.id } })).snapshot, start.snapshot);
  assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).version, 2);
});

test('missing storage and oversized history fail explicitly instead of truncating or simulating a valid plan', async () => {
  const { url, asset, input } = await prepare();
  const missing = database.$extends({ query: { importHistoricalEvidence: { async findMany() {
    throw new Prisma.PrismaClientKnownRequestError('Missing historical evidence storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportHistoricalEvidence' } });
  } } } });
  const isolated = buildApp(missing);
  try {
    const cookie = cookies.JEFE; const token = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': token }, payload: input });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
  } finally { await isolated.close(); }
  for (const model of ['assignment', 'importSourceRevision']) {
    const oversized = database.$extends({ query: { [model]: { async findMany({ args }) {
      assert.equal(args.take, model === 'assignment' ? 10001 : 1001);
      return Array(args.take).fill({});
    } } } });
    await assert.rejects(planClosedAssignments(oversized, asset.id, closedAssignmentPlanSchema.parse(input)), (error) => error.code === 'HISTORICAL_PLAN_LIMIT');
  }
});

after(async () => { await app.close(); });
