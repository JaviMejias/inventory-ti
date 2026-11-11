import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { amendmentActorId, amendmentFixture } from './fixtures/evidence-amendment.mjs';
import { assetId, receiptId } from './fixtures/import-pilot.mjs';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const errorUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};' });
const historyModelUrl = moduleUrl('../src/features/imports/history-evidence-model.ts');
const historyApiUrl = moduleUrl('../src/features/imports/history-evidence-api.ts', { '../../lib/api': errorUrl, './import-review-api': 'data:text/javascript,export const importReviewPath="/inventory/imports/batches";', './history-evidence-model': historyModelUrl });
const model = await import(moduleUrl('../src/features/imports/evidence-amendment-model.ts'));
const errors = await import(errorUrl);
const api = await import(moduleUrl('../src/features/imports/evidence-amendment-api.ts', { '../../lib/api': errorUrl, './history-evidence-api': historyApiUrl }));
const invalid = (error) => error.code === 'INVALID_RESPONSE';

test('explicit link choice: missing is not null, UUID normalized, documentary body only', () => {
  const f = amendmentFixture();
  assert.equal(model.amendmentTarget({ ...f.draft, target: '' }, f.plan.current), undefined);
  assert.equal(model.amendmentTarget(f.draft, f.plan.current), null);
  assert.equal(model.amendmentTarget({ ...f.draft, target: 'asset', assetId: '  ' + assetId.toUpperCase() + '  ' }, f.plan.current), assetId);
  assert.equal(model.amendmentTarget({ ...f.draft, target: 'current' }, f.plan.current), undefined);
  assert.deepEqual(model.createAmendmentIntent(f.plan, f.draft, receiptId), f.intent);
  for (const plan of [{ ...f.plan, valid: false }, { ...f.plan, proposed: null }, { ...f.plan, evidenceVersion: 1000 }, { ...f.plan, used: { endpoint: 'END' } }]) assert.throws(() => model.createAmendmentIntent(plan, f.draft, receiptId));
  for (const draft of [{ ...f.draft, target: '' }, { ...f.draft, confirmed: false }, { ...f.draft, note: ' ' }, { ...f.draft, reference: 'x'.repeat(501) }]) assert.throws(() => model.createAmendmentIntent(f.plan, draft, receiptId));
});
test('plan distinguishes original/current/proposed, unknown date remains unknown and consumed endpoints block including RETIREMENT', () => {
  const f = amendmentFixture(); const result = api.validateAmendmentPlan(f.plan, f.owner, null);
  assert.equal(result.originalEvidence.assetId, assetId); assert.equal(result.current.assetId, null); assert.equal(result.proposed.effectiveDay, null); assert.equal(result.proposed.historicalActorId, null);
  for (const endpoint of ['START', 'END', 'RETIREMENT']) {
    const used = { evidenceId: f.owner.id, itemId: receiptId, endpoint };
    assert.equal(api.validateAmendmentPlan({ ...f.plan, used, valid: false, blockers: ['EVIDENCE_ALREADY_APPLIED'] }, f.owner, null).valid, false);
    assert.throws(() => api.validateAmendmentPlan({ ...f.plan, used }, f.owner, null), invalid);
  }
});
test('crossed owners, modified original cells, guessed actors/dates and malformed plans never appear valid', () => {
  const f = amendmentFixture();
  for (const mutate of [(v) => { v.canApply = true; }, (v) => { v.batchId = assetId; }, (v) => { v.sourceRevision = -1; }, (v) => { v.current.evidenceVersion = 28; },
    (v) => { v.originalEvidence.capture.id = assetId; }, (v) => { v.current.capturedAssetId = null; }, (v) => { v.proposed.historicalActorId = assetId; },
    (v) => { v.proposed.original.originalCells.A.value = 'rewritten'; }, (v) => { v.proposed.assetId = assetId; }, (v) => { v.proposed.effectiveDay = '2025-02-30'; },
    (v) => { v.blockers = ['EVIDENCE_ALREADY_APPLIED']; }, (v) => { v.proposed = null; }, (v) => { v.evidenceId = receiptId; }]) {
    const value = globalThis.structuredClone(f.plan); mutate(value); assert.throws(() => api.validateAmendmentPlan(value, f.owner, null), invalid);
  }
});
test('exact immutable write/recovery receipt binds actor, UUID, frozen proposal and previous version; old detail independent of current head', () => {
  const f = amendmentFixture(); const expected = { intent: f.intent, plan: f.plan, actorId: amendmentActorId };
  for (const reused of [false, true]) assert.equal(api.validateAmendmentEvent(f.receiptFor(f.intent, reused), f.original, expected).version, 28);
  const detail = { ...f.history.scope, persisted: true, event: f.eventFor(1) };
  assert.equal(api.validateAmendmentEvent(detail, f.original, { id: detail.event.id }).version, 1);
  for (const mutate of [(v) => { delete v.reused; }, (v) => { v.event.amendedById = assetId; }, (v) => { v.event.evidenceId = receiptId; }, (v) => { v.event.version = 29; },
    (v) => { v.event.previousAmendmentId = receiptId; }, (v) => { v.event.requestId = assetId; }, (v) => { v.event.note = 'different'; }, (v) => { v.event.snapshot.original.fields.serialNumber = 'changed'; },
    (v) => { v.event.snapshot.historicalActorId = assetId; }, (v) => { v.event.snapshot.effective.fields.receivedDate = 'changed'; }, (v) => { v.event.effectiveDay = '2025-01-01'; }, (v) => { v.event.amendedAt = '2001-01-01T00:00:00Z'; }]) {
    const value = f.receiptFor(); mutate(value); assert.throws(() => api.validateAmendmentEvent(value, f.original, expected), invalid);
  }
});
test('25/2 metadata pages, version zero and scoped detail; failures or incomplete page are not empty history', async () => {
  const f = amendmentFixture(); const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return new globalThis.Response(JSON.stringify(url.includes('offset=25') ? f.pageFor(25) : url.includes('?') ? f.page : { ...f.history.scope, persisted: true, event: f.eventFor(1) })); };
  try {
    assert.equal((await api.readAmendments(f.owner, 0, new globalThis.AbortController().signal)).events.length, 25);
    assert.equal((await api.readAmendments(f.owner, 25, new globalThis.AbortController().signal)).events.length, 2);
    assert.equal((await api.readAmendment(f.original, f.eventFor(1).id, new globalThis.AbortController().signal)).version, 1);
    assert.ok(calls.every((url) => url.includes('/evidence/' + f.owner.id + '/amendments')));
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify(f.pageFor(0, 0)));
    assert.equal((await api.readAmendments(f.owner, 0, new globalThis.AbortController().signal)).total, 0);
    for (const mutate of [(v) => { v.events.pop(); }, (v) => { v.events[0].version = 1; }, (v) => { v.events[0].id = receiptId; }, (v) => { v.events[1].previousAmendmentId = receiptId; }, (v) => { v.hasMore = false; }, (v) => { v.current.evidenceVersion = 26; }]) {
      const value = globalThis.structuredClone(f.page); mutate(value); globalThis.fetch = async () => new globalThis.Response(JSON.stringify(value));
      await assert.rejects(api.readAmendments(f.owner, 0, new globalThis.AbortController().signal), invalid);
    }
  } finally { globalThis.fetch = old; }
});
test('plan and write use dedicated CSRF/deadline; recovery sends identical body, no operational endpoints', async () => {
  const f = amendmentFixture(); const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? { csrfToken: 'qa-token' } : url.endsWith('/amendment-plan') ? f.plan : f.receiptFor())); };
  try {
    await api.readAmendmentPlan(f.owner, null, new globalThis.AbortController().signal);
    await api.saveAmendment(f.plan, f.intent, amendmentActorId); await api.saveAmendment(f.plan, f.intent, amendmentActorId);
    const posts = calls.filter((call) => call.method === 'POST'); assert.equal(posts.length, 3);
    assert.equal(posts[0].body, '{"assetId":null}'); assert.equal(posts[1].body, posts[2].body);
    assert.equal(posts[0].headers.get('X-CSRF-Token'), 'qa-token'); assert.equal(posts[0].signal, calls[0].signal);
    assert.ok(posts.every((call) => /\/amendment-plan$|\/amendments$/.test(call.url)));
  } finally { globalThis.fetch = old; }
});
test('known conflicts need renewed review; unknown completion retains intention, safe Spanish errors', () => {
  for (const error of [new Error('offline'), new errors.ApiRequestError('private', 503), new errors.ApiRequestError('private', 200, 'INVALID_RESPONSE'), new errors.ApiRequestError('private', 409, 'EVIDENCE_AMENDMENT_BUSY'), new errors.ApiRequestError('private', 409, 'EVIDENCE_AMENDMENT_CONFLICT')]) assert.equal(api.amendmentNeedsRecovery(error), true);
  for (const code of ['EVIDENCE_VERSION_CONFLICT', 'REVIEW_VERSION_CONFLICT', 'SOURCE_REVISION_CONFLICT', 'EVIDENCE_ALREADY_APPLIED', 'EVIDENCE_AMENDMENT_PLAN_CHANGED', 'EVIDENCE_AMENDMENT_BLOCKED', 'IDEMPOTENCY_KEY_REUSED', 'FORBIDDEN']) {
    const error = new errors.ApiRequestError('PRIVATE_STACK', 409, code); assert.equal(api.amendmentNeedsRecovery(error), false); assert.doesNotMatch(errors.getApiErrorMessage(error, 'Error localizado'), /PRIVATE_STACK/);
  }
});
