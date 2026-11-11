import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { assetId, receiptId } from './fixtures/import-pilot.mjs';
import { closedActorId, closedApplicationFixture } from './fixtures/closed-application.mjs';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const errorUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};' });
const historyModelUrl = moduleUrl('../src/features/imports/history-evidence-model.ts');
const historyApiUrl = moduleUrl('../src/features/imports/history-evidence-api.ts', { '../../lib/api': errorUrl, './import-review-api': 'data:text/javascript,export const importReviewPath="/inventory/imports/batches";', './history-evidence-model': historyModelUrl });
const closedModelUrl = moduleUrl('../src/features/imports/closed-assignment-model.ts');
const planApiUrl = moduleUrl('../src/features/imports/closed-assignment-api.ts', { '../../lib/api': errorUrl, './history-evidence-api': historyApiUrl, './history-evidence-model': historyModelUrl, './closed-assignment-model': closedModelUrl });
const modelUrl = moduleUrl('../src/features/imports/closed-application-model.ts');
const model = await import(modelUrl); const errors = await import(errorUrl);
const legacyApiUrl = moduleUrl('../src/features/imports/legacy-closed-application-api.ts', { '../../lib/api': errorUrl, './closed-assignment-api': planApiUrl, './closed-assignment-model': closedModelUrl });
const api = await import(moduleUrl('../src/features/imports/closed-application-api.ts', { '../../lib/api': errorUrl, './closed-assignment-api': planApiUrl, './closed-assignment-model': closedModelUrl, './closed-application-model': modelUrl, './history-evidence-api': historyApiUrl, './legacy-closed-application-api': legacyApiUrl }));

test('application freezes only normalized V10 request, not response snapshots or operational state; blocked plans cannot create intent', () => {
  const fixture = closedApplicationFixture(); const intent = model.createClosedApplicationIntent(fixture.plan, receiptId);
  assert.deepEqual(intent, fixture.intent); assert.deepEqual(Object.keys(intent), ['requestId', 'planId', 'confirmation', 'plan']);
  fixture.plan.periods[0].note = 'Changed'; fixture.plan.periods[0].acknowledgedWarnings.push('e'.repeat(64));
  assert.notEqual(intent.plan.periods[0].note, fixture.plan.periods[0].note); assert.equal(intent.plan.periods[0].acknowledgedWarnings.length, 1);
  fixture.plan.planValidationComplete = false; assert.throws(() => model.createClosedApplicationIntent(fixture.plan, receiptId));
});
test('current application intents preserve every normalized period through 25 and reject zero or excess periods', () => {
  const fixture = closedApplicationFixture();
  fixture.plan.periods = Array.from({ length: 25 }, (_, index) => {
    const period = globalThis.structuredClone(fixture.plan.periods[0]);
    period.periodId = '00000000-0000-4000-8000-' + (index + 1000).toString().padStart(12, '0');
    period.start.evidenceId = '00000000-0000-4000-8000-' + (index * 2 + 2000).toString().padStart(12, '0');
    period.end.evidenceId = '00000000-0000-4000-8000-' + (index * 2 + 2001).toString().padStart(12, '0');
    return period;
  });
  const intent = model.createClosedApplicationIntent(fixture.plan, receiptId);
  assert.equal(intent.plan.periods.length, 25); assert.deepEqual(intent.plan.periods.map((period) => period.periodId), fixture.plan.periods.map((period) => period.periodId));
  assert.deepEqual(Object.keys(intent.plan.periods[24]), ['periodId', 'confirmation', 'start', 'end', 'recipient', 'assignmentType', 'returnStatus', 'note', 'evidenceReference', 'acknowledgedWarnings']);
  assert.equal('sources' in intent.plan.periods[24], false); assert.equal('proposedAssignment' in intent.plan.periods[24], false);
  fixture.plan.periods[24].start.dateEvidenceReference = 'Changed source'; fixture.plan.periods[24].recipient.name = 'Changed name'; fixture.plan.periods[24].acknowledgedWarnings.push('e'.repeat(64));
  assert.notEqual(intent.plan.periods[24].start.dateEvidenceReference, fixture.plan.periods[24].start.dateEvidenceReference);
  assert.notEqual(intent.plan.periods[24].recipient.name, fixture.plan.periods[24].recipient.name); assert.equal(intent.plan.periods[24].acknowledgedWarnings.length, 1);
  for (const count of [0, 26]) {
    fixture.plan.periods = Array.from({ length: count }, () => intent.plan.periods[0]);
    assert.throws(() => model.createClosedApplicationIntent(fixture.plan, receiptId)); assert.throws(() => model.closedInputFromPlan(fixture.plan));
  }
});
test('confirmed/recovered receipts bind actor, request, plan, endpoints, persisted assignments and unknown historical actors', () => {
  const fixture = closedApplicationFixture();
  for (const reused of [false, true]) {
    const result = api.validateClosedApplication(fixture.receiptFor(fixture.intent, reused), assetId, { intent: fixture.intent, actorId: closedActorId });
    assert.equal(result.items[0].snapshot.proposedAssignment.returnedById, null); assert.equal(result.appliedById, closedActorId);
    assert.equal(result.plan.assetBefore.status, 'AVAILABLE'); assert.equal(result.items[0].snapshot.returnStatus, 'UNDER_REVIEW');
  }
  const detail = globalThis.structuredClone(fixture.receipt); delete detail.reused;
  assert.equal(api.validateClosedApplication(detail, assetId, { id: detail.application.id }).id, detail.application.id);
});
test('incompatible application never masquerades as success, including crossed asset, actor, snapshot, references and timestamps', () => {
  const fixture = closedApplicationFixture();
  for (const mutate of [(v) => { v.persisted = false; }, (v) => { v.affectsCurrentState = true; }, (v) => { v.mode = 'PLAN'; }, (v) => { delete v.reused; },
    (v) => { v.application.assetId = receiptId; }, (v) => { v.application.requestId = assetId; }, (v) => { v.application.appliedById = assetId; },
    (v) => { v.application.planId = 'f'.repeat(64); }, (v) => { v.application.rulesVersion = 'mda-closed-assignment-plan-1'; }, (v) => { v.application.items = []; },
    (v) => { v.application.items.push(v.application.items[0]); }, (v) => { v.application.items[0].applicationId = assetId; },
    (v) => { v.application.items[0].snapshot.note = 'Other'; }, (v) => { v.application.items[0].endEvidenceId = receiptId; },
    (v) => { v.application.items[0].assignment.assetId = receiptId; }, (v) => { v.application.items[0].assignment.createdById = closedActorId; },
    (v) => { v.application.items[0].assignment.personId = closedActorId; }, (v) => { v.application.items[0].assignment.importedHistory = false; },
    (v) => { v.application.items[0].assignment.endedAt = null; }, (v) => { v.application.items[0].assignment.returnTicketReference = 'Other'; },
    (v) => { v.application.items[0].assignment.createdAt = '2001-01-01T10:00:00Z'; }, (v) => { v.application.items[0].assignment.returnNotes = 'Other'; }]) {
    const value = globalThis.structuredClone(fixture.receipt); mutate(value);
    assert.throws(() => api.validateClosedApplication(value, assetId, { intent: fixture.intent, actorId: closedActorId }), (error) => error.code === 'INVALID_RESPONSE');
  }
});
test('receipt list uses real pages 25/2 and asset-scoped detail; malformed page and owner fail instead of empty', async () => {
  const fixture = closedApplicationFixture(); const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return new globalThis.Response(JSON.stringify(url.includes('offset=25') ? fixture.pageFor(25) : url.includes('?') ? fixture.pageFor() : fixture.receipt)); };
  try {
    assert.equal((await api.readClosedApplications(assetId, 0, new globalThis.AbortController().signal)).items.length, 25);
    assert.equal((await api.readClosedApplications(assetId, 25, new globalThis.AbortController().signal)).items.length, 2);
    assert.equal((await api.readClosedApplication(assetId, fixture.receipt.application.id, new globalThis.AbortController().signal)).id, fixture.receipt.application.id);
    assert.ok(calls.every((url) => url.includes('/assets/' + assetId + '/imported-assignment-applications')));
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ ...fixture.pageFor(), total: 1 }));
    await assert.rejects(api.readClosedApplications(assetId,0,new globalThis.AbortController().signal), (error) => error.code === 'INVALID_RESPONSE');
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify(fixture.receipt));
    await assert.rejects(api.readClosedApplication(receiptId,fixture.receipt.application.id,new globalThis.AbortController().signal), (error) => error.code === 'INVALID_RESPONSE');
  } finally { globalThis.fetch = old; }
});
test('explicit application/recovery share CSRF deadline and exactly the same UUID/body, with no automatic or CRUD request', async () => {
  const fixture = closedApplicationFixture(); const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? { csrfToken: 'fixture-token' } : fixture.receipt)); };
  try {
    await api.saveClosedApplication(assetId,fixture.intent,closedActorId); await api.saveClosedApplication(assetId,fixture.intent,closedActorId);
    assert.equal(calls.length,4); const writes = calls.filter((call) => call.method === 'POST'); assert.equal(writes.length,2);
    assert.equal(writes[0].body,writes[1].body); assert.equal(writes[0].signal,calls[0].signal); assert.equal(writes[0].headers.get('X-CSRF-Token'),'fixture-token');
    assert.ok(writes.every((call) => call.url.endsWith('/imported-assignment-plan/apply')));
  } finally { globalThis.fetch = old; }
});
test('recovery separates uncertain commit from known conflicts; Spanish messages never leak server details', () => {
  for (const error of [new Error('offline'), new errors.ApiRequestError('private',503), new errors.ApiRequestError('private',200,'INVALID_RESPONSE'), new errors.ApiRequestError('private',409,'HISTORICAL_APPLICATION_BUSY'), new errors.ApiRequestError('private',409,'HISTORICAL_APPLICATION_CONFLICT')]) assert.equal(api.closedApplicationNeedsRecovery(error),true);
  for (const code of ['HISTORICAL_PLAN_CHANGED','HISTORICAL_PLAN_BLOCKED','HISTORICAL_EVIDENCE_ALREADY_APPLIED','IDEMPOTENCY_KEY_REUSED','FORBIDDEN']) {
    const error = new errors.ApiRequestError('PRIVATE_STACK',409,code); assert.equal(api.closedApplicationNeedsRecovery(error),false); assert.doesNotMatch(errors.getApiErrorMessage(error),/PRIVATE_STACK/);
  }
});
