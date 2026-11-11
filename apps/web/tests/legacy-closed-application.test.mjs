import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { assetId, receiptId } from './fixtures/import-pilot.mjs';
import { closedApplicationFixture } from './fixtures/closed-application.mjs';
import { legacyClosedApplicationFixture } from './fixtures/legacy-closed-application.mjs';

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
const legacyApiUrl = moduleUrl('../src/features/imports/legacy-closed-application-api.ts', { '../../lib/api': errorUrl, './closed-assignment-api': planApiUrl, './closed-assignment-model': closedModelUrl });
const modelUrl = moduleUrl('../src/features/imports/closed-application-model.ts');
const model = await import(modelUrl);
const planApi = await import(planApiUrl);
const api = await import(moduleUrl('../src/features/imports/closed-application-api.ts', { '../../lib/api': errorUrl, './closed-assignment-api': planApiUrl, './closed-assignment-model': closedModelUrl, './closed-application-model': modelUrl, './history-evidence-api': historyApiUrl, './legacy-closed-application-api': legacyApiUrl }));

function detail(value) { return api.validateClosedApplication(value, assetId, { id: value.application.id }); }
function invalid(value) { assert.throws(() => detail(value), (error) => error.code === 'INVALID_RESPONSE'); }

test('rules1 detail retains the original snapshot, local dates, unknown source day and recorder without fabricating V12 provenance', () => {
  const value = legacyClosedApplicationFixture(); const original = globalThis.structuredClone(value);
  const result = detail(value);
  assert.equal(result, value.application); assert.deepEqual(value, original);
  assert.equal(result.rulesVersion, 'mda-closed-assignment-plan-1'); assert.equal(result.plan.planRulesVersion, result.rulesVersion);
  assert.equal(result.items[0].snapshot.start.confirmedAt, '2001-01-01T09:00:00-03:00');
  assert.equal(result.items[0].snapshot.sources[1].effectiveDay, null);
  for (const source of result.plan.periods[0].sources) {
    assert.equal(source.sourceRevision, 3);
    for (const key of ['evidenceVersion', 'amendmentId', 'capturedSourceRevision']) assert.equal(Object.hasOwn(source, key), false);
  }
  assert.equal(result.items[0].assignment.createdById, null); assert.equal(result.items[0].assignment.endedById, null);
  assert.notEqual(result.appliedAt, result.items[0].snapshot.proposedAssignment.endedAt);
});

test('legacy reads reject malformed or mixed contracts, incomplete plans and broken provenance/receipt bindings', () => {
  const mutations = [
    (s) => { s.rulesVersion = 'mda-closed-assignment-plan-2'; }, (s) => { s.plan.planRulesVersion = 'mda-closed-assignment-plan-2'; },
    (s) => { s.plan.planValidationComplete = false; }, (s) => { s.plan.affectsCurrentState = true; }, (s) => { s.plan.canApply = true; },
    (s) => { s.plan.assetBefore.id = receiptId; }, (s) => { s.plan.summary.warningCount = 0; }, (s) => { s.plan.currentAssignmentsDigest = 'bad'; },
    (s) => { s.plan.periods[0].sources[0].evidenceVersion = 0; }, (s) => { s.plan.periods[0].sources[0].amendmentId = null; },
    (s) => { s.plan.periods[0].sources[0].capturedSourceRevision = 3; }, (s) => { delete s.plan.periods[0].sources[0].sourceRevision; },
    (s) => { s.plan.periods[0].sources[0].endpoint = 'end'; }, (s) => { s.plan.periods[0].sources[0].captureId = 'bad'; },
    (s) => { s.plan.periods[0].sources[0].recordId = 'bad'; }, (s) => { s.plan.periods[0].sources[0].kind = 'RETIREMENT_OBSERVATION'; },
    (s) => { s.plan.periods[0].sources[0].fields = { usedDate: 123 }; }, (s) => { s.plan.periods[0].sources[1].datePrecision = 'DAY'; },
    (s) => { s.plan.periods[0].sources[0].effectiveDay = '2001-01-02'; }, (s) => { s.plan.periods[0].start.confirmedAt = '2001-01-01'; },
    (s) => { s.plan.periods[0].start.confirmedAt = '2001-02-30T09:00:00-03:00'; }, (s) => { s.plan.periods[0].end.dateEvidenceReference = null; },
    (s) => { s.plan.periods[0].recipient = null; }, (s) => { s.plan.periods[0].valid = false; },
    (s) => { s.plan.periods[0].blockers = [{ code: 'SOURCE_DAY_MISMATCH' }]; }, (s) => { s.plan.periods[0].acknowledgedWarnings = []; },
    (s) => { s.plan.periods[0].proposedAssignment.assignedById = s.appliedById; },
    (s) => { s.items[0].snapshot.note = 'Other'; }, (s) => { s.items[0].applicationId = receiptId; },
    (s) => { s.items[0].periodId = assetId; }, (s) => { s.items[0].startEvidenceId = receiptId; },
    (s) => { s.items[0].assignment.assetId = receiptId; }, (s) => { s.items[0].assignment.returnRecordedAt = s.items[0].assignment.endedAt; },
    (s) => { s.items[0].assignment.endedById = s.appliedById; }, (s) => { s.items[0].assignment.returnTicketReference = 'Other'; },
    (s) => { s.items = []; }, (s) => { s.plan.periods.push(s.plan.periods[0]); s.items.push(s.items[0]); }
  ];
  for (const mutate of mutations) {
    const value = legacyClosedApplicationFixture(); mutate(value.application); invalid(value);
  }
  const value = legacyClosedApplicationFixture();
  assert.throws(() => api.validateClosedApplication(value, receiptId), (error) => error.code === 'INVALID_RESPONSE');
  assert.throws(() => api.validateClosedApplication(value, assetId, { id: receiptId }), (error) => error.code === 'INVALID_RESPONSE');
});

test('malformed period data is rejected even when the item snapshot matches that same malformed plan', () => {
  for (const mutate of [
    (p) => { p.sources[0].evidenceVersion = 0; }, (p) => { p.sources[0].amendmentId = null; },
    (p) => { p.sources[0].capturedSourceRevision = 3; }, (p) => { delete p.sources[0].sourceRevision; },
    (p) => { p.sources[0].sourceRevision = -1; }, (p) => { p.sources[0].captureId = 'bad'; },
    (p) => { p.sources[1].endpoint = 'start'; }, (p) => { p.sources[0].recordId = 'bad'; },
    (p) => { p.sources[0].effectiveDay = '2001-01-02'; }, (p) => { p.sources[1].datePrecision = 'DAY'; },
    (p) => { p.sources[0].fields.usedDate = 123; }, (p) => { p.start.confirmedAt = '2001-01-01'; },
    (p) => { p.start.confirmedAt = '2001-02-30T09:00:00-03:00'; }, (p) => { p.end.dateEvidenceReference = null; },
    (p) => { p.recipient = null; }, (p) => { p.acknowledgedWarnings = []; },
    (p) => { p.blockers = [{ code: 'SOURCE_DAY_MISMATCH' }]; }, (p) => { p.valid = false; },
    (p) => { p.proposedAssignment.assignedById = assetId; }, (p) => { p.warnings[0].evidenceId = receiptId; }
  ]) {
    const value = legacyClosedApplicationFixture(); mutate(value.application.plan.periods[0]);
    value.application.items[0].snapshot = globalThis.structuredClone(value.application.plan.periods[0]); invalid(value);
  }
});

test('rules1 preserves original local source day across UTC rollover and accepts historical person/loan snapshots', () => {
  const value = legacyClosedApplicationFixture(); const period = value.application.plan.periods[0];
  period.start.confirmedAt = '2001-01-01T23:00:00-03:00'; period.proposedAssignment.startedAt = '2001-01-02T02:00:00.000Z';
  period.assignmentType = 'LOAN'; period.proposedAssignment.assignmentType = 'LOAN'; period.sources[0].kind = 'LOAN_OBSERVATION';
  period.recipient = { type: 'PERSON', name: 'Persona Histórica' };
  period.proposedAssignment.recipientType = 'PERSON'; period.proposedAssignment.personName = period.recipient.name; period.proposedAssignment.officeName = null;
  period.sources[0].fields = { recipientText: period.recipient.name, serialNumber: '000012', loanDate: '2001-01-01' };
  const item = value.application.items[0]; item.snapshot = globalThis.structuredClone(period);
  Object.assign(item.assignment, { startedAt: period.proposedAssignment.startedAt, assignmentType: 'LOAN', recipientType: 'PERSON', personName: period.recipient.name, officeName: null });
  const parsed = detail(value);
  assert.equal(parsed.plan.periods[0].start.confirmedAt, '2001-01-01T23:00:00-03:00');
  assert.equal(parsed.plan.periods[0].sources[0].effectiveDay, '2001-01-01');
  assert.equal(parsed.plan.periods[0].sources[0].fields.serialNumber, '000012');
});

test('rules1 never creates current intent/input, passes the current plan validator or satisfies a write/recovery response', () => {
  const legacy = legacyClosedApplicationFixture(); const current = closedApplicationFixture();
  assert.throws(() => model.createClosedApplicationIntent(legacy.application.plan, receiptId));
  assert.throws(() => model.closedInputFromPlan(legacy.application.plan));
  assert.throws(() => planApi.validateClosedPlan(legacy.application.plan, current.input, assetId), (error) => error.code === 'INVALID_RESPONSE');
  for (const reused of [false, true]) {
    const value = { ...legacy, reused };
    invalid(value);
    assert.throws(() => api.validateClosedApplication(value, assetId, { intent: current.intent, actorId: legacy.application.appliedById }), (error) => error.code === 'INVALID_RESPONSE');
  }
  assert.throws(() => api.validateClosedApplication(legacy, assetId, { intent: current.intent, actorId: legacy.application.appliedById }), (error) => error.code === 'INVALID_RESPONSE');
});

test('legacy multi-period receipts bind every original snapshot exactly once regardless of item order', () => {
  const value = legacyClosedApplicationFixture(); const saved = value.application;
  const period = globalThis.structuredClone(saved.plan.periods[0]);
  period.periodId = '00000000-0000-4000-8000-000000000071';
  period.start.evidenceId = '00000000-0000-4000-8000-000000000072'; period.end.evidenceId = '00000000-0000-4000-8000-000000000073';
  period.start.confirmedAt = '2003-01-01T09:00:00-03:00'; period.end.confirmedAt = '2004-01-01T10:00:00-03:00';
  period.proposedAssignment.startedAt = '2003-01-01T12:00:00.000Z'; period.proposedAssignment.endedAt = '2004-01-01T13:00:00.000Z';
  period.sources[0].evidenceId = period.start.evidenceId; period.sources[1].evidenceId = period.end.evidenceId;
  period.sources[0].recordId = '5'.repeat(64); period.sources[1].recordId = '6'.repeat(64);
  period.sources[0].effectiveDay = null; period.sources[0].datePrecision = 'UNKNOWN';
  period.warnings[0].evidenceId = period.start.evidenceId;
  const item = globalThis.structuredClone(saved.items[0]);
  item.id = '00000000-0000-4000-8000-000000000074'; item.assignmentId = '00000000-0000-4000-8000-000000000075';
  item.assignment.id = item.assignmentId; item.periodId = period.periodId;
  item.startEvidenceId = period.start.evidenceId; item.endEvidenceId = period.end.evidenceId; item.snapshot = globalThis.structuredClone(period);
  item.assignment.startedAt = period.proposedAssignment.startedAt; item.assignment.endedAt = period.proposedAssignment.endedAt;
  saved.plan.periods.push(period); saved.plan.summary = { periodCount: 2, validCount: 2, blockingCount: 0, warningCount: 2 }; saved.items.unshift(item);
  assert.equal(detail(value).items.length, 2);
  for (const mutate of [
    (s) => { s.items[1] = globalThis.structuredClone(s.items[0]); s.items[1].id = '00000000-0000-4000-8000-000000000076'; },
    (s) => { s.items[1].assignmentId = s.items[0].assignmentId; },
    (s) => { s.items[1].id = s.items[0].id; },
    (s) => { s.plan.periods[1].start.evidenceId = s.plan.periods[0].start.evidenceId; s.plan.periods[1].sources[0].evidenceId = s.plan.periods[0].start.evidenceId; }
  ]) { const changed = globalThis.structuredClone(value); mutate(changed.application); invalid(changed); }
});

test('legacy detail and metadata travel through GET only; legacy returned to save fails without publishing success', async () => {
  const value = legacyClosedApplicationFixture(); const current = closedApplicationFixture(); const calls = []; const old = globalThis.fetch;
  const metadata = Object.fromEntries(['id', 'assetId', 'requestId', 'planId', 'rulesVersion', 'appliedById', 'appliedAt'].map((key) => [key, value.application[key]]));
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? { csrfToken: 'fixture-token' } : url.includes('?') ? {
      scope: value.scope, affectsCurrentState: false, applications: [metadata], total: 1, limit: 25, offset: 0, hasMore: false
    } : value));
  };
  try {
    const signal = new globalThis.AbortController().signal;
    assert.equal((await api.readClosedApplications(assetId, 0, signal)).items[0].rulesVersion, metadata.rulesVersion);
    assert.deepEqual(await api.readClosedApplication(assetId, metadata.id, signal), value.application);
    assert.equal(calls.length, 2); assert.ok(calls.every((call) => call.method === undefined || call.method === 'GET'));
    await assert.rejects(api.saveClosedApplication(assetId, current.intent, metadata.appliedById), (error) => error.code === 'INVALID_RESPONSE');
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  } finally { globalThis.fetch = old; }
});
