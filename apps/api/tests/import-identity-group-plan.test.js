import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { planIdentityGroups } from '../src/imports/identity-group-plan-service.js';
import { hashPassword } from '../src/lib/password.js';
import { closedAssignmentFixture } from './fixtures/closed-assignment-import.js';
import { verifiedRetirementFixture } from './fixtures/verified-retirement-import.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { dateCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `groupplan-${role.toLowerCase()}-${suffix}`; const password = 'Group-plan-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Identity grouping ${role}`, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Identity group ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role]; const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url) { return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } }); }
function groupingInput(preview, version = 1, revision = 0) {
  return { expectedVersion: version, expectedSourceRevision: revision, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: preview.candidates.map((candidate) => candidate.id), note: 'All selected observations independently verified',
    groups: preview.records.map((record) => ({ groupId: randomUUID(), recordIds: [record.id], serialNumber: 'GROUP-NEW-' + randomUUID(),
      assetTag: null, evidenceReference: 'Physical label and original record checked' })) };
}
async function prepare(rows, originalSource) {
  const serial = 'GROUP-SOURCE-' + randomUUID();
  const source = originalSource ?? workbook('Recepción', rows ?? [receptionRow(4, serial, { K: textCell('Disponible') }), receptionRow(5, serial, { K: textCell('Disponible') })]);
  if (!originalSource) source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body); const preview = previewed.json();
  const saved = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.ok([200, 201].includes(saved.statusCode), saved.body);
  const batch = saved.json().batch; const base = `/inventory/imports/batches/${batch.id}`;
  return { source, preview, batch, base, input: groupingInput(preview, batch.version), url: base + '/identity-group-plan' };
}
const codes = (plan) => plan.blockers.map((issue) => issue.code);

test('identity group plan requires JEFE, CSRF, strict proposals and complete original physical coverage', async () => {
  const { input, url } = await prepare();
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { groups: [input.groups[0]] }, { candidateIds: ['f'.repeat(64)] }, { confirmation: 'APPLY' }]) {
    assert.equal((await post(url, { ...input, ...change })).statusCode, 400);
  }
  assert.equal((await post(`/inventory/imports/batches/${randomUUID()}/identity-group-plan`, input)).statusCode, 404);
});

test('identity group plan is deterministic read-only with original lineage and cannot bypass V8, review or application through simulated IDs', async () => {
  const fixture = await prepare(); const { input, url, batch, base, preview } = fixture;
  const snapshot = async () => ({ batch: await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }),
    revisions: await database.importSourceRevision.count({ where: { batchId: batch.id } }), decisions: await database.importReviewDecision.count({ where: { batchId: batch.id } }),
    captures: await database.importHistoryCapture.count({ where: { batchId: batch.id } }), applications: await database.importApplication.count({ where: { batchId: batch.id } }),
    audit: await database.auditLog.count({ where: { entityId: batch.id } }), assets: await database.asset.count({ where: { productId: product.id } }),
    assignments: await database.assignment.count({ where: { asset: { productId: product.id } } }), stock: await database.inventoryStock.count({ where: { productId: product.id } }) });
  const before = await snapshot(); const response = await post(url, input); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  assert.equal(plan.operationKind, 'SPLIT'); assert.equal(plan.proposalValidationComplete, true); assert.equal(plan.canApply, false);
  assert.equal(plan.persisted, false); assert.equal(plan.affectsCurrentState, false); assert.equal(plan.lineagePersistenceImplemented, false);
  assert.equal(plan.originalCandidates[0].candidateId, preview.candidates[0].id);
  assert.equal((await post(url, input)).json().planId, plan.planId); assert.equal((await post(url, { ...input, groups: [...input.groups].reverse() })).json().planId, plan.planId);
  assert.deepEqual(await snapshot(), before);
  const simulatedId = plan.proposedGroups[0].simulatedCandidateIds[0];
  const reviewed = await post(base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: simulatedId, action: 'PROPOSE_NEW', note: 'Simulation cannot approve a source target' }); assert.equal(reviewed.statusCode, 400);
  assert.equal((await post(base + '/apply', plan)).statusCode, 400); assert.equal((await post(url + '/apply', {})).statusCode, 404);
  assert.deepEqual(await snapshot(), before);
});

test('identity group plan tracks V7/V8 effective interpretations and version conflicts without saving partial identity corrections', async () => {
  const fixture = await prepare(); const { base, input, url, source, preview } = fixture;
  const first = (await post(url, input)).json(); const verifiedSerial = 'GROUP-WHOLE-' + randomUUID();
  const revised = await post(base + '/identity-revisions', { expectedRevision: 0, expectedBatchVersion: 1, requestId: randomUUID(), candidateId: preview.candidates[0].id,
    action: 'VERIFY', confirmation: 'VERIFIED_PHYSICAL_IDENTITY', serialNumber: verifiedSerial, assetTag: null,
    note: 'Whole candidate reviewed using existing V8', evidenceReference: 'Original physical label review' }); assert.equal(revised.statusCode, 201, revised.body);
  assert.equal((await post(url, input)).json().code, 'SOURCE_REVISION_CONFLICT');
  const response = await post(url, { ...input, expectedSourceRevision: 1 }); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
  assert.equal(plan.sourceRevision, 1); assert.notEqual(plan.planId, first.planId);
  assert.equal(plan.changes.every((change) => change.beforeCell.value === verifiedSerial), true);
  assert.equal(plan.changes.every((change) => change.originalCell.value === source.sheets[0].rows[1].cells.F.value), true);
  const hold = await post(base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 1, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: preview.candidates[0].id, action: 'HOLD', note: 'Identity needs regrouping review' }); assert.equal(hold.statusCode, 201, hold.body);
  assert.equal((await post(url, { ...input, expectedSourceRevision: 1 })).json().code, 'REVIEW_VERSION_CONFLICT');
  const current = (await post(url, { ...input, expectedVersion: 2, expectedSourceRevision: 1 })).json();
  assert.equal(current.requiresDecisionRenewal, true); assert.equal(current.impacts.decisions[0].action, 'HOLD');
  assert.equal((await get(base + '/resolved-preview')).json().preview.candidates.length, 1);
});

test('identity group plan validates merge realism, outside absorption and residual source conflicts without clearing them', async () => {
  const fixture = await prepare([receptionRow(4, 'GROUP-A'), receptionRow(5, 'GROUP-B', { E: textCell('Model G10') }), receptionRow(6, 'GROUP-OUT')]);
  const { input, preview, url } = fixture; const included = preview.candidates.filter((candidate) => !candidate.serials.includes('GROUP-OUT'));
  const records = included.flatMap((candidate) => candidate.recordIds);
  const merged = { ...input, candidateIds: included.map((candidate) => candidate.id), groups: [{ ...input.groups[0], recordIds: records, serialNumber: 'MERGED-VERIFIED' }] };
  const plan = (await post(url, merged)).json(); assert.equal(plan.operationKind, 'MERGE'); assert.ok(codes(plan).includes('SOURCE_PRODUCT_MODEL_CONFLICT'));
  const clash = (await post(url, { ...merged, groups: [{ ...merged.groups[0], serialNumber: 'GROUP-OUT' }] })).json();
  assert.ok(codes(clash).includes('IDENTITY_OVERLAP_OUTSIDE_SCOPE')); assert.ok(codes(clash).includes('PROPOSED_GROUP_NOT_REALIZABLE'));
  assert.equal(clash.proposedGroups[0].candidates[0].outsideRecordCount, 1);
});

test('identity group plan reports unconsumed historical captures and latest explicit unlink without rewriting archived candidate lineage', async () => {
  const fixture = await prepare([receptionRow(4, 'GROUP-ARCHIVE', { A: dateCell('2001-01-01') }), receptionRow(5, 'GROUP-ARCHIVE', { A: dateCell('2002-01-01') })]);
  const { base, batch, input, url } = fixture; const history = (await get(base + '/history-preview')).json();
  const saved = await post(base + '/history-captures', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), historyPreviewId: history.historyPreviewId,
    confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Original chronology retained', evidenceReference: 'Original receiving records',
    records: history.observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: null })) }); assert.equal(saved.statusCode, 201, saved.body);
  const capture = saved.json().capture; assert.equal(capture.items.length, 2);
  const plan = (await post(url, input)).json(); assert.equal(plan.requiresEvidenceLineageReview, true); assert.equal(plan.impacts.evidence.length, 2);
  assert.equal(plan.proposalValidationComplete, true); assert.equal(plan.impacts.evidence[0].evidenceVersion, 0);
  const correction = await post(base + '/source-revisions', { expectedBatchVersion: 1, expectedRevision: 0, requestId: randomUUID(), note: 'Correct reception source',
    evidenceReference: 'Original signed document', changes: [{ recordId: capture.items[0].recordId, field: 'receivedDate', action: 'REPLACE', value: '2000-01-01' }] });
  assert.equal(correction.statusCode, 201, correction.body);
  const evidenceBase = `/inventory/imports/evidence/${capture.items[0].id}`; const amendmentPlan = (await post(evidenceBase + '/amendment-plan', { assetId: null })).json();
  const amended = await post(evidenceBase + '/amendments', { requestId: randomUUID(), amendmentPlanId: amendmentPlan.amendmentPlanId,
    expectedEvidenceVersion: amendmentPlan.evidenceVersion, expectedBatchVersion: amendmentPlan.batchVersion, expectedSourceRevision: amendmentPlan.sourceRevision,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: null, note: 'Explicit refreshed unlinked evidence', evidenceReference: 'Corrected receiving record' });
  assert.equal(amended.statusCode, 201, amended.body);
  const current = (await post(url, { ...input, expectedSourceRevision: 1 })).json(); const item = current.impacts.evidence.find((entry) => entry.id === capture.items[0].id);
  assert.equal(item.evidenceVersion, 1); assert.equal(item.currentAssetId, null); assert.equal(item.sourceRevision, 1);
  assert.equal((await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id: item.id } })).candidateId, input.candidateIds[0]);
  assert.equal(await database.importHistoryCapture.count({ where: { batchId: batch.id } }), 1);
});

test('identity group plan blocks previously applied pilot candidates across batches of the same source without renaming or duplicating assets', async () => {
  const fixture = await prepare(); const { base, input, source, preview } = fixture;
  const reviewed = await post(base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: preview.candidates[0].id, action: 'PROPOSE_NEW', note: 'Physical original candidate checked' }); assert.equal(reviewed.statusCode, 201, reviewed.body);
  const pilotInput = { expectedVersion: 2, expectedSourceRevision: 0, operations: [{ type: 'CREATE_ASSET', candidateId: preview.candidates[0].id,
    note: 'Explicit available original equipment', confirmation: 'AVAILABLE_UNASSIGNED', acknowledgedWarnings: [], values: { productId: product.id, serialNumber: source.sheets[0].rows[1].cells.F.value } }] };
  const first = (await post(base + '/plan', pilotInput)).json(); pilotInput.operations[0].acknowledgedWarnings = first.operations[0].warnings.map((warning) => warning.id);
  const planResponse = await post(base + '/plan', pilotInput); assert.equal(planResponse.statusCode, 200, planResponse.body); const pilot = planResponse.json(); assert.equal(pilot.planValidationComplete, true);
  const applied = await post(base + '/apply', { requestId: randomUUID(), planId: pilot.planId, confirmation: 'APPLY_ASSET_PILOT', plan: pilotInput });
  assert.equal(applied.statusCode, 201, applied.body); const receiptItem = applied.json().application.items[0];
  const originalAsset = await database.asset.findUniqueOrThrow({ where: { id: receiptItem.assetId } });
  const own = (await post(fixture.url, { ...input, expectedVersion: 2 })).json(); assert.ok(codes(own).includes('SOURCE_CANDIDATE_ALREADY_APPLIED'));
  const other = await prepare(undefined, source); const crossBatch = (await post(other.url, other.input)).json();
  assert.ok(codes(crossBatch).includes('SOURCE_CANDIDATE_ALREADY_APPLIED')); assert.equal(crossBatch.impacts.pilotItems[0].id, receiptItem.id);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: originalAsset.id } }), originalAsset);
});

test('identity group plan blocks records used in closed assignments or verified retirements while preserving their immutable receipts', async () => {
  for (const create of [closedAssignmentFixture, verifiedRetirementFixture]) {
    const fixture = await create({ database, product, actorId: users.JEFE.id, post, get });
    const applied = await post(fixture.url, fixture.input); assert.equal(applied.statusCode, 201, applied.body);
    const preview = buildWorkbookPreview(fixture.source, [], '2026-10-05'); const input = groupingInput(preview, 2);
    const response = await post(fixture.base + '/identity-group-plan', input); assert.equal(response.statusCode, 200, response.body); const plan = response.json();
    assert.ok(codes(plan).includes('SOURCE_OBSERVATION_ALREADY_APPLIED')); assert.equal(plan.proposalValidationComplete, false);
    assert.equal(plan.impacts.evidence.some((entry) => entry.assignmentUse || entry.retirementUse), true);
    assert.equal((await get(fixture.receiptUrl)).json().total, 1);
  }
});

test('identity group plan uses one snapshot across a concurrently committed review decision', async () => {
  const fixture = await prepare(); let triggered = false;
  const concurrent = database.$extends({ query: { importApplicationItem: { async findMany({ args, query }) {
    if (!triggered) { triggered = true; const held = await post(fixture.base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(),
      targetType: 'CANDIDATE', targetId: fixture.input.candidateIds[0], action: 'HOLD', note: 'Concurrent independent review' }); assert.equal(held.statusCode, 201, held.body); }
    return query(args);
  } } } });
  const plan = await planIdentityGroups(concurrent, fixture.batch.id, fixture.input);
  assert.equal(triggered, true); assert.equal(plan.batchVersion, 1); assert.equal(plan.impacts.decisions.length, 0);
  const current = (await post(fixture.url, { ...fixture.input, expectedVersion: 2 })).json();
  assert.equal(current.batchVersion, 2); assert.equal(current.impacts.decisions.length, 1); assert.notEqual(current.planId, plan.planId);
});

test('identity group plan refuses unavailable storage and excessive evidence/assets without partial or truncated success', async () => {
  const fixture = await prepare();
  const missing = database.$extends({ query: { importHistoricalEvidence: { async findMany() {
    throw new Prisma.PrismaClientKnownRequestError('Missing evidence storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportHistoricalEvidence' } });
  } } } });
  const isolated = buildApp(missing);
  try {
    const cookie = cookies.JEFE; const csrfToken = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url: fixture.url, headers: { cookie, 'x-csrf-token': csrfToken }, payload: fixture.input });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
  } finally { await isolated.close(); }
  for (const model of ['importHistoricalEvidence', 'asset']) {
    const oversized = database.$extends({ query: { [model]: { async findMany({ args }) { assert.equal(args.take, model === 'asset' ? 25001 : 101); return Array(args.take).fill({}); } } } });
    await assert.rejects(planIdentityGroups(oversized, fixture.batch.id, fixture.input), (error) => ['IDENTITY_GROUP_EVIDENCE_LIMIT', 'PREVIEW_DATABASE_LIMIT'].includes(error.code));
  }
});

after(async () => { await app.close(); });
