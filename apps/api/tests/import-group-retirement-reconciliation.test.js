import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { reconcileGroupRetirement } from '../src/imports/group-retirement-reconciliation-service.js';
import { hashPassword } from '../src/lib/password.js';
import { groupRetirementFixture } from './fixtures/group-retirement-import.js';

const suffix = randomUUID().slice(0, 8); const productIds = []; const cookies = {}; const users = {}; let product;
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database);
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `grouprecon-${role.toLowerCase()}-${suffix}`; const password = 'Group-reconciliation-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Group reconciliation ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Group reconciliation ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
after(async () => { await app.close(); await database.$disconnect(); });
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
const get = (url) => app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } });
async function prepare(options = {}) {
  const f = await groupRetirementFixture({ database, product, post, get, terminal: true, ...options });
  return { ...f, reconciliationUrl: f.reviewUrl + '/retirement-reconciliation',
    reconciliationInput: { groupKey: f.input.groupKey, assetId: f.asset.id, evidenceId: f.retirement.id } };
}
async function retire(f) {
  const first = await post(f.url, f.input); assert.equal(first.statusCode, 200, first.body);
  const planInput = { ...f.input, acknowledgedGroupWarnings: first.json().groupWarnings.map((entry) => entry.id),
    plan: { ...f.input.plan, acknowledgedWarnings: first.json().warnings.map((entry) => entry.id) } };
  const plan = await post(f.url, planInput); assert.equal(plan.statusCode, 200, plan.body);
  const input = { requestId: randomUUID(), planId: plan.json().planId, confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT', plan: planInput };
  const response = await post(f.url + '/apply', input); assert.equal(response.statusCode, 201, response.body); return { ...response.json().application, input };
}
async function release(f) {
  const response = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Administrative release preserves historical evidence' });
  assert.equal(response.statusCode, 201, response.body);
}
const codes = (result) => result.diagnostics.map((issue) => issue.code);
const assess = (f, input = f.reconciliationInput) => post(f.reconciliationUrl, input);
async function snapshot(f) {
  return { asset: await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }), assignments: await database.assignment.findMany({ where: { assetId: f.asset.id } }),
    review: await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { rows: { orderBy: { recordId: 'asc' } }, release: true, decisions: { orderBy: { version: 'asc' } } } }),
    evidence: await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' }, include: { amendments: { orderBy: { version: 'asc' } } } }),
    consumption: await database.importGroupRetirementRowUse.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { recordId: 'asc' } }),
    pilotConsumption: await database.importIdentityGroupRowUse.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { recordId: 'asc' } }),
    retirements: await database.importGroupRetirementApplication.findMany({ where: { reviewId: f.review.id }, orderBy: { id: 'asc' } }),
    documents: await database.importRetirementReconciliation.findMany({ where: { evidenceId: { in: f.capture.items.map((entry) => entry.id) } }, orderBy: { id: 'asc' } }),
    batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }), auditCount: await database.auditLog.count(),
    movements: await database.inventoryMovement.findMany({ where: { assetId: f.asset.id } }), stock: await database.inventoryStock.findUnique({ where: { productId: product.id } }) };
}

test('group retirement reconciliation requires JEFE and CSRF with strict body, query and exact parent/group membership', async () => {
  const f = await prepare();
  assert.equal((await app.inject({ method: 'POST', url: f.reconciliationUrl, payload: f.reconciliationInput })).statusCode, 401);
  for (const role of ['COORDINADOR','SOPORTE']) assert.equal((await post(f.reconciliationUrl, f.reconciliationInput, role)).statusCode, 403);
  assert.equal((await post(f.reconciliationUrl, f.reconciliationInput, 'JEFE', false)).statusCode, 403);
  for (const change of [{ confirmedAt: null }, { force: true }, { confirmation: 'RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY' }, { acknowledgedWarnings: [] }]) {
    assert.equal((await assess(f, { ...f.reconciliationInput, ...change })).statusCode, 400);
  }
  assert.equal((await post(f.reconciliationUrl + '?force=true', f.reconciliationInput)).statusCode, 400);
  for (const change of [{ groupKey: 'f'.repeat(64) }, { evidenceId: randomUUID() }, { assetId: randomUUID() }]) assert.equal((await assess(f, { ...f.reconciliationInput, ...change })).statusCode, 404);
  assert.equal((await post(`/inventory/imports/batches/${randomUUID()}/identity-group-reviews/${f.review.id}/retirement-reconciliation`, f.reconciliationInput)).statusCode, 404);
  const other = await prepare(); assert.equal((await assess(f, { ...f.reconciliationInput, evidenceId: other.retirement.id })).statusCode, 404);
});

test('group retirement reconciliation of active dated and undated terminals is deterministic, read-only and cannot serve as any confirmation', async () => {
  const f = await prepare();
  for (const decommissionedAt of [new Date('2004-01-01'), null]) {
    await database.asset.update({ where: { id: f.asset.id }, data: { decommissionedAt } });
    const before = await snapshot(f); const response = await assess(f); assert.equal(response.statusCode, 200, response.body); const result = response.json();
    assert.equal(result.classification, decommissionedAt ? 'EXISTING_DATED_RETIREMENT' : 'EXISTING_UNDATED_RETIREMENT');
    assert.equal(result.sourceRetirement.effectiveAt, null); assert.equal(result.sourceRetirement.historicalActorId, null); assert.equal(result.currentEvidence.assetId, null);
    assert.equal(result.diagnosticEvidenceProjection.linkBasis.authorizationGranted, false); assert.equal(result.currentLinkAuthorized, false);
    for (const flag of ['canApply','persisted','affectsCurrentState','evidenceRelinked','documentConfirmationImplemented','operationalResolutionImplemented']) assert.equal(result[flag], false);
    assert.equal(result.planId, undefined); assert.equal((await assess(f)).json().assessmentId, result.assessmentId);
    assert.equal((await post(f.url + '/apply', result)).statusCode, 400);
    assert.equal((await post(`/assets/${f.asset.id}/imported-retirement-document-plan/confirm`, result)).statusCode, 400);
    assert.deepEqual(await snapshot(f), before);
  }
});

test('group retirement reconciliation leaves nonterminal and active-custody observations pending without assigning a retirement date', async () => {
  const f = await prepare({ terminal: false }); const pending = await assess(f); assert.equal(pending.statusCode, 200, pending.body);
  assert.equal(pending.json().classification, 'RETIREMENT_DATE_UNCONFIRMED'); assert.equal(pending.json().existingRetirement, null);
  const active = await prepare({ terminal: false, active: true }); const before = await snapshot(active); const response = await assess(active);
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().classification, 'CURRENT_CUSTODY_CONFLICT');
  assert.ok(codes(response.json()).includes('ACTIVE_ASSIGNMENT_REQUIRES_RETURN')); assert.deepEqual(await snapshot(active), before);
  const wrongKind = f.capture.items.find((entry) => entry.kind === 'RECEIPT_OBSERVATION');
  const receipt = await assess(f, { ...f.reconciliationInput, evidenceId: wrongKind.id }); assert.equal(receipt.json().sourceRetirement, null);
  assert.ok(codes(receipt.json()).includes('RETIREMENT_EVIDENCE_KIND_REQUIRED'));
});

test('group retirement reconciliation distinguishes applied V29 evidence from omitted observations on consumed rows', async () => {
  const f = await prepare({ terminal: false }); const receipt = await retire(f); const before = await snapshot(f);
  const response = await assess(f); assert.equal(response.statusCode, 200, response.body); const result = response.json();
  assert.equal(result.classification, 'ALREADY_GROUP_IMPORTED_RETIREMENT'); assert.equal(result.evidenceState, 'USED_FOR_THIS_RETIREMENT');
  assert.equal(result.sourceRowState, 'CONSUMED'); assert.equal(result.retirementReceipts[0].id, receipt.id); assert.equal(result.retirementReceipts[0].plan, undefined);
  assert.equal(result.existingRetirement.effectiveAt, receipt.decommissionedAt); assert.equal(result.existingRetirement.confirmsSourceDate, false);
  assert.equal((await get(result.links[0].url)).json().application.id, receipt.id);
  const omitted = f.capture.items.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION' && entry.id !== f.retirement.id);
  const other = await assess(f, { ...f.reconciliationInput, evidenceId: omitted.id }); assert.equal(other.statusCode, 200, other.body);
  assert.equal(other.json().classification, 'EXISTING_GROUP_IMPORTED_RETIREMENT'); assert.equal(other.json().evidenceState, 'SOURCE_ROW_CONSUMED');
  assert.equal(other.json().sourceRetirement.effectiveAt, null); assert.deepEqual(await snapshot(f), before);
});

test('group retirement reconciliation remains available after release without restoring projection authority or releasing committed consumption', async () => {
  const f = await prepare({ terminal: false }); const receipt = await retire(f); await release(f); const before = await snapshot(f);
  const response = await assess(f); assert.equal(response.statusCode, 200, response.body); const result = response.json();
  assert.equal(result.reviewState, 'RELEASED'); assert.equal(result.sourceRowState, 'CONSUMED'); assert.equal(result.activeReservations.length, 0);
  assert.equal(result.classification, 'ALREADY_GROUP_IMPORTED_RETIREMENT'); assert.ok(codes(result).includes('GROUP_REVIEW_RELEASED'));
  assert.equal((await get(f.reviewUrl + '/effective-preview')).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
  assert.equal((await post(`/assets/${f.asset.id}/imported-retirement-plan`, receipt.input.plan.plan)).json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  assert.equal((await post(`/assets/${f.asset.id}/imported-retirement-document-plan`, { evidenceId: f.retirement.id, note: 'No bypass', evidenceReference: 'Archived source', acknowledgedWarnings: [] })).json().code, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
  assert.deepEqual(await snapshot(f), before);
});

test('group retirement reconciliation shows a later reservation of released source as a different owner, never as reactivated old authority', async () => {
  const f = await prepare(); await release(f);
  const plan = await post(f.base + '/identity-group-plan', f.proposal); assert.equal(plan.statusCode, 200, plan.body);
  const reserved = await post(f.base + '/identity-group-reviews', { requestId: randomUUID(), planId: plan.json().planId, confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: f.proposal });
  assert.equal(reserved.statusCode, 201, reserved.body); const before = await snapshot(f);
  const response = await assess(f); assert.equal(response.statusCode, 200, response.body); const result = response.json();
  assert.equal(result.reviewState, 'RELEASED'); assert.equal(result.sourceRowState, 'UNCONSUMED'); assert.ok(codes(result).includes('GROUP_SOURCE_RESERVED_BY_ANOTHER_REVIEW'));
  assert.equal(result.activeReservations.every((row) => row.reviewId === reserved.json().review.id), true); assert.deepEqual(await snapshot(f), before);
});

test('group retirement reconciliation exposes identity revisions after release instead of treating the old grouping as current identity', async () => {
  const f = await prepare(); await release(f);
  const response = await post(f.base + '/identity-revisions', { requestId: randomUUID(), expectedRevision: 0, expectedBatchVersion: 1, candidateId: f.proposal.candidateIds[0],
    action: 'VERIFY', confirmation: 'VERIFIED_PHYSICAL_IDENTITY', serialNumber: 'LATER-IDENTITY-' + randomUUID(), assetTag: null,
    note: 'Independent identity verification after administrative release', evidenceReference: 'New physical label review' }); assert.equal(response.statusCode, 201, response.body);
  const before = await snapshot(f); const assessed = await assess(f); assert.equal(assessed.statusCode, 200, assessed.body); const result = assessed.json();
  assert.equal(result.classification, 'EVIDENCE_REVIEW_REQUIRED'); assert.ok(codes(result).includes('GROUP_SOURCE_IDENTITY_REVISED'));
  assert.ok(result.identityRevisedRecordIds.length > 0); assert.equal(result.sourceRevision, 1); assert.equal(result.reviewedSourceRevision, 0);
  assert.equal(result.currentLinkAuthorized, false); assert.deepEqual(await snapshot(f), before);
});

test('group retirement reconciliation uses one repeatable-read snapshot while a concurrent grouped retirement commits', async () => {
  const f = await prepare({ terminal: false }); let triggered = false;
  const concurrent = database.$extends({ query: { importGroupRetirementApplication: { async findMany({ args, query }) {
    if (!triggered) { triggered = true; await retire(f); }
    return query(args);
  } } } });
  const result = await reconcileGroupRetirement(concurrent, f.batch.id, f.review.id, f.reconciliationInput);
  assert.equal(triggered, true); assert.equal(result.currentState, 'NONTERMINAL'); assert.equal(result.sourceRowState, 'UNCONSUMED'); assert.equal(result.retirementReceipts.length, 0);
  const current = (await assess(f)).json(); assert.equal(current.classification, 'ALREADY_GROUP_IMPORTED_RETIREMENT'); assert.equal(current.sourceRowState, 'CONSUMED');
  assert.notEqual(result.assessmentId, current.assessmentId);
});

test('group retirement reconciliation fails clearly for missing storage and oversized context without truncating a successful diagnostic', async () => {
  const f = await prepare();
  const missing = database.$extends({ query: { importGroupRetirementApplication: { async findMany() {
    throw new Prisma.PrismaClientKnownRequestError('Missing grouped retirement storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportGroupRetirementApplication' } });
  } } } });
  const isolated = buildApp(missing);
  try {
    const response = await post(f.reconciliationUrl, f.reconciliationInput, 'JEFE', true, isolated); assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
  } finally { await isolated.close(); }
  for (const model of ['assignment', 'importSourceRevision', 'importHistoricalEvidence']) {
    const oversized = database.$extends({ query: { [model]: { async findMany({ args, query }) {
      if (model === 'importHistoricalEvidence') { const rows = await query(args); return Array(101).fill(rows.find((entry) => entry.id === f.retirement.id)); }
      return Array(args.take).fill({});
    } } } });
    await assert.rejects(reconcileGroupRetirement(oversized, f.batch.id, f.review.id, f.reconciliationInput), (error) => ['GROUP_RECONCILIATION_LIMIT','SOURCE_REVISION_LIMIT'].includes(error.code));
  }
});

test('group retirement reconciliation keeps independent physical groups separate when an original candidate has partially consumed rows', async () => {
  const f = await prepare({ terminal: false, split: true }); await retire(f);
  const applied = await assess(f); assert.equal(applied.statusCode, 200, applied.body); assert.equal(applied.json().sourceRowState, 'CONSUMED');
  const partner = f.projection.groups.find((entry) => entry.groupId !== f.targetGroupId);
  const evidence = f.capture.items.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION' && partner.recordIds.includes(entry.recordId));
  const response = await assess(f, { groupKey: partner.groupKey, assetId: f.partner.id, evidenceId: evidence.id }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().sourceRowState, 'UNCONSUMED'); assert.equal(response.json().retirementReceipts.length, 0); assert.equal(response.json().currentState, 'NONTERMINAL');
  assert.equal(response.json().currentLinkAuthorized, false); assert.equal(response.json().sourceRows.length, 1);
});
