import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { evidenceAmendmentSchema } from '../src/imports/evidence-amendment-schemas.js';
import { amendHistoricalEvidence } from '../src/imports/evidence-amendment-service.js';
import { closedAssignmentApplySchema } from '../src/imports/assignment-apply-schemas.js';
import { applyClosedAssignments } from '../src/imports/assignment-apply-service.js';
import { hashPassword } from '../src/lib/password.js';
import { closedAssignmentFixture } from './fixtures/closed-assignment-import.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const users = {}; const cookies = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `amend-${role.toLowerCase()}-${suffix}`; const password = 'Amend-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Amend ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(response.statusCode, 200); const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Amend product ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role]; const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }
function prepare(options = {}) { return closedAssignmentFixture({ database, product, actorId: users.JEFE.id, post, get, ...options }); }
const endpoint = (id) => `/inventory/imports/evidence/${id}`;
async function planned(id, assetId) {
  const response = await post(endpoint(id) + '/amendment-plan', { assetId }); assert.equal(response.statusCode, 200, response.body);
  const plan = response.json();
  return { plan, input: { requestId: randomUUID(), amendmentPlanId: plan.amendmentPlanId, expectedEvidenceVersion: plan.evidenceVersion,
    expectedBatchVersion: plan.batchVersion, expectedSourceRevision: plan.sourceRevision, confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId,
    note: 'Historical source rechecked without current-state effects', evidenceReference: 'Physical source and custody documents' } };
}
async function amend(id, assetId) {
  const { plan, input } = await planned(id, assetId); assert.equal(plan.valid, true, JSON.stringify(plan.blockers));
  const response = await post(endpoint(id) + '/amendments', input); assert.equal(response.statusCode, 201, response.body); return response.json().event;
}
async function correctEnd(prepared, date = '2002-02-01', revision = 0) {
  const end = prepared.capture.items.find((item) => item.kind === 'RECEIPT_OBSERVATION');
  const response = await post(prepared.base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: revision, requestId: randomUUID(),
    note: 'Reception date checked against original document', evidenceReference: 'Signed reception record', changes: [{ recordId: end.recordId, field: 'receivedDate', action: 'REPLACE', value: date }] });
  assert.equal(response.statusCode, 201, response.body); return end;
}

test('evidence amendments and plans enforce JEFE, CSRF and strict nonoperational DTOs', async () => {
  const { capture } = await prepare(); const id = capture.items[0].id; const { input } = await planned(id, null); const url = endpoint(id);
  assert.equal((await app.inject({ method: 'POST', url: url + '/amendment-plan', payload: { assetId: null } })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) {
    assert.equal((await post(url + '/amendment-plan', { assetId: null }, role)).statusCode, 403);
    assert.equal((await post(url + '/amendments', input, role)).statusCode, 403); assert.equal((await get(url + '/amendments', role)).statusCode, 403);
  }
  assert.equal((await post(url + '/amendment-plan', { assetId: null }, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url + '/amendments', input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(url + '/amendments', { ...input, snapshot: {} })).statusCode, 400);
  assert.equal((await post(url + '/amendment-plan', {})).statusCode, 400);
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
});

test('amendment plans are read-only and unchanged interpretation remains an explicit blocker', async () => {
  const { asset, capture } = await prepare(); const id = capture.items[0].id; const original = await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id } });
  const { plan, input } = await planned(id, asset.id);
  assert.equal(plan.canApply, false); assert.equal(plan.persisted, false); assert.ok(plan.blockers.includes('EVIDENCE_AMENDMENT_UNCHANGED'));
  assert.equal((await post(endpoint(id) + '/amendments', input)).json().code, 'EVIDENCE_AMENDMENT_BLOCKED');
  assert.deepEqual(await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id } }), original);
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
});

test('unlink and relink append versions, retain original capture and make asset evidence reads follow only the current link', async () => {
  const { asset, capture, base } = await prepare({ active: true }); const id = capture.items[0].id;
  const original = await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id } });
  const captured = (await get(base + '/history-captures/' + capture.id)).json();
  const unlinked = await amend(id, null); assert.equal(unlinked.version, 1); assert.equal(unlinked.previousAmendmentId, null);
  assert.equal((await get(`/assets/${asset.id}/imported-evidence`)).json().total, capture.items.length - 1);
  const linked = await amend(id, asset.id); assert.equal(linked.version, 2); assert.equal(linked.previousAmendmentId, unlinked.id);
  const current = (await get(`/assets/${asset.id}/imported-evidence`)).json().evidence.find((item) => item.id === id);
  assert.equal(current.evidenceVersion, 2); assert.equal(current.amendmentId, linked.id); assert.equal(current.capture.sourceRevision, 0);
  assert.deepEqual(await database.importHistoricalEvidence.findUniqueOrThrow({ where: { id } }), original);
  assert.deepEqual((await get(base + '/history-captures/' + capture.id)).json(), captured);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
  assert.equal(await database.assignment.count({ where: { assetId: asset.id, endedAt: null } }), 1);
  const history = (await get(endpoint(id) + '/amendments?limit=1')).json(); assert.equal(history.total, 2); assert.equal(history.hasMore, true);
  assert.equal(history.current.evidenceVersion, 2); assert.equal(history.originalEvidence.assetId, asset.id); assert.equal(history.events[0].version, 2);
  assert.equal('snapshot' in history.events[0], false);
  const detail = await get(endpoint(id) + '/amendments/' + unlinked.id); assert.equal(detail.statusCode, 200); assert.equal(detail.json().event.snapshot.assetId, null);
  const other = capture.items.find((item) => item.id !== id); assert.equal((await get(endpoint(other.id) + '/amendments/' + unlinked.id)).statusCode, 404);
  assert.equal((await get(endpoint(id) + '/amendments?limit=101')).statusCode, 400);
});

test('later reviewed links make originally unlinked evidence usable without creating another observation or operational writes', async () => {
  const { asset, capture, input, planUrl, url } = await prepare({ unlinked: true });
  for (const item of capture.items) { const event = await amend(item.id, asset.id); assert.equal(event.snapshot.historicalActorId, null); }
  const plan = (await post(planUrl, input.plan)).json(); assert.equal(plan.planValidationComplete, true); assert.equal(plan.planRulesVersion, 'mda-closed-assignment-plan-2');
  assert.equal(plan.periods[0].sources.every((source) => source.evidenceVersion === 1 && source.amendmentId), true);
  assert.equal(await database.assignment.count({ where: { assetId: asset.id } }), 0);
  const applied = await post(url, { ...input, planId: plan.planId }); assert.equal(applied.statusCode, 201, applied.body);
  assert.equal(applied.json().application.items[0].assignment.createdById, null);
  assert.equal((await database.importHistoricalEvidence.findMany({ where: { captureId: capture.id } })).every((item) => item.assetId === null), true);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
});

test('source refresh retains original rows, removes only capture staleness and binds applied periods to the exact amended versions', async () => {
  const prepared = await prepare(); const { asset, capture, input, planUrl, url } = prepared;
  const end = await correctEnd(prepared);
  const stale = (await post(planUrl, input.plan)).json(); assert.ok(stale.periods[0].blockers.some((item) => item.code === 'EVIDENCE_SOURCE_REVISED'));
  for (const item of capture.items) await amend(item.id, asset.id);
  const updated = { periods: input.plan.periods.map((period) => ({ ...period, end: { ...period.end, confirmedAt: '2002-02-01T10:00:00-03:00' } })) };
  const plan = (await post(planUrl, updated)).json(); assert.equal(plan.planValidationComplete, true, JSON.stringify(plan.periods[0].blockers));
  assert.equal(plan.periods[0].sources.every((source) => source.sourceRevision === 1 && source.capturedSourceRevision === 0 && source.evidenceVersion === 1), true);
  const current = (await get(`/assets/${asset.id}/imported-evidence`)).json().evidence.find((item) => item.id === end.id);
  assert.equal(current.effectiveDay, '2002-02-01'); assert.equal(current.capturedEffectiveDay, '2002-01-01');
  assert.equal((await post(url, input)).json().code, 'HISTORICAL_PLAN_CHANGED');
  const applied = await post(url, { ...input, planId: plan.planId, plan: updated }); assert.equal(applied.statusCode, 201, applied.body);
  const forbidden = await planned(end.id, null); assert.ok(forbidden.plan.blockers.includes('EVIDENCE_ALREADY_APPLIED'));
  assert.equal((await post(endpoint(end.id) + '/amendments', forbidden.input)).json().code, 'EVIDENCE_ALREADY_APPLIED');
  const event = await database.importEvidenceAmendment.findFirstOrThrow({ where: { evidenceId: end.id } });
  const { id: eventId, ...eventData } = event;
  await assert.rejects(database.importEvidenceAmendment.create({ data: { ...eventData, version: 2, previousAmendmentId: eventId,
    requestId: randomUUID(), assetId: null, snapshot: forbidden.plan.proposed } }), /Applied assignment evidence cannot be amended/);
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: end.id } }), 1);
});

test('SQL assignment receipts reject forged evidence versions and cannot amend endpoints midway through construction', async () => {
  const { asset, capture, input } = await prepare(); const id = capture.items[0].id; const amendment = await planned(id, null);
  const wrongVersions = (period) => ({ ...period, sources: period.sources.map((source) => ({ ...source, evidenceVersion: 999 })) });
  const forged = database.$extends({ query: {
    importAssignmentApplication: { async create({ args, query }) { return query({ ...args, data: { ...args.data, plan: { ...args.data.plan,
      periods: args.data.plan.periods.map(wrongVersions) } } }); } },
    importAssignmentItem: { async create({ args, query }) { return query({ ...args, data: { ...args.data, snapshot: wrongVersions(args.data.snapshot) } }); } }
  } });
  await assert.rejects(applyClosedAssignments(forged, asset.id, closedAssignmentApplySchema.parse(input), users.JEFE.id), /exact current evidence versions/);
  const amendmentData = { evidenceId: id, version: 1, previousAmendmentId: null, batchVersion: 2, sourceRevision: 0, requestId: randomUUID(), requestDigest: 'a'.repeat(64),
    amendmentPlanId: amendment.plan.amendmentPlanId, rulesVersion: 'mda-history-amendment-1', assetId: null, effectiveDay: amendment.plan.proposed.effectiveDay,
    snapshot: amendment.plan.proposed, note: 'Integrity test during construction', evidenceReference: 'Original evidence', amendedById: users.JEFE.id };
  const midway = new Proxy(database, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (operation, options) => database.$transaction(async (transaction) => operation(new Proxy(transaction, { get(client, member) {
      if (member !== 'importAssignmentEvidenceUse') return Reflect.get(client, member);
      return new Proxy(transaction.importAssignmentEvidenceUse, { get(delegate, action) {
        if (action === 'createMany') return async () => transaction.importEvidenceAmendment.create({ data: amendmentData });
        return Reflect.get(delegate, action);
      } });
    } })), options);
  } });
  await assert.rejects(applyClosedAssignments(midway, asset.id, closedAssignmentApplySchema.parse(input), users.JEFE.id), /Applied assignment evidence cannot be amended/);
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
  assert.equal(await database.importAssignmentApplication.count({ where: { assetId: asset.id } }), 0);
  assert.equal(await database.assignment.count({ where: { assetId: asset.id } }), 0);
});

test('refreshing evidence does not waive actual source model conflicts or invent a cleared reception day', async () => {
  const prepared = await prepare({ unknownEndDate: true }); const { asset, capture, base, input, planUrl } = prepared;
  const end = await correctEnd(prepared, '2002-01-01');
  const correction = await post(base + '/source-revisions', { expectedBatchVersion: 2, expectedRevision: 1, requestId: randomUUID(),
    note: 'Documented differences retained for review', evidenceReference: 'Receiving record and equipment label', changes: [
      { recordId: end.recordId, field: 'model', action: 'REPLACE', value: 'Model G10' },
      { recordId: end.recordId, field: 'receivedDate', action: 'RESTORE' }
    ] }); assert.equal(correction.statusCode, 201, correction.body);
  for (const item of capture.items) await amend(item.id, asset.id);
  const current = (await get(`/assets/${asset.id}/imported-evidence`)).json().evidence.find((item) => item.id === end.id);
  assert.equal(current.effectiveDay, null); assert.equal(current.snapshot.datePrecision, 'UNKNOWN');
  const plan = (await post(planUrl, input.plan)).json(); assert.equal(plan.planValidationComplete, false);
  assert.ok(plan.periods[0].blockers.some((item) => item.code === 'SOURCE_PRODUCT_MODEL_CONFLICT'));
  assert.equal(plan.periods[0].blockers.some((item) => item.code === 'EVIDENCE_SOURCE_REVISED'), false);
});

test('amendments cannot guess a different asset or bypass an excluded identity review', async () => {
  const { asset, capture, base } = await prepare(); const id = capture.items[0].id;
  const other = await database.asset.create({ data: { productId: product.id, serialNumber: `OTHER-${randomUUID()}` } });
  const wrong = await planned(id, other.id); assert.ok(wrong.plan.blockers.includes('HISTORY_ASSET_LINK_UNCONFIRMED'));
  assert.equal((await post(endpoint(id) + '/amendments', wrong.input)).json().code, 'EVIDENCE_AMENDMENT_BLOCKED');
  const excluded = await post(base + '/decisions', { expectedVersion: 2, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: capture.items[0].candidateId,
    action: 'EXCLUDE', note: 'Identity evidence excluded after rechecking' }); assert.equal(excluded.statusCode, 201, excluded.body);
  const blocked = await planned(id, asset.id); assert.ok(blocked.plan.blockers.includes('HISTORY_ASSET_LINK_UNCONFIRMED'));
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
});

test('identical concurrent amendment requests recover one event and bind actor and intent even after later application', async () => {
  const { asset, capture, input: applicationInput, planUrl, url } = await prepare({ unlinked: true }); const id = capture.items[0].id;
  const { input } = await planned(id, asset.id); const responses = await Promise.all([post(endpoint(id) + '/amendments', input), post(endpoint(id) + '/amendments', input)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]); const eventId = responses[0].json().event.id;
  for (const item of capture.items.filter((item) => item.id !== id)) await amend(item.id, asset.id);
  const plan = (await post(planUrl, applicationInput.plan)).json(); assert.equal((await post(url, { ...applicationInput, planId: plan.planId })).statusCode, 201);
  const recovered = await post(endpoint(id) + '/amendments', input); assert.equal(recovered.statusCode, 200); assert.equal(recovered.json().event.id, eventId);
  assert.equal((await post(endpoint(id) + '/amendments', { ...input, note: 'Different intent' })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(amendHistoricalEvidence(database, id, evidenceAmendmentSchema.parse(input), users.COORDINADOR.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 1);
});

test('different concurrent amendment intents cannot overwrite the same evidence version', async () => {
  const { capture } = await prepare(); const id = capture.items[0].id; const { input } = await planned(id, null);
  const responses = await Promise.all([post(endpoint(id) + '/amendments', input), post(endpoint(id) + '/amendments', { ...input, requestId: randomUUID() })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'EVIDENCE_VERSION_CONFLICT');
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 1);
});

test('changed source, review and identity snapshots reject stale amendments without any new event', async () => {
  const prepared = await prepare(); const { asset, capture, base } = prepared; const id = capture.items[0].id; const { input } = await planned(id, null);
  await correctEnd(prepared);
  assert.equal((await post(endpoint(id) + '/amendments', input)).json().code, 'SOURCE_REVISION_CONFLICT');
  const fresh = await planned(id, null);
  assert.equal((await post(base + '/decisions', { expectedVersion: 2, expectedSourceRevision: 1, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: capture.items[0].candidateId,
    action: 'HOLD', note: 'Source rechecking in progress' })).statusCode, 201);
  assert.equal((await post(endpoint(id) + '/amendments', fresh.input)).json().code, 'REVIEW_VERSION_CONFLICT');
  const newer = await planned(id, null); await database.asset.update({ where: { id: asset.id }, data: { serialNumber: `CHANGED-${randomUUID()}` } });
  assert.equal((await post(endpoint(id) + '/amendments', newer.input)).json().code, 'EVIDENCE_AMENDMENT_PLAN_CHANGED');
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
});

test('audit failure rolls back an amendment and its retry key without touching source or operational inventory', async () => {
  const { asset, capture } = await prepare(); const id = capture.items[0].id; const { input } = await planned(id, null);
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_HISTORY_EVIDENCE_AMENDED') throw new Error('Injected amendment audit failure'); return query(args);
  } } } });
  await assert.rejects(amendHistoricalEvidence(failing, id, evidenceAmendmentSchema.parse(input), users.JEFE.id), /Injected amendment audit failure/);
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
  assert.equal((await post(endpoint(id) + '/amendments', input)).statusCode, 201);
  assert.equal(await database.assignment.count({ where: { assetId: asset.id } }), 0); assert.equal(await database.inventoryMovement.count({ where: { assetId: asset.id } }), 0);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), asset);
});

test('source lock contention is bounded and leaves the same amendment retry usable', async () => {
  const { capture } = await prepare(); const item = capture.items[0]; const { input } = await planned(item.id, null); let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
  const holder = database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${item.sourceHash}, 0))`; entered(); await gate;
  }, { timeout: 10000 }); await started;
  try {
    const response = await post(endpoint(item.id) + '/amendments', input); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'EVIDENCE_AMENDMENT_BUSY');
    assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: item.id } }), 0);
  } finally { release(); await holder; }
  assert.equal((await post(endpoint(item.id) + '/amendments', input)).statusCode, 201);
});

test('concurrent application and amendment either preserve the applied evidence or invalidate the application plan atomically', async () => {
  const { asset, capture, input, url } = await prepare(); const id = capture.items[0].id; const amendment = await planned(id, null);
  const responses = await Promise.all([post(url, input), post(endpoint(id) + '/amendments', amendment.input)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  if (responses[0].statusCode === 201) {
    assert.equal(responses[1].json().code, 'EVIDENCE_ALREADY_APPLIED'); assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
  } else {
    assert.equal(responses[0].json().code, 'HISTORICAL_PLAN_CHANGED'); assert.equal(await database.importAssignmentApplication.count({ where: { assetId: asset.id } }), 0);
  }
});

test('SQL guards reject forged originals, broken revision chains, unknown actor claims and mutation of amendment events', async () => {
  const { asset, capture } = await prepare(); const id = capture.items[0].id; const { plan } = await planned(id, null);
  const data = { evidenceId: id, version: 1, previousAmendmentId: null, batchVersion: 2, sourceRevision: 0, requestId: randomUUID(), requestDigest: 'a'.repeat(64),
    amendmentPlanId: plan.amendmentPlanId, rulesVersion: 'mda-history-amendment-1', assetId: null, effectiveDay: plan.proposed.effectiveDay, snapshot: plan.proposed,
    note: 'Direct integrity test', evidenceReference: 'Verified original', amendedById: users.JEFE.id };
  for (const change of [{ version: 2 }, { previousAmendmentId: randomUUID() }, { sourceRevision: 1 },
    { snapshot: { ...plan.proposed, historicalActorId: users.JEFE.id } }, { snapshot: { ...plan.proposed, original: { ...plan.proposed.original, row: 999 } } },
    { assetId: asset.id, snapshot: { ...plan.proposed, assetId: asset.id, linkBasis: null } }]) await assert.rejects(database.importEvidenceAmendment.create({ data: { ...data, ...change } }));
  const event = await amend(id, null);
  await assert.rejects(database.importEvidenceAmendment.update({ where: { id: event.id }, data: { note: 'Overwritten' } }), /immutable/);
  await assert.rejects(database.importEvidenceAmendment.delete({ where: { id: event.id } }), /immutable/);
  assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 1);
});

test('missing amendment storage returns an explicit deployment error before any evidence write', async () => {
  const { capture } = await prepare(); const id = capture.items[0].id; const { input } = await planned(id, null);
  const missing = database.$extends({ query: { importEvidenceAmendment: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing amendment storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportEvidenceAmendment' } });
  } } } }); const isolated = buildApp(missing);
  try {
    const cookie = cookies.JEFE; const token = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url: endpoint(id) + '/amendments', headers: { cookie, 'x-csrf-token': token }, payload: input });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
    assert.equal(await database.importEvidenceAmendment.count({ where: { evidenceId: id } }), 0);
  } finally { await isolated.close(); }
});

test('amendment migration preserves populated captures and exposes unchanged version-zero current evidence', async () => {
  const { asset, batch, capture } = await prepare();
  const migration = readFileSync(new URL('../../../prisma/migrations/0021_import_evidence_amendments/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `amendment_migration_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      const tables = ['User', 'Product', 'Asset', 'Assignment', 'ImportBatch', 'ImportHistoryCapture', 'ImportHistoricalEvidence', 'ImportSourceRevision',
        'ImportReviewDecision', 'ImportApplicationItem', 'ImportAssignmentApplication', 'ImportAssignmentItem', 'ImportAssignmentEvidenceUse'];
      for (const table of tables) await transaction.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      await transaction.$executeRawUnsafe(`DROP INDEX "${schema}"."ImportAssignmentItem_startEvidenceId_idx"`);
      await transaction.$executeRawUnsafe(`DROP INDEX "${schema}"."ImportAssignmentItem_endEvidenceId_idx"`);
      await transaction.$executeRaw`INSERT INTO "User" SELECT * FROM public."User" WHERE "id" = ${users.JEFE.id}::uuid`;
      await transaction.$executeRaw`INSERT INTO "Product" SELECT * FROM public."Product" WHERE "id" = ${product.id}::uuid`;
      await transaction.$executeRaw`INSERT INTO "Asset" SELECT * FROM public."Asset" WHERE "id" = ${asset.id}::uuid`;
      await transaction.$executeRaw`INSERT INTO "ImportBatch" SELECT * FROM public."ImportBatch" WHERE "id" = ${batch.id}::uuid`;
      await transaction.$executeRaw`INSERT INTO "ImportHistoryCapture" SELECT * FROM public."ImportHistoryCapture" WHERE "id" = ${capture.id}::uuid`;
      await transaction.$executeRaw`INSERT INTO "ImportHistoricalEvidence" SELECT * FROM public."ImportHistoricalEvidence" WHERE "captureId" = ${capture.id}::uuid`;
      const before = await transaction.$queryRaw`SELECT to_jsonb(e) AS data FROM "ImportHistoricalEvidence" e ORDER BY "id"`;
      const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE VIEW[\s\S]*?;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE TRIGGER[^;]+;/g);
      assert.equal(statements.length, 11); for (const statement of statements) await transaction.$executeRawUnsafe(statement);
      assert.deepEqual(await transaction.$queryRaw`SELECT to_jsonb(e) AS data FROM "ImportHistoricalEvidence" e ORDER BY "id"`, before);
      const current = await transaction.$queryRaw`SELECT "id", "assetId", "evidenceVersion", "amendmentId" FROM "ImportHistoricalEvidenceCurrent" ORDER BY "id"`;
      assert.equal(current.length, capture.items.length); assert.equal(current.every((item) => item.assetId === asset.id && item.evidenceVersion === 0 && item.amendmentId === null), true);
      const [count] = await transaction.$queryRaw`SELECT count(*)::integer AS total FROM "ImportEvidenceAmendment"`;
      assert.equal(count.total, 0); throw new RollbackTest();
    }, { timeout: 15000 });
  } catch (error) { if (!(error instanceof RollbackTest)) throw error; }
});

after(async () => { await app.close(); });
