import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { saveIdentityGroupReview } from '../src/imports/identity-group-review-service.js';
import { hashPassword } from '../src/lib/password.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { closedAssignmentFixture } from './fixtures/closed-assignment-import.js';
import { verifiedRetirementFixture } from './fixtures/verified-retirement-import.js';
import { receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'groupreview-' + role.toLowerCase() + '-' + suffix; const password = 'Group-review-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Identity review ' + role, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Grouping review ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function proposal(preview, version = 1) {
  return { expectedVersion: version, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS', candidateIds: preview.candidates.map((entry) => entry.id),
    note: 'Physical identities verified separately', groups: preview.records.filter((entry) => ['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(entry.kind))
      .map((entry) => ({ groupId: randomUUID(), recordIds: [entry.id], serialNumber: 'VERIFIED-GROUP-' + randomUUID(), assetTag: null, evidenceReference: 'Physical label and source checked' })) };
}
async function stage(source) {
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json(); const saved = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.ok([200, 201].includes(saved.statusCode), saved.body);
  const batch = saved.json().batch; const base = '/inventory/imports/batches/' + batch.id;
  return { source, preview, batch, base, proposal: proposal(preview, batch.version), url: base + '/identity-group-reviews' };
}
async function prepare(rows) {
  const serial = 'ORIGINAL-GROUP-' + randomUUID();
  const source = workbook('Recepción', rows ?? [receptionRow(4, serial, { K: textCell('Disponible') }), receptionRow(5, serial, { K: textCell('Disponible') })]);
  source.source.sha256 = randomBytes(32).toString('hex'); return stage(source);
}
async function reviewInput(fixture) {
  const planned = await post(fixture.base + '/identity-group-plan', fixture.proposal); assert.equal(planned.statusCode, 200, planned.body);
  return { requestId: randomUUID(), planId: planned.json().planId, confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: fixture.proposal };
}
async function save(fixture) {
  const input = await reviewInput(fixture); const response = await post(fixture.url, input); assert.equal(response.statusCode, 201, response.body);
  return { input, receipt: response.json(), review: response.json().review };
}
function releaseInput() { return { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Abandon this review without changing original source' }; }
async function operationalSnapshot() {
  return { assets: await database.asset.findMany({ orderBy: { id: 'asc' } }), assignments: await database.assignment.findMany({ where: { asset: { productId: product.id } }, orderBy: { id: 'asc' } }),
    stock: await database.inventoryStock.findMany({ where: { productId: product.id }, orderBy: { id: 'asc' } }) };
}

test('identity group review and release require JEFE, CSRF, strict DTO and batch ownership', async () => {
  const fixture = await prepare(); const input = await reviewInput(fixture);
  assert.equal((await app.inject({ method: 'POST', url: fixture.url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) { assert.equal((await post(fixture.url, input, role)).statusCode, 403); assert.equal((await get(fixture.url, role)).statusCode, 403); }
  assert.equal((await post(fixture.url, input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { confirmation: 'APPLY' }, { plan: { ...input.plan, groups: [] } }]) assert.equal((await post(fixture.url, { ...input, ...change })).statusCode, 400);
  const { review } = await save(fixture); const url = fixture.url + '/' + review.id + '/release';
  assert.equal((await post(url, releaseInput(), 'COORDINADOR')).statusCode, 403);
  assert.equal((await post(url, releaseInput(), 'JEFE', false)).statusCode, 403);
  assert.equal((await get('/inventory/imports/batches/' + randomUUID() + '/identity-group-reviews/' + review.id)).statusCode, 404);
  assert.equal((await post('/inventory/imports/batches/' + randomUUID() + '/identity-group-reviews/' + review.id + '/release', releaseInput())).statusCode, 404);
});

test('identity grouping review persists immutable per-row lineage without re-keying current preview, decisions, workbook or operational inventory', async () => {
  const fixture = await prepare(); const original = await database.importBatch.findUniqueOrThrow({ where: { id: fixture.batch.id } });
  const before = await operationalSnapshot(); const { receipt, review } = await save(fixture);
  assert.equal(receipt.persisted, true); assert.equal(receipt.canApply, false); assert.equal(receipt.affectsCurrentState, false); assert.equal(receipt.groupedPilotImplemented, false);
  assert.equal(review.rows.length, 2); assert.equal(review.plan.operationKind, 'SPLIT'); assert.equal(review.release, null);
  assert.equal(review.rows.every((row) => row.originalCandidateId === fixture.preview.candidates[0].id && row.sourceHash === fixture.source.source.sha256 && row.isReserved), true);
  for (const row of review.rows) {
    const originalObservation = review.plan.observations.find((entry) => entry.recordId === row.recordId); assert.deepEqual(row.snapshot, originalObservation); assert.equal(row.groupId, originalObservation.proposedGroupId);
  }
  assert.deepEqual(await database.importBatch.findUniqueOrThrow({ where: { id: fixture.batch.id } }), original);
  assert.deepEqual(await operationalSnapshot(), before); assert.equal(await database.importSourceRevision.count({ where: { batchId: fixture.batch.id } }), 0);
  assert.equal(await database.importReviewDecision.count({ where: { batchId: fixture.batch.id } }), 0);
  assert.equal((await get(fixture.base + '/resolved-preview')).json().preview.candidates.length, 1);
  assert.deepEqual((await get(fixture.url + '/' + review.id)).json().review, review);
  const list = (await get(fixture.url + '?limit=1&offset=0')).json(); assert.equal(list.total, 1); assert.equal(list.hasMore, false); assert.equal(list.reviews[0].id, review.id); assert.equal(list.reviews[0].plan, undefined);
  assert.equal((await get(fixture.url + '?limit=1&offset=1')).json().reviews.length, 0);
  assert.equal(await database.auditLog.count({ where: { entityId: review.id, action: 'IMPORT_IDENTITY_GROUP_RESERVED' } }), 1);
});

test('identity group review recovery is actor/intent-bound and works after release without reacquiring reservations', async () => {
  const fixture = await prepare(); const { input, review } = await save(fixture);
  const reversed = { ...input, plan: { ...input.plan, groups: [...input.plan.groups].reverse() } };
  assert.equal((await post(fixture.url, reversed)).json().reused, true);
  assert.equal((await post(fixture.url, { ...input, plan: { ...input.plan, note: 'Different reason' } })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(saveIdentityGroupReview(database, fixture.batch.id, input, users.COORDINADOR.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  const release = releaseInput(); const url = fixture.url + '/' + review.id + '/release';
  assert.equal((await post(url, release)).statusCode, 201); assert.equal((await post(url, release)).json().reused, true);
  assert.equal((await post(url, { ...release, note: 'Different cancellation' })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await post(url, releaseInput())).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
  const recovered = (await post(fixture.url, input)).json(); assert.equal(recovered.reused, true); assert.equal(recovered.review.release.note, release.note);
  assert.equal(recovered.review.rows.every((row) => !row.isReserved), true);
  assert.equal(await database.importIdentityGroupReview.count({ where: { batchId: fixture.batch.id } }), 1);
  assert.equal(await database.auditLog.count({ where: { entityId: review.id } }), 2);
  const replacement = await save(fixture); assert.notEqual(replacement.review.id, review.id); assert.equal(replacement.review.release, null);
});

test('identity review rejects stale plan, batch/source versions and source blockers without writing partial reservations', async () => {
  const fixture = await prepare(); const input = await reviewInput(fixture);
  assert.equal((await post(fixture.url, { ...input, planId: '0'.repeat(64) })).json().code, 'IDENTITY_GROUP_PLAN_CHANGED');
  assert.equal((await post(fixture.url, { ...input, plan: { ...input.plan, expectedVersion: 2 } })).json().code, 'REVIEW_VERSION_CONFLICT');
  assert.equal((await post(fixture.url, { ...input, plan: { ...input.plan, expectedSourceRevision: 1 } })).json().code, 'SOURCE_REVISION_CONFLICT');
  const changed = await post(fixture.base + '/source-revisions', { requestId: randomUUID(), expectedBatchVersion: 1, expectedRevision: 0, note: 'Correct model before grouping',
    evidenceReference: 'Original specification', changes: [{ recordId: input.plan.groups[0].recordIds[0], field: 'model', action: 'REPLACE', value: 'Model G10' }] }); assert.equal(changed.statusCode, 201, changed.body);
  assert.equal((await post(fixture.url, input)).json().code, 'SOURCE_REVISION_CONFLICT');
  assert.equal(await database.importIdentityGroupReview.count({ where: { batchId: fixture.batch.id } }), 0);
  const blocked = await prepare([receptionRow(4, 'SHARED'), receptionRow(5, 'SHARED', { E: textCell('Model G10') })]);
  blocked.proposal.groups = [{ ...blocked.proposal.groups[0], recordIds: blocked.proposal.groups.flatMap((group) => group.recordIds) }];
  const blockedInput = await reviewInput(blocked); assert.equal((await post(blocked.url, blockedInput)).json().code, 'IDENTITY_GROUP_PLAN_BLOCKED');
  assert.equal(await database.importIdentityGroupReview.count({ where: { batchId: blocked.batch.id } }), 0);
});

test('identity group reservations block legacy pilot planning/application and source changes, then release restores the original workflows', async () => {
  const fixture = await prepare();
  const decision = await post(fixture.base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: fixture.preview.candidates[0].id, action: 'PROPOSE_NEW', note: 'Original candidate reviewed' }); assert.equal(decision.statusCode, 201, decision.body);
  fixture.proposal.expectedVersion = 2;
  const pilotInput = { expectedVersion: 2, expectedSourceRevision: 0, operations: [{ type: 'CREATE_ASSET', candidateId: fixture.preview.candidates[0].id,
    note: 'Available original equipment', confirmation: 'AVAILABLE_UNASSIGNED', acknowledgedWarnings: [], values: { productId: product.id, serialNumber: fixture.source.sheets[0].rows[1].cells.F.value } }] };
  const first = (await post(fixture.base + '/plan', pilotInput)).json(); pilotInput.operations[0].acknowledgedWarnings = first.operations[0].warnings.map((entry) => entry.id);
  const plan = (await post(fixture.base + '/plan', pilotInput)).json(); assert.equal(plan.planValidationComplete, true);
  const application = { requestId: randomUUID(), planId: plan.planId, confirmation: 'APPLY_ASSET_PILOT', plan: pilotInput };
  const { review } = await save(fixture); const before = await operationalSnapshot();
  assert.equal((await post(fixture.base + '/plan', pilotInput)).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
  assert.equal((await post(fixture.base + '/apply', application)).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
  const correction = { requestId: randomUUID(), expectedBatchVersion: 2, expectedRevision: 0, note: 'Correct model', evidenceReference: 'Physical label',
    changes: [{ recordId: review.rows[0].recordId, field: 'model', action: 'REPLACE', value: 'Model G10' }] };
  assert.equal((await post(fixture.base + '/source-revisions', correction)).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
  assert.equal((await post(fixture.base + '/identity-revisions', { requestId: randomUUID(), expectedBatchVersion: 2, expectedRevision: 0,
    candidateId: fixture.preview.candidates[0].id, confirmation: 'VERIFIED_PHYSICAL_IDENTITY', action: 'VERIFY', serialNumber: 'WHOLE-VERIFIED-' + randomUUID(),
    assetTag: null, note: 'Whole candidate', evidenceReference: 'Physical labels' })).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
  assert.deepEqual(await operationalSnapshot(), before);
  assert.equal((await post(fixture.url + '/' + review.id + '/release', releaseInput())).statusCode, 201);
  const applied = await post(fixture.base + '/apply', application); assert.equal(applied.statusCode, 201, applied.body);
  const grouping = await reviewInput(fixture); assert.equal((await post(fixture.url, grouping)).json().code, 'IDENTITY_GROUP_PLAN_BLOCKED');
});

test('identity reservations are globally exclusive across concurrent batches sharing the source hash', async () => {
  const first = await prepare();
  await database.asset.create({ data: { productId: product.id, serialNumber: 'SNAPSHOT-' + randomUUID() } });
  const second = await stage(first.source); assert.notEqual(first.batch.id, second.batch.id);
  const inputs = await Promise.all([reviewInput(first), reviewInput(second)]);
  const responses = await Promise.all([post(first.url, inputs[0]), post(second.url, inputs[1])]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409], responses.map((response) => response.body).join('\n'));
  const loser = responses[0].statusCode === 409 ? first : second; const winner = responses[0].statusCode === 201 ? first : second;
  const response = responses.find((entry) => entry.statusCode === 201); const review = response.json().review;
  assert.equal(responses.find((entry) => entry.statusCode === 409).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
  assert.equal((await post(loser.base + '/identity-group-plan', loser.proposal)).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
  assert.equal(await database.importIdentityGroupReview.count({ where: { sourceHash: first.source.source.sha256 } }), 1);
  assert.equal((await post(winner.url + '/' + review.id + '/release', releaseInput())).statusCode, 201);
  assert.equal((await save(loser)).review.rows.length, 2);
});

test('archived evidence is preserved, cannot enter assignments or retirements while reserved, and consumed lineage cannot later be regrouped', async () => {
  for (const create of [closedAssignmentFixture, verifiedRetirementFixture]) {
    const fixture = await create({ database, product, actorId: users.JEFE.id, post, get });
    const group = { ...fixture, proposal: proposal(buildWorkbookPreview(fixture.source), 2), url: fixture.base + '/identity-group-reviews' };
    const evidenceBefore = await database.importHistoricalEvidence.findMany({ where: { captureId: fixture.capture.id }, orderBy: { id: 'asc' } });
    const { review } = await save(group); assert.equal(review.plan.requiresEvidenceLineageReview, true);
    const before = await operationalSnapshot();
    assert.equal((await post(fixture.planUrl, fixture.input.plan)).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
    assert.equal((await post(fixture.url, fixture.input)).json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
    assert.deepEqual(await operationalSnapshot(), before);
    assert.deepEqual(await database.importHistoricalEvidence.findMany({ where: { captureId: fixture.capture.id }, orderBy: { id: 'asc' } }), evidenceBefore);
    assert.equal((await post(group.url + '/' + review.id + '/release', releaseInput())).statusCode, 201);
    const applied = await post(fixture.url, fixture.input); assert.equal(applied.statusCode, 201, applied.body);
    const regrouping = await reviewInput(group); assert.equal((await post(group.url, regrouping)).json().code, 'IDENTITY_GROUP_PLAN_BLOCKED');
    assert.equal((await get(fixture.receiptUrl)).json().total, 1);
  }
});

test('identity review rollback on provenance write failure leaves no review, row reservation or audit receipt', async () => {
  const fixture = await prepare(); const input = await reviewInput(fixture);
  const failure = database.$extends({ query: { importIdentityGroupRow: { async createMany() { throw new Error('Injected provenance failure'); } } } });
  await assert.rejects(saveIdentityGroupReview(failure, fixture.batch.id, input, users.JEFE.id), /Injected provenance failure/);
  assert.equal(await database.importIdentityGroupReview.count({ where: { batchId: fixture.batch.id } }), 0);
  assert.equal(await database.importIdentityGroupRow.count({ where: { sourceHash: fixture.source.source.sha256 } }), 0);
  assert.equal((await save(fixture)).review.rows.length, 2);
});

test('identity review creation captures database milliseconds before INSERT instead of relying on rounded defaults', async () => {
  const fixture = await prepare(); const input = await reviewInput(fixture); let capturedAt;
  const checked = database.$extends({ query: { importIdentityGroupReview: { async create({ args, query }) {
    assert.ok(args.data.createdAt instanceof Date); capturedAt = args.data.createdAt;
    const [clock] = await database.$queryRaw`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
    assert.ok(capturedAt <= clock.capturedAt); return query(args);
  } } } });
  const result = await saveIdentityGroupReview(checked, fixture.batch.id, input, users.JEFE.id);
  assert.deepEqual(result.review.createdAt, capturedAt); assert.equal(result.review.rows.length, 2);
  const repeated = await saveIdentityGroupReview(checked, fixture.batch.id, input, users.JEFE.id);
  assert.equal(repeated.reused, true); assert.deepEqual(repeated.review.createdAt, capturedAt);
});

test('SQL rejects identity review/provenance/release rewriting, incomplete receipts and forged original row ownership', async () => {
  const fixture = await prepare(); const { review } = await save(fixture); const [row] = review.rows;
  for (const operation of [
    () => database.importIdentityGroupReview.update({ where: { id: review.id }, data: { planId: 'e'.repeat(64) } }),
    () => database.importIdentityGroupReview.delete({ where: { id: review.id } }),
    () => database.importIdentityGroupRow.update({ where: { reviewId_recordId: { reviewId: review.id, recordId: row.recordId } }, data: { groupId: randomUUID() } }),
    () => database.importIdentityGroupRow.deleteMany({ where: { reviewId: review.id } }),
    () => database.importIdentityGroupRow.updateMany({ where: { reviewId: review.id }, data: { isReserved: false } }),
    () => database.importIdentityGroupRelease.create({ data: { reviewId: review.id, requestId: randomUUID(), requestDigest: 'd'.repeat(64), note: 'Unauthorized release', releasedById: users.SOPORTE.id } })
  ]) await assert.rejects(operation);
  await post(fixture.url + '/' + review.id + '/release', releaseInput());
  for (const operation of [
    () => database.importIdentityGroupRelease.update({ where: { reviewId: review.id }, data: { note: 'Rewritten release' } }),
    () => database.importIdentityGroupRelease.delete({ where: { reviewId: review.id } }),
    () => database.importIdentityGroupReview.create({ data: { batchId: review.batchId, batchVersion: review.batchVersion, sourceRevision: review.sourceRevision,
      sourceHash: review.sourceHash, requestId: randomUUID(), requestDigest: 'd'.repeat(64), planId: review.planId, plan: review.plan, reviewedById: users.JEFE.id } }),
    () => database.$transaction(async (transaction) => {
      const header = await transaction.importIdentityGroupReview.create({ data: { batchId: review.batchId, batchVersion: review.batchVersion, sourceRevision: review.sourceRevision,
        sourceHash: review.sourceHash, requestId: randomUUID(), requestDigest: 'd'.repeat(64), planId: review.planId, plan: review.plan, reviewedById: users.JEFE.id } });
      await transaction.importIdentityGroupRow.create({ data: { ...row, reviewId: header.id, originalCandidateId: '0'.repeat(64) } });
    })
  ]) await assert.rejects(operation);
  assert.equal(await database.importIdentityGroupReview.count({ where: { batchId: review.batchId } }), 1);
});

test('SQL reservation guard prevents a legacy application header from bypassing the API', async () => {
  const fixture = await prepare();
  await post(fixture.base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: fixture.preview.candidates[0].id, action: 'PROPOSE_NEW', note: 'Reviewed original candidate' }); fixture.proposal.expectedVersion = 2;
  const input = { expectedVersion: 2, expectedSourceRevision: 0, operations: [{ type: 'CREATE_ASSET', candidateId: fixture.preview.candidates[0].id,
    note: 'Original pilot', confirmation: 'AVAILABLE_UNASSIGNED', acknowledgedWarnings: [], values: { productId: product.id, serialNumber: fixture.source.sheets[0].rows[1].cells.F.value } }] };
  const first = (await post(fixture.base + '/plan', input)).json(); input.operations[0].acknowledgedWarnings = first.operations[0].warnings.map((warning) => warning.id);
  const plan = (await post(fixture.base + '/plan', input)).json(); assert.equal(plan.planValidationComplete, true);
  await save(fixture);
  await assert.rejects(database.importApplication.create({ data: { batchId: fixture.batch.id, batchVersion: 2, requestId: randomUUID(), requestDigest: 'a'.repeat(64),
    planId: plan.planId, sourceHash: fixture.source.source.sha256, plan, appliedById: users.JEFE.id } }), /active identity grouping review/);
  assert.equal(await database.importApplication.count({ where: { batchId: fixture.batch.id } }), 0);
});

test('identity grouping storage absence is reported explicitly instead of presenting a usable legacy plan', async () => {
  const fixture = await prepare(); const input = await reviewInput(fixture);
  const missing = database.$extends({ query: { importIdentityGroupReview: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing identity review storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportIdentityGroupReview' } });
  } } } }); const instance = buildApp(missing);
  try { const response = await post(fixture.url, input, 'JEFE', true, instance); assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY'); }
  finally { await instance.close(); }
});

test('SQL rejects snapshot-isolated reservation writes and exposes a unique partial index for active source rows', async () => {
  await assert.rejects(database.$transaction((transaction) => transaction.$queryRaw`SELECT assert_import_identity_unreserved(${'a'.repeat(64)}, ${'b'.repeat(64)}, NULL)`,
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }), /require READ COMMITTED/);
  const indexes = await database.$queryRaw`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ImportIdentityGroupRow_active_source_record_key'`;
  assert.equal(indexes.length, 1); assert.match(indexes[0].indexdef, /CREATE UNIQUE INDEX/); assert.match(indexes[0].indexdef, /WHERE "isReserved"/);
});

test('identity grouping migration adds empty review tables to populated legacy schemas without rewriting operational or archival data', async () => {
  const migration = readFileSync(new URL('../../../prisma/migrations/0023_import_identity_group_reviews/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  await assert.rejects(database.$transaction(async (transaction) => {
    const schema = 'group_migration_' + randomUUID().replaceAll('-', ''); await transaction.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    for (const table of ['User', 'Asset', 'Product', 'ImportBatch', 'ImportSourceRevision', 'ImportApplication', 'ImportApplicationItem',
      'ImportHistoricalEvidence', 'ImportAssignmentItem', 'ImportAssignmentEvidenceUse', 'ImportRetirementApplication']) {
      await transaction.$executeRawUnsafe('CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)');
      await transaction.$executeRawUnsafe('INSERT INTO "' + schema + '"."' + table + '" SELECT * FROM public."' + table + '"');
    }
    await transaction.$executeRawUnsafe('SET LOCAL search_path TO "' + schema + '"');
    const before = await transaction.$queryRaw`SELECT (SELECT count(*) FROM "Asset") AS assets, (SELECT count(*) FROM "ImportHistoricalEvidence") AS evidence`;
    const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
    assert.equal(statements.length, 26); for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    assert.deepEqual(await transaction.$queryRaw`SELECT (SELECT count(*) FROM "Asset") AS assets, (SELECT count(*) FROM "ImportHistoricalEvidence") AS evidence`, before);
    assert.deepEqual(await transaction.$queryRaw`SELECT (SELECT count(*) FROM "ImportIdentityGroupReview")::integer AS reviews, (SELECT count(*) FROM "ImportIdentityGroupRow")::integer AS rows`, [{ reviews: 0, rows: 0 }]);
    throw new RollbackTest();
  }, { timeout: 15000 }), (error) => error instanceof RollbackTest);
});

after(async () => { await app.close(); });
