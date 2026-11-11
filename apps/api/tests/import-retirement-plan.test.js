import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { historicalRetirementPlanSchema } from '../src/imports/retirement-plan-schemas.js';
import { planHistoricalRetirement } from '../src/imports/retirement-plan-service.js';
import { hashPassword } from '../src/lib/password.js';
import { dateCell, retirementRow, workbook } from './fixtures/workbook-preview.js';

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
    const username = `retire-${role.toLowerCase()}-${suffix}`; const password = 'Retirement-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Retirement ${role}`, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(login.statusCode, 200); const header = login.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Retirement product ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role]; const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url) { return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } }); }
async function prepare({ unlinked = false, active = false, retired = false, sheet = 'Baja 2026', unknownReceipt = false } = {}) {
  const asset = await database.$transaction(async (transaction) => {
    const created = await transaction.asset.create({ data: { productId: product.id, serialNumber: `RETIRE-${randomUUID()}`,
      ...(active ? { status: 'ASSIGNED' } : {}), ...(retired ? { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2005-01-01') } : {}) } });
    if (active) await transaction.assignment.create({ data: { assetId: created.id, personName: 'Current recipient', createdById: users.JEFE.id, startedAt: new Date('2010-01-01') } });
    return created;
  });
  const source = workbook(sheet, [retirementRow(sheet, 5, asset.serialNumber, unknownReceipt ? {} : { A: dateCell('2001-01-01') })]);
  source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json(); const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId });
  assert.equal(staged.statusCode, 201, staged.body); const batch = staged.json().batch; const base = `/inventory/imports/batches/${batch.id}`;
  const reviewed = await post(base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: preview.candidates[0].id, action: 'LINK_EXISTING', linkedAssetId: asset.id, note: 'Retirement identity physically verified' });
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  const history = (await get(base + '/history-preview')).json();
  const captured = await post(base + '/history-captures', { expectedVersion: 2, expectedSourceRevision: 0, requestId: randomUUID(), historyPreviewId: history.historyPreviewId,
    confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Retirement source retained without applying it', evidenceReference: 'Archived disposal documents',
    records: history.observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: unlinked ? null : asset.id })) });
  assert.equal(captured.statusCode, 201, captured.body); const capture = captured.json().capture;
  const evidence = capture.items.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION');
  const input = { evidenceId: evidence.id, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: '2005-01-01T09:00:00-03:00',
    dateEvidenceReference: 'Disposal document exact timestamp', note: 'Physical retirement independently confirmed', evidenceReference: 'Signed disposal certificate', acknowledgedWarnings: [] };
  const url = `/assets/${asset.id}/imported-retirement-plan`;
  const first = await post(url, input); assert.equal(first.statusCode, 200, first.body);
  input.acknowledgedWarnings = first.json().warnings.map((warning) => warning.id);
  return { asset, source, preview, batch, base, capture, evidence, input, url };
}
const codes = (response) => response.json().blockers.map((entry) => entry.code);
async function amend(evidenceId, assetId) {
  const base = `/inventory/imports/evidence/${evidenceId}`;
  const planned = await post(base + '/amendment-plan', { assetId }); assert.equal(planned.statusCode, 200, planned.body);
  const plan = planned.json();
  const response = await post(base + '/amendments', { requestId: randomUUID(), amendmentPlanId: plan.amendmentPlanId,
    expectedEvidenceVersion: plan.evidenceVersion, expectedBatchVersion: plan.batchVersion, expectedSourceRevision: plan.sourceRevision,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId, note: 'Retirement archive link or source reviewed', evidenceReference: 'Physical equipment and original records' });
  assert.equal(response.statusCode, 201, response.body); return response.json();
}

test('retirement plan requires JEFE and CSRF, rejects extra effects and cannot replace the separate apply DTO', async () => {
  const { input, url } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url, { ...input, force: true })).statusCode, 400);
  assert.equal((await post(`/assets/${randomUUID()}/imported-retirement-plan`, input)).statusCode, 404);
  assert.equal((await post(url, { ...input, evidenceId: randomUUID() })).statusCode, 404);
  assert.equal((await post(url + '/apply', input)).statusCode, 400);
});

test('retirement planning changes no asset, assignment, source, review, evidence, stock or audit and is deterministic', async () => {
  const { asset, batch, capture, input, url } = await prepare();
  const snapshot = async () => ({ asset: await database.asset.findUniqueOrThrow({ where: { id: asset.id } }),
    assignments: await database.assignment.findMany({ where: { assetId: asset.id }, orderBy: { id: 'asc' } }),
    batch: await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }),
    capture: await database.importHistoryCapture.findUniqueOrThrow({ where: { id: capture.id }, include: { items: { orderBy: { id: 'asc' } } } }),
    decisions: await database.importReviewDecision.findMany({ where: { batchId: batch.id }, orderBy: { id: 'asc' } }),
    amendments: await database.importEvidenceAmendment.findMany({ where: { evidenceId: { in: capture.items.map((entry) => entry.id) } } }),
    auditCount: await database.auditLog.count({ where: { entityId: { in: [asset.id, batch.id, capture.id] } } }),
    stock: await database.inventoryStock.findUnique({ where: { productId: product.id } }), movementCount: await database.inventoryMovement.count({ where: { assetId: asset.id } }) });
  const before = await snapshot(); const response = await post(url, input); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.canApply, false); assert.equal(plan.persisted, false); assert.equal(plan.affectsCurrentState, false);
  assert.equal(plan.proposedRetirement.historicalActorId, null); assert.equal(plan.proposedRetirement.decommissionedAt, '2005-01-01T12:00:00.000Z');
  assert.equal(plan.source.effectiveDay, null); assert.equal(plan.source.sourceReceivedDay, '2001-01-01'); assert.equal(plan.source.evidenceVersion, 0);
  assert.equal((await post(url, input)).json().planId, plan.planId); assert.deepEqual(await snapshot(), before);
});

test('unknown retirement date remains incomplete even with receipt evidence and sheet year, and receipt is not retirement evidence', async () => {
  for (const sheet of ['Baja 2024', 'Baja 2025', 'Baja 2026']) {
    const { capture, input, url } = await prepare({ sheet });
    const partial = { ...input }; delete partial.confirmedAt; delete partial.dateEvidenceReference;
    const response = await post(url, partial); assert.equal(response.statusCode, 200, response.body);
    assert.ok(codes(response).includes('EXACT_RETIREMENT_DATE_REQUIRED')); assert.ok(codes(response).includes('EXACT_RETIREMENT_DATE_PROOF_REQUIRED'));
    assert.equal(response.json().proposedRetirement.decommissionedAt, null); assert.equal(response.json().source.datePrecision, 'UNKNOWN');
    const receipt = capture.items.find((entry) => entry.kind === 'RECEIPT_OBSERVATION');
    const wrongKind = await post(url, { ...input, evidenceId: receipt.id }); assert.ok(codes(wrongKind).includes('RETIREMENT_EVIDENCE_KIND_REQUIRED'));
  }
});

test('current assignments and terminal assets block retirement without closing or replacing existing history', async () => {
  const active = await prepare({ active: true }); const before = await database.assignment.findMany({ where: { assetId: active.asset.id } });
  const response = await post(active.url, active.input); assert.ok(codes(response).includes('ACTIVE_ASSIGNMENT_REQUIRES_RETURN'));
  assert.deepEqual(await database.assignment.findMany({ where: { assetId: active.asset.id } }), before);
  const fixture = await prepare({ retired: true }); const result = await post(fixture.url, fixture.input);
  assert.ok(codes(result).includes('EXISTING_RETIREMENT_REQUIRES_RECONCILIATION'));
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } }), fixture.asset);
});

test('closed periods ending after proposed retirement block and bind the plan to current assignment history', async () => {
  const { asset, input, url } = await prepare(); const baseline = (await post(url, input)).json();
  const created = await post(`/assets/${asset.id}/assignments`, { recipientType: 'OFFICE', officeName: 'Historical office', effectiveAt: '2002-01-01T00:00:00Z' });
  assert.equal(created.statusCode, 201, created.body);
  const returned = await post(`/assets/${asset.id}/assignments/${created.json().assignment.id}/return`, { effectiveAt: '2006-01-01T00:00:00Z' });
  assert.equal(returned.statusCode, 200, returned.body);
  const response = await post(url, input); assert.equal(response.statusCode, 200, response.body);
  assert.ok(codes(response).includes('ASSIGNMENT_AFTER_RETIREMENT')); assert.notEqual(response.json().planId, baseline.planId);
});

test('unlinked and cross-asset retirement evidence need reviewed V12 linkage and later unlinking invalidates a plan', async () => {
  const fixture = await prepare({ unlinked: true }); assert.ok(codes(await post(fixture.url, fixture.input)).includes('EVIDENCE_ASSET_LINK_REQUIRED'));
  const linked = await prepare(); assert.ok(codes(await post(fixture.url, linked.input)).includes('EVIDENCE_ASSET_MISMATCH'));
  await amend(fixture.evidence.id, fixture.asset.id);
  const response = await post(fixture.url, fixture.input); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().planValidationComplete, true); assert.equal(response.json().source.evidenceVersion, 1);
  assert.notEqual(response.json().source.amendmentId, null);
  assert.equal((await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: fixture.evidence.id } })).assetId, null);
  await amend(fixture.evidence.id, null);
  const unlinked = await post(fixture.url, fixture.input); assert.ok(codes(unlinked).includes('EVIDENCE_ASSET_LINK_REQUIRED'));
  assert.equal(unlinked.json().source.evidenceVersion, 2); assert.notEqual(unlinked.json().planId, response.json().planId);
});

test('source corrections invalidate archived retirement, while V12 refresh binds effective versions without rewriting capture', async () => {
  const { base, asset, evidence, input, url } = await prepare({ unknownReceipt: true }); const baseline = (await post(url, input)).json();
  const correction = await post(base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(),
    note: 'Reception day backed by original receipt', evidenceReference: 'Signed receiving record',
    changes: [{ recordId: evidence.recordId, field: 'receivedDate', action: 'REPLACE', value: '2001-01-01' }] });
  assert.equal(correction.statusCode, 201, correction.body); assert.ok(codes(await post(url, input)).includes('EVIDENCE_SOURCE_REVISED'));
  await amend(evidence.id, asset.id);
  const response = await post(url, input); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.source.sourceRevision, 1); assert.equal(plan.source.capturedSourceRevision, 0);
  assert.equal(plan.source.sourceReceivedDay, '2001-01-01'); assert.equal(plan.source.effectiveDay, null);
  assert.notEqual(plan.planId, baseline.planId);
  assert.deepEqual((await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: evidence.id } })).snapshot, evidence.snapshot);
});

test('missing review storage and planning bounds are explicit failures, never truncated success', async () => {
  const { asset, input, url } = await prepare();
  const missing = database.$extends({ query: { importHistoricalEvidence: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing evidence storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportHistoricalEvidence' } });
  } } } });
  const isolated = buildApp(missing);
  try {
    const cookie = cookies.JEFE; const token = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': token }, payload: input });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
  } finally { await isolated.close(); }
  for (const model of ['assignment', 'importSourceRevision']) {
    const oversized = database.$extends({ query: { [model]: { async findMany({ args }) {
      assert.equal(args.take, model === 'assignment' ? 10001 : 1001); return Array(args.take).fill({});
    } } } });
    await assert.rejects(planHistoricalRetirement(oversized, asset.id, historicalRetirementPlanSchema.parse(input)), (error) => error.code === 'HISTORICAL_PLAN_LIMIT');
  }
});

after(async () => { await app.close(); });
