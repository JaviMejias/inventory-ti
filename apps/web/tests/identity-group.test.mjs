import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { identityGroupBatch, identityGroupDraft, identityGroupFixture } from './fixtures/identity-group.mjs';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const errorUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};' });
const reviewApiUrl = moduleUrl('../src/features/imports/import-review-api.ts', { '../../lib/api': errorUrl });
const sourceModelUrl = moduleUrl('../src/features/imports/source-review-model.ts');
const sourceApiUrl = moduleUrl('../src/features/imports/source-review-api.ts', { '../../lib/api': errorUrl, './import-review-api': reviewApiUrl, './source-review-model': sourceModelUrl });
const historyModelUrl = moduleUrl('../src/features/imports/history-evidence-model.ts');
const historyApiUrl = moduleUrl('../src/features/imports/history-evidence-api.ts', { '../../lib/api': errorUrl, './import-review-api': reviewApiUrl, './history-evidence-model': historyModelUrl });
const closedModelUrl = moduleUrl('../src/features/imports/closed-assignment-model.ts');
const modelUrl = moduleUrl('../src/features/imports/identity-group-model.ts');
const model = await import(modelUrl);
const api = await import(moduleUrl('../src/features/imports/identity-group-api.ts', { '../../lib/api': errorUrl, './closed-assignment-model': closedModelUrl,
  './history-evidence-api': historyApiUrl, './import-review-api': reviewApiUrl, './source-review-api': sourceApiUrl, './identity-group-model': modelUrl }));

test('group proposals begin without candidates, inferred identities, rows, consent or an idempotency key', () => {
  const draft = model.emptyIdentityGroupsDraft(); assert.deepEqual(draft.candidateIds, []); assert.deepEqual(draft.assignments, {}); assert.deepEqual(draft.groups, []); assert.equal(draft.confirmed, false);
  const group = model.newIdentityGroup('00000000-0000-4000-8000-000000000101'); assert.equal(group.serial.mode, ''); assert.equal(group.tag.mode, '');
  assert.throws(() => model.identityGroupInput(identityGroupFixture().original, draft, 1, 0));
});
test('all pure-backend response fixtures bind the original input and stay unpersisted, including blocked ambiguity and cross-batch impacts', () => {
  for (const name of ['split', 'merge', 'identity', 'repartition', 'numeric', 'rich', 'unrealizable', 'coordinated']) {
    const f = identityGroupFixture(name); const result = api.validateIdentityGroupPlan(f.plan, f.source.batchId, f.input, f.original);
    assert.deepEqual(result, f.plan); assert.notEqual(result, f.plan); assert.equal(result.canApply, false); assert.equal(result.persisted, false); assert.equal(result.lineagePersistenceImplemented, false);
    assert.deepEqual(model.identityGroupInput(f.original, identityGroupDraft(f), 1, 0), model.normalizeIdentityGroupInput(f.input));
  }
});
test('scope uses complete original physical candidates and rejects external, partial, repeated and over25-row selections', () => {
  const f = identityGroupFixture(); const draft = identityGroupDraft(f);
  draft.assignments[f.original.records[0].id] = ''; assert.ok(model.validateIdentityGroupsDraft(f.original, draft).coverage);
  draft.assignments['f'.repeat(64)] = draft.groups[0].groupId; assert.ok(model.validateIdentityGroupsDraft(f.original, draft).coverage);
  assert.ok(model.validateIdentityGroupScope(f.original, [f.plan.proposedGroups[0].simulatedCandidateIds[0]]));
  assert.ok(model.validateIdentityGroupScope(f.original, [f.input.candidateIds[0], f.input.candidateIds[0]]));
  const original = globalThis.structuredClone(f.original); original.records = Array.from({ length: 26 }, (_, index) => ({ ...f.original.records[0], id: (index + 1).toString(16).padStart(64, '0'), row: index + 4 })); original.candidates[0].recordIds = original.records.map((row) => row.id);
  assert.match(model.validateIdentityGroupScope(original, [original.candidates[0].id]), /25 filas completas/);
  original.records[0].kind = 'CONSUMABLE_REVIEW'; assert.equal(model.physicalGroupCandidates(original).length, 0);
});
test('verified identity and absence require separate explicit choices; placeholders, empty groups and missing evidence cannot be sent', () => {
  const f = identityGroupFixture();
  for (const mutate of [(d) => { d.groups[0].serial.mode = ''; }, (d) => { d.groups[0].tag.mode = ''; }, (d) => { d.groups[0].serial.value = 'N/A'; },
    (d) => { d.groups[0].serial.mode = 'absent'; }, (d) => { d.groups[0].evidenceReference = ''; }, (d) => { d.note = ''; }, (d) => { d.confirmed = false; },
    (d) => { d.assignments[f.input.groups[0].recordIds[0]] = d.groups[1].groupId; }]) {
    const draft = identityGroupDraft(f); mutate(draft); assert.ok(Object.keys(model.validateIdentityGroupsDraft(f.original, draft)).length); assert.throws(() => model.identityGroupInput(f.original, draft, 1, 0));
  }
  const numeric = identityGroupFixture('numeric'); assert.equal(model.identityGroupInput(numeric.original, identityGroupDraft(numeric), 1, 0).groups[0].serialNumber, '000012');
  assert.equal(numeric.plan.observations[0].originalIdentityCells.serialNumber.rawValue, '0012'); assert.equal(numeric.plan.observations[0].originalIdentityCells.serialNumber.numberFormat, '000000');
});
test('strict detached request rejects response snapshots, invented metadata, duplicate membership and non-string identities', () => {
  const f = identityGroupFixture();
  const captured = api.captureIdentityGroupInput(f.input, f.original); f.input.note = 'Changed outside'; f.input.groups[0].recordIds.push('f'.repeat(64)); assert.notEqual(captured.note, f.input.note); assert.equal(captured.groups[0].recordIds.length, 1);
  for (const mutate of [(v) => { v.requestId = f.source.batchId; }, (v) => { v.force = true; }, (v) => { v.expectedSourceRevision = 1001; },
    (v) => { v.groups[0].serialNumber = 12; }, (v) => { v.groups[0].serialNumber = ''; }, (v) => { v.groups[0].recordIds.push(v.groups[1].recordIds[0]); },
    (v) => { v.groups[0].status = 'AVAILABLE'; }, (v) => { v.groups[0].evidenceReference = ' '; }, (v) => { v.groups[0].serialNumber = null; }]) {
    const fresh = identityGroupFixture(); mutate(fresh.input); assert.throws(() => api.captureIdentityGroupInput(fresh.input, fresh.original), { code: 'VALIDATION_ERROR' });
  }
  assert.throws(() => api.captureIdentityGroupInput(f.plan, f.original), { code: 'VALIDATION_ERROR' });
});
test('response guards reject crossed scope, false summaries, fabricated lineage, lost blockers and uncapped match counts', () => {
  const mutations = [
    (v) => { v.canApply = true; }, (v) => { v.persisted = true; }, (v) => { v.affectsCurrentState = true; }, (v) => { v.lineagePersistenceImplemented = true; },
    (v) => { v.batchId = '00000000-0000-4000-8000-000000000999'; }, (v) => { v.sourceHash = 'b'.repeat(64); }, (v) => { v.sourceRevision = 1; },
    (v) => { v.request.note = 'Different input'; }, (v) => { v.originalCandidates[0].recordIds.pop(); }, (v) => { v.observations[0].recordId = 'f'.repeat(64); },
    (v) => { v.observations[0].proposedGroupId = '00000000-0000-4000-8000-000000000999'; }, (v) => { v.proposedGroups[0].serialNumber = 'Not requested'; },
    (v) => { v.proposedGroups[0].candidates[0].outsideRecordCount = -1; }, (v) => { v.proposedGroups[0].candidates[0].existingAssetCount = 12; },
    (v) => { v.changes[0].afterCell.value = 'Different change'; }, (v) => { v.changes[0].beforeCell = null; }, (v) => { v.summary.observationCount = 0; },
    (v) => { v.blockers.push({ code: 'CONFLICT' }); }, (v) => { v.nextWorkflow = 'APPLY_NOW'; }
  ];
  for (const mutate of mutations) { const f = identityGroupFixture(); mutate(f.plan); assert.throws(() => api.validateIdentityGroupPlan(f.plan, f.source.batchId, f.input, f.original), { code: 'INVALID_RESPONSE' }); }
});
test('rich fixture preserves10 of12 matches, explicit null amendment links, cross-batch revisions and usage without private snapshots', () => {
  const f = identityGroupFixture('rich'); const result = api.validateIdentityGroupPlan(f.plan, f.source.batchId, f.input, f.original);
  const candidate = result.proposedGroups.flatMap((group) => group.candidates).find((row) => row.existingAssetCount === 12);
  assert.equal(candidate.existingAssets.length, 10); assert.equal(candidate.hasMoreExistingAssets, true);
  const evidence = result.impacts.evidence[0]; assert.notEqual(evidence.capturedAssetId, null); assert.equal(evidence.currentAssetId, null); assert.equal(evidence.sourceRevision, 9); assert.equal(result.sourceRevision, 0); assert.notEqual(evidence.captureBatchId, result.batchId);
  assert.ok(result.blockers.some((row) => row.code === 'SOURCE_OBSERVATION_ALREADY_APPLIED'));
  for (const mutate of [(v) => { v.impacts.evidence[0].plan = {}; }, (v) => { v.impacts.evidence[0].recordId = 'f'.repeat(64); },
    (v) => { v.impacts.evidence[0].assignmentUse.endpoint = 'RETURN'; }, (v) => { v.requiresEvidenceLineageReview = false; }, (v) => { v.warnings.push({ ...v.issues[0], severity: 'INFO' }); }]) {
    const fresh = identityGroupFixture('rich'); mutate(fresh.plan); assert.throws(() => api.validateIdentityGroupPlan(fresh.plan, fresh.source.batchId, fresh.input, fresh.original));
  }
});
test('explicit simulation uses only the dedicated CSRF POST, captures before token fetch and never writes or retries automatically', async () => {
  const originalFetch = globalThis.fetch; const f = identityGroupFixture(); const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); if (String(url).endsWith('/auth/csrf')) { f.input.note = 'Changed while fetching token'; return new globalThis.Response(JSON.stringify({ csrfToken: 'synthetic' })); } return new globalThis.Response(JSON.stringify(f.plan)); };
  try {
    await api.readIdentityGroupPlan(f.source.batchId, f.input, f.original, new globalThis.AbortController().signal);
    assert.equal(calls.length, 2); assert.match(calls[1].url, /identity-group-plan$/); assert.equal(calls[1].options.method, 'POST'); assert.equal(calls[0].options.signal, calls[1].options.signal);
    assert.equal(new globalThis.Headers(calls[1].options.headers).get('X-CSRF-Token'), 'synthetic'); assert.equal(JSON.parse(calls[1].options.body).note, f.plan.request.note);
    assert.equal('requestId' in JSON.parse(calls[1].options.body), false);
    const before = calls.length; await assert.rejects(api.readIdentityGroupPlan('bad', f.input, f.original, new globalThis.AbortController().signal), { code: 'VALIDATION_ERROR' }); assert.equal(calls.length, before);
  } finally { globalThis.fetch = originalFetch; }
});
test('reserved/error/cancellation are failures with Spanish recovery rather than empty or partial approval', async () => {
  const originalFetch = globalThis.fetch; const f = identityGroupFixture(); let calls = 0;
  globalThis.fetch = async (url) => { calls++; return new globalThis.Response(JSON.stringify(String(url).endsWith('/auth/csrf') ? { csrfToken: 'synthetic' } : { code: 'IDENTITY_GROUP_SOURCE_RESERVED', message: 'PRIVATE_INTERNAL_ERROR' }), { status: String(url).endsWith('/auth/csrf') ? 200 : 409 }); };
  try {
    let failure; try { await api.readIdentityGroupPlan(f.source.batchId, f.input, f.original, new globalThis.AbortController().signal); } catch (error) { failure = error; }
    assert.equal(failure.code, 'IDENTITY_GROUP_SOURCE_RESERVED'); assert.match(api.identityGroupErrorMessage(failure), /revisión de agrupaciones activa/); assert.doesNotMatch(api.identityGroupErrorMessage(failure), /PRIVATE_INTERNAL_ERROR/); assert.equal(calls, 2);
    globalThis.fetch = async (_url, options) => { options.signal.throwIfAborted(); throw new Error('network'); };
    const cancelled = new globalThis.AbortController(); cancelled.abort(); await assert.rejects(api.readIdentityGroupPlan(f.source.batchId, f.input, f.original, cancelled.signal), { name: 'AbortError' });
  } finally { globalThis.fetch = originalFetch; }
});
test('context reads bind current batch/source versions and immutable original preview without automatically simulating', async () => {
  const originalFetch = globalThis.fetch; const f = identityGroupFixture(); const calls = []; let version = 1;
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new globalThis.Response(JSON.stringify(String(url).endsWith('/resolved-preview') ? f.source : identityGroupBatch(f, version))); };
  try {
    const source = await api.readIdentityGroupContext(f.source.batchId, f.original, new globalThis.AbortController().signal); assert.deepEqual(source, f.source);
    assert.equal(calls.length, 2); assert.ok(calls.every((call) => !call.options.method));
    version = 2; await assert.rejects(api.readIdentityGroupContext(f.source.batchId, f.original, new globalThis.AbortController().signal), { code: 'INVALID_RESPONSE' });
    version = 1; const wrong = globalThis.structuredClone(f.original); wrong.source.sha256 = 'b'.repeat(64);
    await assert.rejects(api.readIdentityGroupContext(f.source.batchId, wrong, new globalThis.AbortController().signal), { code: 'INVALID_RESPONSE' });
  } finally { globalThis.fetch = originalFetch; }
});
