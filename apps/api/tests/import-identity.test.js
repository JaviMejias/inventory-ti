import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { URL } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { sheetDictionary } from '../src/imports/dictionary.js';
import { identityRevisionSchema } from '../src/imports/identity-schemas.js';
import { prepareIdentityChanges } from '../src/imports/identity.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { appendIdentityRevision } from '../src/imports/source-service.js';
import { hashPassword } from '../src/lib/password.js';
import { numberCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

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
    const username = `identity-${role.toLowerCase()}-${suffix}`;
    const password = 'Identity-password-123';
    users[role] = await database.user.create({ data: { username, displayName: `Identity ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } });
    assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie'];
    cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: `Identity product ${suffix}`, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } });
  productIds.push(product.id);
});

async function post(url, payload, role = 'JEFE', csrf = true) {
  const cookie = cookies[role];
  const token = csrf ? (await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  for (let attempt = 0; ; attempt++) {
    const response = await app.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
    if (!url.endsWith('/apply') || response.statusCode !== 409 || response.json().code !== 'IMPORT_APPLY_BUSY' || attempt >= 6) return response;
    await setTimeout(50);
  }
}
function get(url) { return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } }); }

async function prepare(extra = {}, options = {}) {
  const serial = options.serial ?? `VERIFIED-${randomUUID()}`;
  const rows = options.rows ?? [receptionRow(4, '', { F: numberCell(123456), K: textCell('Disponible'), ...extra })];
  const source = workbook('Recepción', rows);
  source.source.sha256 = randomBytes(32).toString('hex');
  const previewResponse = await post('/inventory/imports/preview', source);
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json();
  const saved = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId });
  assert.equal(saved.statusCode, 201, saved.body);
  const batch = saved.json().batch;
  const candidate = preview.candidates[0];
  const base = `/inventory/imports/batches/${batch.id}`;
  const input = { expectedRevision: 0, expectedBatchVersion: 1, requestId: randomUUID(), candidateId: candidate.id,
    action: 'VERIFY', confirmation: 'VERIFIED_PHYSICAL_IDENTITY', serialNumber: serial, assetTag: candidate.tags[0] ?? null,
    note: 'All observations checked against the physical asset', evidenceReference: 'Physical label photograph L-001' };
  return { source, preview, batch, candidate, base, input };
}
function decision(candidateId, version = 1, revision = 1, assetId) {
  return { expectedVersion: version, expectedSourceRevision: revision, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: candidateId,
    action: assetId ? 'LINK_EXISTING' : 'PROPOSE_NEW', ...(assetId ? { linkedAssetId: assetId } : {}), note: 'Identity interpretation explicitly approved' };
}
function plan(candidateId, serial, version = 2, revision = 1) {
  return { expectedVersion: version, expectedSourceRevision: revision, operations: [{ type: 'CREATE_ASSET', candidateId, note: 'Available physical asset checked',
    confirmation: 'AVAILABLE_UNASSIGNED', values: { productId: product.id, serialNumber: serial } }] };
}

test('identity review requires JEFE, CSRF, explicit text and a physical target', async () => {
  const { base, input } = await prepare();
  const url = base + '/identity-revisions';
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(url, input, role)).statusCode, 403);
  assert.equal((await post(url, input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { serialNumber: 123456 }, { confirmation: 'FORCE' }, { candidateId: 'f'.repeat(64) }]) assert.equal((await post(url, { ...input, ...change })).statusCode, 400);
  assert.equal((await post(`/inventory/imports/batches/${randomUUID()}/identity-revisions`, input)).statusCode, 404);
});

test('identity review refuses a missing V8 migration before persisting any source correction', async () => {
  const { batch, input } = await prepare();
  const missing = database.$extends({ query: { importReviewDecision: { async findFirst() {
    throw new Prisma.PrismaClientKnownRequestError('Missing source revision column', { code: 'P2022', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportReviewDecision' } });
  } } } });
  const isolatedApp = buildApp(missing);
  try {
    const cookie = cookies.JEFE;
    const token = (await isolatedApp.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken;
    const response = await isolatedApp.inject({ method: 'POST', url: `/inventory/imports/batches/${batch.id}/identity-revisions`, headers: { cookie, 'x-csrf-token': token }, payload: input });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().code, 'IMPORT_REVIEW_NOT_READY');
    assert.equal(await database.importSourceRevision.count({ where: { batchId: batch.id } }), 0);
  } finally { await isolatedApp.close(); }
});

test('numeric identity resolves without changing original source, then supports a reviewed atomic pilot', async () => {
  const { source, preview, batch, candidate, base, input } = await prepare();
  const original = await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
  assert.equal((await post(base + '/decisions', decision(candidate.id, 1, 0))).json().code, 'NEW_ASSET_PROPOSAL_CONFLICT');
  const corrected = await post(base + '/identity-revisions', input);
  assert.equal(corrected.statusCode, 201, corrected.body);
  assert.equal(corrected.json().canApply, false);
  const resolved = (await get(base + '/resolved-preview')).json();
  assert.equal(resolved.preview.candidates[0].id, candidate.id);
  assert.deepEqual(resolved.preview.candidates[0].serials, [input.serialNumber.toUpperCase()]);
  assert.equal(resolved.preview.issues.some((issue) => issue.code === 'NUMERIC_SERIAL_REQUIRES_REVIEW'), false);
  assert.deepEqual((await get(base + '/preview')).json().snapshot, preview);
  assert.deepEqual(await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } }), original);
  assert.deepEqual(original.workbook, source);
  assert.equal((await post(base + '/decisions', decision(candidate.id, 1, 0))).json().code, 'SOURCE_REVISION_CONFLICT');
  const reviewed = await post(base + '/decisions', decision(candidate.id));
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  assert.equal(reviewed.json().decision.sourceRevision, 1);
  const planInput = plan(candidate.id, input.serialNumber);
  const planned = (await post(base + '/plan', planInput)).json();
  assert.equal(planned.planValidationComplete, true);
  const payload = { requestId: randomUUID(), planId: planned.planId, confirmation: 'APPLY_ASSET_PILOT', plan: planInput };
  const applied = await post(base + '/apply', payload);
  assert.equal(applied.statusCode, 201, applied.body);
  const item = applied.json().application.items[0];
  assert.equal(item.candidateId, candidate.id);
  assert.equal(item.result.serialNumber, input.serialNumber);
  assert.equal(item.operation.sourceCorrections[0].originalCell.type, 'number');
  assert.equal(item.operation.identityRevision, 1);
  assert.equal(item.operation.decisionSourceRevision, 1);
  assert.equal((await post(base + '/identity-revisions', input)).statusCode, 200);
  assert.equal((await post(base + '/identity-revisions', { ...input, expectedRevision: 1, expectedBatchVersion: 2, requestId: randomUUID(), serialNumber: 'Other identity' })).json().code, 'SOURCE_TARGET_ALREADY_APPLIED');
});

test('a verified existing match uses explicit review and metadata only, never changes operational identity or status', async () => {
  const asset = await database.$transaction(async (transaction) => {
    const asset = await transaction.asset.create({ data: { productId: product.id, serialNumber: `EXISTING-${randomUUID()}`, status: 'ASSIGNED', location: 'Old location' } });
    await transaction.assignment.create({ data: { assetId: asset.id, personName: 'Fixture recipient', createdById: users.JEFE.id, startedAt: new Date() } });
    return asset;
  });
  const { candidate, base, input } = await prepare({}, { serial: asset.serialNumber });
  assert.equal((await post(base + '/identity-revisions', input)).statusCode, 201);
  assert.equal((await post(base + '/decisions', decision(candidate.id))).json().code, 'NEW_ASSET_PROPOSAL_CONFLICT');
  assert.equal((await post(base + '/decisions', decision(candidate.id, 1, 1, asset.id))).statusCode, 201);
  const planInput = { expectedVersion: 2, expectedSourceRevision: 1, operations: [{ type: 'UPDATE_METADATA', candidateId: candidate.id, assetId: asset.id,
    note: 'Verified location', values: { location: 'Verified location' } }] };
  const planned = (await post(base + '/plan', planInput)).json();
  assert.equal(planned.planValidationComplete, true);
  const result = await post(base + '/apply', { requestId: randomUUID(), planId: planned.planId, confirmation: 'APPLY_ASSET_PILOT', plan: planInput });
  assert.equal(result.statusCode, 201, result.body);
  const after = await database.asset.findUniqueOrThrow({ where: { id: asset.id } });
  assert.equal(after.serialNumber, asset.serialNumber); assert.equal(after.assetTag, null); assert.equal(after.status, 'ASSIGNED');
  assert.equal(after.location, 'Verified location');
});

test('identity changes require renewed approval and restoration invalidates plans while preserving exact originals', async () => {
  const tag = `TAG-${randomUUID()}`;
  const { candidate, base, input, source } = await prepare({ G: textCell(tag) });
  assert.equal((await post(base + '/decisions', decision(candidate.id, 1, 0))).statusCode, 201);
  assert.equal((await post(base + '/identity-revisions', { ...input, expectedBatchVersion: 2 })).statusCode, 201);
  const planInput = plan(candidate.id, input.serialNumber);
  planInput.operations[0].values.assetTag = tag;
  const pending = (await post(base + '/plan', planInput)).json();
  assert.ok(pending.operations[0].blockers.some((blocker) => blocker.code === 'IDENTITY_REVIEW_DECISION_REQUIRED'));
  assert.equal((await post(base + '/decisions', decision(candidate.id, 2, 1))).statusCode, 201);
  planInput.expectedVersion = 3;
  const approved = (await post(base + '/plan', planInput)).json();
  assert.equal(approved.planValidationComplete, true);
  const restore = { expectedRevision: 1, expectedBatchVersion: 3, requestId: randomUUID(), candidateId: candidate.id, action: 'RESTORE', confirmation: 'RESTORE_ORIGINAL_IDENTITY',
    note: 'Reopen the original uncertainty', evidenceReference: 'Review L-002' };
  assert.equal((await post(base + '/identity-revisions', restore)).statusCode, 201);
  const reverted = (await get(base + '/resolved-preview')).json();
  assert.deepEqual(reverted.preview.records[0].originalCells, source.sheets[0].rows[1].cells);
  assert.deepEqual(reverted.sourceContext.identityRevisions, [{ candidateId: candidate.id, revision: 2 }]);
  const failed = await post(base + '/apply', { requestId: randomUUID(), planId: approved.planId, confirmation: 'APPLY_ASSET_PILOT', plan: planInput });
  assert.equal(failed.json().code, 'SOURCE_REVISION_CONFLICT');
  const current = (await post(base + '/plan', { ...planInput, expectedSourceRevision: 2 })).json();
  assert.ok(current.operations[0].blockers.some((blocker) => blocker.code === 'NUMERIC_SERIAL_REQUIRES_REVIEW'));
  assert.ok(current.operations[0].blockers.some((blocker) => blocker.code === 'IDENTITY_REVIEW_DECISION_REQUIRED'));
});

test('all observations in a candidate receive the verified pair but other incidents remain blocking', async () => {
  const serial = `SHARED-${randomUUID()}`;
  const { base, input, candidate } = await prepare({}, { rows: [receptionRow(4, serial, { G: textCell('TAG-A'), K: textCell('Disponible'), Z: { type: 'formula', value: '=1+1' } }),
    receptionRow(5, serial, { G: textCell('TAG-B'), K: textCell('Disponible') })] });
  const corrected = await post(base + '/identity-revisions', { ...input, serialNumber: serial, assetTag: `VERIFIED-TAG-${randomUUID()}` });
  assert.equal(corrected.statusCode, 201, corrected.body);
  const resolved = (await get(base + '/resolved-preview')).json();
  assert.equal(resolved.preview.candidates[0].recordIds.length, 2);
  assert.equal(resolved.preview.candidates[0].id, candidate.id);
  assert.equal(resolved.preview.issues.some((issue) => issue.code === 'SERIAL_HAS_MULTIPLE_TAGS'), false);
  assert.equal(resolved.preview.issues.some((issue) => issue.code === 'FORMULA_REQUIRES_REVIEW'), true);
  assert.equal(resolved.preview.issues.some((issue) => issue.code === 'UNMAPPED_COLUMN'), true);
});

test('identity revision rejects collisions, blanking and attempts to merge independent candidates atomically', async () => {
  const a = `SERIAL-A-${randomUUID()}`;
  const b = `SERIAL-B-${randomUUID()}`;
  const { base, input, batch } = await prepare({}, { rows: [receptionRow(4, a, { G: textCell('TAG-A') }), receptionRow(5, b, { G: textCell('TAG-B') })] });
  assert.equal((await post(base + '/identity-revisions', { ...input, serialNumber: a, assetTag: 'TAG-B' })).json().code, 'IDENTITY_CROSS_CANDIDATE_CONFLICT');
  assert.equal((await post(base + '/identity-revisions', { ...input, serialNumber: b, assetTag: 'TAG-B' })).json().code, 'IDENTITY_GROUP_CHANGE_REQUIRES_REVIEW');
  assert.equal((await post(base + '/identity-revisions', { ...input, assetTag: null })).json().code, 'IDENTITY_CANNOT_DROP_SOURCE_VALUE');
  assert.equal(await database.importSourceRevision.count({ where: { batchId: batch.id } }), 0);
});

test('identity and descriptive corrections share optimistic revisions, idempotency and actor-bound history', async () => {
  const { base, input, batch, preview } = await prepare();
  const descriptive = { expectedRevision: 0, expectedBatchVersion: 1, requestId: randomUUID(), note: 'Descriptive review', evidenceReference: 'Catalog proof',
    changes: [{ recordId: preview.records[0].id, field: 'model', action: 'REPLACE', value: 'Corrected model' }] };
  const responses = await Promise.all([post(base + '/identity-revisions', input), post(base + '/source-revisions', descriptive)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'SOURCE_REVISION_CONFLICT');
  const identityWon = responses[0].statusCode === 201;
  const approvedInput = identityWon ? input : { ...input, expectedRevision: 1 };
  if (!identityWon) assert.equal((await post(base + '/identity-revisions', approvedInput)).statusCode, 201);
  assert.equal((await post(base + '/identity-revisions', approvedInput)).statusCode, 200);
  assert.equal((await post(base + '/identity-revisions', { ...approvedInput, note: 'Different intention' })).json().code, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(appendIdentityRevision(database, batch.id, identityRevisionSchema.parse(approvedInput), users.COORDINADOR.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  const history = (await get(base + '/source-revisions?limit=1')).json();
  assert.equal(history.revision, identityWon ? 1 : 2);
});

test('identity audit failures roll back corrections and preserve safe retries', async () => {
  const { batch, input } = await prepare();
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.action === 'IMPORT_SOURCE_CORRECTED') throw new Error('Injected identity audit failure');
    return query(args);
  } } } });
  await assert.rejects(appendIdentityRevision(failing, batch.id, identityRevisionSchema.parse(input), users.JEFE.id), /Injected identity audit failure/);
  assert.equal(await database.importSourceRevision.count({ where: { batchId: batch.id } }), 0);
  assert.equal((await appendIdentityRevision(database, batch.id, identityRevisionSchema.parse(input), users.JEFE.id)).reused, false);
});

test('corrected candidate references remain deduplicated across batches and block post-application reinterpretation', async () => {
  const first = await prepare();
  const copy = JSON.parse(JSON.stringify(first.source));
  copy.source.fileName = 'Same-source-copy.xlsx';
  const preview = (await post('/inventory/imports/preview', copy)).json();
  const staged = await post('/inventory/imports/batches', { workbook: copy, previewId: preview.previewId });
  assert.equal(staged.statusCode, 201, staged.body);
  const secondBase = `/inventory/imports/batches/${staged.json().batch.id}`;
  assert.equal(preview.candidates[0].id, first.candidate.id);
  const prepared = [];
  for (const base of [first.base, secondBase]) {
    assert.equal((await post(base + '/identity-revisions', { ...first.input, requestId: randomUUID() })).statusCode, 201);
    assert.equal((await post(base + '/decisions', decision(first.candidate.id))).statusCode, 201);
    const planInput = plan(first.candidate.id, first.input.serialNumber);
    const planned = (await post(base + '/plan', planInput)).json();
    assert.equal(planned.planValidationComplete, true);
    prepared.push({ base, input: { requestId: randomUUID(), planId: planned.planId, confirmation: 'APPLY_ASSET_PILOT', plan: planInput } });
  }
  const responses = await Promise.all(prepared.map(({ base, input }) => post(base + '/apply', input)));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.statusCode === 409).json().code, 'IMPORT_TARGET_ALREADY_APPLIED');
  assert.equal(await database.importApplicationItem.count({ where: { sourceHash: first.source.source.sha256 } }), 1);
  const losingBase = prepared[responses[0].statusCode === 409 ? 0 : 1].base;
  const restore = { expectedRevision: 1, expectedBatchVersion: 2, requestId: randomUUID(), candidateId: first.candidate.id,
    action: 'RESTORE', confirmation: 'RESTORE_ORIGINAL_IDENTITY', note: 'Cannot rewrite already applied source', evidenceReference: 'Review L-003' };
  assert.equal((await post(losingBase + '/identity-revisions', restore)).json().code, 'SOURCE_TARGET_ALREADY_APPLIED');
});

test('SQL identity mapping matches the dictionary and guards reject forged columns or obsolete source decisions', async () => {
  for (const [sheet, mapping] of Object.entries(sheetDictionary)) for (const field of ['serialNumber', 'assetTag']) {
    const column = Object.entries(mapping.columns).find(([, entry]) => entry.field === field)?.[0] ?? null;
    const [result] = await database.$queryRaw`SELECT import_identity_column(${sheet}, ${field}) AS column`;
    assert.equal(result.column, column);
  }
  const { batch, source, input, base, candidate } = await prepare();
  const parsed = identityRevisionSchema.parse(input);
  const changes = prepareIdentityChanges(source, source, { revision: 0, corrections: [] }, parsed);
  const data = { batchId: batch.id, revision: 1, expectedBatchVersion: 1, requestId: input.requestId, requestDigest: importPlanDigest(parsed),
    note: input.note, evidenceReference: input.evidenceReference, reviewedById: users.JEFE.id, changes };
  await assert.rejects(database.importSourceRevision.create({ data: { ...data, changes: [{ ...changes[0], column: 'A', originalCell: null, beforeCell: null }] } }));
  assert.equal((await post(base + '/identity-revisions', input)).statusCode, 201);
  await assert.rejects(database.$transaction(async (transaction) => {
    await transaction.importBatch.update({ where: { id: batch.id }, data: { version: { increment: 1 } } });
    await transaction.importReviewDecision.create({ data: { batchId: batch.id, batchVersion: 2, sourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: candidate.id,
      action: 'PROPOSE_NEW', note: 'Obsolete source review', reviewedById: users.JEFE.id } });
  }));
  assert.equal((await database.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).version, 1);
});

test('identity migration preserves populated decisions and assets with a compatible zero revision', async () => {
  const migration = readFileSync(new URL('../../../prisma/migrations/0018_import_identity_review/migration.sql', import.meta.url), 'utf8');
  class RollbackTest extends Error {}
  try {
    await database.$transaction(async (transaction) => {
      const schema = `identity_migration_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportBatch" ("id" UUID PRIMARY KEY, "version" INTEGER, "sourceHash" TEXT, "preview" JSONB)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportReviewDecision" ("id" UUID PRIMARY KEY, "legacy" TEXT NOT NULL)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportSourceRevision" ("batchId" UUID, "revision" INTEGER, "changes" JSONB)');
      await transaction.$executeRawUnsafe('CREATE TABLE "ImportApplicationItem" ("sourceHash" TEXT, "candidateId" TEXT)');
      await transaction.$executeRawUnsafe('CREATE TABLE "Asset" ("id" UUID PRIMARY KEY, "serialNumber" TEXT, "assetTag" TEXT, "status" TEXT)');
      const assetId = randomUUID(); const decisionId = randomUUID();
      await transaction.$executeRaw`INSERT INTO "Asset" VALUES (${assetId}::uuid, 'Original serial', 'Original tag', 'DECOMMISSIONED')`;
      await transaction.$executeRaw`INSERT INTO "ImportReviewDecision" VALUES (${decisionId}::uuid, 'Preserved review')`;
      const statements = migration.match(/ALTER TABLE[^;]+;|CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$ LANGUAGE (?:plpgsql|SQL IMMUTABLE STRICT);/g);
      assert.equal(statements.length, 5);
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
      assert.deepEqual(await transaction.$queryRaw`SELECT * FROM "Asset"`, [{ id: assetId, serialNumber: 'Original serial', assetTag: 'Original tag', status: 'DECOMMISSIONED' }]);
      assert.deepEqual(await transaction.$queryRaw`SELECT * FROM "ImportReviewDecision"`, [{ id: decisionId, legacy: 'Preserved review', sourceRevision: 0 }]);
      throw new RollbackTest();
    }, { timeout: 15000 });
  } catch (error) { if (!(error instanceof RollbackTest)) throw error; }
});

after(async () => { await app.close(); });
