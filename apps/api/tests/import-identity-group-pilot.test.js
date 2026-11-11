import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { planIdentityGroupPilot } from '../src/imports/identity-group-pilot-service.js';
import { identityGroupPilotSchema } from '../src/imports/identity-group-pilot-schemas.js';
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
    const username = 'grouppilot-' + role.toLowerCase() + '-' + suffix; const password = 'Group-pilot-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group pilot ' + role, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group pilot ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url, role = 'JEFE', instance = app) { return instance.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
async function reserve(f, merged = false) {
  const proposal = { expectedVersion: f.batch.version, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: f.preview.candidates.map((entry) => entry.id), note: 'Physical equipment groups verified',
    groups: f.preview.records.filter((entry) => ['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(entry.kind)).map((record) => ({
      groupId: randomUUID(), recordIds: [record.id], serialNumber: ('GROUP-PILOT-VERIFIED-' + randomUUID()).toUpperCase(),
      assetTag: record.tagKey, evidenceReference: 'Physical labels and original records' })) };
  if (merged) proposal.groups = [{ ...proposal.groups[0], recordIds: proposal.groups.flatMap((group) => group.recordIds) }];
  const plan = await post(f.base + '/identity-group-plan', proposal); assert.equal(plan.statusCode, 200, plan.body);
  const saved = await post(f.base + '/identity-group-reviews', { requestId: randomUUID(), planId: plan.json().planId,
    confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: proposal }); assert.equal(saved.statusCode, 201, saved.body);
  const review = saved.json().review; const reviewUrl = f.base + '/identity-group-reviews/' + review.id;
  const projection = await get(reviewUrl + '/effective-preview'); assert.equal(projection.statusCode, 200, projection.body);
  return { ...f, review, reviewUrl, url: reviewUrl + '/pilot-plan', projection: projection.json(), decisions: [], decisionVersion: 0 };
}
async function decide(f, index = 0, action = 'PROPOSE_NEW', assetId = null) {
  f.projection = (await get(f.reviewUrl + '/effective-preview')).json();
  const current = (await get(f.reviewUrl + '/decisions')).json(); const group = f.projection.groups[index];
  const input = { requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
    expectedDecisionVersion: current.decisionVersion, expectedBatchVersion: f.projection.batchVersion, expectedSourceRevision: f.projection.sourceRevision,
    projectionId: f.projection.projectionId, groupKey: group.groupKey, action, ...(assetId ? { linkedAssetId: assetId } : {}),
    note: 'Independent operational group intent', evidenceReference: 'Physical and archival documents',
    evidenceReviews: group.evidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion,
      disposition: 'EXCLUDE_FROM_GROUP_PILOT', note: 'Retain archive outside the asset pilot', evidenceReference: 'History remains separately reviewed' })) };
  const response = await post(f.reviewUrl + '/decisions', input); assert.equal(response.statusCode, 201, response.body);
  const decision = response.json().decision; f.decisions = [...f.decisions.filter((entry) => entry.groupKey !== group.groupKey), decision];
  f.decisionVersion = response.json().decisionVersion; return decision;
}
async function prepare(extra = {}, reviewed = true, merged = false) {
  const serial = ('GROUP-PILOT-ORIGINAL-' + randomUUID()).toUpperCase();
  const source = workbook('Recepción', [receptionRow(4, serial, { K: textCell('Disponible'), ...extra }), receptionRow(5, serial, { K: textCell('Disponible'), ...extra })]);
  source.source.sha256 = randomBytes(32).toString('hex'); const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json(); const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch; const f = await reserve({ source, preview, batch, base: '/inventory/imports/batches/' + batch.id }, merged);
  if (reviewed) await decide(f); return f;
}
function inputFor(f, indices = [0]) {
  return { expectedBatchVersion: f.projection.batchVersion, expectedSourceRevision: f.projection.sourceRevision,
    expectedDecisionVersion: f.decisionVersion, projectionId: f.projection.projectionId,
    operations: indices.map((index) => { const group = f.projection.groups[index]; return { type: 'CREATE_ASSET', groupKey: group.groupKey,
      decisionId: f.decisions.find((entry) => entry.groupKey === group.groupKey)?.id ?? randomUUID(), note: 'Available unassigned verified group',
      confirmation: 'AVAILABLE_UNASSIGNED', acknowledgedWarnings: [],
      values: { productId: product.id, serialNumber: group.serialNumber, assetTag: group.assetTag, location: 'Bodega' } }; }) };
}
function release(f) { return post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Abandon grouping without operational effects' }); }
async function snapshot(f) {
  return { batch: await database.importBatch.findUniqueOrThrow({ where: { id: f.batch.id } }),
    review: await database.importIdentityGroupReview.findUniqueOrThrow({ where: { id: f.review.id }, include: { rows: { orderBy: { recordId: 'asc' } }, release: true } }),
    decisions: await database.importIdentityGroupDecision.findMany({ where: { reviewId: f.review.id }, orderBy: { version: 'asc' } }),
    revisions: await database.importSourceRevision.count({ where: { batchId: f.batch.id } }),
    evidence: await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' } }),
    assets: await database.asset.findMany({ orderBy: { id: 'asc' } }), assignments: await database.assignment.count({ where: { asset: { productId: product.id } } }),
    stock: await database.inventoryStock.findMany({ where: { productId: product.id }, orderBy: { id: 'asc' } }),
    movements: await database.inventoryMovement.count({ where: { productId: product.id } }),
    applications: await database.importApplication.count({ where: { sourceHash: f.source.source.sha256 } }),
    audit: await database.auditLog.count({ where: { OR: [{ entityId: f.batch.id }, { entityId: f.review.id }, { entityId: { in: f.decisions.map((entry) => entry.id) } }] } }) };
}
const has = (response, code) => response.json().operations[0].blockers.some((entry) => entry.code === code);

test('group pilot route requires JEFE and CSRF with strict versions, query, operations and batch ownership', async () => {
  const f = await prepare(); const input = inputFor(f);
  assert.equal((await app.inject({ method: 'POST', url: f.url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(f.url, input, role)).statusCode, 403);
  assert.equal((await post(f.url, input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { expectedDecisionVersion: -1 }, { operations: [] },
    { operations: [{ ...input.operations[0], values: { ...input.operations[0].values, status: 'AVAILABLE' } }] }]) assert.equal((await post(f.url, { ...input, ...change })).statusCode, 400);
  assert.equal((await post(f.url + '?force=true', input)).statusCode, 400);
  const invalid = await post(f.url, { ...input, operations: [{ ...input.operations[0], groupKey: f.preview.candidates[0].id }] });
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().code, 'INVALID_IDENTITY_GROUP_TARGET');
  assert.equal((await post('/inventory/imports/batches/' + randomUUID() + '/identity-group-reviews/' + f.review.id + '/pilot-plan', input)).statusCode, 404);
  const upper = '/inventory/imports/batches/' + f.batch.id.toUpperCase() + '/identity-group-reviews/' + f.review.id.toUpperCase() + '/pilot-plan';
  const response = await post(upper, { ...input, operations: [{ ...input.operations[0], decisionId: input.operations[0].decisionId.toUpperCase(),
    values: { ...input.operations[0].values, productId: product.id.toUpperCase() } }] }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().planValidationComplete, true);
});

test('group pilot is deterministic, partial, fully traceable and strictly read-only across inventory, source, archive and review', async () => {
  const f = await prepare(); const before = await snapshot(f); const input = inputFor(f);
  const response = await post(f.url, input); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.canApply, false); assert.equal(plan.persisted, false);
  assert.equal(plan.groupedPilotPlanImplemented, true); assert.equal(plan.groupedPilotImplemented, false);
  assert.equal(plan.summary.omittedGroupCount, 1); assert.equal(plan.summary.selectedObservationCount, 1);
  assert.equal(plan.omittedGroups[0].latestDecisionId, null); assert.equal(plan.operations[0].decision.id, f.decisions[0].id);
  assert.equal(plan.operations[0].source[0].sheet, 'Recepción'); assert.equal(plan.operations[0].deduplication[0].sourceHash, f.source.source.sha256);
  assert.equal(plan.operations[0].source[0].originalCandidateId, f.preview.candidates[0].id);
  assert.equal((await post(f.url, input)).json().planId, plan.planId); assert.deepEqual(await snapshot(f), before);
  assert.equal((await get(f.reviewUrl + '/effective-preview')).json().projectionId, f.projection.projectionId);
  assert.equal((await post(f.url + '/apply', {})).statusCode, 400);
  const legacy = await post(f.base + '/plan', { expectedVersion: 1, expectedSourceRevision: 0, operations: [{ type: 'CREATE_ASSET',
    candidateId: f.preview.candidates[0].id, note: 'Cannot use old pilot to apply reviewed groups', confirmation: 'AVAILABLE_UNASSIGNED',
    values: { productId: product.id, serialNumber: 'LEGACY' } }] }); assert.equal(legacy.json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
});

test('group pilot requires latest receipt and its separate review version rather than historical or original candidate authority', async () => {
  const unreviewed = await prepare({}, false); assert.equal(has(await post(unreviewed.url, inputFor(unreviewed)), 'GROUP_DECISION_REQUIRED'), true);
  const f = await prepare(); const input = inputFor(f);
  for (const [change, code] of [[{ expectedBatchVersion: 2 }, 'REVIEW_VERSION_CONFLICT'], [{ expectedSourceRevision: 1 }, 'SOURCE_REVISION_CONFLICT'],
    [{ expectedDecisionVersion: 0 }, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT'], [{ projectionId: '0'.repeat(64) }, 'IDENTITY_GROUP_PROJECTION_CHANGED']]) {
    assert.equal((await post(f.url, { ...input, ...change })).json().code, code);
  }
  await decide(f, 0, 'HOLD');
  assert.equal((await post(f.url, input)).json().code, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT');
  const latest = { ...inputFor(f), operations: input.operations };
  const held = await post(f.url, latest); assert.equal(held.statusCode, 200, held.body);
  assert.equal(has(held, 'GROUP_DECISION_NOT_LATEST'), true); assert.equal(has(held, 'NEW_GROUP_ASSET_REVIEW_REQUIRED'), true);
  await decide(f, 0, 'EXCLUDE'); assert.equal(has(await post(f.url, inputFor(f)), 'NEW_GROUP_ASSET_REVIEW_REQUIRED'), true);
});

test('group pilot cannot silently renew a decision after inventory or earlier candidate context changes', async () => {
  const f = await prepare(); const oldInput = inputFor(f);
  const asset = await database.asset.create({ data: { productId: product.id, serialNumber: f.projection.groups[0].serialNumber } });
  assert.equal((await post(f.url, oldInput)).json().code, 'IDENTITY_GROUP_PROJECTION_CHANGED');
  f.projection = (await get(f.reviewUrl + '/effective-preview')).json();
  const stale = await post(f.url, inputFor(f)); assert.equal(stale.statusCode, 200, stale.body);
  assert.equal(has(stale, 'GROUP_DECISION_STALE'), true); assert.equal(has(stale, 'EXISTING_ASSET_MATCH'), true);
  await decide(f, 0, 'LINK_EXISTING', asset.id);
  const group = f.projection.groups[0]; const decision = f.decisions.find((entry) => entry.groupKey === group.groupKey);
  const input = { ...inputFor(f), operations: [{ type: 'UPDATE_METADATA', groupKey: group.groupKey, decisionId: decision.id,
    assetId: asset.id, note: 'Metadata only', values: { location: 'Verified storage' } }] };
  assert.equal((await post(f.url, input)).json().planValidationComplete, true);
  const legacy = await post(f.base + '/decisions', { requestId: randomUUID(), expectedVersion: 1, expectedSourceRevision: 0, targetType: 'CANDIDATE',
    targetId: f.preview.candidates[0].id, action: 'HOLD', note: 'Earlier candidate remains an antecedent' }); assert.equal(legacy.statusCode, 201, legacy.body);
  assert.equal((await post(f.url, input)).json().code, 'REVIEW_VERSION_CONFLICT');
});

test('group pilot binds catalog snapshot and shared product rules without selecting a product implicitly', async () => {
  const f = await prepare(); const input = inputFor(f); const first = await post(f.url, input); assert.equal(first.json().planValidationComplete, true);
  await database.product.update({ where: { id: product.id }, data: { model: 'Model G10' } });
  try {
    const changed = await post(f.url, input); assert.equal(changed.statusCode, 200, changed.body); assert.equal(has(changed, 'SELECTED_PRODUCT_MODEL_CONFLICT'), true);
    assert.notEqual(changed.json().planId, first.json().planId);
  } finally { await database.product.update({ where: { id: product.id }, data: { model: 'Model G9' } }); }
  const missing = await post(f.url, { ...input, operations: [{ ...input.operations[0], values: { ...input.operations[0].values, productId: randomUUID() } }] });
  assert.equal(has(missing, 'PRODUCT_NOT_FOUND'), true);
  const quantity = await database.product.create({ data: { name: 'Group quantity ' + randomUUID(), trackingMode: 'QUANTITY' } });
  assert.equal(has(await post(f.url, { ...input, operations: [{ ...input.operations[0], values: { ...input.operations[0].values, productId: quantity.id } }] }), 'PRODUCT_NOT_ASSET'), true);
});

test('group pilot warnings are acknowledged exactly and unknown availability or outgoing source use cannot become available', async () => {
  const f = await prepare({ E: textCell('') }); const input = inputFor(f);
  const first = await post(f.url, input); assert.equal(first.statusCode, 200, first.body); assert.equal(has(first, 'WARNINGS_NOT_ACKNOWLEDGED'), true);
  input.operations[0].acknowledgedWarnings = first.json().operations[0].warnings.map((entry) => entry.id); assert.equal((await post(f.url, input)).json().planValidationComplete, true);
  input.operations[0].acknowledgedWarnings = ['f'.repeat(64)]; assert.equal(has(await post(f.url, input), 'UNKNOWN_WARNING_ACKNOWLEDGEMENT'), true);
  for (const extra of [{ K: textCell('No Disponible') }, { N: textCell('Dispatch ticket') }]) {
    const pending = await prepare(extra); assert.equal((await post(pending.url, inputFor(pending))).json().planValidationComplete, false);
  }
});

test('group metadata pilot reports null clearing without modifying assigned state, physical identity or product', async () => {
  const f = await prepare({}, false); const group = f.projection.groups[0];
  const asset = await database.$transaction(async (transaction) => {
    const created = await transaction.asset.create({ data: { productId: product.id, serialNumber: group.serialNumber, location: 'Original storage', status: 'ASSIGNED' } });
    await transaction.assignment.create({ data: { assetId: created.id, personName: 'Current recipient', createdById: users.JEFE.id, startedAt: new Date('2025-01-01') } }); return created;
  });
  const decision = await decide(f, 0, 'LINK_EXISTING', asset.id); const input = { ...inputFor(f), operations: [{
    type: 'UPDATE_METADATA', groupKey: group.groupKey, decisionId: decision.id, assetId: asset.id, note: 'Metadata, never custody', values: { location: null } }] };
  const before = await snapshot(f); const response = await post(f.url, input); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().planValidationComplete, true); assert.equal(response.json().operations[0].resultingStatus, 'ASSIGNED');
  assert.deepEqual(response.json().operations[0].changes, [{ field: 'location', before: 'Original storage', after: null }]); assert.deepEqual(await snapshot(f), before);
  const forbidden = await post(f.url, { ...input, operations: [{ ...input.operations[0], values: { assetTag: 'Rewrite identity' } }] }); assert.equal(forbidden.statusCode, 400);
  assert.equal(has(await post(f.url, { ...input, operations: [{ ...input.operations[0], values: { location: 'Original storage' } }] }), 'NO_METADATA_CHANGE'), true);
});

test('group pilot plans all selected groups in deterministic order and preserves every deduplication row once', async () => {
  const f = await prepare(); await decide(f, 1); const input = inputFor(f, [0, 1]);
  const response = await post(f.url, input); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.summary.selectedObservationCount, 2); assert.equal(plan.summary.omittedGroupCount, 0);
  const keys = plan.operations.flatMap((entry) => entry.deduplication.map((row) => row.key)); assert.equal(new Set(keys).size, 2);
  assert.equal((await post(f.url, { ...input, operations: [...input.operations].reverse() })).json().planId, plan.planId);
  assert.equal((await post(f.url, { ...input, operations: [input.operations[0], input.operations[0]] })).statusCode, 400);
});

test('group pilot includes every observation of a multi-row group without creating one proposed asset per Excel row', async () => {
  const f = await prepare({}, true, true); const response = await post(f.url, inputFor(f)); assert.equal(response.statusCode, 200, response.body);
  const plan = response.json(); assert.equal(plan.planValidationComplete, true); assert.equal(plan.summary.createCount, 1);
  assert.equal(plan.summary.selectedObservationCount, 2); assert.equal(plan.operations[0].source.length, 2); assert.equal(plan.omittedGroups.length, 0);
  assert.deepEqual(plan.operations[0].source.map((entry) => entry.recordId).sort(), f.review.rows.map((entry) => entry.recordId).sort());
  assert.equal(plan.operations[0].deduplication.length, 2); assert.equal(await database.asset.count({ where: { serialNumber: f.projection.groups[0].serialNumber } }), 0);
});

test('group pilot uses a consistent snapshot across later catalog changes and never writes a refreshed plan', async () => {
  const f = await prepare(); const input = inputFor(f); let armed = true;
  const concurrent = database.$extends({ query: { product: { async findMany({ args, query }) {
    if (armed) { armed = false; await database.product.update({ where: { id: product.id }, data: { model: 'Model G10' } }); } return query(args);
  } } } });
  try {
    const response = await planIdentityGroupPilot(concurrent, f.batch.id, f.review.id, identityGroupPilotSchema.parse(input));
    assert.equal(response.planValidationComplete, true); assert.equal(response.operations[0].product.model, 'Model G9');
    const next = await post(f.url, input); assert.equal(has(next, 'SELECTED_PRODUCT_MODEL_CONFLICT'), true); assert.notEqual(next.json().planId, response.planId);
  } finally { await database.product.update({ where: { id: product.id }, data: { model: 'Model G9' } }); }
});

test('group pilot snapshot stays coherent across concurrent decision or cancellation commits but the next request observes them', async () => {
  for (const kind of ['decision', 'release']) {
    const f = await prepare(); const input = inputFor(f); let armed = true;
    const concurrent = database.$extends({ query: { async $queryRaw({ args, query }) {
      if (armed && args.sql?.includes('ImportIdentityGroupDecision')) { armed = false; if (kind === 'release') await release(f); else await decide(f, 0, 'HOLD'); }
      return query(args);
    } } });
    const result = await planIdentityGroupPilot(concurrent, f.batch.id, f.review.id, identityGroupPilotSchema.parse(input));
    assert.equal(result.planValidationComplete, true); assert.equal(result.decisionVersion, 1); assert.equal(result.canApply, false);
    const next = await post(f.url, input); assert.equal(next.statusCode, 409);
    assert.equal(next.json().code, kind === 'release' ? 'IDENTITY_GROUP_ALREADY_RELEASED' : 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT');
  }
});

test('group pilot keeps archived evidence null and excluded dispositions intact without importing history or waiving source use', async () => {
  const archive = await closedAssignmentFixture({ database, product, actorId: users.JEFE.id, post, get });
  const f = await reserve({ ...archive, preview: (await get(archive.base + '/resolved-preview')).json().preview, batch: { ...archive.batch, version: 2 } });
  const evidence = f.projection.groups[0].evidence[0]; const base = '/inventory/imports/evidence/' + evidence.id;
  const amendmentPlan = await post(base + '/amendment-plan', { assetId: null }); assert.equal(amendmentPlan.statusCode, 200, amendmentPlan.body);
  const amendment = await post(base + '/amendments', { requestId: randomUUID(), expectedEvidenceVersion: 0, expectedBatchVersion: 2, expectedSourceRevision: 0,
    amendmentPlanId: amendmentPlan.json().amendmentPlanId, confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: null,
    note: 'Original archive remains unlinked pending independent review', evidenceReference: 'Physical verification' }); assert.equal(amendment.statusCode, 201, amendment.body);
  await decide(f); const before = await snapshot(f);
  const response = await post(f.url, inputFor(f)); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().planValidationComplete, false);
  const retained = response.json().operations[0].evidence.find((entry) => entry.id === evidence.id);
  assert.equal(retained.currentAssetId, null); assert.equal(retained.capturedAssetId, archive.asset.id);
  assert.equal(retained.review.disposition, 'EXCLUDE_FROM_GROUP_PILOT'); assert.equal(retained.appliedByThisPlan, false);
  assert.deepEqual(await snapshot(f), before);
});

test('group pilot fails explicitly for missing decision storage, corrupt receipts and planning bounds without partial success', async () => {
  const f = await prepare(); const input = inputFor(f);
  for (const kind of ['missing', 'corrupt', 'limit']) {
    const broken = database.$extends({ query: { async $queryRaw({ args, query }) {
      if (!args.sql?.includes('ImportIdentityGroupDecision')) return query(args);
      if (kind === 'missing') throw new Prisma.PrismaClientKnownRequestError('Missing group decisions', { code: 'P2010', clientVersion: Prisma.prismaVersion.client,
        meta: { code: '42P01', message: 'relation "ImportIdentityGroupDecision" does not exist' } });
      const rows = await query(args);
      return kind === 'corrupt' ? rows.map((entry) => ({ ...entry, requestDigest: '0'.repeat(64) })) : Array(26).fill(rows[0]);
    } } }); const instance = buildApp(broken);
    try {
      const response = await post(f.url, input, 'JEFE', true, instance); assert.equal(response.statusCode, kind === 'missing' ? 503 : 409, response.body);
      assert.equal(response.json().code, { missing: 'IMPORT_REVIEW_NOT_READY', corrupt: 'INVALID_IDENTITY_GROUP_DECISION', limit: 'IDENTITY_GROUP_DECISION_LIMIT' }[kind]);
    } finally { await instance.close(); }
  }
  await release(f); assert.equal((await post(f.url, input)).json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
});

after(async () => { await app.close(); });
