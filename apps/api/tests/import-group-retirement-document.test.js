import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { groupRetirementDocumentRequestDigest } from '../src/imports/group-retirement-document-schemas.js';
import { planGroupRetirementDocument } from '../src/imports/group-retirement-document-plan-service.js';
import { recordGroupRetirementDocument } from '../src/imports/group-retirement-document-service.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { hashPassword } from '../src/lib/password.js';
import { groupRetirementFixture } from './fixtures/group-retirement-import.js';
import { verifiedRetirementFixture } from './fixtures/verified-retirement-import.js';

const suffix = randomUUID().slice(0, 8); const users = {}; const cookies = {}; const productIds = []; let product;
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database);
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `grpdoc-${role.toLowerCase()}-${suffix}`; const password = 'Group-document-review-123';
    users[role] = await database.user.create({ data: { username, displayName: `Group document ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const cookie = response.headers['set-cookie']; cookies[role] = (Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Group documentary ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
after(async () => { await app.close(); await database.$disconnect(); });
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
const get = (url, role = 'JEFE') => app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } });
const codes = (plan) => plan.blockers.map((issue) => issue.code);
async function refresh(f, evidenceId = f.retirement.id) {
  const { plan: ignored, ...context } = f.input; void ignored;
  const input = { ...context, document: { evidenceId, note: 'Additional observation reviewed against existing terminal', evidenceReference: 'Archived inventory and current disposal record', acknowledgedWarnings: [] } };
  const first = await post(f.documentPlanUrl, input); assert.equal(first.statusCode, 200, first.body);
  input.acknowledgedGroupWarnings = first.json().groupWarnings.map((warning) => warning.id); input.document.acknowledgedWarnings = first.json().warnings.map((warning) => warning.id);
  const response = await post(f.documentPlanUrl, input); assert.equal(response.statusCode, 200, response.body);
  f.documentPlan = response.json(); f.documentPlanInput = input; f.documentInput = { requestId: randomUUID(), planId: f.documentPlan.planId,
    confirmation: 'RECONCILE_GROUP_RETIREMENT_DOCUMENT_ONLY', plan: input }; return f;
}
async function prepare(options = {}) {
  const f = await groupRetirementFixture({ database, product, post, get, terminal: true, ...options });
  f.documentPlanUrl = f.reviewUrl + '/retirement-document-plan'; f.documentUrl = f.documentPlanUrl + '/confirm'; f.documentsUrl = f.reviewUrl + '/retirement-documents';
  return refresh(f);
}
async function release(f) {
  const response = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Historical documentary review remains archived' }); assert.equal(response.statusCode, 201, response.body);
}
async function retire(f) {
  const first = await post(f.url, f.input); assert.equal(first.statusCode, 200, first.body);
  const input = { ...f.input, acknowledgedGroupWarnings: first.json().groupWarnings.map((warning) => warning.id), plan: { ...f.input.plan, acknowledgedWarnings: first.json().warnings.map((warning) => warning.id) } };
  const plan = await post(f.url, input); assert.equal(plan.statusCode, 200, plan.body);
  const response = await post(f.url + '/apply', { requestId: randomUUID(), planId: plan.json().planId, confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT', plan: input }); assert.equal(response.statusCode, 201, response.body); return response.json().application;
}
async function snapshot(f) {
  return { asset: await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }),
    evidence: await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' }, include: { amendments: { orderBy: { version: 'asc' } } } }),
    review: await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { rows: { orderBy: { recordId: 'asc' } }, decisions: { orderBy: { version: 'asc' } }, release: true } }),
    assignments: await database.assignment.findMany({ where: { assetId: f.asset.id } }),
    retirement: await database.importGroupRetirementApplication.findMany({ where: { assetId: f.asset.id } }),
    consumption: await database.importGroupRetirementRowUse.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { recordId: 'asc' } }),
    pilot: await database.importIdentityGroupRowUse.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { recordId: 'asc' } }),
    movements: await database.inventoryMovement.findMany({ where: { assetId: f.asset.id } }), stock: await database.inventoryStock.findUnique({ where: { productId: product.id } }) };
}

test('group document records dated and undated existing terminal observations with atomic audit and no operational or archive mutation', async () => {
  for (const undated of [false, true]) {
    const f = await prepare(); if (undated) { await database.asset.update({ where: { id: f.asset.id }, data: { decommissionedAt: null } }); await f.refreshDecision(); await refresh(f); }
    assert.equal(f.documentPlan.planValidationComplete, true, JSON.stringify(f.documentPlan.blockers)); const before = await snapshot(f);
    for (const flag of ['persisted','canApply','affectsCurrentState','evidenceRelinked','confirmsSourceDate','consumesOperationalEvidence']) assert.equal(f.documentPlan[flag], false);
    const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body); const result = response.json();
    assert.equal(result.reconciliation.plan.sourceRetirement.effectiveAt, null); assert.equal(result.reconciliation.plan.sourceRetirement.historicalActorId, null);
    assert.equal(result.reconciliation.plan.currentEvidence.assetId, null); assert.equal(result.reconciliation.plan.existingRetirement.effectiveAt, before.asset.decommissionedAt?.toISOString() ?? null);
    assert.deepEqual(await snapshot(f), before); const audit = await database.auditLog.findMany({ where: { entityId: result.reconciliation.id } }); assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'IMPORT_GROUP_RETIREMENT_DOCUMENT_RECONCILED'); assert.equal(audit[0].userId, users.JEFE.id);
    const detail = await get(f.documentsUrl + '/' + result.reconciliation.id); assert.equal(detail.statusCode, 200); assert.deepEqual(detail.json().reconciliation, result.reconciliation);
    const diagnostic = await post(f.reviewUrl + '/retirement-reconciliation', { groupKey: f.input.groupKey, assetId: f.asset.id, evidenceId: f.retirement.id });
    assert.equal(diagnostic.statusCode, 200); assert.equal(diagnostic.json().persisted, false); assert.equal(diagnostic.json().planId, undefined);
  }
});
test('group document permissions, CSRF, parent scope, dates, query and foreign confirmation are strict', async () => {
  const f = await prepare();
  for (const [url, input] of [[f.documentPlanUrl, f.documentPlanInput], [f.documentUrl, f.documentInput]]) {
    assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
    for (const role of ['COORDINADOR','SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
    assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403); assert.equal((await post(url + '?force=true', input)).statusCode, 400);
  }
  assert.equal((await post(f.documentPlanUrl, { ...f.documentPlanInput, document: { ...f.documentPlanInput.document, confirmedAt: null } })).statusCode, 400);
  assert.equal((await post(f.documentUrl, { ...f.documentInput, confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT' })).statusCode, 400);
  assert.equal((await post(f.documentPlanUrl.replace(f.batch.id, randomUUID()), f.documentPlanInput)).statusCode, 404);
  assert.equal((await get(f.documentsUrl, 'SOPORTE')).statusCode, 403); assert.equal((await get(f.documentsUrl + '?force=true')).statusCode, 400);
});
test('group document leaves nonterminal, invalid terminal chronology, wrong evidence kind and custody pending', async () => {
  const nonterminal = await prepare({ terminal: false }); assert.ok(codes(nonterminal.documentPlan).includes('EXISTING_TERMINAL_RETIREMENT_REQUIRED'));
  assert.equal((await post(nonterminal.documentUrl, nonterminal.documentInput)).json().code, 'GROUP_DOCUMENT_BLOCKED');
  const active = await prepare({ terminal: false, active: true }); assert.ok(codes(active.documentPlan).includes('ACTIVE_ASSIGNMENT_REQUIRES_RETURN'));
  const f = await prepare(); const receipt = f.capture.items.find((entry) => entry.kind === 'RECEIPT_OBSERVATION'); await refresh(f, receipt.id); assert.ok(codes(f.documentPlan).includes('RETIREMENT_EVIDENCE_KIND_REQUIRED'));
  for (const date of ['1899-01-01','2999-01-01','1999-01-01']) {
    await database.asset.update({ where: { id: f.asset.id }, data: { decommissionedAt: new Date(date) } });
    await f.refreshDecision(); await refresh(f); assert.equal(f.documentPlan.planValidationComplete, false);
  }
});
test('group document revalidates current full asset and exact warnings before recording', async () => {
  const f = await prepare(); assert.ok(f.documentPlan.warnings.length > 0);
  const missing = await post(f.documentPlanUrl, { ...f.documentPlanInput, document: { ...f.documentPlanInput.document, acknowledgedWarnings: [] } });
  assert.ok(codes(missing.json()).includes('WARNINGS_NOT_ACKNOWLEDGED'));
  assert.equal((await post(f.documentUrl, { ...f.documentInput, planId: missing.json().planId, plan: missing.json().request })).json().code, 'GROUP_DOCUMENT_BLOCKED');
  assert.equal((await post(f.documentUrl, { ...f.documentInput, planId: 'f'.repeat(64) })).json().code, 'GROUP_DOCUMENT_PLAN_CHANGED');
  await database.asset.update({ where: { id: f.asset.id }, data: { notes: 'Subsequent terminal metadata review' } });
  assert.equal((await post(f.documentUrl, f.documentInput)).json().code, 'IDENTITY_GROUP_PROJECTION_CHANGED');
  assert.equal(await database.importGroupRetirementDocument.count({ where: { reviewId: f.review.id } }), 0);
  await f.refreshDecision(); await refresh(f); assert.equal((await post(f.documentUrl, f.documentInput)).statusCode, 201);
});
test('group document uses a fresh decision after V29 retirement and documents only omitted evidence without changing consumed rows or retirement receipt', async () => {
  const f = await prepare({ terminal: false }); const receipt = await retire(f); await f.refreshDecision(); await refresh(f);
  assert.ok(codes(f.documentPlan).includes('EVIDENCE_ALREADY_APPLIED'));
  const omitted = f.capture.items.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION' && entry.id !== receipt.evidenceId); await refresh(f, omitted.id);
  assert.equal(f.documentPlan.planValidationComplete, true, JSON.stringify(f.documentPlan.blockers)); const before = await snapshot(f);
  const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().reconciliation.plan.existingRetirement.dateOrigin, 'GROUP_VERIFIED_IMPORT_RECEIPT'); assert.deepEqual(await snapshot(f), before);
});
test('group document retries recover the same immutable receipt after cancellation without granting new authority', async () => {
  const f = await prepare(); const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body); const receipt = response.json().reconciliation;
  assert.equal((await post(f.documentUrl, { ...f.documentInput, plan: { ...f.documentPlanInput, document: { ...f.documentPlanInput.document, note: 'Different intent' } } })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(recordGroupRetirementDocument(database, f.batch.id, f.review.id, f.documentInput, users.SOPORTE.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await post(f.documentUrl, { ...f.documentInput, requestId: randomUUID() })).json().code, 'GROUP_DOCUMENT_BLOCKED');
  await release(f); const repeated = await post(f.documentUrl, f.documentInput); assert.equal(repeated.statusCode, 200, repeated.body); assert.equal(repeated.json().reused, true); assert.deepEqual(repeated.json().reconciliation, receipt);
  assert.equal((await post(f.documentPlanUrl, f.documentPlanInput)).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
  assert.equal((await post(f.documentUrl, { ...f.documentInput, requestId: randomUUID() })).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
  const list = (await get(f.documentsUrl + '?limit=1')).json(); assert.equal(list.total, 1); assert.equal(list.reconciliations[0].plan, undefined);
  assert.equal((await get(f.documentsUrl + '?offset=1')).json().reconciliations.length, 0); assert.equal((await get(f.documentsUrl + '/' + receipt.id)).statusCode, 200);
  assert.equal((await get(f.documentsUrl.replace(f.batch.id, randomUUID()) + '/' + receipt.id)).statusCode, 404);
});
test('group document without a prior receipt cannot confirm a released administrative review', async () => {
  const f = await prepare(); await release(f); assert.equal((await post(f.documentUrl, f.documentInput)).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
  assert.equal(await database.importGroupRetirementDocument.count({ where: { reviewId: f.review.id } }), 0);
});
test('group document keeps physical groups independent even when they share the same original candidate', async () => {
  const f = await prepare({ split: true }); assert.equal(f.documentPlan.planValidationComplete, true, JSON.stringify(f.documentPlan.blockers));
  assert.equal(f.documentPlan.sourceRows.length, 1); const before = await snapshot(f); const partner = await database.asset.findUniqueOrThrow({ where: { id: f.partner.id } });
  const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(await snapshot(f), before); assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: partner.id } }), partner);
});
test('group document rolls back receipt on audit failure and concurrent retries produce a single receipt', async () => {
  const f = await prepare(); const before = await snapshot(f);
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_GROUP_RETIREMENT_DOCUMENT_RECONCILED') throw new Error('Injected group documentary audit failure'); return query(args);
  } } } });
  await assert.rejects(recordGroupRetirementDocument(failing, f.batch.id, f.review.id, f.documentInput, users.JEFE.id), /Injected group documentary audit failure/);
  assert.deepEqual(await snapshot(f), before); assert.equal(await database.importGroupRetirementDocument.count({ where: { reviewId: f.review.id } }), 0);
  const responses = await Promise.all([post(f.documentUrl, f.documentInput), post(f.documentUrl, f.documentInput)]);
  assert.ok(responses.some((item) => item.statusCode === 201), responses.map((item) => item.body).join('\n'));
  assert.ok(responses.every((item) => [200,201,409].includes(item.statusCode))); assert.equal((await post(f.documentUrl, f.documentInput)).statusCode, 200);
  assert.equal(await database.importGroupRetirementDocument.count({ where: { reviewId: f.review.id } }), 1);
});
test('group document storage absence is explicitly unavailable', async () => {
  const f = await prepare(); const missing = database.$extends({ query: { importGroupRetirementDocument: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing group document storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportGroupRetirementDocument' } });
  } } } }); const isolated = buildApp(missing);
  try { const response = await post(f.documentPlanUrl, f.documentPlanInput, 'JEFE', true, isolated); assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY'); }
  finally { await isolated.close(); }
});
test('group document plans read one repeatable snapshot while terminal metadata changes concurrently', async () => {
  const f = await prepare(); let triggered = false;
  const concurrent = database.$extends({ query: { asset: { async findUniqueOrThrow({ args, query }) {
    if (!triggered) { triggered = true; await database.asset.update({ where: { id: f.asset.id }, data: { notes: 'Concurrent terminal review' } }); }
    return query(args);
  } } } });
  const plan = await planGroupRetirementDocument(concurrent, f.batch.id, f.review.id, f.documentPlanInput);
  assert.equal(triggered, true); assert.equal(plan.assetSnapshot.notes, f.documentPlan.assetSnapshot.notes); assert.equal(plan.planId, f.documentPlan.planId);
  assert.equal((await post(f.documentUrl, f.documentInput)).json().code, 'IDENTITY_GROUP_PROJECTION_CHANGED');
});
test('group document cannot duplicate a V30 confirmation made before the source was grouped', async () => {
  const legacy = await verifiedRetirementFixture({ database, product, actorId: users.JEFE.id, post, get, retired: true });
  const documentUrl = '/assets/' + legacy.asset.id + '/imported-retirement-document-plan';
  const document = { evidenceId: legacy.evidence.id, note: 'Earlier independent documentary review', evidenceReference: 'Archived original inventory', acknowledgedWarnings: [] };
  const first = await post(documentUrl, document); document.acknowledgedWarnings = first.json().warnings.map((warning) => warning.id);
  const plan = await post(documentUrl, document);
  const applied = await post(documentUrl + '/confirm', { requestId: randomUUID(), planId: plan.json().planId, confirmation: 'RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY', plan: document }); assert.equal(applied.statusCode, 201, applied.body);
  const proposal = { expectedVersion: 2, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS', candidateIds: legacy.preview.candidates.map((entry) => entry.id),
    note: 'Later administrative review of physical identity', groups: [{ groupId: randomUUID(), recordIds: legacy.preview.records.map((entry) => entry.id), serialNumber: legacy.asset.serialNumber, assetTag: null, evidenceReference: 'Physical serial checked' }] };
  const groupPlan = await post(legacy.base + '/identity-group-plan', proposal); assert.equal(groupPlan.statusCode, 200, groupPlan.body);
  const reserved = await post(legacy.base + '/identity-group-reviews', { requestId: randomUUID(), planId: groupPlan.json().planId, confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: proposal }); assert.equal(reserved.statusCode, 201, reserved.body);
  const review = reserved.json().review; const reviewUrl = legacy.base + '/identity-group-reviews/' + review.id; const projection = (await get(reviewUrl + '/effective-preview')).json(); const group = projection.groups[0];
  const saved = await post(reviewUrl + '/decisions', { requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY', expectedDecisionVersion: 0,
    expectedBatchVersion: projection.batchVersion, expectedSourceRevision: projection.sourceRevision, projectionId: projection.projectionId, groupKey: group.groupKey, action: 'LINK_EXISTING', linkedAssetId: legacy.asset.id,
    note: 'Review prior documentary source without reapplying it', evidenceReference: 'Physical identity and original archive', evidenceReviews: group.evidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion,
      disposition: 'EXCLUDE_FROM_GROUP_PILOT', note: 'Prior document retained independently', evidenceReference: 'Existing documentary receipt' })) }); assert.equal(saved.statusCode, 201, saved.body);
  const f = { ...legacy, retirement: legacy.evidence, review, reviewUrl, documentPlanUrl: reviewUrl + '/retirement-document-plan',
    input: { expectedBatchVersion: projection.batchVersion, expectedSourceRevision: projection.sourceRevision, expectedDecisionVersion: saved.json().decisionVersion,
      expectedEvidenceVersion: 0, projectionId: projection.projectionId, groupKey: group.groupKey, decisionId: saved.json().decision.id, acknowledgedGroupWarnings: [] } };
  await refresh(f); assert.ok(codes(f.documentPlan).includes('RETIREMENT_DOCUMENT_ALREADY_RECONCILED'));
  assert.equal((await post(f.documentPlanUrl + '/confirm', f.documentInput)).json().code, 'GROUP_DOCUMENT_BLOCKED');
  await assert.rejects(database.$transaction((transaction) => rawReceipt(transaction, f)), /duplicate documentary/i);
});
test('group documentary SQL prevents V30 duplicate and V30 planner exposes the version already documented after release', async () => {
  const f = await prepare(); const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body);
  await assert.rejects(database.importRetirementReconciliation.create({ data: { assetId: f.asset.id, evidenceId: f.retirement.id, evidenceVersion: 0, sourceRevision: 0,
    requestId: randomUUID(), requestDigest: 'a'.repeat(64), planId: 'b'.repeat(64), rulesVersion: 'mda-retirement-document-1', plan: {}, recordedById: users.JEFE.id } }), /already has a group documentary/i);
  await release(f);
  const independent = await post('/assets/' + f.asset.id + '/imported-retirement-document-plan', f.documentPlanInput.document); assert.equal(independent.statusCode, 200, independent.body);
  assert.ok(codes(independent.json()).includes('RETIREMENT_DOCUMENT_ALREADY_RECONCILED'));
});

async function rawReceipt(transaction, f, change = {}) {
  const [clock] = await transaction.$queryRaw`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "recordedAt"`;
  const p = f.documentPlan;
  return transaction.importGroupRetirementDocument.create({ data: { batchId: f.batch.id, reviewId: f.review.id, decisionId: p.decisionId, groupId: p.groupId, groupKey: p.groupKey,
    sourceHash: p.sourceHash, assetId: f.asset.id, evidenceId: p.source.evidenceId, evidenceVersion: p.source.evidenceVersion, amendmentId: p.source.amendmentId, sourceRevision: p.source.sourceRevision,
    requestId: f.documentInput.requestId, requestDigest: groupRetirementDocumentRequestDigest(f.documentInput), planId: p.planId, rulesVersion: p.rulesVersion, plan: p, recordedById: users.JEFE.id, recordedAt: clock.recordedAt, ...change } });
}
async function rawAudit(transaction, receipt) {
  return transaction.auditLog.create({ data: { userId: receipt.recordedById, action: 'IMPORT_GROUP_RETIREMENT_DOCUMENT_RECONCILED', entityType: 'ImportGroupRetirementDocument', entityId: receipt.id,
    metadata: { batchId: receipt.batchId, reviewId: receipt.reviewId, assetId: receipt.assetId, evidenceId: receipt.evidenceId, evidenceVersion: receipt.evidenceVersion, planId: receipt.planId, affectsCurrentState: false, confirmsSourceDate: false, consumesOperationalEvidence: false } } });
}
test('group document SQL rejects forged actor, versions, transaction marker, full snapshot, intent digest and missing atomic audit', async () => {
  const f = await prepare();
  for (const change of [{ recordedById: users.SOPORTE.id }, { createdTransactionId: '1' }, { evidenceVersion: 1, amendmentId: randomUUID() }, { requestDigest: 'f'.repeat(64) },
    { plan: { ...f.documentPlan, assetSnapshot: { ...f.documentPlan.assetSnapshot, notes: 'Forged terminal' } } },
    { plan: { ...f.documentPlan, sourceConsumption: [{ origin: 'GROUP_RETIREMENT' }] } }]) {
    await assert.rejects(database.$transaction((transaction) => rawReceipt(transaction, f, change)), /document|terminal|archive|constraint/i);
  }
  await assert.rejects(database.$transaction((transaction) => rawReceipt(transaction, f)), /atomic audit/i);
  const id = randomUUID(); const oldAudit = await rawAudit(database, { ...f.documentPlan.source, batchId: f.batch.id, reviewId: f.review.id,
    id, assetId: f.asset.id, planId: f.documentPlan.planId, recordedById: users.JEFE.id });
  await assert.rejects(database.$transaction((transaction) => rawReceipt(transaction, f, { id })), /atomic audit/i);
  await database.auditLog.delete({ where: { id: oldAudit.id } });
  assert.equal(await database.importGroupRetirementDocument.count({ where: { reviewId: f.review.id } }), 0);
});
test('group document SQL does not accept a self-rehashed supplied retirement date or incomplete archive coverage', async () => {
  const f = await prepare();
  for (const transform of [(plan) => { plan.request.document.confirmedAt = '2005-01-01'; }, (plan) => { plan.evidenceCoverage.pop(); },
    (plan) => { plan.retirementReceipts = [{ id: randomUUID(), origin: 'GROUP' }]; }, (plan) => { plan.proposedEvidenceProjection.assetId = randomUUID(); }]) {
    const plan = JSON.parse(JSON.stringify(f.documentPlan)); transform(plan); const { planId: ignored, mode, persisted, canApply, planValidationComplete, ...content } = plan; void ignored; void mode; void persisted; void canApply; void planValidationComplete;
    plan.planId = importPlanDigest(content); const input = { ...f.documentInput, planId: plan.planId, plan: plan.request };
    await assert.rejects(database.$transaction((transaction) => rawReceipt(transaction, f, { plan, planId: plan.planId, requestDigest: groupRetirementDocumentRequestDigest(input) })), /document|archive|identit/i);
  }
});
test('group document SQL seals same-transaction context even after early constraints and cannot manufacture a terminal before recording', async () => {
  const f = await prepare();
  await assert.rejects(database.$transaction(async (transaction) => { await transaction.asset.update({ where: { id: f.asset.id }, data: { notes: 'Same transaction' } }); await rawReceipt(transaction, f); }), /preexisting|terminal/i);
  for (const mutate of [
    (transaction) => transaction.asset.update({ where: { id: f.asset.id }, data: { notes: 'Mutation after receipt' } }),
    (transaction) => transaction.product.update({ where: { id: product.id }, data: { name: 'Mutation after receipt' } }),
    (transaction) => transaction.user.update({ where: { id: users.JEFE.id }, data: { displayName: 'Mutation after receipt' } }),
    (transaction) => transaction.importIdentityGroupRow.updateMany({ where: { reviewId: f.review.id }, data: { isReserved: false } })
  ]) {
    await assert.rejects(database.$transaction(async (transaction) => { const receipt = await rawReceipt(transaction, f); await rawAudit(transaction, receipt);
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); await transaction.$executeRawUnsafe('SAVEPOINT documentary_context'); await mutate(transaction);
    }), /documentary context|immutable/i);
  }
  assert.equal((await post(f.documentUrl, f.documentInput)).statusCode, 201);
});
test('group documentary receipts and audits are immutable while unrelated deletes are not suppressed', async () => {
  const f = await prepare(); const response = await post(f.documentUrl, f.documentInput); assert.equal(response.statusCode, 201, response.body); const id = response.json().reconciliation.id;
  await assert.rejects(database.importGroupRetirementDocument.update({ where: { id }, data: { recordedAt: new Date() } }), /immutable/i);
  await assert.rejects(database.importGroupRetirementDocument.delete({ where: { id } }), /immutable/i);
  await assert.rejects(database.auditLog.deleteMany({ where: { entityId: id } }), /immutable/i);
  await assert.rejects(database.$transaction((transaction) => transaction.$executeRawUnsafe('TRUNCATE "ImportGroupRetirementDocument"')), /immutable/i);
  const unrelated = await database.auditLog.create({ data: { userId: users.JEFE.id, entityType: 'Unrelated', entityId: randomUUID(), action: 'UNRELATED_DOCUMENTARY_TEST' } });
  assert.equal((await database.auditLog.delete({ where: { id: unrelated.id } })).id, unrelated.id);
});
