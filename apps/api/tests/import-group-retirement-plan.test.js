import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { planGroupRetirement } from '../src/imports/group-retirement-plan-service.js';
import { groupRetirementPlanSchema } from '../src/imports/group-retirement-plan-schemas.js';
import { hashPassword } from '../src/lib/password.js';
import { groupClosedAssignmentFixture } from './fixtures/group-closed-assignment.js';
import { groupRetirementFixture } from './fixtures/group-retirement-import.js';

const suffix = randomUUID().slice(0, 8); const productIds = [];
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database); const cookies = {}; const users = {}; let product;
before(async () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    const username = 'groupretire-' + role.toLowerCase() + '-' + suffix; const password = 'Group-retirement-password-123';
    users[role] = await database.user.create({ data: { username, displayName: 'Group retirement ' + role, passwordHash: hashPassword(password), role } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(login.statusCode, 200, login.body);
    const header = login.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Group retirement ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, payload, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) } });
}
function get(url) { return app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } }); }
function prepare(options = {}) { return groupRetirementFixture({ database, product, post, get, ...options }); }
async function decide(f) { return f.refreshDecision(); }
async function acknowledged(f, input = f.input) {
  const first = await post(f.url, input); assert.equal(first.statusCode, 200, first.body);
  const next = { ...input, acknowledgedGroupWarnings: first.json().groupWarnings.map((entry) => entry.id),
    plan: { ...input.plan, acknowledgedWarnings: first.json().warnings.map((entry) => entry.id) } };
  const response = await post(f.url, next); assert.equal(response.statusCode, 200, response.body); return { input: next, plan: response.json() };
}
async function snapshot(f) {
  return { asset: await database.asset.findUnique({ where: { id: f.asset.id } }), assignments: await database.assignment.findMany({ where: { assetId: f.asset.id }, orderBy: { id: 'asc' } }),
    evidence: await database.importHistoricalEvidence.findMany({ where: { sourceHash: f.source.source.sha256 }, orderBy: { id: 'asc' }, include: { amendments: true } }),
    groupUses: await database.importIdentityGroupRowUse.findMany({ where: { sourceHash: f.source.source.sha256 } }),
    retirements: await database.importRetirementApplication.count({ where: { assetId: f.asset.id } }),
    historyLinks: await database.importGroupHistoryLink.count({ where: { evidence: { sourceHash: f.source.source.sha256 } } }),
    audit: await database.auditLog.count({ where: { entityId: { in: [f.batch.id, f.review.id, f.asset.id, f.decision.id] } } }) };
}
const codes = (plan) => plan.blockers.map((entry) => entry.code);
function read(instance, f, input = f.input) { return planGroupRetirement(instance, f.batch.id, f.review.id, groupRetirementPlanSchema.parse(input)); }

test('group retirement route plans directly from reviewed identity and archived disposal without any pilot application or writes', async () => {
  const f = await prepare(); const beforeState = await snapshot(f); const { plan, input } = await acknowledged(f);
  assert.equal(plan.planValidationComplete, true, JSON.stringify(plan.blockers)); assert.equal(plan.originalEvidence.assetId, null);
  assert.equal(plan.proposedEvidenceProjection.assetId, f.asset.id); assert.equal(plan.proposedEvidenceProjection.linkBasis.type, 'REVIEWED_IDENTITY_GROUP_PROPOSAL');
  assert.equal(plan.proposedRetirement.decommissionedAt, '2005-01-01T12:00:00.000Z'); assert.equal(plan.sourceRetirement.effectiveAt, null);
  assert.equal(plan.source.fields.serialNumber, f.asset.serialNumber); assert.equal(plan.source.fields.receivedDate, '2000-01-01');
  assert.equal(plan.omittedEvidence.length, f.capture.items.length - 1);
  for (const flag of ['persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'operationalHistoryApplied', 'retirementApplicationImplemented']) assert.equal(plan[flag], false);
  assert.equal((await post(f.url, input)).json().planId, plan.planId); assert.deepEqual(await snapshot(f), beforeState);
  assert.equal((await post(f.url + '/apply', input)).statusCode, 400);
});

test('group retirement requires JEFE, CSRF, strict intent and exact batch-review ownership', async () => {
  const f = await prepare(); assert.equal((await app.inject({ method: 'POST', url: f.url, payload: f.input })).statusCode, 401);
  for (const role of ['COORDINADOR', 'SOPORTE']) assert.equal((await post(f.url, f.input, role)).statusCode, 403);
  assert.equal((await post(f.url, f.input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ force: true }, { assetId: f.asset.id }, { expectedDecisionVersion: -1 }, { plan: { ...f.input.plan, confirmedAt: '2005-01-01' } }]) assert.equal((await post(f.url, { ...f.input, ...change })).statusCode, 400);
  assert.equal((await post(f.url + '?force=true', f.input)).statusCode, 400);
  for (const parent of [f.batch.id, f.review.id]) assert.equal((await post(f.url.replace(parent, randomUUID()), f.input)).statusCode, 404);
});

test('group retirement preserves undated sources and requires proof, source chronology and exact warning acknowledgements', async () => {
  const f = await prepare(); const { input } = await acknowledged(f);
  for (const [change, expected] of [[{ confirmedAt: null }, 'EXACT_RETIREMENT_DATE_REQUIRED'], [{ dateEvidenceReference: null }, 'EXACT_RETIREMENT_DATE_PROOF_REQUIRED'],
    [{ confirmedAt: '2099-01-01T00:00:00Z' }, 'HISTORICAL_DATE_IN_FUTURE'], [{ confirmedAt: '1999-01-01T00:00:00Z' }, 'RETIREMENT_BEFORE_RECEIPT_DAY'],
    [{ acknowledgedWarnings: ['f'.repeat(64)] }, 'UNKNOWN_WARNING_ACKNOWLEDGEMENT']]) {
    const response = await post(f.url, { ...input, plan: { ...input.plan, ...change } }); assert.equal(response.statusCode, 200, response.body);
    assert.ok(codes(response.json()).includes(expected)); assert.equal(response.json().planValidationComplete, false);
  }
});

test('group retirement blocks active custody and terminal replacement without changing either current state', async () => {
  for (const [options, code] of [[{ active: true }, 'ACTIVE_ASSIGNMENT_REQUIRES_RETURN'], [{ terminal: true }, 'EXISTING_RETIREMENT_REQUIRES_RECONCILIATION']]) {
    const f = await prepare(options); const beforeState = await snapshot(f); const { plan } = await acknowledged(f);
    assert.ok(codes(plan).includes(code)); assert.equal(plan.planValidationComplete, false); assert.deepEqual(await snapshot(f), beforeState);
  }
});

test('group retirement binds decision and evidence versions and refuses foreign or non-retirement observations', async () => {
  const foreign = await prepare(); const f = await prepare();
  for (const [change, code] of [[{ expectedBatchVersion: 2 }, 'REVIEW_VERSION_CONFLICT'], [{ expectedSourceRevision: 1 }, 'SOURCE_REVISION_CONFLICT'],
    [{ projectionId: 'a'.repeat(64) }, 'IDENTITY_GROUP_PROJECTION_CHANGED'], [{ expectedDecisionVersion: 2 }, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT'],
    [{ decisionId: randomUUID() }, 'GROUP_DECISION_NOT_LATEST'], [{ expectedEvidenceVersion: 1 }, 'EVIDENCE_VERSION_CONFLICT']]) {
    const response = await post(f.url, { ...f.input, ...change }); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, code);
  }
  const other = await post(f.url, { ...f.input, plan: { ...f.input.plan, evidenceId: foreign.retirement.id } }); assert.equal(other.statusCode, 404);
  const receipt = f.capture.items.find((entry) => entry.kind === 'RECEIPT_OBSERVATION');
  const wrong = await post(f.url, { ...f.input, plan: { ...f.input.plan, evidenceId: receipt.id } }); assert.equal(wrong.statusCode, 200);
  assert.ok(codes(wrong.json()).includes('RETIREMENT_EVIDENCE_KIND_REQUIRED'));
});

test('group retirement retains pilot and legacy source guards and refuses a released identity review', async () => {
  const f = await prepare(); const beforeState = await snapshot(f); const { input } = await acknowledged(f);
  const legacy = await post('/assets/' + f.asset.id + '/imported-retirement-plan', input.plan);
  assert.equal(legacy.statusCode, 409); assert.equal(legacy.json().code, 'IDENTITY_GROUP_SOURCE_RESERVED');
  const pilot = await post(f.reviewUrl + '/pilot-plan', { expectedBatchVersion: 1, expectedSourceRevision: 0, expectedDecisionVersion: 1, projectionId: f.projection.projectionId,
    operations: [{ type: 'UPDATE_METADATA', groupKey: f.input.groupKey, decisionId: f.decision.id, assetId: f.asset.id, note: 'Not a retirement application', values: { location: 'Warehouse' } }] });
  assert.equal(pilot.statusCode, 200, pilot.body); assert.ok(pilot.json().operations[0].blockers.some((entry) => entry.code === 'RETIREMENT_REQUIRES_SEPARATE_WORKFLOW'));
  assert.deepEqual(await snapshot(f), beforeState);
  const released = await post(f.reviewUrl + '/release', { requestId: randomUUID(), confirmation: 'RELEASE_IDENTITY_GROUP_REVIEW_ONLY', note: 'Abandon unconfirmed retirement review' });
  assert.equal(released.statusCode, 201, released.body);
  const result = await post(f.url, input); assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'IDENTITY_GROUP_ALREADY_RELEASED');
});

test('group retirement rejects missing storage, corrupted snapshots and excessive histories explicitly', async () => {
  const f = await prepare();
  const missing = database.$extends({ query: { importHistoricalEvidence: { async findMany() {
    throw new Prisma.PrismaClientKnownRequestError('Missing history storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportHistoricalEvidence' } });
  } } } }); const isolated = buildApp(missing);
  try { const response = await post(f.url, f.input, 'JEFE', true, isolated); assert.equal(response.statusCode, 503, response.body); } finally { await isolated.close(); }
  const corrupt = database.$extends({ query: { importHistoricalEvidence: { async findMany({ args, query }) {
    const rows = await query(args); return args.include ? rows.map((row) => ({ ...row, snapshot: {} })) : rows;
  } } } });
  await assert.rejects(read(corrupt, f), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
  const excessive = database.$extends({ query: { assignment: { async findMany({ args }) { assert.equal(args.take, 10001); return Array.from({ length: 10001 }, () => ({})); } } } });
  await assert.rejects(read(excessive, f), (error) => error.code === 'GROUP_RETIREMENT_PLAN_LIMIT');
});

test('group retirement reads one repeatable snapshot while later custody requires a fresh projection and decision', async () => {
  const f = await prepare(); const { input } = await acknowledged(f); let changed = false;
  const racing = database.$extends({ query: { importHistoricalEvidence: { async findMany({ args, query }) {
    const rows = await query(args);
    if (args.include && !changed) { changed = true; const response = await post('/assets/' + f.asset.id + '/assignments', { personName: 'Concurrent custodian', effectiveAt: '2001-01-01T00:00:00Z' }); assert.equal(response.statusCode, 201, response.body); }
    return rows;
  } } } });
  const plan = await read(racing, f, input); assert.equal(changed, true); assert.equal(plan.planValidationComplete, true); assert.equal(plan.assetBefore.status, 'AVAILABLE');
  const stale = await post(f.url, input); assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'IDENTITY_GROUP_PROJECTION_CHANGED');
  await decide(f); const current = await acknowledged(f); assert.ok(codes(current.plan).includes('ACTIVE_ASSIGNMENT_REQUIRES_RETURN'));
});

test('group retirement chronological bounds use corrected V27 history rather than immutable original timestamps', async () => {
  const closed = await groupClosedAssignmentFixture({ database, product, post, get, knownDay: false });
  const first = await post(closed.url, closed.input); assert.equal(first.statusCode, 200, first.body);
  const groupInput = { ...closed.input, plan: { periods: closed.input.plan.periods.map((period) => ({ ...period,
    acknowledgedWarnings: first.json().periods.find((value) => value.periodId === period.periodId).warnings.map((warning) => warning.id) })) } };
  const reviewed = await post(closed.url, groupInput); assert.equal(reviewed.statusCode, 200, reviewed.body); assert.equal(reviewed.json().planValidationComplete, true);
  const applied = await post(closed.url + '/apply', { requestId: randomUUID(), planId: reviewed.json().planId, confirmation: 'APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY', plan: groupInput });
  assert.equal(applied.statusCode, 201, applied.body); const origin = applied.json().application; const target = origin.items[0]; const period = groupInput.plan.periods[0];
  const correctionUrl = closed.itemUrl + '/closed-assignment-applications/' + origin.id + '/items/' + target.id + '/correction-plan';
  const correction = { expectedOriginPlanId: origin.planId, expectedCorrectionVersion: 0, reason: 'Correct verified historical return timestamp', supportingReference: 'Signed rectification',
    correction: { start: { confirmedAt: period.start.confirmedAt, dateEvidenceReference: period.start.dateEvidenceReference },
      end: { confirmedAt: '2006-01-01T00:00:00Z', dateEvidenceReference: 'Verified corrected return timestamp' }, recipient: period.recipient,
      assignmentType: period.assignmentType, returnStatus: period.returnStatus, note: period.note, evidenceReference: period.evidenceReference, acknowledgedWarnings: period.acknowledgedWarnings } };
  const correctedPlan = await post(correctionUrl, correction); assert.equal(correctedPlan.statusCode, 200, correctedPlan.body); assert.equal(correctedPlan.json().planValidationComplete, true, correctedPlan.body);
  const corrected = await post(correctionUrl + '/apply', { requestId: randomUUID(), correctionPlanId: correctedPlan.json().correctionPlanId, confirmation: 'APPLY_GROUP_ASSIGNMENT_CORRECTION', plan: correction });
  assert.equal(corrected.statusCode, 201, corrected.body);
  const f = await prepare({ existingAsset: closed.asset }); const { plan } = await acknowledged(f);
  assert.ok(codes(plan).includes('ASSIGNMENT_AFTER_RETIREMENT')); assert.equal(plan.planValidationComplete, false);
  const original = await database.assignment.findUniqueOrThrow({ where: { id: target.assignmentId } }); assert.equal(original.endedAt.getUTCFullYear(), 2002);
  const valid = await acknowledged(f, { ...f.input, plan: { ...f.input.plan, confirmedAt: '2007-01-01T00:00:00Z' } });
  assert.equal(valid.plan.planValidationComplete, true, JSON.stringify(valid.plan.blockers));
  const terminal = await post(f.url + '/apply', { requestId: randomUUID(), planId: valid.plan.planId,
    confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT', plan: valid.input });
  assert.equal(terminal.statusCode, 201, terminal.body); assert.equal(terminal.json().application.decommissionedAt, '2007-01-01T00:00:00.000Z');
  assert.equal((await database.assignment.findUniqueOrThrow({ where: { id: target.assignmentId } })).endedAt.getUTCFullYear(), 2002);
});

after(async () => { await app.close(); await database.$disconnect(); });
