import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { deserialize, serialize } from 'node:v8';

import { Prisma, PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import { planAssignmentCorrection } from '../src/imports/assignment-correction-service.js';
import { applyAssignmentCorrection } from '../src/imports/assignment-correction-apply-service.js';
import { assignmentCorrectionRequestDigest } from '../src/imports/assignment-correction-apply-schemas.js';
import { correctionEnvelope } from '../src/imports/assignment-correction-chain.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { hashPassword } from '../src/lib/password.js';
import { closedAssignmentFixture } from './fixtures/closed-assignment-import.js';

const suffix = randomUUID().slice(0, 8); const users = {}; const cookies = {}; const productIds = []; let product;
const clone = (value) => deserialize(serialize(value));
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const database = new PrismaClient().$extends({ query: { asset: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { productId: { in: productIds } }] } });
} } } });
const app = buildApp(database);
before(async () => {
  for (const role of ['JEFE','COORDINADOR','SOPORTE']) {
    const username = `legacycorrection-${role.toLowerCase()}-${suffix}`; const password = 'Legacy-correction-review-123';
    users[role] = await database.user.create({ data: { username, displayName: `Legacy correction ${role}`, passwordHash: hashPassword(password), role } });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: username, password } }); assert.equal(response.statusCode, 200);
    const header = response.headers['set-cookie']; cookies[role] = (Array.isArray(header) ? header[0] : header).split(';')[0];
  }
  product = await database.product.create({ data: { name: 'Legacy corrections ' + suffix, trackingMode: 'ASSET', equipmentType: 'Notebook', brand: 'HP', model: 'Model G9' } }); productIds.push(product.id);
});
after(async () => { await app.close(); await database.$disconnect(); });
async function post(url, payload, role = 'JEFE', csrf = true, instance = app) {
  const cookie = cookies[role]; const token = csrf ? (await instance.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })).json().csrfToken : null;
  return instance.inject({ method: 'POST', url, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}) }, payload });
}
const get = (url) => app.inject({ method: 'GET', url, headers: { cookie: cookies.JEFE } });
async function prepare({ amendedBeforeApply = false, ...options } = {}) {
  const f = await closedAssignmentFixture({ database, product, actorId: users.JEFE.id, post, get, unlinked: amendedBeforeApply, ...options });
  if (amendedBeforeApply) for (const evidence of f.capture.items) {
    const base = '/inventory/imports/evidence/' + evidence.id; const response = await post(base + '/amendment-plan', { assetId: f.asset.id }); assert.equal(response.statusCode, 200, response.body); const p = response.json();
    const amended = await post(base + '/amendments', { requestId: randomUUID(), amendmentPlanId: p.amendmentPlanId, expectedEvidenceVersion: p.evidenceVersion,
      expectedBatchVersion: p.batchVersion, expectedSourceRevision: p.sourceRevision, confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: f.asset.id,
      note: 'Review original endpoint identity before applying history', evidenceReference: 'Independent physical label verification' }); assert.equal(amended.statusCode, 201, amended.body);
  }
  const first = await post(f.planUrl, f.input.plan); assert.equal(first.statusCode, 200, first.body);
  const planInput = { periods: f.input.plan.periods.map((period) => ({ ...period, acknowledgedWarnings: first.json().periods.find((entry) => entry.periodId === period.periodId).warnings.map((entry) => entry.id) })) };
  const planned = await post(f.planUrl, planInput); assert.equal(planned.statusCode, 200, planned.body); assert.equal(planned.json().planValidationComplete, true, planned.body);
  const applied = await post(f.url, { requestId: randomUUID(), planId: planned.json().planId, confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: planInput });
  assert.equal(applied.statusCode, 201, applied.body); const receipt = applied.json().application; const period = planInput.periods[0]; const item = receipt.items.find((entry) => entry.periodId === period.periodId);
  return { ...f, receipt, assignmentItem: item, originalPlanInput: planInput, correctionUrl: f.receiptUrl + '/' + receipt.id + '/items/' + item.id + '/correction-plan',
    correctionInput: { expectedOriginPlanId: receipt.planId, expectedCorrectionVersion: 0, reason: 'Correct transcription against original documents', supportingReference: 'Signed historical rectification review',
      correction: { ...omit(period, ['periodId','confirmation','start','end']), start: omit(period.start, ['evidenceId']), end: omit(period.end, ['evidenceId']), note: 'Corrected closed-history note' } } };
}
const code = (response, status, expected) => { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().code, expected, response.body); };
const blockers = (response) => { assert.equal(response.statusCode, 200, response.body); return response.json().blockers.map((entry) => entry.code); };
async function snapshot(f) {
  return { asset: await database.asset.findUniqueOrThrow({ where: { id: f.asset.id } }), assignments: await database.assignment.findMany({ where: { assetId: f.asset.id }, orderBy: { id: 'asc' } }),
    receipt: await database.importAssignmentApplication.findUniqueOrThrow({ where: { id: f.receipt.id }, include: { items: { orderBy: { periodId: 'asc' }, include: { evidenceUses: { orderBy: { endpoint: 'asc' } } } } } }),
    archive: await database.importHistoricalEvidence.findMany({ where: { captureId: f.capture.id }, orderBy: { id: 'asc' }, include: { amendments: { orderBy: { version: 'asc' } } } }),
    audits: await database.auditLog.findMany({ where: { userId: users.JEFE.id }, orderBy: { id: 'asc' } }),
    movements: await database.inventoryMovement.findMany({ where: { assetId: f.asset.id } }), stock: await database.inventoryStock.findUnique({ where: { productId: product.id } }) };
}
async function withMutation(f, model, mutate, expected = 'INVALID_ASSIGNMENT_APPLICATION') {
  const extended = database.$extends({ query: { [model]: { async $allOperations({ operation, args, query }) {
    const result = await query(args); if (!operation.startsWith('find') || result === null || (model === 'importHistoricalEvidence' && !args.include?.capture)) return result;
    const value = clone(result); mutate(value); return value;
  } } } }); const isolated = buildApp(extended);
  try { code(await post(f.correctionUrl, f.correctionInput, 'JEFE', true, isolated), 409, expected); } finally { await isolated.close(); }
}

test('legacy correction route requires JEFE and CSRF, strict query and exact existing parent and item', async () => {
  const f = await prepare();
  assert.equal((await app.inject({ method: 'POST', url: f.correctionUrl, payload: f.correctionInput })).statusCode, 401);
  for (const role of ['COORDINADOR','SOPORTE']) assert.equal((await post(f.correctionUrl, f.correctionInput, role)).statusCode, 403);
  assert.equal((await post(f.correctionUrl, f.correctionInput, 'JEFE', false)).statusCode, 403);
  assert.equal((await post(f.correctionUrl + '?force=true', f.correctionInput)).statusCode, 400);
  for (const part of [f.asset.id, f.receipt.id, f.assignmentItem.id]) assert.equal((await post(f.correctionUrl.replace(part, randomUUID()), f.correctionInput)).statusCode, 404);
  for (const change of [{ force: true }, { requestId: randomUUID() }, { expectedCorrectionVersion: 1001 }, { correction: { ...f.correctionInput.correction, assetId: f.asset.id } },
    { correction: { ...f.correctionInput.correction, start: { ...f.correctionInput.correction.start, evidenceId: randomUUID() } } }]) {
    assert.equal((await post(f.correctionUrl, { ...f.correctionInput, ...change })).statusCode, 400);
  }
  assert.equal((await post(f.correctionUrl + '/apply', f.correctionInput)).statusCode, 400);
});
test('legacy correction review returns stable separate original and proposed values while leaving all domain data unchanged', async () => {
  const f = await prepare({ count: 2 }); const before = await snapshot(f); const response = await post(f.correctionUrl, f.correctionInput); assert.equal(response.statusCode, 200, response.body); const p = response.json();
  assert.equal(p.scope, 'LEGACY_CLOSED_ASSIGNMENT_CORRECTION_PLAN'); assert.equal(p.planValidationComplete, true); assert.equal(p.currentCorrectionVersion, 0);
  assert.deepEqual(p.changes, [{ field: 'note', before: f.assignmentItem.assignment.notes, after: f.correctionInput.correction.note }]);
  for (const flag of ['persisted','canApply','affectsCurrentState','evidenceRelinked','operationalHistoryApplied','correctionApplicationImplemented']) assert.equal(p[flag], false);
  assert.equal(p.proposed.assignedById, null); assert.equal(p.proposed.returnedById, null); assert.equal(p.originalAssignment.createdById, null);
  assert.equal(p.originalAssignment.returnRecordedAt, f.receipt.appliedAt); assert.equal(p.ownership.length, 2);
  assert.equal((await post(f.correctionUrl, f.correctionInput)).json().correctionPlanId, p.correctionPlanId); assert.deepEqual(await snapshot(f), before);
  assert.equal((await post(f.planUrl, f.originalPlanInput)).json().planValidationComplete, false);
  assert.equal((await post(f.url, p)).statusCode, 400);
});
test('legacy correction accepts current endpoint versions amended before application and retains their captured origin', async () => {
  const f = await prepare({ amendedBeforeApply: true }); const before = await snapshot(f); const response = await post(f.correctionUrl, f.correctionInput); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().planValidationComplete, true); assert.equal(response.json().sources.every((entry) => entry.evidenceVersion === 1 && entry.amendmentId), true);
  assert.deepEqual(await snapshot(f), before);
});
test('legacy correction preserves current custody, later returns and terminal state independently of original application', async () => {
  for (const options of [{ active: true }, { retired: true }]) {
    const f = await prepare(options); const before = await snapshot(f); const response = await post(f.correctionUrl, f.correctionInput); assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().planValidationComplete, true); assert.deepEqual(await snapshot(f), before);
    if (options.active) {
      assert.equal(response.json().currentCustody.length, 1); const returned = await post('/assets/' + f.asset.id + '/assignments/' + response.json().currentCustody[0].id + '/return', { returnStatus: 'AVAILABLE', effectiveAt: '2006-01-01T00:00:00Z' }); assert.equal(returned.statusCode, 200, returned.body);
      const after = await snapshot(f); const checked = await post(f.correctionUrl, f.correctionInput); assert.equal(checked.json().planValidationComplete, true, checked.body); assert.deepEqual(await snapshot(f), after);
    }
  }
});
test('legacy correction requires material changes, independent date proofs and known-day compatibility', async () => {
  const f = await prepare(); const original = { ...f.correctionInput, correction: { ...f.correctionInput.correction, note: f.assignmentItem.assignment.notes } };
  assert.ok(blockers(await post(f.correctionUrl, original)).includes('ASSIGNMENT_CORRECTION_UNCHANGED'));
  for (const [change, expected] of [[{ start: { ...original.correction.start, confirmedAt: '2001-01-02T00:00:00Z' } }, 'SOURCE_DAY_MISMATCH'],
    [{ start: { ...original.correction.start, dateEvidenceReference: null } }, 'EXACT_DATE_PROOF_REQUIRED'], [{ recipient: null }, 'CONFIRMED_RECIPIENT_REQUIRED']]) {
    assert.ok(blockers(await post(f.correctionUrl, { ...f.correctionInput, correction: { ...f.correctionInput.correction, ...change } })).includes(expected));
  }
});
test('legacy correction excludes only the selected original period, not its siblings or newer custody', async () => {
  const f = await prepare({ count: 2, unknownEndDate: true }); const sister = f.receipt.items.find((entry) => entry.id !== f.assignmentItem.id);
  const input = { ...f.correctionInput, correction: { ...f.correctionInput.correction, end: { ...f.correctionInput.correction.end, confirmedAt: new Date(new Date(sister.assignment.startedAt).getTime() + 1).toISOString() } } };
  assert.ok(blockers(await post(f.correctionUrl, input)).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
  const g = await prepare({ active: true, unknownEndDate: true });
  assert.ok(blockers(await post(g.correctionUrl, { ...g.correctionInput, correction: { ...g.correctionInput.correction, end: { ...g.correctionInput.correction.end, confirmedAt: '2006-01-01T00:00:00Z' } } })).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
});
test('legacy correction rejects forged root, sibling, assignment, proof digest or origin importer', async () => {
  const f = await prepare({ count: 2 }); const sisterId = f.receipt.items.find((entry) => entry.id !== f.assignmentItem.id).id;
  for (const mutate of [(receipt) => { receipt.requestDigest = 'f'.repeat(64); }, (receipt) => { receipt.items.find((entry) => entry.id === sisterId).assignment.notes = 'Changed sibling'; },
    (receipt) => { receipt.items.find((entry) => entry.id === sisterId).evidenceUses.pop(); }, (receipt) => { receipt.items[0].assignment.groupImportHistory = { id: randomUUID() }; },
    (receipt) => { receipt.appliedById = users.SOPORTE.id; }]) await withMutation(f, 'importAssignmentApplication', mutate);
  code(await post(f.correctionUrl, { ...f.correctionInput, expectedOriginPlanId: 'f'.repeat(64) }), 409, 'ASSIGNMENT_ORIGIN_CHANGED');
});
test('legacy correction rejects incomplete audit metadata and foreign endpoint or application ownership', async () => {
  const f = await prepare();
  for (const mutate of [(audits) => { audits.pop(); }, (audits) => { audits[0].metadata.affectsCurrentState = true; }, (audits) => { audits[0].userId = users.SOPORTE.id; }]) {
    await withMutation(f, 'auditLog', mutate);
  }
  for (const mutate of [(rows) => { rows[0].assignmentUse.itemId = randomUUID(); }, (rows) => { rows[0].groupAssignmentUse = { itemId: randomUUID() }; },
    (rows) => { rows[0].groupRetirementUse = { id: randomUUID() }; }]) await withMutation(f, 'importHistoricalEvidence', mutate);
  await withMutation(f, 'importHistoricalEvidence', (rows) => { rows[0].snapshot.effective.row = 999; }, 'INVALID_HISTORICAL_EVIDENCE');
});
test('legacy correction source and product conflicts remain visible without exempting ownership in normal planners', async () => {
  const f = await prepare(); const revised = database.$extends({ query: { importSourceRevision: { async findMany({ args, query }) {
    const revisions = await query(args); return [...revisions, { batchId: f.batch.id, revision: 1, changes: [{ candidateId: f.capture.items[0].candidateId }] }];
  } } } }); const isolated = buildApp(revised);
  try { assert.ok(blockers(await post(f.correctionUrl, f.correctionInput, 'JEFE', true, isolated)).includes('EVIDENCE_SOURCE_REVISED')); } finally { await isolated.close(); }
  const quantity = database.$extends({ query: { asset: { async findUnique({ args, query }) {
    const result = await query(args); return result?.product ? { ...result, product: { ...result.product, trackingMode: 'QUANTITY' } } : result;
  } } } }); const quantityApp = buildApp(quantity);
  try { assert.ok(blockers(await post(f.correctionUrl, f.correctionInput, 'JEFE', true, quantityApp)).includes('PRODUCT_NOT_ASSET')); } finally { await quantityApp.close(); }
  await database.asset.update({ where: { id: f.asset.id }, data: { serialNumber: 'Changed-identity-' + randomUUID() } });
  assert.ok(blockers(await post(f.correctionUrl, f.correctionInput)).includes('CURRENT_ASSET_IDENTITY_CONFLICT'));
  const original = await post(f.planUrl, f.originalPlanInput); assert.equal(original.statusCode, 200, original.body);
  assert.ok(original.json().periods[0].blockers.some((entry) => entry.code === 'ENDPOINT_EVIDENCE_ALREADY_APPLIED'));
});
test('legacy correction reads a single repeatable snapshot across concurrent terminal metadata changes', async () => {
  const f = await prepare(); const before = await post(f.correctionUrl, f.correctionInput); let triggered = false;
  const concurrent = database.$extends({ query: { importHistoricalEvidence: { async findMany({ args, query }) {
    if (!triggered && args.include?.capture) { triggered = true; await database.asset.update({ where: { id: f.asset.id }, data: { notes: 'Concurrent terminal metadata' } }); }
    return query(args);
  } } } });
  const p = await planAssignmentCorrection(concurrent, f.asset.id, f.receipt.id, f.assignmentItem.id, f.correctionInput);
  assert.equal(triggered, true); assert.equal(p.correctionPlanId, before.json().correctionPlanId); assert.equal(p.currentAsset.notes, before.json().currentAsset.notes);
  assert.notEqual((await post(f.correctionUrl, f.correctionInput)).json().correctionPlanId, p.correctionPlanId);
});
test('legacy correction fails explicitly on excessive context or unavailable storage and unsupported original rules', async () => {
  const f = await prepare();
  await withMutation(f, 'importAssignmentApplication', (receipt) => { receipt.rulesVersion = 'mda-closed-assignment-plan-1'; }, 'ASSIGNMENT_ORIGIN_RULES_UNSUPPORTED');
  await withMutation(f, 'importAssignmentApplication', (receipt) => { receipt.items = Array(26).fill(receipt.items[0]); }, 'ASSIGNMENT_CORRECTION_LIMIT');
  for (const model of ['assignment','importSourceRevision','auditLog']) await withMutation(f, model, (rows) => { while (rows.length < (model === 'assignment' ? 10001 : model === 'auditLog' ? 27 : 1001)) rows.push({}); }, 'ASSIGNMENT_CORRECTION_LIMIT');
  const missing = database.$extends({ query: { importAssignmentApplication: { async findFirst() {
    throw new Prisma.PrismaClientKnownRequestError('Missing legacy origin storage', { code: 'P2021', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'ImportAssignmentApplication' } });
  } } } }); const isolated = buildApp(missing);
  try { code(await post(f.correctionUrl, f.correctionInput, 'JEFE', true, isolated), 503, 'IMPORT_REVIEW_NOT_READY'); } finally { await isolated.close(); }
});
test('legacy correction plan hashing includes full current metadata and documentary proof without relying only on updatedAt', async () => {
  const f = await prepare(); const before = await post(f.correctionUrl, f.correctionInput);
  const changed = database.$extends({ query: { asset: { async findUnique({ args, query }) { const result = await query(args); return result?.id === f.asset.id ? { ...result, notes: 'Reviewed current metadata' } : result; } } } });
  const p = await planAssignmentCorrection(changed, f.asset.id, f.receipt.id, f.assignmentItem.id, f.correctionInput);
  assert.notEqual(p.correctionPlanId, before.json().correctionPlanId); assert.equal(p.currentAsset.updatedAt.toISOString(), before.json().currentAsset.updatedAt);
  const input = clone(f.correctionInput); input.correction.start.dateEvidenceReference = 'Additional signed time proof';
  const additional = await post(f.correctionUrl, input); assert.equal(additional.json().planValidationComplete, true, additional.body);
  assert.ok(additional.json().changes.some((entry) => entry.field === 'startDateEvidenceReference'));
});

async function confirmLegacy(f, plan = f.correctionInput, requestId = randomUUID()) {
  const response = await post(f.correctionUrl, plan); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().planValidationComplete, true, response.body);
  return { requestId, correctionPlanId: response.json().correctionPlanId, confirmation: 'APPLY_LEGACY_ASSIGNMENT_CORRECTION', plan };
}
const applyLegacy = (f, input) => post(f.correctionUrl + '/apply', input);
const correctionBase = (f) => f.correctionUrl.replace('/correction-plan', '/corrections');
test('legacy correction application stores an audited version and effective detail and timeline while preserving all original domain facts', async () => {
  const f = await prepare({ count: 2, active: true }); const before = await snapshot(f); const input = await confirmLegacy(f);
  const response = await applyLegacy(f, input); assert.equal(response.statusCode, 201, response.body); const correction = response.json().correction;
  assert.equal(correction.version, 1); assert.equal(correction.previousId, null); assert.equal(correction.correctedById, users.JEFE.id);
  const after = await snapshot(f); assert.equal(after.audits.length, before.audits.length + 1); after.audits = before.audits; assert.deepEqual(after, before);
  const detail = await get('/assignments/' + f.assignmentItem.assignmentId); assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().assignment.notes, f.correctionInput.correction.note); assert.equal(detail.json().assignment.originalAssignment.notes, f.assignmentItem.assignment.notes);
  assert.equal(detail.json().assignment.historyCorrection.id, correction.id);
  const events = (await get('/assets/' + f.asset.id + '/history')).json().events.filter((entry) => entry.historyCorrection?.id === correction.id);
  assert.equal(events.length, 2); assert.ok(events.every((entry) => entry.actor === null && entry.recordedById === f.receipt.appliedById));
});
test('legacy correction application has strict own confirmation, role, CSRF, query and exact receipt parents', async () => {
  const f = await prepare(); const input = await confirmLegacy(f);
  for (const role of ['COORDINADOR','SOPORTE']) assert.equal((await post(f.correctionUrl + '/apply', input, role)).statusCode, 403);
  assert.equal((await post(f.correctionUrl + '/apply', input, 'JEFE', false)).statusCode, 403);
  for (const change of [{ confirmation: 'APPLY_GROUP_ASSIGNMENT_CORRECTION' }, { correctedById: users.JEFE.id }, { force: true }]) assert.equal((await applyLegacy(f, { ...input, ...change })).statusCode, 400);
  assert.equal((await post(f.correctionUrl + '/apply?force=true', input)).statusCode, 400);
  assert.equal((await post((f.correctionUrl + '/apply').replace(f.receipt.id, randomUUID()), input)).statusCode, 404);
  assert.equal((await applyLegacy(f, input)).statusCode, 201);
});
test('legacy correction application retries recover exact receipts, reject intent or actor reuse and expose scoped paginated history', async () => {
  const f = await prepare(); const input = await confirmLegacy(f); const response = await applyLegacy(f, input); assert.equal(response.statusCode, 201, response.body);
  const again = await applyLegacy(f, input); assert.equal(again.statusCode, 200); assert.equal(again.json().reused, true); assert.deepEqual(again.json().correction, response.json().correction);
  code(await applyLegacy(f, { ...input, plan: { ...input.plan, reason: 'Different intent' } }), 409, 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(applyAssignmentCorrection(database, f.asset.id, f.receipt.id, f.assignmentItem.id, input, users.SOPORTE.id), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
  const list = (await get(correctionBase(f) + '?limit=1')).json(); assert.equal(list.total, 1); assert.equal(list.corrections[0].plan, undefined);
  const detail = await get(correctionBase(f) + '/' + response.json().correction.id); assert.equal(detail.statusCode, 200); assert.deepEqual(detail.json().correction, response.json().correction);
  assert.equal((await get(correctionBase(f).replace(f.asset.id, randomUUID()) + '/' + response.json().correction.id)).statusCode, 404);
});
test('legacy correction application chains subsequent versions from latest effective values, preserves origin and recovers older requests', async () => {
  const f = await prepare(); const input = await confirmLegacy(f); const first = await applyLegacy(f, input); assert.equal(first.statusCode, 201, first.body);
  code(await post(f.correctionUrl, f.correctionInput), 409, 'ASSIGNMENT_CORRECTION_VERSION_CONFLICT');
  const nextPlan = { ...f.correctionInput, expectedCorrectionVersion: 1, correction: { ...f.correctionInput.correction, note: 'Second effective historical note', returnStatus: 'IN_REPAIR' } };
  const secondInput = await confirmLegacy(f, nextPlan); const second = await applyLegacy(f, secondInput); assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().correction.version, 2); assert.equal(second.json().correction.previousId, first.json().correction.id);
  assert.equal(second.json().correction.plan.before.note, f.correctionInput.correction.note);
  assert.deepEqual((await applyLegacy(f, input)).json().correction, first.json().correction);
  assert.equal((await get('/assignments/' + f.assignmentItem.assignmentId)).json().assignment.returnStatus, 'IN_REPAIR');
  const root = await database.assignment.findUniqueOrThrow({ where: { id: f.assignmentItem.assignmentId } }); assert.equal(root.returnStatus, f.assignmentItem.assignment.returnStatus);
});
test('legacy correction application changes effective bounds used by new assignments, siblings and retirement without changing original timestamps', async () => {
  const f = await prepare({ unknownEndDate: true }); const input = await confirmLegacy(f, { ...f.correctionInput, correction: { ...f.correctionInput.correction,
    end: { ...f.correctionInput.correction.end, confirmedAt: '2004-01-01T00:00:00Z' } } });
  const response = await applyLegacy(f, input); assert.equal(response.statusCode, 201, response.body);
  const delivered = await post('/assets/' + f.asset.id + '/assignments', { personName: 'New Custodian', effectiveAt: '2003-01-01T00:00:00Z' }); assert.equal(delivered.statusCode, 409, delivered.body);
  await assert.rejects(database.asset.update({ where: { id: f.asset.id }, data: { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2003-01-01') } }), /effective custody history/);
  const detail = (await get('/assignments/' + f.assignmentItem.assignmentId)).json().assignment;
  assert.equal(detail.endedAt, '2004-01-01T00:00:00.000Z'); assert.equal(detail.originalAssignment.endedAt, f.assignmentItem.assignment.endedAt);
});
test('legacy correction application revalidates context and warnings and rolls back on audit failure', async () => {
  const f = await prepare(); const input = await confirmLegacy(f);
  await database.asset.update({ where: { id: f.asset.id }, data: { notes: 'Changed current metadata after review' } });
  code(await applyLegacy(f, input), 409, 'ASSIGNMENT_CORRECTION_PLAN_CHANGED'); const current = await confirmLegacy(f);
  const failing = database.$extends({ query: { auditLog: { async create({ args, query }) { if (args.data.action === 'IMPORT_LEGACY_ASSIGNMENT_CORRECTED') throw new Error('Injected legacy correction audit failure'); return query(args); } } } });
  await assert.rejects(applyAssignmentCorrection(failing, f.asset.id, f.receipt.id, f.assignmentItem.id, current, users.JEFE.id), /Injected legacy correction audit failure/);
  assert.equal(await database.importAssignmentCorrection.count({ where: { itemId: f.assignmentItem.id } }), 0);
  assert.equal((await applyLegacy(f, current)).statusCode, 201);
});
test('legacy correction application concurrent retries cannot duplicate a version and use stable idempotent recovery', async () => {
  const f = await prepare(); const input = await confirmLegacy(f); const responses = await Promise.all([applyLegacy(f,input),applyLegacy(f,input)]);
  assert.ok(responses.some((entry) => entry.statusCode === 201), responses.map((entry) => entry.body).join('\n'));
  assert.ok(responses.every((entry) => [200,201,409].includes(entry.statusCode))); assert.equal((await applyLegacy(f,input)).statusCode,200);
  assert.equal(await database.importAssignmentCorrection.count({ where: { itemId: f.assignmentItem.id } }),1);
});
async function rawCorrection(tx,f,input,change={}) {
  const plan = (await post(f.correctionUrl,input.plan)).json();
  const [clock] = await tx.$queryRaw`SELECT date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC') AS "capturedAt"`;
  return tx.importAssignmentCorrection.create({ data: { itemId:f.assignmentItem.id,version:plan.currentCorrectionVersion+1,previousId:plan.currentCorrectionId,
    requestId:input.requestId,requestDigest:assignmentCorrectionRequestDigest(input),correctionPlanId:plan.correctionPlanId,rulesVersion:'mda-legacy-assignment-correction-application-1',
    plan,reason:input.plan.reason,supportingReference:input.plan.supportingReference,assetSnapshot:plan.currentAsset,custodySnapshot:plan.currentCustody,correctedById:users.JEFE.id,correctedAt:clock.capturedAt,...change } });
}
async function rawCorrectionAudit(tx,f,event) {
  return tx.auditLog.create({ data: { userId:users.JEFE.id,action:'IMPORT_LEGACY_ASSIGNMENT_CORRECTED',entityType:'ImportAssignmentCorrection',entityId:event.id,
    metadata:{assetId:f.asset.id,applicationId:f.receipt.id,assignmentItemId:f.assignmentItem.id,assignmentId:f.assignmentItem.assignmentId,version:event.version,previousId:event.previousId,affectsCurrentState:false} } });
}
test('legacy correction SQL rejects forged actor, marker, sequential version, snapshot, intent and missing atomic audit', async () => {
  const f=await prepare(); const input=await confirmLegacy(f);
  for (const change of [{correctedById:users.SOPORTE.id},{createdTransactionId:'1'},{version:2},{requestDigest:'f'.repeat(64)},{assetSnapshot:{id:f.asset.id}}]) {
    await assert.rejects(database.$transaction((tx)=>rawCorrection(tx,f,input,change)),/Legacy correction|constraint/i);
  }
  await assert.rejects(database.$transaction((tx)=>rawCorrection(tx,f,input)),/audit.*atomic|atomically/i);
  const fabricatedId=randomUUID(); const oldAudit=await rawCorrectionAudit(database,f,{id:fabricatedId,version:1,previousId:null});
  await assert.rejects(database.$transaction((tx)=>rawCorrection(tx,f,input,{id:fabricatedId})),/audit.*atomic|atomically/i);
  await database.auditLog.delete({where:{id:oldAudit.id}});
  assert.equal(await database.importAssignmentCorrection.count({where:{itemId:f.assignmentItem.id}}),0);
});
test('legacy correction SQL seals context after early constraints and savepoints and keeps receipts and audits immutable', async () => {
  const f=await prepare(); const input=await confirmLegacy(f);
  for (const mutate of [(tx)=>tx.asset.update({where:{id:f.asset.id},data:{notes:'Hidden change'}}), (tx)=>tx.product.update({where:{id:product.id},data:{name:'Hidden change'}})]) {
    await assert.rejects(database.$transaction(async(tx)=>{const event=await rawCorrection(tx,f,input);await rawCorrectionAudit(tx,f,event);await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');await tx.$executeRawUnsafe('SAVEPOINT legacy_seal');await mutate(tx);}),/capture transaction/i);
  }
  const response=await applyLegacy(f,input);assert.equal(response.statusCode,201,response.body);const event=response.json().correction;
  await assert.rejects(database.importAssignmentCorrection.delete({where:{id:event.id}}),/immutable/i);
  await assert.rejects(database.importAssignmentCorrection.update({where:{id:event.id},data:{reason:'Rewritten'}}),/immutable/i);
  await assert.rejects(database.auditLog.deleteMany({where:{entityId:event.id}}),/immutable/i);
  await assert.rejects(database.auditLog.deleteMany({where:{entityId:f.receipt.id}}),/immutable/i);
});
test('legacy correction SQL rejects self-rehashed false intention, evidence presentation or original audit metadata',async()=>{
  const f=await prepare();const input=await confirmLegacy(f);const original=(await post(f.correctionUrl,input.plan)).json();
  for(const mutate of [(p)=>{p.request.correction.note='Different requested note';},(p)=>{p.currentEvidence[0].snapshot.original.row=999;},(p)=>{p.validationContextPlanId='f'.repeat(64);},(p)=>{p.proposedPeriod.force=true;p.request.correction.force=true;}]){
    const plan=JSON.parse(JSON.stringify(original));mutate(plan);plan.correctionPlanId=importPlanDigest(Object.fromEntries(Object.entries(plan).filter(([key])=>!correctionEnvelope.has(key))));
    const changed={...input,correctionPlanId:plan.correctionPlanId,plan:plan.request};
    await assert.rejects(database.$transaction((tx)=>rawCorrection(tx,f,input,{plan,correctionPlanId:plan.correctionPlanId,requestDigest:assignmentCorrectionRequestDigest(changed)})),/Legacy correction/i);
  }
  const root=await database.auditLog.findFirstOrThrow({where:{entityId:f.receipt.id,action:'IMPORT_CLOSED_ASSIGNMENTS_APPLIED'}});
  await database.auditLog.update({where:{id:root.id},data:{metadata:{forged:true}}});
  code(await applyLegacy(f,input),409,'INVALID_ASSIGNMENT_APPLICATION');
});
test('legacy correction plan storage absence is explicit and later original metadata cannot be silently rewritten',async()=>{
  const f=await prepare();const input=await confirmLegacy(f);const missing=database.$extends({query:{importAssignmentCorrection:{async findMany(){throw new Prisma.PrismaClientKnownRequestError('Missing correction storage',{code:'P2021',clientVersion:Prisma.prismaVersion.client,meta:{modelName:'ImportAssignmentCorrection'}});}}}});
  const isolated=buildApp(missing);try{code(await post(f.correctionUrl,f.correctionInput,'JEFE',true,isolated),503,'IMPORT_REVIEW_NOT_READY');}finally{await isolated.close();}
  const response=await applyLegacy(f,input);assert.equal(response.statusCode,201,response.body);
  await database.asset.update({where:{id:f.asset.id},data:{notes:'Separate later current metadata'}});
  assert.deepEqual((await applyLegacy(f,input)).json().correction,response.json().correction);
});
