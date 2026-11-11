import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { assetId, receiptId } from './fixtures/import-pilot.mjs';
import { closedAssignmentFixture } from './fixtures/closed-assignment.mjs';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const errorUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};' });
const historyModelUrl = moduleUrl('../src/features/imports/history-evidence-model.ts');
const historyApiUrl = moduleUrl('../src/features/imports/history-evidence-api.ts', { '../../lib/api': errorUrl, './import-review-api': 'data:text/javascript,export const importReviewPath="/inventory/imports/batches";', './history-evidence-model': historyModelUrl });
const modelUrl = moduleUrl('../src/features/imports/closed-assignment-model.ts');
const model = await import(modelUrl);
const errors = await import(errorUrl);
const api = await import(moduleUrl('../src/features/imports/closed-assignment-api.ts', { '../../lib/api': errorUrl, './history-evidence-api': historyApiUrl, './history-evidence-model': historyModelUrl, './closed-assignment-model': modelUrl }));
const historyApi = await import(historyApiUrl);
test('closed-period drafts start with no recipient, state, dates, endpoints or acknowledgements; explicit confirmation is required', () => {
  const draft = model.emptyClosedPeriod(receiptId);
  assert.equal(draft.startAt, ''); assert.equal(draft.endAt, ''); assert.equal(draft.returnStatus, ''); assert.equal(draft.recipientType, '');
  assert.equal(draft.assignmentType, ''); assert.deepEqual(draft.acknowledgedWarnings, []);
  assert.deepEqual(Object.keys(model.validateClosedPeriod(draft)), ['startId', 'endId', 'assignmentType', 'note', 'reference', 'confirmed']);
  assert.throws(() => model.closedPlanInput(draft));
});
test('exact instants preserve offset/local day, reject rollover, absent zones, impossible times, pre-1900 and excessive precision', () => {
  for (const value of ['1900-01-01T01:00:00+01:00', '2025-01-02T23:30:00-03:00', '2024-02-29T09:00:00.123Z']) assert.equal(model.validHistoricalInstant(value), true, value);
  for (const value of ['2025-02-29T09:00:00Z', '2025-04-31T09:00:00Z', '2025-01-02T09:00:00', '2025-01-02', '2025-01-02T24:00:00Z', '2025-01-02T12:60:00Z', '2025-01-02T12:00:60Z',
    '1899-12-31T23:59:59Z', '1900-01-01T00:00:00+01:00', '2025-01-02T12:00:00.1234Z', '2025-01-02T12:00:00+25:00', '2025-01-02T12:00:00+03:99']) assert.equal(model.validHistoricalInstant(value), false, value);
  const draft = closedAssignmentFixture().draftFor(); draft.startAt = '2025-01-02T23:30:00-03:00';
  const input = model.closedPlanInput(draft); assert.equal(input.periods[0].start.confirmedAt, draft.startAt);
  assert.equal(new Date(input.periods[0].start.confirmedAt).toISOString().slice(0,10), '2025-01-03');
});
test('strict plan intent is a clone; unknown dates/proofs/recipient/state stay explicit null for server blockers', () => {
  const draft = closedAssignmentFixture().draftFor(); draft.startAt = ''; draft.startProof = ''; draft.recipientType = ''; draft.recipientName = ''; draft.returnStatus = '';
  const input = model.closedPlanInput(draft); assert.equal(input.periods[0].start.confirmedAt, null); assert.equal(input.periods[0].start.dateEvidenceReference, null);
  assert.equal(input.periods[0].recipient, null); assert.equal(input.periods[0].returnStatus, null);
  draft.acknowledgedWarnings.push('a'.repeat(64)); assert.deepEqual(input.periods[0].acknowledgedWarnings, []);
  assert.deepEqual(Object.keys(input), ['periods']); assert.deepEqual(Object.keys(input.periods[0]), ['periodId', 'confirmation', 'start', 'end', 'recipient', 'assignmentType', 'returnStatus', 'note', 'evidenceReference', 'acknowledgedWarnings']);
  draft.endId = draft.startId; assert.match(model.validateClosedPeriod(draft).endId, /distintas/);
  draft.recipientType = 'PERSON'; draft.recipientName = 'Ana'; assert.ok(model.validateClosedPeriod(draft).recipientName);
  draft.recipientType = 'OFFICE'; draft.recipientName = 'Sucursal'; assert.equal(model.validateClosedPeriod(draft).recipientName, undefined);
});
test('V12 rules2 plan distinguishes current evidence from original capture; blocked and complete plans remain unpersisted', async () => {
  const fixture = closedAssignmentFixture(); const draft = fixture.draftFor(); let input = model.closedPlanInput(draft);
  const blocked = api.validateClosedPlan(fixture.planFor(input), input, assetId);
  assert.equal(blocked.planValidationComplete, false); assert.equal(blocked.canApply, false); assert.equal(blocked.persisted, false);
  assert.equal(blocked.periods[0].sources[0].evidenceVersion, 1); assert.equal(blocked.periods[0].sources[0].sourceRevision, 1); assert.equal(blocked.periods[0].sources[0].capturedSourceRevision, 0);
  draft.acknowledgedWarnings = [fixture.warning.id]; input = model.closedPlanInput(draft);
  const complete = api.validateClosedPlan(fixture.planFor(input), input, assetId); assert.equal(complete.planValidationComplete, true);
  assert.equal(complete.periods[0].proposedAssignment.returnStatus, 'UNDER_REVIEW'); assert.equal(complete.assetBefore.status, 'AVAILABLE');
  const old = globalThis.fetch; globalThis.fetch = async () => new globalThis.Response(JSON.stringify(fixture.documents.pageFor(0)));
  try { assert.equal((await historyApi.readAssetImportedEvidence(assetId,0,new globalThis.AbortController().signal)).evidence[0].kind, 'USAGE_OBSERVATION'); } finally { globalThis.fetch = old; }
});
test('plan rejects wrong owner/scope, old rules, altered intent, actors, dates, page/period identities and malformed source versions', () => {
  const fixture = closedAssignmentFixture(); const input = model.closedPlanInput(fixture.draftFor());
  for (const mutate of [(v) => { v.canApply = true; }, (v) => { v.persisted = true; }, (v) => { v.affectsCurrentState = true; }, (v) => { v.scope = 'CLOSED_ASSIGNMENT_HISTORY'; },
    (v) => { v.assetBefore.id = receiptId; }, (v) => { v.planRulesVersion = 'mda-closed-assignment-plan-1'; }, (v) => { v.periods.push(v.periods[0]); },
    (v) => { v.periods[0].periodId = assetId; }, (v) => { v.periods[0].recipient.name = 'Otra Persona'; }, (v) => { v.periods[0].start.confirmedAt = '2025-01-02T13:30:00Z'; },
    (v) => { v.periods[0].proposedAssignment.assignedById = assetId; }, (v) => { v.periods[0].proposedAssignment.personId = assetId; },
    (v) => { v.periods[0].proposedAssignment.startedAt = '2025-01-03T13:30:00Z'; }, (v) => { v.periods[0].proposedAssignment.returnStatus = 'AVAILABLE'; },
    (v) => { delete v.periods[0].sources[0].evidenceVersion; }, (v) => { v.periods[0].sources[0].amendmentId = null; }, (v) => { v.periods[0].sources[1].amendmentId = assetId; },
    (v) => { v.periods[0].sources[0].evidenceId = assetId; }, (v) => { v.periods[0].sources[1].endpoint = 'start'; }, (v) => { v.periods[0].sources[0].sourceRevision = -1; },
    (v) => { v.periods[0].sources[1].sourceRevision = 1; },
    (v) => { v.periods[0].sources[0].effectiveDay = '2025-02-30'; }, (v) => { v.periods[0].sources[0].fields.receivedDate = {}; },
    (v) => { v.periods[0].warnings[0].evidenceId = assetId; }, (v) => { v.periods[0].valid = true; }, (v) => { v.summary.blockingCount = 0; }, (v) => { v.planValidationComplete = true; }]) {
    const response = fixture.planFor(input); mutate(response); assert.throws(() => api.validateClosedPlan(response, input, assetId), { code: 'INVALID_RESPONSE' });
  }
});
test('plan preserves warning severity/context, safe backend blockers and semantic JSON order; no auto-recognition', () => {
  const fixture = closedAssignmentFixture(); const input = model.closedPlanInput(fixture.draftFor()); const response = fixture.planFor(input);
  response.periods[0].start = Object.fromEntries(Object.entries(response.periods[0].start).reverse());
  response.periods[0].warnings[0].contextualOnly = true; response.periods[0].warnings[0].issue.severity = 'BLOCKING';
  const result = api.validateClosedPlan(response, input, assetId);
  assert.equal(result.periods[0].warnings[0].issue.severity, 'BLOCKING'); assert.deepEqual(result.periods[0].acknowledgedWarnings, []);
  assert.match(result.periods[0].blockers[0].code, /WARNINGS_NOT_ACKNOWLEDGED/);
});
test('read-only planning is explicit POST with CSRF/deadline, contains no apply/state actors and is cancelable', async () => {
  const fixture = closedAssignmentFixture(); const input = model.closedPlanInput(fixture.draftFor()); const previous = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({url, options}); options.signal.throwIfAborted(); return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? {csrfToken:'csrf-qa'} : fixture.planFor(input))); };
  try {
    const result = await api.readClosedAssignmentPlan(assetId,input,new globalThis.AbortController().signal); assert.equal(result.persisted,false);
    assert.equal(calls.length,2); assert.equal(calls[1].url,'https://fixture.invalid/assets/'+assetId+'/imported-assignment-plan');
    assert.equal(calls[1].options.method,'POST'); assert.equal(new globalThis.Headers(calls[1].options.headers).get('X-CSRF-Token'),'csrf-qa'); assert.equal(calls[1].options.body,JSON.stringify(input));
    const controller = new globalThis.AbortController(); controller.abort(); await assert.rejects(api.readClosedAssignmentPlan(assetId,input,controller.signal),{name:'AbortError'});
  } finally {globalThis.fetch = previous;}
});
test('planning failures retain safe error semantics rather than a fake complete/empty plan', async () => {
  const fixture = closedAssignmentFixture(); const input = model.closedPlanInput(fixture.draftFor()); const previous = globalThis.fetch;
  globalThis.fetch = async (url) => new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? {csrfToken:'csrf-qa'} : {code:'HISTORICAL_PLAN_LIMIT',message:'private SQL'}),{status:url.endsWith('/auth/csrf') ? 200 : 409});
  try {await assert.rejects(api.readClosedAssignmentPlan(assetId,input,new globalThis.AbortController().signal),{code:'HISTORICAL_PLAN_LIMIT'});} finally {globalThis.fetch = previous;}
  for (const code of ['HISTORICAL_PLAN_LIMIT','INVALID_HISTORICAL_EVIDENCE','INVALID_SOURCE_REVISION']) { const message = errors.getApiErrorMessage(new errors.ApiRequestError('private SQL',409,code),'Fallback'); assert.notEqual(message,'Fallback'); assert.doesNotMatch(message,/private/); }
});
