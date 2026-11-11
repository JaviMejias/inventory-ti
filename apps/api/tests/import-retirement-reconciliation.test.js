import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { reconcileHistoricalRetirement } from '../src/imports/retirement-reconciliation-service.js';
import { hashPassword } from '../src/lib/password.js';
import { verifiedRetirementFixture } from './fixtures/verified-retirement-import.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const users = {}; const cookies = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `retrecon-${role.toLowerCase()}-${suffix}`; const password = 'Retirement-reconciliation-123';
    users[role] = await database.user.create({ data: { username, displayName: `Reconciliation ${role}`, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Retirement reconciliation ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role]; const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url) { return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } }); }
async function prepare(options = {}) {
  const fixture = await verifiedRetirementFixture({ database, product, actorId: users.JEFE.id, post, get, ...options });
  return { ...fixture, assessmentUrl: `/assets/${fixture.asset.id}/imported-retirement-reconciliation`, assessmentInput: { evidenceId: fixture.evidence.id } };
}
async function amend(fixture, assetId) {
  const base = `/inventory/imports/evidence/${fixture.evidence.id}`;
  const response = await post(base + '/amendment-plan', { assetId }); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  const applied = await post(base + '/amendments', { requestId: randomUUID(), amendmentPlanId: plan.amendmentPlanId,
    expectedEvidenceVersion: plan.evidenceVersion, expectedBatchVersion: plan.batchVersion, expectedSourceRevision: plan.sourceRevision,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId, note: 'Evidence reviewed without retiring asset', evidenceReference: 'Original inventory records' });
  assert.equal(applied.statusCode, 201, applied.body);
}
const codes = (assessment) => assessment.diagnostics.map((issue) => issue.code);

test('retirement reconciliation requires JEFE and CSRF, strict read-only DTO, existing asset and evidence', async () => {
  const { assessmentUrl: url, assessmentInput: input } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { confirmedAt: '2005-01-01T12:00:00Z' }, { confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT' }, { acknowledgedWarnings: [] }]) {
    assert.equal((await post(url, { ...input, ...change })).statusCode, 400);
  }
  assert.equal((await post(`/assets/${randomUUID()}/imported-retirement-reconciliation`, input)).statusCode, 404);
  assert.equal((await post(url, { evidenceId: randomUUID() })).statusCode, 404);
});

test('retirement reconciliation preserves all domain/archive/review/audit data, stays deterministic and cannot be applied as V14', async () => {
  const fixture = await prepare(); const { asset, batch, capture, assessmentUrl, assessmentInput } = fixture;
  const snapshot = async () => ({ asset: await database.asset.findUniqueOrThrow({ where: { id: asset.id } }),
    assignments: await database.assignment.findMany({ where: { assetId: asset.id }, orderBy: { id: 'asc' } }),
    batch: await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }),
    capture: await database.importHistoryCapture.findUniqueOrThrow({ where: { id: capture.id }, include: { items: { orderBy: { id: 'asc' } } } }),
    reviews: await database.importReviewDecision.findMany({ where: { batchId: batch.id }, orderBy: { id: 'asc' } }),
    amendments: await database.importEvidenceAmendment.findMany({ where: { evidenceId: { in: capture.items.map((item) => item.id) } } }),
    applications: await database.importRetirementApplication.findMany({ where: { assetId: asset.id } }),
    audits: await database.auditLog.count({ where: { entityId: { in: [asset.id, batch.id, capture.id] } } }),
    movements: await database.inventoryMovement.count({ where: { assetId: asset.id } }), stock: await database.inventoryStock.findUnique({ where: { productId: product.id } }) });
  const before = await snapshot(); const response = await post(assessmentUrl, assessmentInput); assert.equal(response.statusCode, 200, response.body); const result = response.json();
  assert.equal(result.classification, 'RETIREMENT_DATE_UNCONFIRMED'); assert.equal(result.evidenceState, 'ARCHIVED_ONLY');
  assert.equal(result.source.sourceReceivedDay, '2001-01-01'); assert.equal(result.sourceRetirement.effectiveAt, null);
  assert.equal(result.sourceRetirement.historicalActorId, null); assert.equal(result.canApply, false); assert.equal(result.persisted, false);
  assert.equal(result.affectsCurrentState, false); assert.equal(result.operationalResolutionImplemented, false);
  assert.equal(result.planId, undefined); assert.equal((await post(assessmentUrl, assessmentInput)).json().assessmentId, result.assessmentId);
  assert.equal((await post(fixture.url, result)).statusCode, 400);
  const unknownPlan = (await post(fixture.planUrl, { ...fixture.input.plan, confirmedAt: null, dateEvidenceReference: null })).json();
  assert.equal((await post(fixture.url, { ...fixture.input, planId: unknownPlan.planId, plan: unknownPlan.request })).json().code, 'RETIREMENT_PLAN_BLOCKED');
  assert.deepEqual(await snapshot(), before);
});

test('retirement reconciliation of dated and undated legacy terminals never fills/replaces dates or attaches imported provenance', async () => {
  const fixture = await prepare({ retired: true });
  for (const date of [new Date('2005-01-01'), null]) {
    await database.asset.update({ where: { id: fixture.asset.id }, data: { decommissionedAt: date } });
    const before = await database.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } });
    const result = (await post(fixture.assessmentUrl, fixture.assessmentInput)).json();
    assert.equal(result.classification, date ? 'EXISTING_DATED_RETIREMENT' : 'EXISTING_UNDATED_RETIREMENT');
    assert.equal(result.existingRetirement.effectiveAt, date?.toISOString() ?? null); assert.equal(result.existingRetirement.confirmsSourceDate, false);
    assert.equal(result.existingRetirement.dateOrigin, 'CURRENT_ASSET'); assert.equal(result.existingApplication, null);
    assert.equal(result.links.verifiedPlan, null); assert.ok(result.nextSteps.includes('RECONCILE_EXISTING_RETIREMENT_SEPARATELY'));
    assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } }), before);
  }
  assert.equal(await database.importRetirementApplication.count({ where: { assetId: fixture.asset.id } }), 0);
});

test('retirement reconciliation exposes active custody and inconsistent flags without closing deliveries or reactivating assets', async () => {
  const active = await prepare({ active: true }); const before = await database.assignment.findMany({ where: { assetId: active.asset.id } });
  const result = (await post(active.assessmentUrl, active.assessmentInput)).json();
  assert.equal(result.classification, 'CURRENT_CUSTODY_CONFLICT'); assert.ok(result.nextSteps.includes('REVIEW_CURRENT_CUSTODY'));
  assert.equal(result.links.verifiedPlan, null); assert.deepEqual(await database.assignment.findMany({ where: { assetId: active.asset.id } }), before);
  const inactive = await prepare(); await database.asset.update({ where: { id: inactive.asset.id }, data: { isActive: false } });
  const inconsistent = (await post(inactive.assessmentUrl, inactive.assessmentInput)).json();
  assert.equal(inconsistent.classification, 'CURRENT_STATE_REVIEW_REQUIRED'); assert.ok(inconsistent.nextSteps.includes('REVIEW_CURRENT_STATE'));
  assert.equal((await database.asset.findUniqueOrThrow({ where: { id: inactive.asset.id } })).isActive, false);
});

test('retirement reconciliation tracks unlinked/mismatched/current V12 evidence and source corrections without refreshing archive automatically', async () => {
  const fixture = await prepare({ unlinked: true, unknownReceipt: true }); const original = fixture.evidence.snapshot;
  const baseline = (await post(fixture.assessmentUrl, fixture.assessmentInput)).json(); assert.equal(baseline.classification, 'EVIDENCE_REVIEW_REQUIRED');
  const other = await prepare(); const mismatch = (await post(other.assessmentUrl, fixture.assessmentInput)).json(); assert.ok(codes(mismatch).includes('EVIDENCE_ASSET_LINK_REQUIRED'));
  await amend(fixture, fixture.asset.id);
  const linked = (await post(fixture.assessmentUrl, fixture.assessmentInput)).json(); assert.equal(linked.classification, 'RETIREMENT_DATE_UNCONFIRMED'); assert.equal(linked.source.evidenceVersion, 1);
  const crossAsset = (await post(other.assessmentUrl, fixture.assessmentInput)).json(); assert.ok(codes(crossAsset).includes('EVIDENCE_ASSET_MISMATCH'));
  const correction = await post(fixture.base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(),
    note: 'Correct reception independently of disposal', evidenceReference: 'Original reception record',
    changes: [{ recordId: fixture.evidence.recordId, field: 'receivedDate', action: 'REPLACE', value: '2001-01-01' }] }); assert.equal(correction.statusCode, 201, correction.body);
  const stale = (await post(fixture.assessmentUrl, fixture.assessmentInput)).json(); assert.ok(codes(stale).includes('EVIDENCE_SOURCE_REVISED'));
  await amend(fixture, fixture.asset.id);
  const refreshed = (await post(fixture.assessmentUrl, fixture.assessmentInput)).json(); assert.equal(refreshed.classification, 'RETIREMENT_DATE_UNCONFIRMED');
  assert.equal(refreshed.source.sourceRevision, 1); assert.equal(refreshed.source.evidenceVersion, 2); assert.equal(refreshed.source.capturedSourceRevision, 0);
  assert.equal(refreshed.source.sourceReceivedDay, '2001-01-01'); assert.equal(refreshed.sourceRetirement.effectiveAt, null);
  assert.notEqual(refreshed.assessmentId, linked.assessmentId);
  await amend(fixture, null); assert.ok(codes((await post(fixture.assessmentUrl, fixture.assessmentInput)).json()).includes('EVIDENCE_ASSET_LINK_REQUIRED'));
  assert.deepEqual((await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: fixture.evidence.id } })).snapshot, original);
});

test('retirement reconciliation recovers V14 receipt after application and later source revision without treating capture or source as retirement date', async () => {
  const fixture = await prepare(); const applied = await post(fixture.url, fixture.input); assert.equal(applied.statusCode, 201, applied.body); const receipt = applied.json().application;
  const before = await database.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } });
  const response = await post(fixture.assessmentUrl, fixture.assessmentInput); assert.equal(response.statusCode, 200, response.body); const result = response.json();
  assert.equal(result.classification, 'ALREADY_IMPORTED_RETIREMENT'); assert.equal(result.evidenceState, 'USED_FOR_THIS_RETIREMENT');
  assert.equal(result.existingApplication.id, receipt.id); assert.equal(result.existingApplication.appliedById, users.JEFE.id);
  assert.equal(result.existingApplication.plan, undefined); assert.equal(result.existingRetirement.effectiveAt, receipt.decommissionedAt);
  assert.equal(result.sourceRetirement.effectiveAt, null); assert.equal(result.existingRetirement.confirmsSourceDate, false);
  assert.equal(result.sourceRetirement.historicalActorId, null); assert.equal(result.links.verifiedPlan, null);
  assert.equal((await get(result.links.existingApplication)).json().application.id, receipt.id);
  const revised = await post(fixture.base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(),
    note: 'Later catalog review', evidenceReference: 'Original model record', changes: [{ recordId: fixture.evidence.recordId, field: 'model', action: 'REPLACE', value: 'Model G10' }] });
  assert.equal(revised.statusCode, 201, revised.body);
  const later = (await post(fixture.assessmentUrl, fixture.assessmentInput)).json(); assert.equal(later.classification, 'ALREADY_IMPORTED_RETIREMENT');
  assert.ok(codes(later).includes('EVIDENCE_SOURCE_REVISED')); assert.ok(later.nextSteps.includes('REVIEW_EVIDENCE_LINK_AND_SOURCE'));
  assert.equal(later.existingApplication.id, receipt.id); assert.notEqual(later.assessmentId, result.assessmentId);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } }), before);
});

test('retirement reconciliation separates selected evidence from other imported retirement and never attaches it to the old receipt', async () => {
  const appliedFixture = await prepare(); assert.equal((await post(appliedFixture.url, appliedFixture.input)).statusCode, 201);
  const existingAsset = await database.asset.findUniqueOrThrow({ where: { id: appliedFixture.asset.id } });
  const otherSource = await prepare({ existingAsset }); const before = await database.importRetirementApplication.findUniqueOrThrow({ where: { assetId: existingAsset.id } });
  const response = await post(otherSource.assessmentUrl, otherSource.assessmentInput); assert.equal(response.statusCode, 200, response.body); const result = response.json();
  assert.equal(result.classification, 'EXISTING_IMPORTED_RETIREMENT'); assert.equal(result.evidenceApplication, null);
  assert.notEqual(result.source.evidenceId, result.existingApplication.evidenceId); assert.equal(result.existingApplication.id, before.id);
  assert.deepEqual(await database.importRetirementApplication.findUniqueOrThrow({ where: { assetId: existingAsset.id } }), before);
  const unrelated = await prepare(); const foreign = (await post(unrelated.assessmentUrl, appliedFixture.assessmentInput)).json();
  assert.equal(foreign.classification, 'EVIDENCE_ALREADY_USED'); assert.equal(foreign.evidenceState, 'USED_FOR_OTHER_RETIREMENT');
  assert.equal(foreign.existingApplication, null); assert.equal(foreign.evidenceApplication.id, before.id); assert.equal(foreign.links.existingApplication, null);
});

test('retirement reconciliation uses one repeatable-read snapshot across a concurrent verified retirement commit', async () => {
  const fixture = await prepare(); let triggered = false;
  const concurrent = database.$extends({ query: { importRetirementApplication: { async findMany({ args, query }) {
    if (!triggered) { triggered = true; const applied = await post(fixture.url, fixture.input); assert.equal(applied.statusCode, 201, applied.body); }
    return query(args);
  } } } });
  const snapshot = await reconcileHistoricalRetirement(concurrent, fixture.asset.id, fixture.assessmentInput);
  assert.equal(triggered, true); assert.equal(snapshot.currentState, 'NONTERMINAL'); assert.equal(snapshot.existingApplication, null);
  assert.equal(snapshot.classification, 'RETIREMENT_DATE_UNCONFIRMED');
  const current = (await post(fixture.assessmentUrl, fixture.assessmentInput)).json(); assert.equal(current.classification, 'ALREADY_IMPORTED_RETIREMENT');
  assert.notEqual(current.assessmentId, snapshot.assessmentId);
});

test('retirement reconciliation fails clearly for unavailable storage and bounded history, never returns a truncated successful assessment', async () => {
  const fixture = await prepare();
  const missing = database.$extends({ query: { importRetirementApplication: { async findMany() {
    throw new Prisma.PrismaClientKnownRequestError('Missing retirement storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportRetirementApplication' } });
  } } } });
  const isolated = buildApp(missing);
  try {
    const cookie = cookies.JEFE; const csrfToken = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url: fixture.assessmentUrl, headers: { cookie, 'x-csrf-token': csrfToken }, payload: fixture.assessmentInput });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
  } finally { await isolated.close(); }
  for (const model of ['assignment', 'importSourceRevision']) {
    const oversized = database.$extends({ query: { [model]: { async findMany({ args }) {
      assert.equal(args.take, model === 'assignment' ? 10001 : 1001); return Array(args.take).fill({});
    } } } });
    await assert.rejects(reconcileHistoricalRetirement(oversized, fixture.asset.id, fixture.assessmentInput), (error) => error.code === 'HISTORICAL_PLAN_LIMIT');
  }
});

after(async () => { await app.close(); });
