import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { retirementReconciliationFixture } from './fixtures/retirement-reconciliation.mjs';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const errorUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};' });
const historyModelUrl = moduleUrl('../src/features/imports/history-evidence-model.ts');
const historyApiUrl = moduleUrl('../src/features/imports/history-evidence-api.ts', { '../../lib/api': errorUrl, './import-review-api': 'data:text/javascript,export const importReviewPath="/inventory/imports/batches";', './history-evidence-model': historyModelUrl });
const closedModelUrl = moduleUrl('../src/features/imports/closed-assignment-model.ts');
const closedApiUrl = moduleUrl('../src/features/imports/closed-assignment-api.ts', { '../../lib/api': errorUrl, './history-evidence-api': historyApiUrl, './history-evidence-model': historyModelUrl, './closed-assignment-model': closedModelUrl });
const planApiUrl = moduleUrl('../src/features/imports/retirement-plan-api.ts', { '../../lib/api': errorUrl, './closed-assignment-api': closedApiUrl, './closed-assignment-model': closedModelUrl, './history-evidence-api': historyApiUrl, './history-evidence-model': historyModelUrl });
const modelUrl = moduleUrl('../src/features/imports/retirement-reconciliation-model.ts');
const model = await import(modelUrl);
const api = await import(moduleUrl('../src/features/imports/retirement-reconciliation-api.ts', { '../../lib/api': errorUrl, './closed-assignment-api': closedApiUrl, './closed-assignment-model': closedModelUrl, './history-evidence-api': historyApiUrl, './retirement-plan-api': planApiUrl, './retirement-reconciliation-model': modelUrl }));

test('all V15 classifications stay read-only and preserve separate current, source and receipt contexts', () => {
  const f = retirementReconciliationFixture();
  for (const kind of Object.keys(model.retirementClassificationLabels)) {
    const source = f.assessmentFor(kind); const result = api.validateRetirementReconciliation(source, f.assetId, f.evidenceId);
    assert.deepEqual(result, source); assert.notEqual(result, source); assert.equal(result.canApply, false); assert.equal(result.affectsCurrentState, false);
    assert.deepEqual(result.sourceRetirement, { effectiveAt: null, datePrecision: 'UNKNOWN', historicalActorId: null });
    assert.notEqual(result.source.sourceReceivedDay, result.sourceRetirement.effectiveAt);
  }
});
test('reject effect flags, forged plans, crossed evidence/owner, invalid provenance and foreign executable links', () => {
  const f = retirementReconciliationFixture();
  const changes = [
    (v) => { v.canApply = true; }, (v) => { v.persisted = true; }, (v) => { v.affectsCurrentState = true; }, (v) => { v.operationalResolutionImplemented = true; },
    (v) => { v.planId = 'a'.repeat(64); }, (v) => { v.proposedRetirement = {}; }, (v) => { v.requestId = f.assetId; },
    (v) => { v.classification = 'READY_TO_APPLY'; }, (v) => { v.scope = 'HISTORICAL_RETIREMENT_PLAN'; },
    (v) => { v.assetBefore.id = f.evidenceId; }, (v) => { v.assetBefore.product.id = f.assetId; },
    (v) => { v.source.evidenceId = f.assetId; }, (v) => { v.source.evidenceVersion = 1; }, (v) => { v.source.sourceRevision = -1; },
    (v) => { v.sourceRetirement.effectiveAt = '2025-01-02T13:30:00.000Z'; }, (v) => { v.sourceRetirement.historicalActorId = f.metadata.appliedById; },
    (v) => { v.links.verifiedPlan = 'https://untrusted.invalid/execute'; }, (v) => { v.links.existingApplication = '/assets/' + f.assetId; },
    (v) => { v.diagnostics.push({ code: 'WARNINGS_NOT_ACKNOWLEDGED' }); }, (v) => { v.warnings[0].evidenceId = f.assetId; },
    (v) => { v.warnings[0].issue.severity = 'INFO'; }, (v) => { v.warnings.push(v.warnings[0]); }, (v) => { v.nextSteps.push(v.nextSteps[0]); }
  ];
  for (const change of changes) { const value = f.assessmentFor(); change(value); assert.throws(() => api.validateRetirementReconciliation(value, f.assetId, f.evidenceId), { code: 'INVALID_RESPONSE' }); }
});
test('earlier than1900 and future recorded dates remain visible as inconsistent facts without relaxing V13 dates', () => {
  const f = retirementReconciliationFixture();
  for (const date of ['1800-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
    const value = f.assessmentFor('EXISTING_DATED_RETIREMENT'); value.classification = 'CURRENT_STATE_REVIEW_REQUIRED'; value.currentState = 'INCONSISTENT';
    value.assetBefore.decommissionedAt = date; value.existingRetirement.effectiveAt = date; value.diagnostics.push({ code: 'CURRENT_RETIREMENT_DATE_UNCONFIRMED' });
    const result = api.validateRetirementReconciliation(value, f.assetId, f.evidenceId); assert.equal(result.existingRetirement.effectiveAt, date); assert.equal(result.existingRetirement.confirmsSourceDate, false);
  }
  const bad = f.assessmentFor(); bad.assetBefore.decommissionedAt = 'not-a-date';
  assert.throws(() => api.validateRetirementReconciliation(bad, f.assetId, f.evidenceId));
});
test('a non-retirement observation stays its original kind and cannot gain a fictitious retirement date', () => {
  const f = retirementReconciliationFixture(); const value = f.assessmentFor('EVIDENCE_REVIEW_REQUIRED');
  value.source.kind = 'RECEIPT_OBSERVATION'; value.source.effectiveDay = '2024-12-01'; value.source.datePrecision = 'DAY'; value.sourceRetirement = null;
  value.diagnostics.push({ code: 'RETIREMENT_EVIDENCE_KIND_REQUIRED' });
  const result = api.validateRetirementReconciliation(value, f.assetId, f.evidenceId); assert.equal(result.source.kind, 'RECEIPT_OBSERVATION'); assert.equal(result.sourceRetirement, null);
  value.sourceRetirement = { effectiveAt: null, datePrecision: 'UNKNOWN', historicalActorId: null };
  assert.throws(() => api.validateRetirementReconciliation(value, f.assetId, f.evidenceId));
});
test('metadata never exposes private snapshots or turns another asset consumption into the selected asset receipt', () => {
  const f = retirementReconciliationFixture(); const used = f.assessmentFor('EVIDENCE_ALREADY_USED');
  assert.notEqual(api.validateRetirementReconciliation(used, f.assetId, f.evidenceId).evidenceApplication.assetId, f.assetId);
  assert.equal(used.existingApplication, null); assert.equal(used.links.existingApplication, null);
  for (const change of [(v) => { v.existingApplication.assetId = f.evidenceId; }, (v) => { v.evidenceApplication.evidenceId = f.assetId; },
    (v) => { v.existingApplication.plan = {}; }, (v) => { v.existingApplication.appliedById = 'Juan Pérez'; },
    (v) => { v.existingApplication.evidenceVersion = 2; }, (v) => { v.evidenceApplication.appliedAt = '2025-01-01T00:00:00Z'; }]) {
    const value = f.assessmentFor('ALREADY_IMPORTED_RETIREMENT'); change(value); assert.throws(() => api.validateRetirementReconciliation(value, f.assetId, f.evidenceId));
  }
});
test('explicit reconciliation POST sends only evidenceId with CSRF and one deadline; it never requests apply, edits or receipts', async () => {
  const original = globalThis.fetch; const calls = []; const f = retirementReconciliationFixture();
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new globalThis.Response(JSON.stringify(String(url).endsWith('/auth/csrf') ? { csrfToken: 'synthetic' } : f.assessmentFor()), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    await api.readRetirementReconciliation(f.assetId, f.evidenceId, new globalThis.AbortController().signal);
    assert.equal(calls.length, 2); assert.equal(calls[1].options.method, 'POST'); assert.deepEqual(JSON.parse(calls[1].options.body), { evidenceId: f.evidenceId });
    assert.match(calls[1].url, /imported-retirement-reconciliation$/); assert.equal(new globalThis.Headers(calls[1].options.headers).get('X-CSRF-Token'), 'synthetic');
    assert.equal(calls[0].options.signal, calls[1].options.signal);
    await assert.rejects(api.readRetirementReconciliation('bad-id', f.evidenceId, new globalThis.AbortController().signal), { code: 'VALIDATION_ERROR' }); assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});
test('failed or cancelled reconciliation cannot become empty success or issue an automatic retry', async () => {
  const original = globalThis.fetch; const f = retirementReconciliationFixture(); let calls = 0;
  globalThis.fetch = async (url) => { calls++; return new globalThis.Response(JSON.stringify(String(url).endsWith('/auth/csrf') ? { csrfToken: 'synthetic' } : { code: 'IMPORT_REVIEW_NOT_READY', message: 'PRIVATE_INTERNAL_ERROR' }), { status: String(url).endsWith('/auth/csrf') ? 200 : 503, headers: { 'Content-Type': 'application/json' } }); };
  try {
    await assert.rejects(api.readRetirementReconciliation(f.assetId, f.evidenceId, new globalThis.AbortController().signal), { code: 'IMPORT_REVIEW_NOT_READY' }); assert.equal(calls, 2);
    globalThis.fetch = async (_url, options) => { options.signal.throwIfAborted(); throw new Error('network'); };
    const cancelled = new globalThis.AbortController(); cancelled.abort();
    await assert.rejects(api.readRetirementReconciliation(f.assetId, f.evidenceId, cancelled.signal), { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
