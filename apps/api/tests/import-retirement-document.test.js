import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { retirementDocumentRequestDigest } from '../src/imports/retirement-document-schemas.js';
import { recordRetirementDocument } from '../src/imports/retirement-document-service.js';
import { hashPassword } from '../src/lib/password.js';
import { verifiedRetirementFixture } from './fixtures/verified-retirement-import.js';
import { groupRetirementFixture } from './fixtures/group-retirement-import.js';

const suffix = randomUUID().slice(0, 8); const productIds = []; const users = {}; const cookies = {}; let product;
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database);
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `retdoc-${role.toLowerCase()}-${suffix}`; const password = 'Retirement-document-review-123';
    users[role] = await database.user.create({ data: { username, displayName: `Document reviewer ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Retirement documentary ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
after(async () => { await app.close(); await database.$disconnect(); });
async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role]; const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
const get = (url, role = 'JEFE') => app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } });
async function prepare(options = {}) {
  const fixture = await verifiedRetirementFixture({ database, product, actorId: users.JEFE.id, post, get, retired: true, ...options });
  const planUrl = `/assets/${fixture.asset.id}/imported-retirement-document-plan`; const url = planUrl + '/confirm';
  const first = await post(planUrl, { evidenceId: fixture.evidence.id, note: 'Additional source reviewed against existing terminal', evidenceReference: 'Archived inventory record', acknowledgedWarnings: [] });
  assert.equal(first.statusCode, 200, first.body); const planInput = { ...first.json().request, acknowledgedWarnings: first.json().warnings.map((warning) => warning.id) };
  const response = await post(planUrl, planInput); assert.equal(response.statusCode, 200, response.body); const documentPlan = response.json();
  return { ...fixture, documentPlan, planInput, documentPlanUrl: planUrl, documentUrl: url,
    documentInput: { requestId: randomUUID(), planId: documentPlan.planId, confirmation: 'RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY', plan: planInput },
    documentsUrl: `/assets/${fixture.asset.id}/imported-retirement-documents` };
}
const codes = (plan) => plan.blockers.map((issue) => issue.code);
const snapshot = async (f) => ({ asset: await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }),
  evidence: await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: f.evidence.id } }),
  assignments: await database.assignment.findMany({ where: { assetId: f.asset.id } }),
  retirements: await database.importRetirementApplication.findMany({ where: { assetId: f.asset.id } }),
  movements: await database.inventoryMovement.findMany({ where: { assetId: f.asset.id } }), stock: await database.inventoryStock.findUnique({ where: { productId: product.id } }) });

test('retirement document reconciliation records dated and undated terminal evidence without changing any operational or source facts', async () => {
  for (const undated of [false, true]) {
    const f = await prepare(); if (undated) {
      await database.asset.update({ where: { id: f.asset.id }, data: { decommissionedAt: null } });
      f.documentPlan = (await post(f.documentPlanUrl, f.planInput)).json(); f.documentInput.planId = f.documentPlan.planId;
    }
    const before = await snapshot(f); assert.equal(f.documentPlan.planValidationComplete, true, JSON.stringify(f.documentPlan.blockers));
    assert.equal(f.documentPlan.canApply, false); assert.equal(f.documentPlan.affectsCurrentState, false); assert.equal(f.documentPlan.persisted, false);
    const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body); const result = response.json();
    assert.equal(result.affectsCurrentState, false); assert.equal(result.confirmsSourceDate, false); assert.equal(result.consumesOperationalEvidence, false);
    assert.equal(result.reconciliation.plan.sourceRetirement.effectiveAt, null); assert.equal(result.reconciliation.plan.sourceRetirement.historicalActorId, null);
    assert.equal(result.reconciliation.plan.existingRetirement.effectiveAt, undated ? null : before.asset.decommissionedAt.toISOString());
    assert.deepEqual(await snapshot(f), before);
    const audit = await database.auditLog.findMany({ where: { entityId: result.reconciliation.id } }); assert.equal(audit.length, 1);
    assert.equal(audit[0].userId, users.JEFE.id); assert.equal(audit[0].metadata.affectsCurrentState, false);
    const detail = await get(f.documentsUrl + '/' + result.reconciliation.id); assert.equal(detail.statusCode, 200); assert.deepEqual(detail.json().reconciliation, result.reconciliation);
  }
});

test('retirement document routes require JEFE, CSRF, strict intent and scoped existing parents', async () => {
  const f = await prepare();
  for (const url of [f.documentPlanUrl, f.documentUrl]) {
    const input = url === f.documentUrl ? f.documentInput : f.planInput;
    assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
    for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
    assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
    assert.equal((await post(url, { ...input, force: true })).statusCode, 400);
  }
  assert.equal((await post(f.documentUrl, { ...f.documentInput, confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT' })).statusCode, 400);
  assert.equal((await post(f.documentPlanUrl, { ...f.planInput, confirmedAt: '2005-01-01' })).statusCode, 400);
  assert.equal((await post(`/assets/${randomUUID()}/imported-retirement-document-plan`, f.planInput)).statusCode, 404);
  assert.equal((await post(f.documentPlanUrl, { ...f.planInput, evidenceId: randomUUID() })).statusCode, 404);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await get(f.documentsUrl, role)).statusCode, 403);
  assert.equal((await get(f.documentsUrl + '?limit=0')).statusCode, 400);
  assert.equal((await get(`/assets/${randomUUID()}/imported-retirement-documents`)).statusCode, 404);
});

test('retirement document leaves nonterminal undated observations pending and blocks custody, mismatched links and invalid dates', async () => {
  const pending = await prepare({ retired: false }); assert.ok(codes(pending.documentPlan).includes('EXISTING_TERMINAL_RETIREMENT_REQUIRED'));
  assert.equal(pending.documentPlan.existingRetirement, null);
  const before = await snapshot(pending); assert.equal((await post(pending.documentUrl, pending.documentInput)).json().code, 'RETIREMENT_DOCUMENT_BLOCKED');
  assert.deepEqual(await snapshot(pending), before);
  const unlinked = await prepare({ unlinked: true }); assert.ok(codes(unlinked.documentPlan).includes('EVIDENCE_ASSET_LINK_REQUIRED'));
  const active = await prepare({ retired: false, active: true }); assert.ok(codes(active.documentPlan).includes('CURRENT_CUSTODY_REQUIRES_REVIEW'));
  const invalid = await prepare();
  const reception = invalid.capture.items.find((entry) => entry.kind === 'RECEIPT_OBSERVATION'); assert.ok(reception);
  const wrongKind = (await post(invalid.documentPlanUrl, { ...invalid.planInput, evidenceId: reception.id })).json();
  assert.ok(codes(wrongKind).includes('RETIREMENT_EVIDENCE_KIND_REQUIRED')); assert.equal(wrongKind.sourceRetirement, null);
  for (const decommissionedAt of [new Date('1899-01-01'), new Date('2999-01-01'), new Date('2000-01-01')]) {
    await database.asset.update({ where: { id: invalid.asset.id }, data: { decommissionedAt } });
    assert.ok(codes((await post(invalid.documentPlanUrl, invalid.planInput)).json()).includes(decommissionedAt.getUTCFullYear() === 2000 ? 'CURRENT_RETIREMENT_BEFORE_SOURCE_RECEIPT' : 'CURRENT_RETIREMENT_DATE_UNCONFIRMED'));
  }
});

test('retirement document revalidates changed context and exact warnings without creating partial receipts', async () => {
  const f = await prepare(); assert.ok(f.documentPlan.warnings.length > 0);
  const missing = (await post(f.documentPlanUrl, { ...f.planInput, acknowledgedWarnings: [] })).json(); assert.ok(codes(missing).includes('WARNINGS_NOT_ACKNOWLEDGED'));
  assert.equal((await post(f.documentUrl, { ...f.documentInput, planId: missing.planId, plan: missing.request })).json().code, 'RETIREMENT_DOCUMENT_BLOCKED');
  await database.asset.update({ where: { id: f.asset.id }, data: { notes: 'Later metadata review' } });
  assert.equal((await post(f.documentUrl, f.documentInput)).json().code, 'RETIREMENT_DOCUMENT_PLAN_CHANGED');
  assert.equal(await database.importRetirementReconciliation.count({ where: { assetId: f.asset.id } }), 0);
  const current = (await post(f.documentPlanUrl, f.planInput)).json(); assert.equal((await post(f.documentUrl, { ...f.documentInput, planId: current.planId })).statusCode, 201);
});

test('retirement document retries recover the identical receipt and reject changed actor or intention and duplicate evidence versions', async () => {
  const f = await prepare(); const applied = await post(f.documentUrl, f.documentInput); assert.equal(applied.statusCode, 201, applied.body);
  const receipt = applied.json().reconciliation;
  const repeated = await post(f.documentUrl, f.documentInput); assert.equal(repeated.statusCode, 200); assert.equal(repeated.json().reused, true); assert.deepEqual(repeated.json().reconciliation, receipt);
  assert.equal((await post(f.documentUrl, { ...f.documentInput, plan: { ...f.planInput, note: 'Other intent' } })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(recordRetirementDocument(database, f.asset.id, f.documentInput, users.COORDINADOR.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await post(f.documentUrl, { ...f.documentInput, requestId: randomUUID() })).json().code, 'RETIREMENT_DOCUMENT_BLOCKED');
  const current = (await post(f.documentPlanUrl, f.planInput)).json(); assert.ok(codes(current).includes('RETIREMENT_DOCUMENT_ALREADY_RECONCILED'));
  const list = (await get(f.documentsUrl + '?limit=1')).json(); assert.equal(list.total, 1); assert.equal(list.hasMore, false); assert.equal(list.reconciliations[0].plan, undefined);
  assert.equal((await get(f.documentsUrl + '?offset=1')).json().reconciliations.length, 0);
  assert.equal((await get(`/assets/${randomUUID()}/imported-retirement-documents/${receipt.id}`)).statusCode, 404);
  assert.equal((await get(f.documentsUrl + '/' + randomUUID())).statusCode, 404);
});

test('retirement document rolls back receipt if atomic audit creation fails and allows the original request afterward', async () => {
  const f = await prepare(); const before = await snapshot(f);
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_RETIREMENT_DOCUMENT_RECONCILED') throw new Error('Injected documentary audit failure');
    return query(args);
  } } } });
  await assert.rejects(recordRetirementDocument(failing, f.asset.id, f.documentInput, users.JEFE.id), /Injected documentary audit failure/);
  assert.equal(await database.importRetirementReconciliation.count({ where: { assetId: f.asset.id } }), 0); assert.deepEqual(await snapshot(f), before);
  assert.equal((await post(f.documentUrl, f.documentInput)).statusCode, 201);
});

test('retirement document races never duplicate receipts and transient contention is recoverable', async () => {
  const f = await prepare(); const responses = await Promise.all([post(f.documentUrl, f.documentInput), post(f.documentUrl, f.documentInput)]);
  assert.ok(responses.some((response) => response.statusCode === 201), responses.map((response) => response.body).join('\n'));
  assert.ok(responses.every((response) => [200, 201, 409].includes(response.statusCode)));
  assert.equal((await post(f.documentUrl, f.documentInput)).statusCode, 200);
  assert.equal(await database.importRetirementReconciliation.count({ where: { assetId: f.asset.id } }), 1);
});

test('retirement document storage absence returns explicit unavailable response', async () => {
  const f = await prepare(); const missing = database.$extends({ query: { importRetirementReconciliation: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing documentary storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportRetirementReconciliation' } });
  } } } });
  const isolated = buildApp(missing);
  try {
    const cookie = cookies.JEFE; const csrf = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url: f.documentPlanUrl, headers: { cookie, 'x-csrf-token': csrf }, payload: f.planInput });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
  } finally { await isolated.close(); }
});

async function rawReceipt(transaction, f, change = {}) {
  const [clock] = await transaction.$queryRaw`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "recordedAt"`;
  return transaction.importRetirementReconciliation.create({ data: { assetId: f.asset.id, evidenceId: f.evidence.id, evidenceVersion: f.documentPlan.source.evidenceVersion,
    amendmentId: f.documentPlan.source.amendmentId, sourceRevision: f.documentPlan.source.sourceRevision, requestId: f.documentInput.requestId,
    requestDigest: retirementDocumentRequestDigest(f.documentInput), planId: f.documentPlan.planId, rulesVersion: f.documentPlan.rulesVersion,
    plan: f.documentPlan, recordedById: users.JEFE.id, recordedAt: clock.recordedAt, ...change } });
}
test('retirement document SQL rejects missing audit, forged actor, altered snapshots and digests at the persistence boundary', async () => {
  const f = await prepare();
  for (const change of [{ recordedById: users.SOPORTE.id }, { createdTransactionId: '1' }, { requestDigest: 'f'.repeat(64) },
    { plan: { ...f.documentPlan, assetBefore: { ...f.documentPlan.assetBefore, notes: 'Forged metadata' } } }]) {
    await assert.rejects(database.$transaction((transaction) => rawReceipt(transaction, f, change)), /reconciliation|Document/i);
  }
  await assert.rejects(database.$transaction((transaction) => rawReceipt(transaction, f)), /atomic audit/i);
  assert.equal(await database.importRetirementReconciliation.count({ where: { assetId: f.asset.id } }), 0);
  const id = randomUUID(); const oldAudit = await database.auditLog.create({ data: { userId: users.JEFE.id, action: 'IMPORT_RETIREMENT_DOCUMENT_RECONCILED',
    entityType: 'ImportRetirementReconciliation', entityId: id, metadata: { assetId: f.asset.id, evidenceId: f.evidence.id,
      evidenceVersion: f.documentPlan.source.evidenceVersion, planId: f.documentPlan.planId, affectsCurrentState: false, confirmsSourceDate: false, consumesOperationalEvidence: false } } });
  await assert.rejects(database.$transaction((transaction) => rawReceipt(transaction, f, { id })), /atomic audit/i);
  await database.auditLog.delete({ where: { id: oldAudit.id } });
  assert.equal((await post(f.documentUrl, f.documentInput)).statusCode, 201);
});

test('retirement document receipt and audit are immutable while unrelated later asset metadata remains independently editable', async () => {
  const f = await prepare(); const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body); const receipt = response.json().reconciliation;
  await assert.rejects(database.importRetirementReconciliation.update({ where: { id: receipt.id }, data: { requestDigest: 'f'.repeat(64) } }), /immutable/);
  await assert.rejects(database.importRetirementReconciliation.delete({ where: { id: receipt.id } }), /immutable/);
  await assert.rejects(database.$executeRawUnsafe('TRUNCATE "ImportRetirementReconciliation"'), /immutable/);
  const audit = await database.auditLog.findFirstOrThrow({ where: { entityId: receipt.id } });
  await assert.rejects(database.auditLog.delete({ where: { id: audit.id } }), /immutable/);
  await assert.rejects(database.auditLog.update({ where: { id: audit.id }, data: { metadata: {} } }), /immutable/);
  await database.asset.update({ where: { id: f.asset.id }, data: { notes: 'Separate later metadata edit' } });
  assert.deepEqual((await get(f.documentsUrl + '/' + receipt.id)).json().reconciliation, receipt);
});

test('retirement document supplements an existing verified legacy retirement without reusing its original evidence or rewriting its receipt', async () => {
  const original = await prepare({ retired: false }); const applied = await post(original.url, original.input); assert.equal(applied.statusCode, 201, applied.body);
  const asset = await database.asset.findUniqueOrThrow({ where: { id: original.asset.id } });
  const used = (await post(original.documentPlanUrl, original.planInput)).json(); assert.ok(codes(used).includes('EVIDENCE_ALREADY_APPLIED'));
  const f = await prepare({ existingAsset: asset }); assert.equal(f.documentPlan.planValidationComplete, true, JSON.stringify(f.documentPlan.blockers));
  assert.equal(f.documentPlan.existingRetirement.legacyApplicationId, applied.json().application.id); assert.equal(f.documentPlan.existingRetirement.confirmsSourceDate, false);
  const before = await snapshot(f); assert.equal((await post(f.documentUrl, f.documentInput)).statusCode, 201); assert.deepEqual(await snapshot(f), before);
});

test('retirement document preserves grouped source reservations and permits only independent supplemental evidence on an already grouped-retired asset', async () => {
  const grouped = await groupRetirementFixture({ database, product, post, get });
  const planUrl = `/assets/${grouped.asset.id}/imported-retirement-document-plan`;
  const document = { evidenceId: grouped.retirement.id, note: 'Additional documentary review', evidenceReference: 'Archived inventory', acknowledgedWarnings: [] };
  assert.equal((await post(planUrl, document)).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
  const first = await post(grouped.url, grouped.input); assert.equal(first.statusCode, 200, first.body);
  const input = { ...grouped.input, acknowledgedGroupWarnings: first.json().groupWarnings.map((entry) => entry.id),
    plan: { ...grouped.input.plan, acknowledgedWarnings: first.json().warnings.map((entry) => entry.id) } };
  const plan = await post(grouped.url, input); assert.equal(plan.statusCode, 200, plan.body);
  const applied = await post(grouped.url + '/apply', { requestId: randomUUID(), planId: plan.json().planId, confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT', plan: input });
  assert.equal(applied.statusCode, 201, applied.body); assert.equal((await post(planUrl, document)).json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  const asset = await database.asset.findUniqueOrThrow({ where: { id: grouped.asset.id } }); const f = await prepare({ existingAsset: asset });
  assert.equal(f.documentPlan.existingRetirement.groupApplicationId, applied.json().application.id); assert.equal(f.documentPlan.existingRetirement.dateOrigin, 'GROUP_VERIFIED_IMPORT_RECEIPT');
  const before = await database.importGroupRetirementApplication.findUniqueOrThrow({ where: { assetId: asset.id }, include: { rows: true } });
  const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(await database.importGroupRetirementApplication.findUniqueOrThrow({ where: { assetId: asset.id }, include: { rows: true } }), before);
});

test('retirement document captures a specific evidence version while later explicit amendments and old-request recovery remain separate', async () => {
  const f = await prepare(); const applied = await post(f.documentUrl, f.documentInput); assert.equal(applied.statusCode, 201, applied.body); const receipt = applied.json().reconciliation;
  const base = `/inventory/imports/evidence/${f.evidence.id}`;
  for (const assetId of [null, f.asset.id]) {
    const response = await post(base + '/amendment-plan', { assetId }); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
    const amended = await post(base + '/amendments', { requestId: randomUUID(), amendmentPlanId: plan.amendmentPlanId, expectedEvidenceVersion: plan.evidenceVersion,
      expectedBatchVersion: plan.batchVersion, expectedSourceRevision: plan.sourceRevision, confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId,
      note: 'Explicit independent link review after documentary capture', evidenceReference: 'Physical identity verification' }); assert.equal(amended.statusCode, 201, amended.body);
    if (assetId === null) assert.ok(codes((await post(f.documentPlanUrl, f.planInput)).json()).includes('EVIDENCE_ASSET_LINK_REQUIRED'));
  }
  const current = (await post(f.documentPlanUrl, f.planInput)).json(); assert.equal(current.source.evidenceVersion, 2); assert.equal(current.planValidationComplete, true);
  const second = await post(f.documentUrl, { ...f.documentInput, requestId: randomUUID(), planId: current.planId }); assert.equal(second.statusCode, 201, second.body);
  assert.deepEqual((await post(f.documentUrl, f.documentInput)).json().reconciliation, receipt);
  assert.equal((await get(f.documentsUrl)).json().total, 2); assert.equal((await get(f.documentsUrl + '/' + receipt.id)).json().reconciliation.evidenceVersion, 0);
});

test('retirement document respects database custody chronology and records only a compatible existing terminal context', async () => {
  const f = await prepare({ retired: false });
  await database.assignment.create({ data: { assetId: f.asset.id, personName: 'Historical recipient', createdById: users.JEFE.id,
    startedAt: new Date('2001-01-01'), endedAt: new Date('2006-01-01'), endedById: users.JEFE.id, returnRecordedAt: new Date('2006-01-01'), returnStatus: 'AVAILABLE' } });
  await assert.rejects(database.asset.update({ where: { id: f.asset.id }, data: { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2005-01-01') } }), /Terminal date cannot precede effective custody history/);
  await database.asset.update({ where: { id: f.asset.id }, data: { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2007-01-01') } });
  const before = await snapshot(f); const plan = (await post(f.documentPlanUrl, f.planInput)).json(); assert.equal(plan.planValidationComplete, true, JSON.stringify(plan.blockers));
  const applied = await post(f.documentUrl, { ...f.documentInput, planId: plan.planId }); assert.equal(applied.statusCode, 201, applied.body); assert.deepEqual(await snapshot(f), before);
});

test('retirement document SQL guards survive early constraints and savepoints without permitting hidden asset, product, custody or audit mutations', async () => {
  const f = await prepare(); const before = await snapshot(f);
  const intercepted = new Proxy(database, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (operation, options) => database.$transaction(async (transaction) => {
      const result = await operation(transaction); await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      const attempts = [() => transaction.asset.update({ where: { id: f.asset.id }, data: { notes: 'Hidden mutation' } }),
        () => transaction.product.update({ where: { id: product.id }, data: { name: 'Hidden product mutation' } }),
        () => transaction.auditLog.deleteMany({ where: { entityId: result.reconciliation.id } }),
        () => transaction.assignment.create({ data: { assetId: f.asset.id, personName: 'Hidden custody', createdById: users.JEFE.id,
          startedAt: new Date('2001-01-01'), endedAt: new Date('2002-01-01'), endedById: users.JEFE.id, returnRecordedAt: new Date('2002-01-01'), returnStatus: 'AVAILABLE' } })];
      for (const attempt of attempts) {
        await transaction.$executeRawUnsafe('SAVEPOINT document_guard_test'); await assert.rejects(attempt(), /reconciliation/i);
        await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT document_guard_test'); await transaction.$executeRawUnsafe('RELEASE SAVEPOINT document_guard_test');
      }
      return result;
    }, options);
  } });
  const result = await recordRetirementDocument(intercepted, f.asset.id, f.documentInput, users.JEFE.id); assert.equal(result.persisted, true); assert.deepEqual(await snapshot(f), before);
  const second = await prepare();
  await assert.rejects(database.$transaction(async (transaction) => {
    await transaction.asset.update({ where: { id: second.asset.id }, data: { notes: 'Mutation before receipt' } });
    await rawReceipt(transaction, second);
  }), /cannot create or update/i);
});

test('retirement document occupied locks return a retryable conflict and do not persist a receipt', async () => {
  const f = await prepare(); let acquired; let release; const ready = new Promise((resolve) => { acquired = resolve; }); const released = new Promise((resolve) => { release = resolve; });
  const holder = database.$transaction(async (transaction) => { await transaction.$executeRawUnsafe('LOCK TABLE "Asset" IN SHARE MODE'); acquired(); await released; });
  await ready;
  try { await assert.rejects(recordRetirementDocument(database, f.asset.id, f.documentInput, users.JEFE.id), (error) => error.code === 'RETIREMENT_DOCUMENT_BUSY'); }
  finally { release(); await holder; }
  assert.equal(await database.importRetirementReconciliation.count({ where: { assetId: f.asset.id } }), 0);
  assert.equal((await post(f.documentUrl, f.documentInput)).statusCode, 201);
});

test('retirement document refuses stale source interpretation instead of treating reconciliation as a source-conflict waiver', async () => {
  const f = await prepare(); const response = await post(f.base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 0, requestId: randomUUID(),
    note: 'Later catalog interpretation review', evidenceReference: 'Original model record', changes: [{ recordId: f.evidence.recordId, field: 'model', action: 'REPLACE', value: 'Model G10' }] });
  assert.equal(response.statusCode, 201, response.body);
  const plan = (await post(f.documentPlanUrl, f.planInput)).json(); assert.ok(codes(plan).includes('EVIDENCE_SOURCE_REVISED'));
  assert.equal((await post(f.documentUrl, f.documentInput)).json().code, 'RETIREMENT_DOCUMENT_BLOCKED');
  assert.equal(await database.importRetirementReconciliation.count({ where: { assetId: f.asset.id } }), 0);
  const base = `/inventory/imports/evidence/${f.evidence.id}`; const refresh = await post(base + '/amendment-plan', { assetId: f.asset.id }); assert.equal(refresh.statusCode, 200, refresh.body);
  const amendmentPlan = refresh.json(); const amended = await post(base + '/amendments', { requestId: randomUUID(), amendmentPlanId: amendmentPlan.amendmentPlanId,
    expectedEvidenceVersion: amendmentPlan.evidenceVersion, expectedBatchVersion: amendmentPlan.batchVersion, expectedSourceRevision: amendmentPlan.sourceRevision,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: f.asset.id, note: 'Explicit refresh from reviewed source interpretation', evidenceReference: 'Original model review' });
  assert.equal(amended.statusCode, 201, amended.body);
  const current = (await post(f.documentPlanUrl, f.planInput)).json(); assert.equal(current.source.sourceRevision, 1); assert.equal(current.source.evidenceVersion, 1);
  const applied = await post(f.documentUrl, { ...f.documentInput, planId: current.planId }); assert.equal(applied.statusCode, 201, applied.body);
  assert.deepEqual((await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: f.evidence.id } })).snapshot, f.evidence.snapshot);
});
