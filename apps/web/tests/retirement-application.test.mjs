import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { assetId, receiptId } from './fixtures/import-pilot.mjs';
import { retirementActorId, retirementApplicationFixture } from './fixtures/retirement-application.mjs';

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
const retirementModelUrl = moduleUrl('../src/features/imports/retirement-plan-model.ts', { './closed-assignment-model': closedModelUrl });
const planApiUrl = moduleUrl('../src/features/imports/retirement-plan-api.ts', { '../../lib/api': errorUrl, './closed-assignment-api': closedApiUrl, './closed-assignment-model': closedModelUrl, './history-evidence-api': historyApiUrl, './history-evidence-model': historyModelUrl });
const modelUrl = moduleUrl('../src/features/imports/retirement-application-model.ts', { '../../lib/api': errorUrl, './history-evidence-api': historyApiUrl, './retirement-plan-api': planApiUrl, './retirement-plan-model': retirementModelUrl });
const model = await import(modelUrl); const errors = await import(errorUrl);
const api = await import(moduleUrl('../src/features/imports/retirement-application-api.ts', { '../../lib/api': errorUrl, './closed-assignment-model': closedModelUrl, './history-evidence-api': historyApiUrl, './retirement-application-model': modelUrl, './retirement-plan-api': planApiUrl }));

test('intent contains exactly the V13 request, normalizes its UUID and freezes a detached body', () => {
  const f = retirementApplicationFixture(); const intent = model.createRetirementApplicationIntent(f.plan, receiptId.toUpperCase());
  assert.deepEqual(intent, f.intent); assert.deepEqual(Object.keys(intent), ['requestId', 'planId', 'confirmation', 'plan']);
  assert.deepEqual(model.retirementInputFromPlan(f.plan), f.input);
  f.plan.request.note = 'Changed'; f.plan.request.acknowledgedWarnings.push('e'.repeat(64));
  assert.equal(intent.plan.note, f.input.note); assert.equal(intent.plan.acknowledgedWarnings.length, 1);
  assert.throws(() => { intent.requestId = assetId; }, TypeError);
  assert.throws(() => { intent.plan.note = 'Changed'; }, TypeError);
  assert.throws(() => intent.plan.acknowledgedWarnings.push('e'.repeat(64)), TypeError);
  assert.equal(model.createRetirementApplicationIntent(retirementApplicationFixture().plan, 'ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456').requestId,
    'abcdef12-abcd-4abc-8abc-abcdef123456');
});

test('strict intent guard rejects response snapshots, extra fields, missing proof, invalid dates and warnings', () => {
  const f = retirementApplicationFixture();
  const mutations = [
    (v) => { v.force = true; }, (v) => { v.actorId = retirementActorId; }, (v) => { v.requestId = ''; }, (v) => { v.requestId = 'new-key'; },
    (v) => { v.planId = 'A'.repeat(64); }, (v) => { v.confirmation = 'VERIFIED_HISTORICAL_RETIREMENT'; },
    (v) => { v.plan = f.plan; }, (v) => { v.plan.status = 'DECOMMISSIONED'; }, (v) => { v.plan.historicalActorId = null; },
    (v) => { v.plan.confirmation = 'APPLY_VERIFIED_HISTORICAL_RETIREMENT'; }, (v) => { v.plan.evidenceId = 'bad'; },
    (v) => { v.plan.confirmedAt = null; }, (v) => { v.plan.confirmedAt = '2025-02-30T00:00:00Z'; },
    (v) => { v.plan.confirmedAt = '2025-01-02'; }, (v) => { v.plan.dateEvidenceReference = null; },
    (v) => { v.plan.dateEvidenceReference = ' '; }, (v) => { v.plan.note = ''; }, (v) => { v.plan.note = ' padded '; },
    (v) => { v.plan.note = 'x'.repeat(2001); }, (v) => { v.plan.evidenceReference = 'x'.repeat(501); },
    (v) => { v.plan.acknowledgedWarnings.push(v.plan.acknowledgedWarnings[0]); },
    (v) => { v.plan.acknowledgedWarnings = ['bad']; }, (v) => { delete v.plan.acknowledgedWarnings; }
  ];
  for (const mutate of mutations) {
    const value = globalThis.structuredClone(f.intent); mutate(value);
    assert.throws(() => model.validateRetirementApplicationIntent(value), { code: 'VALIDATION_ERROR' });
  }
  for (const value of [null, [], {}, f.plan]) assert.throws(() => model.validateRetirementApplicationIntent(value), { code: 'VALIDATION_ERROR' });
});

test('creating an intent requires the complete validated V13 plan and exact warning acknowledgements', () => {
  const f = retirementApplicationFixture();
  for (const mutate of [(v) => { v.planValidationComplete = false; }, (v) => { v.blockers.push({ code: 'BLOCKED' }); },
    (v) => { v.canApply = true; }, (v) => { v.persisted = true; }, (v) => { v.affectsCurrentState = true; },
    (v) => { v.request.acknowledgedWarnings = []; }, (v) => { v.proposedRetirement.historicalActorId = retirementActorId; },
    (v) => { v.proposedRetirement.assetId = receiptId; }]) {
    const plan = globalThis.structuredClone(f.plan); mutate(plan);
    assert.throws(() => model.createRetirementApplicationIntent(plan, receiptId));
  }
});

test('new and recovered receipts preserve backend result, evidence versions and unknown historical actor', () => {
  const f = retirementApplicationFixture();
  for (const reused of [false, true]) {
    const raw = f.receiptFor(reused); const saved = api.validateRetirementApplication(raw, assetId, { intent: f.intent, actorId: retirementActorId });
    assert.deepEqual(saved, raw.application); assert.equal(saved.plan.proposedRetirement.historicalActorId, null);
    assert.equal(saved.result.updatedAt, saved.appliedAt); assert.notEqual(saved.decommissionedAt, saved.appliedAt);
    raw.application.result.serialNumber = 'Changed'; assert.notEqual(saved.result.serialNumber, 'Changed');
    assert.throws(() => { saved.result.serialNumber = 'Changed'; }, TypeError);
    assert.throws(() => { saved.plan.source.fields.serialNumber = 'Changed'; }, TypeError);
  }
  const detail = f.receiptFor(); delete detail.reused;
  assert.equal(api.validateRetirementApplication(detail, assetId, { id: detail.application.id }).id, detail.application.id);
  const amended = globalThis.structuredClone(f.plan); amended.source.evidenceVersion = 1;
  amended.source.amendmentId = receiptId; amended.source.sourceRevision += 1;
  assert.equal(api.validateRetirementApplication(f.receiptFor(true, amended), assetId).evidenceVersion, 1);
  const anonymousIdentity = globalThis.structuredClone(f.plan); anonymousIdentity.assetBefore.serialNumber = null; anonymousIdentity.assetBefore.assetTag = null;
  assert.equal(api.validateRetirementApplication(f.receiptFor(false, anonymousIdentity), assetId).result.serialNumber, null);
});

test('malformed receipts cannot confirm a crossed actor, request, asset, plan, evidence or terminal result', () => {
  const f = retirementApplicationFixture();
  const mutations = [
    (v) => { v.scope = 'HISTORICAL_RETIREMENT_PLAN'; }, (v) => { v.mode = 'PLAN'; }, (v) => { v.persisted = false; },
    (v) => { v.affectsCurrentState = false; }, (v) => { delete v.reused; }, (v) => { v.reused = 1; },
    (v) => { v.application.assetId = receiptId; }, (v) => { v.application.requestId = assetId; },
    (v) => { v.application.appliedById = assetId; }, (v) => { v.application.appliedById = null; },
    (v) => { v.application.planId = 'f'.repeat(64); }, (v) => { v.application.requestDigest = 'bad'; },
    (v) => { v.application.rulesVersion = 'mda-retirement-plan-2'; }, (v) => { v.application.evidenceId = receiptId; },
    (v) => { v.application.evidenceVersion = 1; v.application.amendmentId = receiptId; },
    (v) => { v.application.sourceRevision += 1; }, (v) => { v.application.amendmentId = receiptId; },
    (v) => { v.application.decommissionedAt = v.application.appliedAt; }, (v) => { v.application.appliedAt = 'invalid'; },
    (v) => { v.application.plan.request.note = 'Other'; }, (v) => { v.application.plan.proposedRetirement.historicalActorId = retirementActorId; },
    (v) => { v.application.plan.blockers.push({ code: 'BLOCKED' }); }, (v) => { v.application.plan.persisted = true; },
    (v) => { v.application.result.id = receiptId; }, (v) => { v.application.result.productId = receiptId; },
    (v) => { v.application.result.serialNumber = 'Other'; }, (v) => { v.application.result.assetTag = 'Other'; },
    (v) => { v.application.result.status = 'AVAILABLE'; }, (v) => { v.application.result.isActive = true; },
    (v) => { v.application.result.decommissionedAt = null; }, (v) => { v.application.result.updatedAt = v.application.decommissionedAt; },
    (v) => { v.application.result.actorId = retirementActorId; }, (v) => { delete v.application.result; }
  ];
  for (const mutate of mutations) {
    const value = f.receiptFor(); mutate(value);
    assert.throws(() => api.validateRetirementApplication(value, assetId, { intent: f.intent, actorId: retirementActorId }), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => api.validateRetirementApplication(f.receipt, assetId, { intent: f.intent }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => api.validateRetirementApplication(f.receipt, assetId, { id: receiptId }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => api.validateRetirementApplication(f.receipt, receiptId), { code: 'INVALID_RESPONSE' });
});

test('read list and detail use only parent-scoped GET with limit 25 and immutable metadata', async () => {
  const f = retirementApplicationFixture(); const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); options.signal.throwIfAborted();
    return new globalThis.Response(JSON.stringify(url.includes('?') ? f.pageFor(Number(new URL(url).searchParams.get('offset'))) : f.receipt));
  };
  try {
    const signal = new globalThis.AbortController().signal;
    const page = await api.readRetirementApplications(assetId, 0, signal);
    assert.deepEqual(page, { items: [f.metadata], total: 1, limit: 25, offset: 0, hasMore: false });
    assert.throws(() => page.items.push(f.metadata), TypeError);
    assert.equal((await api.readRetirementApplications(assetId, 25, signal)).items.length, 0);
    assert.equal((await api.readRetirementApplication(assetId, f.metadata.id, signal)).id, f.metadata.id);
    assert.deepEqual(calls.map((call) => call.url), [
      `https://fixture.invalid/assets/${assetId}/imported-retirement-applications?limit=25&offset=0`,
      `https://fixture.invalid/assets/${assetId}/imported-retirement-applications?limit=25&offset=25`,
      `https://fixture.invalid/assets/${assetId}/imported-retirement-applications/${f.metadata.id}`
    ]);
    assert.ok(calls.every((call) => !call.options.method && call.options.body === undefined));
  } finally { globalThis.fetch = original; }
});

test('invalid pagination, private snapshots, cross-parent metadata and failed reads fail closed', async () => {
  const f = retirementApplicationFixture(); const original = globalThis.fetch; let calls = 0;
  const signal = new globalThis.AbortController().signal;
  globalThis.fetch = async () => { calls += 1; throw new Error('must not fetch'); };
  try {
    for (const offset of [-1, 0.5, NaN, Infinity, 2147483648]) await assert.rejects(api.readRetirementApplications(assetId, offset, signal), { code: 'VALIDATION_ERROR' });
    await assert.rejects(api.readRetirementApplication('bad', f.metadata.id, signal), { code: 'VALIDATION_ERROR' });
    await assert.rejects(api.readRetirementApplication(assetId, '../other', signal), { code: 'VALIDATION_ERROR' });
    assert.equal(calls, 0);
    for (const mutate of [(v) => { v.total = 0; }, (v) => { v.offset = 25; }, (v) => { v.limit = 100; }, (v) => { v.hasMore = true; },
      (v) => { v.affectsCurrentState = false; }, (v) => { v.applications[0].assetId = receiptId; },
      (v) => { v.applications[0].plan = f.plan; }, (v) => { v.applications[0].result = f.receipt.application.result; },
      (v) => { v.applications.push(v.applications[0]); v.total = 2; }, (v) => { delete v.applications; }]) {
      const page = f.pageFor(); mutate(page);
      globalThis.fetch = async () => new globalThis.Response(JSON.stringify(page));
      await assert.rejects(api.readRetirementApplications(assetId, 0, signal), { code: 'INVALID_RESPONSE' });
    }
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ ...f.pageFor(), applications: [], total: 0 }));
    assert.equal((await api.readRetirementApplications(assetId, 0, signal)).items.length, 0);
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify(f.pageFor(2147483647)));
    assert.equal((await api.readRetirementApplications(assetId, 2147483647, signal)).offset, 2147483647);
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify(f.receipt));
    await assert.rejects(api.readRetirementApplication(receiptId, f.metadata.id, signal), { code: 'INVALID_RESPONSE' });
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ code: 'NOT_FOUND', message: 'PRIVATE' }), { status: 404 });
    await assert.rejects(api.readRetirementApplication(assetId, f.metadata.id, signal), { code: 'NOT_FOUND' });
  } finally { globalThis.fetch = original; }
});

test('explicit apply captures body before CSRF, retries identical UUID/body, and bounds all calls at 30 seconds', async () => {
  const f = retirementApplicationFixture(); const original = globalThis.fetch; const oldTimeout = globalThis.AbortSignal.timeout;
  const calls = []; const deadlines = [];
  globalThis.AbortSignal.timeout = (duration) => { deadlines.push(duration); return oldTimeout(duration); };
  const intent = globalThis.structuredClone(f.intent);
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/csrf')) { intent.plan.note = 'Changed during CSRF'; return new globalThis.Response(JSON.stringify({ csrfToken: 'fixture-token' })); }
    return new globalThis.Response(JSON.stringify(f.receiptFor(calls.length > 2)));
  };
  try {
    await api.saveRetirementApplication(assetId, intent, retirementActorId);
    await api.saveRetirementApplication(assetId, f.intent, retirementActorId);
    assert.equal(calls.length, 4); assert.deepEqual(deadlines, [30000, 30000]);
    assert.equal(calls[1].options.body, JSON.stringify(f.intent)); assert.equal(calls[1].options.body, calls[3].options.body);
    assert.equal(calls[0].options.signal, calls[1].options.signal);
    assert.equal(calls[1].options.headers.get('X-CSRF-Token'), 'fixture-token');
    assert.ok(calls.filter((call) => call.options.method === 'POST').every((call) => call.url === `https://fixture.invalid/assets/${assetId}/imported-retirement-plan/apply`));
    assert.ok(calls.every((call) => call.options.credentials === 'include'));
    const prior = calls.length;
    await assert.rejects(api.saveRetirementApplication(assetId, { ...f.intent, force: true }, retirementActorId), { code: 'VALIDATION_ERROR' });
    await assert.rejects(api.saveRetirementApplication(assetId, f.intent, 'bad'), { code: 'VALIDATION_ERROR' });
    assert.equal(calls.length, prior);
  } finally { globalThis.fetch = original; globalThis.AbortSignal.timeout = oldTimeout; }
});

test('read cancellation and timeout remain errors; a lost write never retries automatically', async () => {
  const f = retirementApplicationFixture(); const original = globalThis.fetch; const oldTimeout = globalThis.AbortSignal.timeout; const deadlines = [];
  globalThis.AbortSignal.timeout = (duration) => { deadlines.push(duration); return oldTimeout(duration); };
  let calls = 0;
  globalThis.fetch = async (url, options) => { calls += 1; options.signal.throwIfAborted(); throw new Error('offline'); };
  try {
    const controller = new globalThis.AbortController(); controller.abort();
    await assert.rejects(api.readRetirementApplications(assetId, 0, controller.signal), { name: 'AbortError' });
    await assert.rejects(api.readRetirementApplication(assetId, f.metadata.id, controller.signal), { name: 'AbortError' });
    assert.deepEqual(deadlines, [30000, 30000]);
    globalThis.fetch = async (url) => { calls += 1; if (url.endsWith('/auth/csrf')) return new globalThis.Response('{"csrfToken":"fixture-token"}'); throw new Error('lost response'); };
    const before = calls;
    await assert.rejects(api.saveRetirementApplication(assetId, f.intent, retirementActorId), (error) => error.code === 'NETWORK_ERROR' && api.retirementApplicationNeedsRecovery(error));
    assert.equal(calls - before, 2);
    const timedOut = new globalThis.AbortController(); timedOut.abort(new globalThis.DOMException('Timed out', 'TimeoutError'));
    globalThis.AbortSignal.timeout = () => timedOut.signal;
    globalThis.fetch = async (url, options) => { options.signal.throwIfAborted(); };
    await assert.rejects(api.saveRetirementApplication(assetId, f.intent, retirementActorId), (error) => error.name === 'TimeoutError' && api.retirementApplicationNeedsRecovery(error));
  } finally { globalThis.fetch = original; globalThis.AbortSignal.timeout = oldTimeout; }
});

test('recovery and Spanish errors distinguish uncertain outcomes from stale or blocked plans without private details', () => {
  for (const error of [new Error('PRIVATE'), new errors.ApiRequestError('PRIVATE', 503),
    ...['NETWORK_ERROR', 'INVALID_RESPONSE', 'RETIREMENT_APPLICATION_BUSY', 'RETIREMENT_APPLICATION_CONFLICT', 'RETIREMENT_ALREADY_APPLIED'].map((code) => new errors.ApiRequestError('PRIVATE', 409, code))]) {
    assert.equal(api.retirementApplicationNeedsRecovery(error), true);
    assert.doesNotMatch(api.getRetirementApplicationErrorMessage(error), /PRIVATE/);
  }
  for (const code of ['RETIREMENT_PLAN_CHANGED', 'RETIREMENT_PLAN_BLOCKED', 'IDEMPOTENCY_KEY_REUSED', 'VALIDATION_ERROR', 'FORBIDDEN',
    'CSRF_INVALID', 'UNAUTHENTICATED', 'NOT_FOUND', 'HISTORICAL_PLAN_LIMIT', 'INVALID_HISTORICAL_EVIDENCE', 'INVALID_SOURCE_REVISION', 'UNKNOWN']) {
    const error = new errors.ApiRequestError('PRIVATE', 409, code, { private: 'PRIVATE' });
    assert.equal(api.retirementApplicationNeedsRecovery(error), false);
    assert.doesNotMatch(api.getRetirementApplicationErrorMessage(error), /PRIVATE|undefined/);
    assert.ok(api.getRetirementApplicationErrorMessage(error).length > 20);
  }
});
