import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { URL } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { captureHistoricalEvidence } from '../src/imports/history-service.js';
import { historyCaptureSchema } from '../src/imports/history-schemas.js';
import { hashPassword } from '../src/lib/password.js';
import { dateCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

const suffix = randomUUID().slice(0, 8);
const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: {
  async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } }); }
} } });
const app = buildApp(database);
const cookies = {};
const users = {};
let product;

before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = `history-${role.toLowerCase()}-${suffix}`;
    const password = 'History-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `History ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `History product ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});

async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role];
  const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
function get(url, role = 'JEFE') { return app.inject({ method: 'GET', url, headers: { cookie: cookies[role] } }); }

async function prepare(options = {}) {
  const serial = options.serial ?? `HISTORY-${randomUUID()}`;
  let source = options.source;
  if (!source) {
    source = options.retirement ? workbook('Baja 2026', [{ row: 2, cells: { A: dateCell('2001-01-01'), B: textCell('Notebook'), C: textCell('HP'), D: textCell('Model G9'), E: textCell(serial) } }])
      : workbook('Recepción', [receptionRow(4, serial, { A: dateCell('2001-01-01'), K: textCell('Disponible'), ...options.extra })]);
    source.source.sha256 = randomBytes(32).toString('hex');
  }
  const previewed = await post('/inventory/imports/preview', source);
  assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json();
  const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId });
  assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch;
  const base = `/inventory/imports/batches/${batch.id}`;
  return { source, preview, batch, base, serial };
}
function captureInput(view, records = view.observations.slice(0, 1).map(({ recordId, kind }) => ({ recordId, kind }))) {
  return { expectedVersion: view.batchVersion, expectedSourceRevision: view.sourceRevision, requestId: randomUUID(), historyPreviewId: view.historyPreviewId,
    confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Historical observation reviewed without current-state effects', evidenceReference: 'Workbook and custody evidence E-001', records };
}

test('history capture and preview require JEFE, writes require CSRF and linked evidence requires authentication', async () => {
  const { base } = await prepare();
  const view = (await get(base + '/history-preview')).json();
  const input = captureInput(view);
  assert.equal((await app.inject({ method: 'GET', url: base + '/history-preview' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: base + '/history-captures', payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) {
    assert.equal((await get(base + '/history-preview', role)).statusCode, 403);
    assert.equal((await post(base + '/history-captures', input, role)).statusCode, 403);
  }
  assert.equal((await post(base + '/history-captures', input, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(base + '/history-captures', { ...input, effectiveAt: '2001-01-01T00:00:00Z' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/assets/${randomUUID()}/imported-evidence` })).statusCode, 401);
  assert.equal((await get(`/inventory/imports/batches/${randomUUID()}/history-preview`)).statusCode, 404);
});

test('historical preview and capture preserve uncertain dates, raw source and actor separation without operational writes', async () => {
  const { base, batch, source, preview } = await prepare({ extra: { A: dateCell('2055-01-01'), M: textCell('Not dated'), P: textCell('Reported dispatch without a known recipient') } });
  const before = await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
  const assets = await database.asset.findMany({ where: { productId: product.id } });
  const usersBefore = await database.user.findMany({ where: { username: { startsWith: `history-`, endsWith: suffix } } });
  const view = (await get(base + '/history-preview')).json();
  assert.equal(view.observations.length, 2);
  assert.equal(view.canApply, false); assert.equal(view.persisted, false);
  assert.equal(view.observations.every((entry) => entry.effectiveDay === null), true);
  assert.equal(await database.importHistoryCapture.count({ where: { batchId: batch.id } }), 0);
  const response = await post(base + '/history-captures', captureInput(view, view.observations.map(({ recordId, kind }) => ({ recordId, kind }))));
  assert.equal(response.statusCode, 201, response.body);
  const { capture, affectsCurrentState } = response.json();
  assert.equal(affectsCurrentState, false); assert.equal(capture.items.length, 2);
  assert.equal(capture.capturedById, users.JEFE.id);
  assert.ok(capture.capturedAt);
  assert.equal(capture.rulesVersion, 'mda-history-evidence-1');
  assert.equal(capture.items.every((item) => item.effectiveDay === null && item.assetId === null && item.snapshot.historicalActorId === null), true);
  assert.deepEqual(capture.items[0].snapshot.original.originalCells, source.sheets[0].rows[1].cells);
  assert.ok(capture.items.some((item) => item.snapshot.issues.some((issue) => issue.code === 'FUTURE_SOURCE_DATE')));
  assert.deepEqual(await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }), before);
  assert.deepEqual((await get(base + '/preview')).json().snapshot, preview);
  assert.deepEqual(await database.asset.findMany({ where: { productId: product.id } }), assets);
  assert.deepEqual(await database.user.findMany({ where: { username: { startsWith: `history-`, endsWith: suffix } } }), usersBefore);
  assert.equal(await database.auditLog.count({ where: { entityId: capture.id, action: 'IMPORT_HISTORY_EVIDENCE_CAPTURED' } }), 1);
  assert.equal((await get(base + '/history-preview')).json().observations.every((entry) => entry.stored !== null), true);
});

test('retirement evidence can link to a reviewed terminal asset without decommissioning or dating it again', async () => {
  const asset = await database.asset.create({ data: { productId: product.id, serialNumber: `RETIRED-${randomUUID()}`, status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date() } });
  const { base, preview } = await prepare({ retirement: true, serial: asset.serialNumber });
  const before = await database.asset.findUniqueOrThrow({ where: { id: asset.id } });
  const reviewed = await post(base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: preview.candidates[0].id, action: 'LINK_EXISTING', linkedAssetId: asset.id, note: 'Physical source linkage reviewed' });
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  const view = (await get(base + '/history-preview')).json();
  const retirement = view.observations.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION');
  assert.equal(retirement.effectiveDay, null);
  assert.equal(retirement.linkOptions[0].assetId, asset.id);
  const response = await post(base + '/history-captures', captureInput(view, [{ recordId: retirement.recordId, kind: retirement.kind, assetId: asset.id.toUpperCase() }]));
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().capture.items[0].snapshot.linkBasis.type, 'REVIEW_DECISION');
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: asset.id } }), before);
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const read = await get(`/assets/${asset.id}/imported-evidence?limit=1`, role);
    assert.equal(read.statusCode, 200); assert.equal(read.json().total, 1); assert.equal(read.json().affectsCurrentState, false);
  }
  assert.equal(await database.assignment.count({ where: { assetId: asset.id } }), 0);
  assert.equal(await database.inventoryMovement.count({ where: { assetId: asset.id } }), 0);
});

test('linking historical custody evidence preserves an active assignment, and guesses are rejected', async () => {
  const asset = await database.$transaction(async (transaction) => {
    const created = await transaction.asset.create({ data: { productId: product.id, serialNumber: `ASSIGNED-HISTORY-${randomUUID()}`, status: 'ASSIGNED' } });
    await transaction.assignment.create({ data: { assetId: created.id, personName: 'Existing recipient', createdById: users.JEFE.id, startedAt: new Date() } });
    return created;
  });
  const { base, preview } = await prepare({ serial: asset.serialNumber, extra: { M: dateCell('2002-01-01'), P: textCell('Historical office dispatch') } });
  const assignments = await database.assignment.findMany({ where: { assetId: asset.id } });
  const initialView = (await get(base + '/history-preview')).json();
  assert.equal((await post(base + '/history-captures', captureInput(initialView, [{ recordId: initialView.observations[0].recordId, kind: initialView.observations[0].kind, assetId: asset.id }]))).json().code, 'HISTORY_ASSET_LINK_UNCONFIRMED');
  assert.equal((await post(base + '/decisions', { expectedVersion: 1, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: preview.candidates[0].id,
    action: 'LINK_EXISTING', linkedAssetId: asset.id, note: 'Reviewed historical asset reference' })).statusCode, 201);
  const view = (await get(base + '/history-preview')).json();
  const usage = view.observations.find((entry) => entry.kind === 'USAGE_OBSERVATION');
  const result = await post(base + '/history-captures', captureInput(view, [{ recordId: usage.recordId, kind: usage.kind, assetId: asset.id }]));
  assert.equal(result.statusCode, 201, result.body);
  assert.equal((await database.asset.findUniqueOrThrow({ where: { id: asset.id } })).status, 'ASSIGNED');
  assert.deepEqual(await database.assignment.findMany({ where: { assetId: asset.id } }), assignments);
});

test('pilot receipts support later historical evidence without reapplying inventory or requiring a fresh operational batch', async () => {
  const { base, preview, serial } = await prepare();
  const candidateId = preview.candidates[0].id;
  assert.equal((await post(base + '/decisions', { expectedVersion: 1, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: candidateId, action: 'PROPOSE_NEW', note: 'Physical availability verified' })).statusCode, 201);
  const plan = { expectedVersion: 2, operations: [{ type: 'CREATE_ASSET', candidateId, note: 'Verified asset', confirmation: 'AVAILABLE_UNASSIGNED', values: { productId: product.id, serialNumber: serial } }] };
  const planned = (await post(base + '/plan', plan)).json();
  assert.equal(planned.planValidationComplete, true);
  const input = { requestId: randomUUID(), planId: planned.planId, confirmation: 'APPLY_ASSET_PILOT', plan };
  let applied;
  for (let attempt = 0; attempt < 8; attempt++) {
    applied = await post(base + '/apply', input);
    if (applied.json().code !== 'IMPORT_APPLY_BUSY') break;
    await setTimeout(50);
  }
  assert.equal(applied.statusCode, 201, applied.body);
  const assetId = applied.json().application.items[0].assetId;
  const before = await database.asset.findUniqueOrThrow({ where: { id: assetId } });
  assert.equal((await get(base + '/freshness')).json().stale, true);
  const view = (await get(base + '/history-preview')).json();
  assert.equal(view.observations[0].linkOptions[0].basis.type, 'PILOT_RECEIPT');
  const result = await post(base + '/history-captures', captureInput(view, [{ recordId: view.observations[0].recordId, kind: view.observations[0].kind, assetId }]));
  assert.equal(result.statusCode, 201, result.body);
  assert.deepEqual(await database.asset.findUniqueOrThrow({ where: { id: assetId } }), before);
  assert.equal(await database.importApplicationItem.count({ where: { sourceHash: preview.source.sha256 } }), 1);
});

test('capture idempotency survives later changes and binds actor, rationale and normalized selection', async () => {
  const { base, batch } = await prepare({ extra: { M: dateCell('2002-01-01') } });
  const view = (await get(base + '/history-preview')).json();
  const input = captureInput(view, view.observations.map(({ recordId, kind }) => ({ recordId, kind })));
  const responses = await Promise.all([post(base + '/history-captures', input), post(base + '/history-captures', input)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]);
  const captureId = responses[0].json().capture.id;
  const retried = await post(base + '/history-captures', { ...input, records: input.records.toReversed() });
  assert.equal(retried.statusCode, 200); assert.equal(retried.json().capture.id, captureId);
  assert.equal((await post(base + '/history-captures', { ...input, note: 'Another reason' })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(captureHistoricalEvidence(database, batch.id, historyCaptureSchema.parse(input), users.COORDINADOR.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await database.importHistoryCapture.count({ where: { batchId: batch.id } }), 1);
});

test('two batches for the same source cannot duplicate historical observations or leave partial capture headers', async () => {
  const first = await prepare();
  const copied = JSON.parse(JSON.stringify(first.source)); copied.source.fileName = 'Same-history-source.xlsx';
  const second = await prepare({ source: copied });
  const views = await Promise.all([get(first.base + '/history-preview'), get(second.base + '/history-preview')]);
  const responses = await Promise.all([post(first.base + '/history-captures', captureInput(views[0].json())), post(second.base + '/history-captures', captureInput(views[1].json()))]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'HISTORY_EVIDENCE_ALREADY_CAPTURED');
  assert.equal(await database.importHistoricalEvidence.count({ where: { sourceHash: first.source.source.sha256 } }), 1);
  assert.equal(await database.importHistoryCapture.count({ where: { sourceHash: first.source.source.sha256 } }), 1);
});

test('invalid source targets, stale previews, revisions and review versions perform no history writes', async () => {
  const { base, batch } = await prepare();
  const view = (await get(base + '/history-preview')).json();
  const input = captureInput(view);
  for (const [override, code] of [[{ historyPreviewId: 'f'.repeat(64) }, 'HISTORY_PREVIEW_CHANGED'], [{ expectedVersion: 2 }, 'REVIEW_VERSION_CONFLICT'],
    [{ expectedSourceRevision: 1 }, 'SOURCE_REVISION_CONFLICT'], [{ records: [{ ...input.records[0], kind: 'LOAN_OBSERVATION' }] }, 'INVALID_HISTORICAL_TARGET']]) {
    assert.equal((await post(base + '/history-captures', { ...input, ...override })).json().code, code);
  }
  const missing = await post(base + '/history-captures', { ...input, records: [{ ...input.records[0], assetId: randomUUID() }] });
  assert.equal(missing.statusCode, 404);
  await database.asset.create({ data: { productId: product.id, serialNumber: `NEW-SNAPSHOT-${randomUUID()}` } });
  assert.equal((await post(base + '/history-captures', input)).json().code, 'HISTORY_PREVIEW_CHANGED');
  assert.equal(await database.importHistoryCapture.count({ where: { batchId: batch.id } }), 0);
});

test('source corrections invalidate a historical preview but previously captured originals remain immutable', async () => {
  const { base, preview } = await prepare({ extra: { A: dateCell('2055-01-01') } });
  const oldView = (await get(base + '/history-preview')).json();
  const oldInput = captureInput(oldView);
  const corrected = await post(base + '/source-revisions', { expectedRevision: 0, expectedBatchVersion: 1, requestId: randomUUID(), note: 'Verified receiving date', evidenceReference: 'Receiving act R-001',
    changes: [{ recordId: preview.records[0].id, field: 'receivedDate', action: 'REPLACE', value: '2001-01-01' }] });
  assert.equal(corrected.statusCode, 201, corrected.body);
  assert.equal((await post(base + '/history-captures', oldInput)).json().code, 'SOURCE_REVISION_CONFLICT');
  const view = (await get(base + '/history-preview')).json();
  const response = await post(base + '/history-captures', captureInput(view));
  assert.equal(response.statusCode, 201, response.body);
  const item = response.json().capture.items[0];
  assert.equal(item.effectiveDay, '2001-01-01');
  assert.equal(item.snapshot.original.fields.receivedDate, '2055-01-01');
  assert.equal(item.snapshot.effective.fields.receivedDate, '2001-01-01');
  assert.equal(item.snapshot.sourceCorrections.length, 1);
  await assert.rejects(database.importHistoricalEvidence.update({ where: { id: item.id }, data: { effectiveDay: '2002-01-01' } }));
  await assert.rejects(database.importHistoryCapture.delete({ where: { id: response.json().capture.id } }));
});

test('audit failure rolls back the historical capture and all its items, allowing the same request to retry', async () => {
  const { base, batch } = await prepare();
  const input = historyCaptureSchema.parse(captureInput((await get(base + '/history-preview')).json()));
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_HISTORY_EVIDENCE_CAPTURED') throw new Error('Injected history audit failure');
    return query(args);
  } } } });
  await assert.rejects(captureHistoricalEvidence(failing, batch.id, input, users.JEFE.id), /Injected history audit failure/);
  assert.equal(await database.importHistoryCapture.count({ where: { batchId: batch.id } }), 0);
  assert.equal(await database.importHistoricalEvidence.count({ where: { sourceHash: batch.sourceHash } }), 0);
  assert.equal((await captureHistoricalEvidence(database, batch.id, input, users.JEFE.id)).reused, false);
});

test('historical capture bounds source lock waits, rolls back and safely retries the same request', async () => {
  const { base, batch } = await prepare();
  const input = captureInput((await get(base + '/history-preview')).json());
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const holder = database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${batch.sourceHash}, 0))`;
    entered();
    await gate;
  }, { timeout: 10000 });
  await started;
  try {
    const response = await post(base + '/history-captures', input);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'HISTORY_CAPTURE_BUSY');
    assert.equal(await database.importHistoryCapture.count({ where: { batchId: batch.id } }), 0);
    assert.equal(await database.importHistoricalEvidence.count({ where: { sourceHash: batch.sourceHash } }), 0);
  } finally { release(); await holder; }
  assert.equal((await post(base + '/history-captures', input)).statusCode, 201);
});

test('history receipts and metadata lists are paginated, scoped and do not repeat source cells in list responses', async () => {
  const { base } = await prepare({ extra: { M: dateCell('2002-01-01') } });
  let view = (await get(base + '/history-preview?limit=1')).json();
  assert.equal(view.total, 2); assert.equal(view.hasMore, true);
  const first = await post(base + '/history-captures', captureInput(view));
  assert.equal(first.statusCode, 201, first.body);
  view = (await get(base + '/history-preview?limit=1&offset=1')).json();
  const second = await post(base + '/history-captures', captureInput(view));
  assert.equal(second.statusCode, 201, second.body);
  const list = (await get(base + '/history-captures?limit=1')).json();
  assert.equal(list.total, 2); assert.equal(list.hasMore, true);
  assert.equal('selection' in list.captures[0], false); assert.equal('items' in list.captures[0], false);
  assert.equal((await get(base + '/history-captures/' + first.json().capture.id)).statusCode, 200);
  const other = await prepare();
  assert.equal((await get(other.base + '/history-captures/' + first.json().capture.id)).statusCode, 404);
  assert.equal((await get(base + '/history-captures?limit=101')).statusCode, 400);
});

test('a missing history migration yields a safe deployment error before any historical write', async () => {
  const { base, batch } = await prepare();
  const input = captureInput((await get(base + '/history-preview')).json());
  const missing = database.$extends({ query: { importHistoryCapture: { async findUnique() {
    throw new Prisma.PrismaClientKnownRequestError('Missing capture table', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportHistoryCapture' } });
  } } } });
  const isolated = buildApp(missing);
  try {
    const cookie = cookies.JEFE;
    const token = (await isolated.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolated.inject({ method: 'POST', url: base + '/history-captures', headers: { cookie, 'x-csrf-token': token }, payload: input });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
    assert.equal(await database.importHistoryCapture.count({ where: { batchId: batch.id } }), 0);
  } finally { await isolated.close(); }
});

test('database guards reject incomplete captures, altered originals and invented asset provenance', async () => {
  const { base } = await prepare();
  const view = (await get(base + '/history-preview')).json();
  const captured = await post(base + '/history-captures', captureInput(view));
  assert.equal(captured.statusCode, 201, captured.body);
  const capture = captured.json().capture;
  const item = capture.items[0];
  const header = { batchId: capture.batchId, batchVersion: capture.batchVersion, sourceRevision: capture.sourceRevision, sourceHash: capture.sourceHash,
    requestId: randomUUID(), requestDigest: 'e'.repeat(64), historyPreviewId: capture.historyPreviewId, rulesVersion: capture.rulesVersion, note: 'Guard test', evidenceReference: 'Guard proof', selection: capture.selection, capturedById: users.JEFE.id };
  const matchesDatabaseError = (pattern) => (error) => {
    assert.match(error.message + ' ' + JSON.stringify(error.meta), pattern);
    return true;
  };
  await assert.rejects(database.importHistoryCapture.create({ data: header }), matchesDatabaseError(/Every historical selection requires one immutable evidence item/));
  for (const [snapshot, pattern] of [
    [{ ...item.snapshot, original: { ...item.snapshot.original, row: 999 } }, /Historical evidence must retain a mapped physical source/],
    [{ ...item.snapshot, historicalActorId: users.JEFE.id }, /ImportHistoricalEvidence_snapshot_check/],
    [{ ...item.snapshot, linkBasis: { type: 'REVIEW_DECISION', id: randomUUID() } }, /Unlinked evidence cannot claim a reviewed asset/]
  ]) {
    await assert.rejects(database.$transaction(async (transaction) => {
      const copied = await transaction.importHistoryCapture.create({ data: { ...header, requestId: randomUUID(), selection: [snapshot] } });
      await transaction.importHistoricalEvidence.create({ data: { captureId: copied.id, sourceHash: item.sourceHash, recordId: item.recordId,
        candidateId: item.candidateId, kind: item.kind, effectiveDay: item.effectiveDay, assetId: null, snapshot } });
    }), matchesDatabaseError(pattern));
  }
  await assert.rejects(database.importHistoricalEvidence.delete({ where: { id: item.id } }));
});

test('historical evidence migration adds empty storage without changing existing operational or review rows', async () => {
  const migration = readFileSync(new URL('../../../prisma/migrations/0019_import_historical_evidence/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `history_migration_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await transaction.$executeRawUnsafe('CREATE TABLE "User" ("id" UUID PRIMARY KEY)');
      await transaction.$executeRawUnsafe('CREATE TABLE "Asset" ("id" UUID PRIMARY KEY, "status" TEXT)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportBatch" ("id" UUID PRIMARY KEY, "version" INTEGER, "sourceHash" TEXT, "preview" JSONB)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportSourceRevision" ("batchId" UUID, "revision" INTEGER, "changes" JSONB)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportReviewDecision" ("id" UUID PRIMARY KEY, "batchId" UUID, "targetType" TEXT, "targetId" TEXT, "batchVersion" INTEGER, "sourceRevision" INTEGER, "action" TEXT, "linkedAssetId" UUID)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportApplicationItem" ("id" UUID PRIMARY KEY, "sourceHash" TEXT, "candidateId" TEXT, "assetId" UUID)');
      const assetId = randomUUID(); const batchId = randomUUID();
      await transaction.$executeRaw`INSERT INTO "Asset" VALUES (${assetId}::uuid, 'DECOMMISSIONED')`;
      await transaction.$executeRaw`INSERT INTO "ImportBatch" VALUES (${batchId}::uuid, 3, ${'a'.repeat(64)}, ${'{}'}::jsonb)`;
      const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE (?:CONSTRAINT )?TRIGGER[^;]+;/g);
      assert.equal(statements.length, 13);
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
      assert.deepEqual(await transaction.$queryRaw`SELECT * FROM "Asset"`, [{ id: assetId, status: 'DECOMMISSIONED' }]);
      const [counts] = await transaction.$queryRaw`SELECT (SELECT count(*)::integer FROM "ImportBatch") AS batches, (SELECT count(*)::integer FROM "ImportHistoryCapture") AS captures, (SELECT count(*)::integer FROM "ImportHistoricalEvidence") AS evidence`;
      assert.deepEqual(counts, { batches: 1, captures: 0, evidence: 0 });
      throw new RollbackTest();
    }, { timeout: 15000 });
  } catch (error) { if (!(error instanceof RollbackTest)) throw error; }
});

after(async () => { await app.close(); });
