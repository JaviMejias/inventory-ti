import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { getIdentityGroupProjection } from '../src/imports/identity-group-projection-service.js';
import { hashPassword } from '../src/lib/password.js';
import { closedAssignmentFixture } from './fixtures/closed-assignment-import.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const users = {}; const cookies = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'groupprojection-' + role.toLowerCase() + '-' + suffix; const password = 'Group-projection-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group projection ' + role, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group projection ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload) {
  const cookie = cookies.JEFE; const token = (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
  return app.inject({ method: 'POST', url, payload, headers: { cookie, 'x-csrf-token': token } });
}
function get(url, role = 'JEFE', instance = app) { return instance.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function proposal(preview, version = 1, candidateIds = preview.candidates.map((entry) => entry.id)) {
  return { expectedVersion: version, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS', candidateIds, note: 'Physical source groups verified',
    groups: preview.records.filter((record) => preview.candidates.some((candidate) => candidateIds.includes(candidate.id) && candidate.recordIds.includes(record.id)))
      .map((record) => ({ groupId: randomUUID(), recordIds: [record.id], serialNumber: ('PROJECTION-VERIFIED-' + randomUUID()).toUpperCase(), assetTag: null, evidenceReference: 'Physical label verified' })) };
}
async function reserve(fixture) {
  const response = await post(fixture.base + '/identity-group-plan', fixture.proposal); assert.equal(response.statusCode, 200, response.body);
  const saved = await post(fixture.base + '/identity-group-reviews', { requestId: randomUUID(), planId: response.json().planId,
    confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: fixture.proposal }); assert.equal(saved.statusCode, 201, saved.body);
  const review = saved.json().review; const reviewUrl = fixture.base + '/identity-group-reviews/' + review.id;
  return { ...fixture, review, reviewUrl, url: reviewUrl + '/effective-preview' };
}
async function prepare(outside = false) {
  const serial = ('PROJECTION-ORIGINAL-' + randomUUID()).toUpperCase();
  const source = workbook('Recepción', [receptionRow(4, serial, { K: textCell('Disponible') }), receptionRow(5, serial, { K: textCell('Disponible') }),
    ...(outside ? [receptionRow(6, 'PROJECTION-OUTSIDE-' + randomUUID())] : [])]); source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body); const preview = previewed.json();
  const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch; const base = '/inventory/imports/batches/' + batch.id;
  const candidates = preview.candidates.filter((candidate) => candidate.serials.includes(serial));
  return reserve({ source, preview, batch, base, proposal: proposal(preview, 1, candidates.map((candidate) => candidate.id)) });
}
async function snapshot(f) {
  return { batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }),
    review: await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { rows: { orderBy: { recordId: 'asc' } }, release: true } }),
    decisions: await database.importReviewDecision.findMany({ where: { batchId: f.batch.id }, orderBy: { id: 'asc' } }),
    revisions: await database.importSourceRevision.count({ where: { batchId: f.batch.id } }), evidence: await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' } }),
    assets: await database.asset.findMany({ orderBy: { id: 'asc' } }), assignments: await database.assignment.count({ where: { asset: { productId: product.id } } }),
    stock: await database.inventoryStock.count({ where: { productId: product.id } }), audit: await database.auditLog.count({ where: { OR: [{ entityId: f.batch.id }, { entityId: f.review.id }] } }) };
}
function release(f) { return post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Abandon proposal without changing source' }); }

test('identity group effective preview requires JEFE, active review ownership and strict read-only query parameters', async () => {
  const f = await prepare(); assert.equal((await app.inject({ method: 'GET', url: f.url })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await get(f.url, role)).statusCode, 403);
  for (const query of ['?force=true', '?asOf=2000-01-01', '?sourceRevision=0', '?groupId=' + randomUUID()]) assert.equal((await get(f.url + query)).statusCode, 400);
  assert.equal((await get('/inventory/imports/batches/' + randomUUID() + '/identity-group-reviews/' + f.review.id + '/effective-preview')).statusCode, 404);
  assert.equal((await get(f.base + '/identity-group-reviews/' + randomUUID() + '/effective-preview')).statusCode, 404);
  const normal = await get(f.url); assert.equal(normal.statusCode, 200);
  const upper = await get('/inventory/imports/batches/' + f.batch.id.toUpperCase() + '/identity-group-reviews/' + f.review.id.toUpperCase() + '/effective-preview');
  assert.equal(upper.statusCode, 200, upper.body); assert.equal(upper.json().projectionId, normal.json().projectionId);
});

test('identity group effective preview is deterministic, bounded and preserves current inventory, source and administrative receipts', async () => {
  const f = await prepare(); const before = await snapshot(f);
  const response = await get(f.url); assert.equal(response.statusCode, 200, response.body); const preview = response.json();
  assert.equal(preview.groups.length, 2); assert.equal(preview.summary.observationCount, 2); assert.equal(preview.projectionValidationComplete, true);
  assert.equal(preview.persisted, false); assert.equal(preview.reviewPersisted, true); assert.equal(preview.canApply, false); assert.equal(preview.groupedPilotImplemented, false);
  assert.equal(preview.freshness.reviewSnapshotCurrent, true); assert.equal((await get(f.url)).json().projectionId, preview.projectionId);
  assert.deepEqual(await snapshot(f), before); assert.equal((await get(f.base + '/resolved-preview')).json().preview.candidates.length, 1);
  for (const group of preview.groups) {
    assert.equal(group.observations[0].originalIdentityCells.serialNumber.value, f.source.sheets[0].rows[1].cells.F.value);
    assert.equal(group.observations[0].projectedIdentity.serialKey, group.serialNumber);
    const decision = await post(f.base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
      targetId: group.groupKey, action: 'PROPOSE_NEW', note: 'Group key is not a legacy candidate target' }); assert.equal(decision.statusCode, 400);
  }
  assert.equal((await post(f.url + '/apply', {})).statusCode, 404); assert.deepEqual(await snapshot(f), before);
});

test('identity group effective preview refreshes current matches and ambiguity without changing stable group keys or accepting new authority', async () => {
  const f = await prepare(); const first = (await get(f.url)).json(); const selected = first.groups[0];
  const asset = await database.asset.create({ data: { productId: product.id, serialNumber: selected.serialNumber } });
  const matched = (await get(f.url)).json(); assert.equal(matched.freshness.reviewSnapshotCurrent, false); assert.notEqual(matched.projectionId, first.projectionId);
  assert.deepEqual(matched.groups.map((group) => group.groupKey), first.groups.map((group) => group.groupKey));
  const match = matched.groups.find((group) => group.groupKey === selected.groupKey); assert.equal(match.candidates[0].existingAssetCount, 1); assert.equal(match.candidates[0].existingAssets[0].id, asset.id);
  assert.equal(match.requiresNewDecision, true); assert.equal(matched.canApply, false);
  const other = await database.product.create({ data: { name: 'Projection collision ' + randomUUID(), trackingMode: 'ASSET' } }); productIds.push(other.id);
  await database.asset.create({ data: { productId: other.id, serialNumber: selected.serialNumber } });
  const ambiguous = (await get(f.url)).json(); assert.equal(ambiguous.projectionValidationComplete, false); assert.ok(ambiguous.blockers.some((entry) => entry.code === 'SOURCE_AMBIGUOUS_EXISTING_ASSET'));
  assert.deepEqual(ambiguous.groups.map((group) => group.groupKey), first.groups.map((group) => group.groupKey));
  assert.equal((await get(f.reviewUrl)).json().review.planId, f.review.planId);
});

test('identity group effective preview shows later context and decisions explicitly while preserving the selected physical grouping', async () => {
  const f = await prepare(true); const first = (await get(f.url)).json(); const baseline = buildWorkbookPreview(f.source); const outsider = baseline.records.find((record) => record.row === 6);
  const corrected = await post(f.base + '/source-revisions', { requestId: randomUUID(), expectedRevision: 0, expectedBatchVersion: 1, note: 'Correct unrelated model',
    evidenceReference: 'Outside record specification', changes: [{ recordId: outsider.id, field: 'model', action: 'REPLACE', value: 'Model G10' }] }); assert.equal(corrected.statusCode, 201, corrected.body);
  const held = await post(f.base + '/decisions', { requestId: randomUUID(), expectedVersion: 1, expectedSourceRevision: 1, targetType: 'CANDIDATE',
    targetId: f.proposal.candidateIds[0], action: 'HOLD', note: 'Review source before loading' }); assert.equal(held.statusCode, 201, held.body);
  const current = (await get(f.url)).json(); assert.equal(current.sourceRevision, 1); assert.equal(current.batchVersion, 2);
  assert.equal(current.freshness.sourceRevisionChanged, true); assert.equal(current.freshness.batchVersionChanged, true); assert.equal(current.freshness.reviewSnapshotCurrent, false);
  assert.equal(current.groups.every((group) => group.originalDecisions[0].action === 'HOLD' && group.requiresNewDecision), true);
  assert.equal(current.groups.every((group) => group.observations[0].fields.model === 'Model G9'), true);
  assert.deepEqual(current.groups.map((group) => group.groupKey), first.groups.map((group) => group.groupKey)); assert.equal(current.canApply, false);
});

test('identity group effective preview tracks latest archived evidence and explicit unlink without relinking historical identity to proposed groups', async () => {
  const fixture = await closedAssignmentFixture({ database, product, actorId: users.JEFE.id, post, get });
  const f = await reserve({ ...fixture, proposal: proposal(buildWorkbookPreview(fixture.source), 2) }); const first = (await get(f.url)).json();
  assert.equal(first.requiresEvidenceLineageReview, true);
  const evidence = fixture.capture.items[0]; const evidenceUrl = '/inventory/imports/evidence/' + evidence.id;
  const original = await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
  const amendment = (await post(evidenceUrl + '/amendment-plan', { assetId: null })).json();
  const revised = await post(evidenceUrl + '/amendments', { requestId: randomUUID(), amendmentPlanId: amendment.amendmentPlanId,
    expectedEvidenceVersion: amendment.evidenceVersion, expectedBatchVersion: amendment.batchVersion, expectedSourceRevision: amendment.sourceRevision,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: null, note: 'Explicit unlinked archive interpretation', evidenceReference: 'Historical receipt check' }); assert.equal(revised.statusCode, 201, revised.body);
  const current = (await get(f.url)).json(); const entry = current.groups.flatMap((group) => group.evidence).find((item) => item.id === evidence.id);
  assert.equal(entry.currentAssetId, null); assert.equal(entry.capturedAssetId, fixture.asset.id); assert.equal(entry.evidenceVersion, 1); assert.equal(entry.linkedToGroup, false);
  assert.equal(entry.requiresExplicitLineageReview, true); assert.equal(current.freshness.reviewSnapshotCurrent, false);
  assert.deepEqual(current.groups.map((group) => group.groupKey), first.groups.map((group) => group.groupKey));
  assert.deepEqual(await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: evidence.id } }), original);
  assert.equal(await database.importAssignmentApplication.count({ where: { assetId: fixture.asset.id } }), 0);
  assert.equal((await post(fixture.url, fixture.input)).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
});

test('identity group effective preview stops on release and gives a replacement review distinct stable keys without erasing prior provenance', async () => {
  const f = await prepare(); const first = (await get(f.url)).json(); assert.equal((await release(f)).statusCode, 201);
  assert.equal((await get(f.url)).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED'); assert.equal((await get(f.reviewUrl)).statusCode, 200);
  const replacement = await reserve(f); const next = (await get(replacement.url)).json();
  assert.notEqual(next.reviewId, first.reviewId); assert.notEqual(next.groups[0].groupKey, first.groups[0].groupKey);
  assert.equal(await database.importIdentityGroupReview.count({ where: { batchId: f.batch.id } }), 2);
  const old = (await get(f.reviewUrl)).json().review; assert.equal(old.rows.every((row) => !row.isReserved), true);
  assert.deepEqual(old.plan, f.review.plan);
});

test('identity group effective preview uses one repeatable-read snapshot across concurrent inventory changes and cancellation', async () => {
  for (const change of ['asset', 'release']) {
    const f = await prepare(); let triggered = false;
    const concurrent = database.$extends({ query: { importApplicationItem: { async findMany({ args, query }) {
      if (!triggered) {
        triggered = true;
        if (change === 'asset') await database.asset.create({ data: { productId: product.id, serialNumber: f.proposal.groups[0].serialNumber } });
        else assert.equal((await release(f)).statusCode, 201);
      }
      return query(args);
    } } } });
    const previous = await getIdentityGroupProjection(concurrent, f.batch.id, f.review.id); assert.equal(triggered, true);
    assert.equal(previous.freshness.reviewSnapshotCurrent, true); assert.equal(previous.projectionValidationComplete, true);
    if (change === 'asset') {
      assert.equal(previous.groups.flatMap((group) => group.candidates).every((candidate) => candidate.existingAssetCount === 0), true);
      const current = (await get(f.url)).json(); assert.equal(current.freshness.reviewSnapshotCurrent, false); assert.notEqual(current.projectionId, previous.projectionId);
    } else assert.equal((await get(f.url)).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
  }
});

test('identity group effective preview fails clearly for corrupt lineage, missing storage and planning bounds without truncated success', async () => {
  const f = await prepare();
  const corrupt = database.$extends({ query: { importIdentityGroupReview: { async findFirst({ args, query }) {
    const review = await query(args); return review ? { ...review, rows: review.rows.slice(0, 1) } : review;
  } } } }); await assert.rejects(getIdentityGroupProjection(corrupt, f.batch.id, f.review.id), (error) => error.code === 'INVALID_IDENTITY_GROUP_REVIEW');
  const missing = database.$extends({ query: { importIdentityGroupReview: { async findFirst() {
    throw new Prisma.PrismaClientKnownRequestError('Missing grouping storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportIdentityGroupReview' } });
  } } } }); const instance = buildApp(missing);
  try { const response = await get(f.url, 'JEFE', instance); assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY'); }
  finally { await instance.close(); }
  for (const model of ['asset', 'importHistoricalEvidence']) {
    const oversized = database.$extends({ query: { [model]: { async findMany({ args }) {
      assert.equal(args.take, model === 'asset' ? 25001 : 101); return Array(args.take).fill({});
    } } } }); await assert.rejects(getIdentityGroupProjection(oversized, f.batch.id, f.review.id), (error) => ['PREVIEW_DATABASE_LIMIT', 'IDENTITY_GROUP_EVIDENCE_LIMIT'].includes(error.code));
  }
});

after(async () => { await app.close(); });
