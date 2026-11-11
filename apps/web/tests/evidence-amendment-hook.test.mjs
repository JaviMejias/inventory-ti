import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { amendmentActorId, amendmentFixture } from './fixtures/evidence-amendment.mjs';

function harness({ save, generate } = {}) {
  const fixture = amendmentFixture(); const slots = []; let cursor = 0; const cleanup = []; const toasts = []; const calls = []; const reads = []; let sequence = 500;
  const exports = {};
  const modules = {
    react: { useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
      useRef: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
      useEffect: (effect) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanup.push(effect()); } } },
    '../../ui': { useRequestError: () => () => 'Error localizado', useToast: () => ({ showToast: (value) => toasts.push(value) }) },
    './evidence-amendment-api': { amendmentNeedsRecovery: (error) => error.unknown === true,
      readAmendmentPlan: async (owner, target, signal) => { reads.push({ owner, target, signal }); return generate ? generate(signal, fixture) : fixture.plan; },
      saveAmendment: async (plan, body, actor) => { calls.push({ plan: globalThis.structuredClone(plan), body: globalThis.structuredClone(body), actor }); return save ? save(body, fixture) : fixture.receiptFor(body).event; } },
    './evidence-amendment-model': { createAmendmentIntent: (plan, draft, requestId) => ({ ...fixture.intent, requestId, note: draft.note.trim(), evidenceReference: draft.reference.trim(), assetId: plan.proposed.assetId }) }
  };
  const source = readFileSync(new URL('../src/features/imports/useEvidenceAmendment.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; }, globalThis: { AbortController: globalThis.AbortController, structuredClone: globalThis.structuredClone, crypto: { randomUUID: () => '00000000-0000-4000-8000-' + (++sequence).toString().padStart(12, '0') } } });
  return { fixture, reads, calls, toasts, render: () => { cursor = 0; return exports.useEvidenceAmendment(fixture.owner, amendmentActorId); }, unmount: () => cleanup.forEach((fn) => fn?.()) };
}
test('explicit planning is duplicate guarded and aborted/stale results never replace a newer proposal', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; }); let attempt = 0;
  const h = harness({ generate: async (signal, fixture) => { if (!attempt++) await held; return { ...fixture.plan, amendmentPlanId: signal.aborted ? 'old' : 'new' }; } });
  const old = h.render(); const first = old.generate(null); await old.generate(null); assert.equal(h.reads.length, 1);
  old.invalidate(); assert.equal(h.reads[0].signal.aborted, true); await h.render().generate(null); release(); await first;
  assert.equal(h.render().plan.amendmentPlanId, 'new'); assert.equal(h.render().planning, false);
});
test('one write on double activation, obsolete callbacks cannot resave after confirmed event', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const h = harness({ save: async (body, f) => { await held; return f.receiptFor(body).event; } });
  await h.render().generate(null); const hook = h.render(); const first = hook.save(hook.plan, h.fixture.draft);
  await hook.save(hook.plan, h.fixture.draft); assert.equal(h.calls.length, 1); assert.equal(hook.submitting(), true);
  release(); await first; await hook.save(hook.plan, h.fixture.draft); assert.equal(h.calls.length, 1); assert.equal(h.toasts.length, 1);
});
test('uncertain completion retains frozen proposal, normalized body and UUID for manual recovery only', async () => {
  let attempt = 0; const h = harness({ save: async (body, f) => { if (!attempt++) throw { unknown: true }; return f.receiptFor(body, true).event; } });
  await h.render().generate(null); const ready = h.render(); await ready.save(ready.plan, h.fixture.draft);
  const uncertain = h.render(); assert.equal(uncertain.uncertain, true); assert.ok(uncertain.requestId); assert.equal(h.toasts.length, 0);
  h.fixture.plan.proposed.effective.fields.receivedDate = 'later external change'; h.fixture.draft.note = 'external change';
  uncertain.invalidate(); await uncertain.generate(null); assert.equal(h.reads.length, 1); assert.equal(h.calls.length, 1);
  await uncertain.save(); assert.deepEqual(h.calls[0], h.calls[1]); assert.ok(h.render().saved); assert.equal(h.render().uncertain, false);
});
test('known version conflict rejects stale save until fresh explicit plan, preserves caller draft and creates new UUID', async () => {
  let attempt = 0; const h = harness({ save: async (body, f) => { if (!attempt++) throw { unknown: false }; return f.receiptFor(body).event; } });
  await h.render().generate(null); const old = h.render(); await old.save(old.plan, h.fixture.draft); await old.save(old.plan, h.fixture.draft);
  assert.equal(h.calls.length, 1); assert.equal(h.render().plan, null); assert.equal(h.fixture.draft.note, '  Nueva revisión  ');
  await h.render().generate(null); const ready = h.render(); await ready.save(ready.plan, h.fixture.draft);
  assert.equal(h.calls.length, 2); assert.notEqual(h.calls[0].body.requestId, h.calls[1].body.requestId);
});
test('unmount aborts reads but does not pretend to undo writes, detached result never announces success', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; }); const h = harness({ save: async (body, f) => { await held; return f.receiptFor(body).event; } });
  await h.render().generate(null); const hook = h.render(); const pending = hook.save(hook.plan, h.fixture.draft); h.unmount(); release();
  assert.equal(await pending, undefined); assert.equal(h.toasts.length, 0); assert.equal(h.calls.length, 1);
});
