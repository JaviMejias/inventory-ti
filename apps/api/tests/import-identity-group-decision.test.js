import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { appendIdentityGroupDecision } from '../src/imports/identity-group-decision-service.js';
import { identityGroupDecisionSchema } from '../src/imports/identity-group-decision-schemas.js';
import { hashPassword } from '../src/lib/password.js';
import { closedAssignmentFixture } from './fixtures/closed-assignment-import.js';
import { receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'groupdecision-' + role.toLowerCase() + '-' + suffix; const password = 'Group-decision-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group decision ' + role, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group decision ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url, role = 'JEFE', instance = app) { return instance.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
async function reserve(fixture) {
  const proposal = { expectedVersion: fixture.batch.version, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: fixture.preview.candidates.map((entry) => entry.id), note: 'Independent physical grouping checked',
    groups: fixture.preview.records.filter((entry) => ['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(entry.kind))
      .map((record) => ({ groupId: randomUUID(), recordIds: [record.id], serialNumber: ('DECISION-VERIFIED-' + randomUUID()).toUpperCase(),
        assetTag: null, evidenceReference: 'Physical and archival label checklist' })) };
  const plan = await post(fixture.base + '/identity-group-plan', proposal); assert.equal(plan.statusCode, 200, plan.body);
  const saved = await post(fixture.base + '/identity-group-reviews', { requestId: randomUUID(), planId: plan.json().planId,
    confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: proposal }); assert.equal(saved.statusCode, 201, saved.body);
  const review = saved.json().review; const reviewUrl = fixture.base + '/identity-group-reviews/' + review.id;
  const projection = await get(reviewUrl + '/effective-preview'); assert.equal(projection.statusCode, 200, projection.body);
  return { ...fixture, review, reviewUrl, projection: projection.json(), url: reviewUrl + '/decisions' };
}
async function prepare() {
  const serial = ('DECISION-ORIGINAL-' + randomUUID()).toUpperCase();
  const source = workbook('Recepción', [receptionRow(4, serial, { K: textCell('Disponible') }), receptionRow(5, serial, { K: textCell('Disponible') })]);
  source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json(); const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch; return reserve({ source, preview, batch, base: '/inventory/imports/batches/' + batch.id });
}
function intent(f, change = {}) {
  return { requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY', expectedDecisionVersion: 0,
    expectedBatchVersion: f.projection.batchVersion, expectedSourceRevision: f.projection.sourceRevision,
    projectionId: f.projection.projectionId, groupKey: f.projection.groups[0].groupKey, action: 'PROPOSE_NEW',
    note: 'Independent decision for this physical group', evidenceReference: 'Reviewed physical checklist', evidenceReviews: [], ...change };
}
function release(f) { return post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Abandon this physical grouping' }); }
async function snapshot(f) {
  return { batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }),
    review: await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { rows: { orderBy: { recordId: 'asc' } }, release: true } }),
    assets: await database.asset.findMany({ orderBy: { id: 'asc' } }), assignments: await database.assignment.count({ where: { asset: { productId: product.id } } }),
    stock: await database.inventoryStock.findMany({ where: { productId: product.id }, orderBy: { id: 'asc' } }),
    evidence: await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' } }),
    amendments: await database.importEvidenceAmendment.findMany({ where: { evidence: { sourceHash: f.source.source.sha256 } }, orderBy: { id: 'asc' } }),
    revisions: await database.importSourceRevision.count({ where: { batchId: f.batch.id } }), legacyDecisions: await database.importReviewDecision.count({ where: { batchId: f.batch.id } }) };
}

test('group decisions require JEFE, CSRF, strict DTO and review ownership without accepting legacy or simulated targets', async () => {
  const f = await prepare(); const input = intent(f);
  assert.equal((await app.inject({ method: 'POST', url: f.url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) { assert.equal((await post(f.url, input, role)).statusCode, 403); assert.equal((await get(f.url, role)).statusCode, 403); }
  assert.equal((await post(f.url, input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { confirmation: 'APPLY' }, { action: 'LINK_EXISTING' }, { linkedAssetId: randomUUID() }]) assert.equal((await post(f.url, { ...input, ...change })).statusCode, 400);
  for (const groupKey of [f.projection.groups[0].originalCandidateIds[0], f.projection.groups[0].simulatedCandidateIds[0]]) {
    const response = await post(f.url, { ...input, groupKey }); assert.equal(response.statusCode, 400); assert.equal(response.json().code, 'INVALID_IDENTITY_GROUP_TARGET');
  }
  const wrong = '/inventory/imports/batches/' + randomUUID() + '/identity-group-reviews/' + f.review.id + '/decisions';
  assert.equal((await get(wrong)).statusCode, 404); assert.equal((await post(wrong, input)).statusCode, 404);
  assert.equal((await get(f.url + '?force=true')).statusCode, 400);
  const upper = '/inventory/imports/batches/' + f.batch.id.toUpperCase() + '/identity-group-reviews/' + f.review.id.toUpperCase() + '/decisions';
  const saved = await post(upper, input); assert.equal(saved.statusCode, 201, saved.body);
  assert.equal((await get(upper)).json().decisions[0].reviewId, f.review.id);
});

test('group decisions append a separate versioned history without modifying source, reservations, operational inventory or prior approvals', async () => {
  const f = await prepare(); const before = await snapshot(f);
  const created = await post(f.url, intent(f)); assert.equal(created.statusCode, 201, created.body); const first = created.json().decision;
  assert.equal(created.json().canApply, false); assert.equal(created.json().evidenceRelinked, false); assert.equal(first.version, 1);
  assert.equal(first.projectionId, f.projection.projectionId); assert.equal(first.groupKey, f.projection.groups[0].groupKey);
  assert.deepEqual(await snapshot(f), before); assert.equal((await get(f.reviewUrl + '/effective-preview')).json().projectionId, f.projection.projectionId);
  for (const [index, action] of ['HOLD', 'EXCLUDE'].entries()) {
    const response = await post(f.url, intent(f, { action, expectedDecisionVersion: index + 1 })); assert.equal(response.statusCode, 201, response.body);
  }
  const latest = (await get(f.url)).json(); assert.equal(latest.decisionVersion, 3); assert.equal(latest.total, 1); assert.equal(latest.decisions[0].action, 'EXCLUDE'); assert.equal(latest.decisions[0].projectionCurrent, true);
  assert.equal(latest.decisions[0].projection, undefined);
  const page = (await get(f.url + '?mode=history&limit=1&offset=1')).json(); assert.equal(page.total, 3); assert.equal(page.hasMore, true); assert.equal(page.decisions[0].action, 'HOLD');
  const historical = (await get(f.url + '/' + first.id)).json(); assert.equal(historical.decision.projection.projectionId, f.projection.projectionId);
  assert.equal((await get(f.url + '/' + randomUUID())).statusCode, 404); assert.equal((await get(f.url + '/' + first.id + '?force=true')).statusCode, 400);
  assert.equal((await get(f.url + '?groupKey=' + f.projection.groups[1].groupKey)).json().total, 0);
  assert.deepEqual(await snapshot(f), before); assert.equal(await database.auditLog.count({ where: { entityType: 'ImportIdentityGroupDecision', entityId: first.id } }), 1);
  const pilot = await post(f.base + '/plan', { expectedVersion: 1, expectedSourceRevision: 0, operations: [{
    type: 'CREATE_ASSET', candidateId: f.preview.candidates[0].id, note: 'Cannot bypass groups', confirmation: 'AVAILABLE_UNASSIGNED',
    acknowledgedWarnings: [], values: { productId: product.id, serialNumber: 'LEGACY' } }] });
  assert.equal(pilot.json().code, 'IDENTITY_GROUP_SOURCE_RESERVED'); assert.equal((await post(f.url + '/apply', {})).statusCode, 404);
});

test('group decision retries recover immutable receipts after new decisions or release but cannot change intent or author', async () => {
  const f = await prepare(); const input = intent(f); const first = await post(f.url, input); assert.equal(first.statusCode, 201, first.body);
  const recovered = await post(f.url, { ...input, requestId: input.requestId.toUpperCase() }); assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(recovered.json().reused, true);
  assert.equal((await post(f.url, { ...input, note: 'Different intention' })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(appendIdentityGroupDecision(database, f.batch.id, f.review.id, identityGroupDecisionSchema.parse(input), users.COORDINADOR.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  const second = await post(f.url, intent(f, { action: 'HOLD', expectedDecisionVersion: 1 })); assert.equal(second.statusCode, 201, second.body);
  assert.equal((await release(f)).statusCode, 201);
  const retry = await post(f.url, input); assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().decision.id, first.json().decision.id); assert.equal(retry.json().decisionVersion, 2);
  assert.equal((await post(f.url, intent(f, { expectedDecisionVersion: 2 }))).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
  const history = (await get(f.url + '?mode=history')).json(); assert.equal(history.total, 2); assert.equal(history.reviewActive, false); assert.equal(history.currentProjectionId, null);
  assert.equal(history.decisions.every((entry) => !entry.projectionCurrent), true);
  assert.equal((await get(f.url + '/' + first.json().decision.id)).json().projectionCurrent, false);
});

test('group decision concurrency serializes its own version and identical retries without rewriting the batch', async () => {
  const f = await prepare(); const inputs = [intent(f), intent(f, { groupKey: f.projection.groups[1].groupKey })];
  const results = await Promise.all(inputs.map((input) => post(f.url, input))); assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409]);
  assert.equal(results.find((result) => result.statusCode === 409).json().code, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT');
  const retry = intent(f, { action: 'HOLD', expectedDecisionVersion: 1 });
  const repeated = await Promise.all([post(f.url, retry), post(f.url, retry)]); assert.deepEqual(repeated.map((result) => result.statusCode).sort(), [200, 201]);
  assert.equal(repeated[0].json().decision.id, repeated[1].json().decision.id);
  assert.equal((await get(f.url)).json().decisionVersion, 2); assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } })).version, 1);
});

test('group decisions reject changed projection, batch and source versions before saving any event', async () => {
  const f = await prepare(); const input = intent(f);
  for (const [change, code] of [[{ expectedBatchVersion: 2 }, 'REVIEW_VERSION_CONFLICT'], [{ expectedSourceRevision: 1 }, 'SOURCE_REVISION_CONFLICT'],
    [{ projectionId: '0'.repeat(64) }, 'IDENTITY_GROUP_PROJECTION_CHANGED']]) assert.equal((await post(f.url, { ...input, ...change })).json().code, code);
  await database.asset.create({ data: { productId: product.id, serialNumber: f.projection.groups[0].serialNumber } });
  assert.equal((await post(f.url, input)).json().code, 'IDENTITY_GROUP_PROJECTION_CHANGED');
  f.projection = (await get(f.reviewUrl + '/effective-preview')).json();
  assert.equal((await post(f.url, intent(f))).json().code, 'NEW_ASSET_PROPOSAL_CONFLICT');
  assert.equal(await database.importIdentityGroupDecision.count({ where: { reviewId: f.review.id } }), 0);
});

test('group decision freshness changes with later original candidate decisions but group decisions never reuse that authority', async () => {
  const f = await prepare(); const input = intent(f);
  assert.equal((await post(f.url, input)).statusCode, 201);
  const legacy = await post(f.base + '/decisions', { requestId: randomUUID(), expectedVersion: 1, expectedSourceRevision: 0,
    targetType: 'CANDIDATE', targetId: f.preview.candidates[0].id, action: 'HOLD', note: 'Original candidate remains an antecedent only' });
  assert.equal(legacy.statusCode, 201, legacy.body);
  assert.equal((await get(f.url)).json().decisions[0].projectionCurrent, false);
  assert.equal((await post(f.url, { ...input, requestId: randomUUID(), expectedDecisionVersion: 1 })).json().code, 'REVIEW_VERSION_CONFLICT');
  f.projection = (await get(f.reviewUrl + '/effective-preview')).json(); assert.equal(f.projection.groups[0].originalDecisions[0].action, 'HOLD');
  const second = await post(f.url, intent(f, { expectedDecisionVersion: 1 })); assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().decision.batchVersion, 2); assert.equal(second.json().decision.version, 2);
  assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } })).version, 2);
});

test('group decisions fail busy on concurrent inventory writers then safely retry without a partial receipt or version', async () => {
  const f = await prepare(); const input = intent(f); let entered; let unlock;
  const ready = new Promise((resolve) => { entered = resolve; }); const barrier = new Promise((resolve) => { unlock = resolve; });
  const holding = database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('LOCK TABLE "Asset" IN ROW EXCLUSIVE MODE'); entered(); await barrier;
  }, { timeout: 5000 });
  await ready;
  try {
    const response = await post(f.url, input); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'IDENTITY_GROUP_REVIEW_BUSY');
    assert.equal(await database.importIdentityGroupDecision.count({ where: { reviewId: f.review.id } }), 0);
  } finally { unlock(); await holding; }
  assert.equal((await post(f.url, input)).statusCode, 201);
});

test('group decision recording and cancellation serialize so no new authority is accepted after release', async () => {
  const f = await prepare(); const input = intent(f); let entered; let resume; let armed = true;
  const ready = new Promise((resolve) => { entered = resolve; }); const barrier = new Promise((resolve) => { resume = resolve; });
  const paused = database.$extends({ query: { asset: { async findMany({ args, query }) {
    if (armed) { armed = false; entered(); await barrier; } return query(args);
  } } } });
  const saving = appendIdentityGroupDecision(paused, f.batch.id, f.review.id, identityGroupDecisionSchema.parse(input), users.JEFE.id);
  await ready; const releasing = release(f); resume();
  const recorded = await saving; const cancelled = await releasing; assert.equal(recorded.decision.version, 1); assert.equal(cancelled.statusCode, 201, cancelled.body);
  const list = (await get(f.url)).json(); assert.equal(list.reviewActive, false); assert.equal(list.decisions[0].projectionCurrent, false);
  assert.equal((await post(f.url, input)).statusCode, 200);
  assert.equal((await post(f.url, intent(f, { expectedDecisionVersion: 1 }))).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
});

test('group decisions suggest an exact existing match while ambiguous inventory only permits hold or exclusion', async () => {
  const f = await prepare(); const group = f.projection.groups[0];
  const asset = await database.asset.create({ data: { productId: product.id, serialNumber: group.serialNumber } }); f.projection = (await get(f.reviewUrl + '/effective-preview')).json();
  assert.equal((await post(f.url, intent(f, { action: 'LINK_EXISTING', linkedAssetId: randomUUID() }))).json().code, 'ASSET_NOT_SUGGESTED');
  const input = intent(f, { action: 'LINK_EXISTING', linkedAssetId: asset.id }); const saved = await post(f.url, input); assert.equal(saved.statusCode, 201, saved.body);
  const original = saved.json().decision;
  const other = await database.product.create({ data: { name: 'Ambiguity ' + randomUUID(), trackingMode: 'ASSET' } }); productIds.push(other.id);
  await database.asset.create({ data: { productId: other.id, serialNumber: group.serialNumber } }); f.projection = (await get(f.reviewUrl + '/effective-preview')).json();
  assert.equal(f.projection.projectionValidationComplete, false);
  assert.equal((await post(f.url, intent(f, { action: 'LINK_EXISTING', linkedAssetId: asset.id, expectedDecisionVersion: 1 }))).json().code, 'IDENTITY_GROUP_DECISION_BLOCKED');
  assert.equal((await get(f.url)).json().decisions[0].projectionCurrent, false);
  assert.equal((await get(f.url + '/' + original.id)).json().decision.projectionId, original.projectionId);
  const held = await post(f.url, intent(f, { action: 'HOLD', expectedDecisionVersion: 1 })); assert.equal(held.statusCode, 201, held.body);
});

test('group evidence decisions require every current archived item and preserve captured links and explicit null without relinking history', async () => {
  const archived = await closedAssignmentFixture({ database, product, actorId: users.JEFE.id, post, get });
  const f = await reserve({ ...archived, preview: (await get(archived.base + '/resolved-preview')).json().preview,
    batch: { ...archived.batch, version: 2 } });
  const selected = f.projection.groups.find((group) => group.evidence.length); const evidence = selected.evidence[0];
  const before = await snapshot(f); const input = intent(f, { groupKey: selected.groupKey });
  assert.equal((await post(f.url, input)).json().code, 'IDENTITY_GROUP_EVIDENCE_COVERAGE_REQUIRED');
  const reviews = selected.evidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion,
    disposition: 'CONFIRM_GROUP_MEMBERSHIP', note: 'Observed document belongs to verified physical group', evidenceReference: 'Signed originals and labels' }));
  assert.equal((await post(f.url, { ...input, evidenceReviews: [{ ...reviews[0], expectedEvidenceVersion: 1 }, ...reviews.slice(1)] })).json().code, 'EVIDENCE_VERSION_CONFLICT');
  const saved = await post(f.url, { ...input, evidenceReviews: reviews }); assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().evidenceRelinked, false); assert.deepEqual(await snapshot(f), before);
  const data = { ...saved.json().decision, id: randomUUID(), requestId: randomUUID(), version: 2, createdAt: new Date() };
  for (const evidenceReviews of [[], reviews.map((entry) => ({ ...entry, disposition: null }))]) {
    await assert.rejects(database.importIdentityGroupDecision.create({ data: { ...data, evidenceReviews } }));
  }
  const amendmentBase = '/inventory/imports/evidence/' + evidence.id;
  const amendmentPlan = await post(amendmentBase + '/amendment-plan', { assetId: null }); assert.equal(amendmentPlan.statusCode, 200, amendmentPlan.body);
  const amended = await post(amendmentBase + '/amendments', { requestId: randomUUID(), expectedEvidenceVersion: 0, expectedBatchVersion: 2, expectedSourceRevision: 0,
    amendmentPlanId: amendmentPlan.json().amendmentPlanId, confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: null,
    note: 'Explicitly unlink archival asset pending grouping review', evidenceReference: 'Physical review' }); assert.equal(amended.statusCode, 201, amended.body);
  assert.equal((await get(f.url)).json().decisions[0].projectionCurrent, false);
  assert.equal((await post(f.url, { ...input, requestId: randomUUID(), expectedDecisionVersion: 1, evidenceReviews: reviews })).json().code, 'IDENTITY_GROUP_PROJECTION_CHANGED');
  f.projection = (await get(f.reviewUrl + '/effective-preview')).json();
  const currentGroup = f.projection.groups.find((entry) => entry.groupKey === selected.groupKey);
  const updated = intent(f, { expectedDecisionVersion: 1, groupKey: selected.groupKey, evidenceReviews: currentGroup.evidence.map((entry) => ({
    evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion, disposition: 'EXCLUDE_FROM_GROUP_PILOT',
    note: 'Keep original archive outside future group pilot', evidenceReference: 'Archival link remains uncertain' })) });
  const result = await post(f.url, updated); assert.equal(result.statusCode, 201, result.body);
  const snapshotEvidence = result.json().decision.projection.groups.find((entry) => entry.groupKey === selected.groupKey).evidence.find((entry) => entry.id === evidence.id);
  assert.equal(snapshotEvidence.currentAssetId, null); assert.equal(snapshotEvidence.capturedAssetId, archived.asset.id); assert.equal(snapshotEvidence.linkedToGroup, false);
  assert.equal(await database.importAssignmentApplication.count({ where: { assetId: archived.asset.id } }), 0);
});

test('group decision audit failure rolls back version and permits a safe retry with the same request id', async () => {
  const f = await prepare(); const input = intent(f);
  const broken = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_IDENTITY_GROUP_DECISION_RECORDED') throw new Error('Simulated group audit failure'); return query(args);
  } } } });
  await assert.rejects(appendIdentityGroupDecision(broken, f.batch.id, f.review.id, identityGroupDecisionSchema.parse(input), users.JEFE.id), /Simulated group audit failure/);
  assert.equal(await database.importIdentityGroupDecision.count({ where: { reviewId: f.review.id } }), 0);
  assert.equal((await post(f.url, input)).statusCode, 201);
});

test('SQL group decision guards reject rewriting, unauthorized actors, forged keys, membership, version gaps and snapshot-isolated writes', async () => {
  const f = await prepare(); const created = await post(f.url, intent(f)); assert.equal(created.statusCode, 201, created.body); const decision = created.json().decision;
  for (const operation of [
    () => database.importIdentityGroupDecision.update({ where: { id: decision.id }, data: { action: 'HOLD' } }),
    () => database.importIdentityGroupDecision.delete({ where: { id: decision.id } })
  ]) await assert.rejects(operation, /decisions are immutable/);
  const data = { ...decision, id: randomUUID(), requestId: randomUUID(), version: 2, createdAt: new Date() };
  for (const change of [{ reviewedById: users.SOPORTE.id }, { version: 4 }, { groupKey: '0'.repeat(64) },
    { groupId: randomUUID() }, { projection: { ...decision.projection, groups: [] } },
    { projection: { ...decision.projection, groups: decision.projection.groups.map((entry) => ({ ...entry, serialNumber: 'FORGED' })) } }]) {
    await assert.rejects(database.importIdentityGroupDecision.create({ data: { ...data, ...change } }));
  }
  await assert.rejects(database.$transaction((transaction) => transaction.importIdentityGroupDecision.create({ data }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }), /require READ COMMITTED/);
  await release(f); await assert.rejects(database.importIdentityGroupDecision.create({ data }), /requires active complete review/);
  assert.equal(await database.importIdentityGroupDecision.count({ where: { reviewId: f.review.id } }), 1);
});

test('group decision storage absence returns explicit 503 for ORM and raw-table failures without writing a decision', async () => {
  const f = await prepare();
  const missing = database.$extends({ query: { importIdentityGroupDecision: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing decisions', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportIdentityGroupDecision' } });
  } } } }); const instance = buildApp(missing);
  try { const response = await post(f.url, intent(f), 'JEFE', true, instance); assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY'); }
  finally { await instance.close(); }
  const raw = database.$extends({ query: { async $queryRaw({ args, query }) {
    if (args.sql?.includes('ImportIdentityGroupDecision')) throw new Prisma.PrismaClientKnownRequestError('Missing decisions', { code: 'P2010',
      clientVersion: Prisma.prismaVersion.client, meta: { code: '42P01', message: 'relation "ImportIdentityGroupDecision" does not exist' } }); return query(args);
  } } }); const rawApp = buildApp(raw);
  try { const response = await get(f.url, 'JEFE', rawApp); assert.equal(response.statusCode, 503, response.body); }
  finally { await rawApp.close(); }
});

test('group decision migration is additive on populated review and inventory tables without changing existing source or reserves', async () => {
  const f = await prepare(); assert.equal((await post(f.url, intent(f))).statusCode, 201);
  const migration = readFileSync(new URL('../../../prisma/migrations/0024_import_identity_group_decisions/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  await assert.rejects(database.$transaction(async (transaction) => {
    const schema = 'group_decision_migration_' + randomUUID().replaceAll('-', ''); await transaction.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    for (const table of ['User', 'Asset', 'ImportBatch', 'ImportIdentityGroupReview', 'ImportIdentityGroupRow', 'ImportIdentityGroupRelease',
      'ImportSourceRevision', 'ImportHistoricalEvidence', 'ImportEvidenceAmendment', 'ImportAssignmentEvidenceUse', 'ImportRetirementApplication']) {
      await transaction.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await transaction.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await transaction.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '", public');
    const before = await transaction.$queryRaw`SELECT (SELECT count(*) FROM "Asset") AS assets, (SELECT count(*) FROM "ImportIdentityGroupReview") AS reviews,
      (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "isReserved") AS reserved, (SELECT count(*) FROM "ImportHistoricalEvidence") AS evidence`;
    const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE TRIGGER[^;]+;/g);
    assert.equal(statements.length, 6); for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    assert.deepEqual(await transaction.$queryRaw`SELECT (SELECT count(*) FROM "Asset") AS assets, (SELECT count(*) FROM "ImportIdentityGroupReview") AS reviews,
      (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "isReserved") AS reserved, (SELECT count(*) FROM "ImportHistoricalEvidence") AS evidence`, before);
    assert.deepEqual(await transaction.$queryRaw`SELECT count(*)::integer AS decisions FROM "ImportIdentityGroupDecision"`, [{ decisions: 0 }]);
    throw new RollbackTest();
  }, { timeout: 15000 }), (error) => error instanceof RollbackTest);
});

after(async () => { await app.close(); });
