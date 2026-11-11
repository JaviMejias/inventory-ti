import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { assetId, receiptId } from './fixtures/import-pilot.mjs';
import { retirementFixture } from './fixtures/retirement-plan.mjs';

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
const modelUrl = moduleUrl('../src/features/imports/retirement-plan-model.ts', { './closed-assignment-model': closedModelUrl });
const model = await import(modelUrl);
const api = await import(moduleUrl('../src/features/imports/retirement-plan-api.ts', { '../../lib/api': errorUrl, './closed-assignment-api': closedApiUrl, './closed-assignment-model': closedModelUrl, './history-evidence-api': historyApiUrl, './history-evidence-model': historyModelUrl }));
const historyApi = await import(historyApiUrl);

test('retirement starts empty and requires deliberate evidence/reason/reference/review, not a guessed date', () => {
  const draft = model.emptyRetirementDraft();
  assert.equal(draft.confirmedAt, ''); assert.equal(draft.dateEvidenceReference, ''); assert.deepEqual(draft.acknowledgedWarnings, []);
  assert.deepEqual(Object.keys(model.validateRetirementDraft(draft)), ['evidenceId', 'note', 'reference', 'confirmed']);
  assert.throws(() => model.retirementPlanInput(draft));
});
test('exact retirement instants preserve entered day/offset and reject invalid dates, pre1900, missing seconds/zone and precision', () => {
  const draft = retirementFixture().draftFor();
  for (const value of ['2025-02-29T12:00:00Z', '2025-01-02', '2025-01-02T12:00-03:00', '2025-01-02T24:00:00Z', '1899-01-01T12:00:00Z', '2025-01-02T12:00:00.1234Z', '2025-01-02T12:00:00+24:00']) {
    draft.confirmedAt = value; assert.ok(model.validateRetirementDraft(draft).confirmedAt, value);
  }
  draft.confirmedAt = '2024-02-29T23:30:00-03:00'; assert.equal(model.validateRetirementDraft(draft).confirmedAt, undefined);
  assert.equal(model.retirementPlanInput(draft).confirmedAt, draft.confirmedAt);
});
test('nullable facts remain null and request has only V13 fields; acknowledgements clone, limits and identities validated', () => {
  const f = retirementFixture(); const draft = f.draftFor(); draft.confirmedAt = ' '; draft.dateEvidenceReference = ' '; draft.note = '  Motivo  ';
  const input = model.retirementPlanInput(draft); assert.equal(input.confirmedAt, null); assert.equal(input.dateEvidenceReference, null); assert.equal(input.note, 'Motivo');
  assert.deepEqual(Object.keys(input), ['evidenceId', 'confirmation', 'confirmedAt', 'dateEvidenceReference', 'note', 'evidenceReference', 'acknowledgedWarnings']);
  draft.acknowledgedWarnings.push(f.warning.id); assert.deepEqual(input.acknowledgedWarnings, []);
  draft.acknowledgedWarnings.push(f.warning.id); assert.ok(model.validateRetirementDraft(draft).acknowledgedWarnings);
  draft.evidenceId = 'candidate-hash'; assert.ok(model.validateRetirementDraft(draft).evidenceId);
  draft.reference = 'x'.repeat(501); assert.ok(model.validateRetirementDraft(draft).reference);
  draft.note = 'x'.repeat(2001); assert.ok(model.validateRetirementDraft(draft).note);
});
test('blocked and complete plans remain unpersisted; captured date unknown and reception distinct from confirmed retirement', () => {
  const f = retirementFixture(); const draft = f.draftFor(); draft.confirmedAt = ''; draft.dateEvidenceReference = '';
  let input = model.retirementPlanInput(draft); let plan = api.validateRetirementPlan(f.planFor(input), input, assetId);
  assert.equal(plan.proposedRetirement.decommissionedAt, null); assert.equal(plan.source.effectiveDay, null); assert.equal(plan.source.sourceReceivedDay, '2024-12-01');
  assert.equal(plan.planValidationComplete, false); assert.equal(plan.warnings[0].issue.severity, 'WARNING');
  input = model.retirementPlanInput({ ...f.draftFor(), acknowledgedWarnings: [f.warning.id] }); plan = api.validateRetirementPlan(f.planFor(input), input, assetId);
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.canApply, false); assert.equal(plan.persisted, false); assert.equal(plan.affectsCurrentState, false);
  assert.equal(plan.proposedRetirement.historicalActorId, null); assert.equal(plan.proposedRetirement.decommissionedAt, '2025-01-02T13:30:00.000Z');
});
test('reject wrong scope/owner/intent, invented source date/actor, altered proposal/versions/counts/warnings and false completeness', () => {
  const f = retirementFixture(); const input = model.retirementPlanInput(f.draftFor());
  const mutations = [(v) => { v.canApply = true; }, (v) => { v.persisted = true; }, (v) => { v.affectsCurrentState = true; }, (v) => { v.scope = 'VERIFIED_HISTORICAL_RETIREMENT'; },
    (v) => { v.planRulesVersion = 'old'; }, (v) => { v.assetBefore.id = receiptId; }, (v) => { v.assetBefore.product.id = receiptId; }, (v) => { v.request.note = 'another'; },
    (v) => { v.request.confirmedAt = '2025-01-02T10:30:00Z'; }, (v) => { v.source.evidenceId = receiptId; }, (v) => { v.source.kind = 'RECEIPT_OBSERVATION'; },
    (v) => { v.source.effectiveDay = '2025-01-02'; }, (v) => { v.source.sourceReceivedDay = '2025-02-30'; }, (v) => { v.source.datePrecision = 'DAY'; },
    (v) => { v.source.evidenceVersion = -1; }, (v) => { v.source.evidenceVersion = 1; v.source.amendmentId = null; }, (v) => { v.source.sourceRevision = -1; },
    (v) => { v.source.fields.receivedDate = {}; }, (v) => { v.proposedRetirement.historicalActorId = assetId; }, (v) => { v.proposedRetirement.assetId = receiptId; },
    (v) => { v.proposedRetirement.decommissionedAt = '2025-01-02T00:00:00Z'; }, (v) => { v.proposedRetirement.isActive = true; }, (v) => { v.summary.validCount = 1; },
    (v) => { v.warnings[0].evidenceId = receiptId; }, (v) => { v.warnings[0].issue.severity = 'BLOCKING'; }, (v) => { v.warnings.push(v.warnings[0]); },
    (v) => { v.planValidationComplete = true; }, (v) => { v.summary.blockingCount = 0; }, (v) => { v.blockers = []; v.summary.blockingCount = 0; v.summary.validCount = 1; v.planValidationComplete = true; }];
  for (const mutate of mutations) { const value = f.planFor(input); mutate(value); assert.throws(() => api.validateRetirementPlan(value, input, assetId), { code: 'INVALID_RESPONSE' }); }
});
test('retirement uses CSRF protected explicit read POST, never /apply or /decommission, is cancelable and returns failed reads as errors', async () => {
  const f = retirementFixture(); const input = model.retirementPlanInput(f.draftFor()); const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); options.signal.throwIfAborted(); return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? { csrfToken: 'qa' } : f.planFor(input))); };
  try {
    const plan = await api.readRetirementPlan(assetId, input, new globalThis.AbortController().signal); assert.equal(plan.persisted, false);
    assert.equal(calls.length, 2); assert.equal(calls[1].url, 'https://fixture.invalid/assets/' + assetId + '/imported-retirement-plan');
    assert.equal(calls[1].options.method, 'POST'); assert.equal(calls[1].options.body, JSON.stringify(input)); assert.equal(new globalThis.Headers(calls[1].options.headers).get('X-CSRF-Token'), 'qa');
    const controller = new globalThis.AbortController(); controller.abort(); await assert.rejects(api.readRetirementPlan(assetId, input, controller.signal), { name: 'AbortError' });
    globalThis.fetch = async (url) => new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? { csrfToken: 'qa' } : { code: 'HISTORICAL_PLAN_LIMIT', message: 'private' }), { status: url.endsWith('/auth/csrf') ? 200 : 409 });
    await assert.rejects(api.readRetirementPlan(assetId, input, new globalThis.AbortController().signal), { code: 'HISTORICAL_PLAN_LIMIT' });
  } finally { globalThis.fetch = old; }
});
test('evidence server pages validate 25/2; retirement choices may span pages but are never inferred from another kind', async () => {
  const f = retirementFixture(); const old = globalThis.fetch;
  globalThis.fetch = async (url) => new globalThis.Response(JSON.stringify(f.documents.pageFor(Number(new URL(url).searchParams.get('offset')))));
  try {
    const first = await historyApi.readAssetImportedEvidence(assetId, 0, new globalThis.AbortController().signal);
    const second = await historyApi.readAssetImportedEvidence(assetId, 25, new globalThis.AbortController().signal);
    assert.equal(first.evidence.length, 25); assert.equal(second.evidence.length, 2); assert.equal(second.hasMore, false);
    assert.ok(first.evidence.some((row) => row.id === f.evidence.id)); assert.ok(second.evidence.some((row) => row.id === f.second.id));
  } finally { globalThis.fetch = old; }
});
