import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { assetId } from './fixtures/import-pilot.mjs';
import { retirementActorId, retirementApplicationFixture } from './fixtures/retirement-application.mjs';

function harness(save) {
  const fixture = retirementApplicationFixture(); const slots = []; const cleanup = []; const calls = []; const toasts = []; const failures = [];
  let cursor = 0; let sequence = 400; const exports = {};
  const modules = {
    react: {
      useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
      useRef: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
      useEffect: (effect) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanup.push(effect()); } }
    },
    '../../ui': { useRequestError: () => (error, message) => { failures.push(error); return message; }, useToast: () => ({ showToast: (value) => toasts.push(value) }) },
    './retirement-application-api': {
      retirementApplicationNeedsRecovery: (error) => error.unknown === true,
      getRetirementApplicationErrorMessage: () => 'Recuperación de baja en español',
      saveRetirementApplication: async (id, intent, actor) => { calls.push({ id, actor, intent: globalThis.structuredClone(intent) }); return save(intent, fixture, calls.length); }
    },
    './retirement-application-model': { createRetirementApplicationIntent: (plan, requestId) => ({ requestId, planId: plan.planId, confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT', plan: globalThis.structuredClone(plan.request) }) }
  };
  const source = readFileSync(new URL('../src/features/imports/useRetirementApplication.ts', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; }, globalThis: { crypto: { randomUUID: () => '00000000-0000-4000-8000-' + (++sequence).toString().padStart(12, '0') } } });
  return { fixture, calls, toasts, failures, render: () => { cursor = 0; return exports.useRetirementApplication(assetId, retirementActorId); }, unmount: () => cleanup.forEach((fn) => fn?.()) };
}

test('retirement apply is explicit, synchronously single-flight and cannot repeat after a confirmed receipt', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const h = harness(async (intent, fixture) => { await held; return fixture.receipt.application; });
  const hook = h.render(); assert.equal(h.calls.length, 0);
  const first = hook.save(h.fixture.plan); await hook.save(h.fixture.plan);
  assert.equal(h.calls.length, 1); assert.equal(hook.submitting(), true); assert.equal(hook.blocked(), true); assert.equal(h.render().busy, true);
  release(); await first; await hook.save(h.fixture.plan); assert.equal(h.calls.length, 1);
  assert.ok(h.render().saved); assert.equal(h.render().busy, false); assert.equal(h.toasts.length, 1); assert.match(h.toasts[0].title, /Baja histórica aplicada/);
});

test('uncertain retirement keeps one actor UUID and exact input through explicit recovery, with no automatic retry', async () => {
  const h = harness(async (intent, fixture, number) => { if (number === 1) throw { unknown: true }; return fixture.receipt.application; });
  await h.render().save(h.fixture.plan); const recovery = h.render();
  assert.equal(recovery.uncertain, true); assert.equal(h.calls.length, 1); assert.ok(recovery.requestId); assert.equal(h.toasts.length, 0);
  h.fixture.plan.request.note = 'Changed outside the frozen intention'; recovery.reviewed();
  await recovery.save(h.fixture.plan); assert.deepEqual(h.calls[0], h.calls[1]);
  assert.equal(h.render().uncertain, false); assert.ok(h.render().saved); assert.equal(h.calls[0].actor, retirementActorId);
});

test('known conflict preserves localized feedback and blocks stale callbacks until a newly reviewed plan', async () => {
  const h = harness(async (intent, fixture, number) => { if (number === 1) throw { unknown: false }; return fixture.receipt.application; });
  const stale = h.render(); await stale.save(h.fixture.plan); await stale.save(h.fixture.plan);
  assert.equal(h.calls.length, 1); assert.equal(h.render().needsPlan, true); assert.equal(h.render().error, 'Recuperación de baja en español');
  assert.equal(h.toasts.length, 0); h.fixture.plan.planId = 'e'.repeat(64);
  h.render().reviewed(); await h.render().save(h.fixture.plan);
  assert.equal(h.calls.length, 2); assert.notEqual(h.calls[0].intent.requestId, h.calls[1].intent.requestId); assert.equal(h.calls[1].intent.planId, 'e'.repeat(64));
});

test('unmount does not claim success or allow an obsolete callback to apply a retirement', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const h = harness(async (intent, fixture) => { await held; return fixture.receipt.application; });
  const hook = h.render(); const pending = hook.save(h.fixture.plan); h.unmount(); release();
  assert.equal(await pending, undefined); await hook.save(h.fixture.plan); assert.equal(h.calls.length, 1); assert.equal(h.toasts.length, 0);
});

test('unreviewed or incomplete plans never start application and recoverable errors retain the intention', async () => {
  const h = harness(async () => { throw { unknown: true }; }); const hook = h.render();
  await hook.save(); await hook.save({ ...h.fixture.plan, planValidationComplete: false }); assert.equal(h.calls.length, 0);
  await hook.save(h.fixture.plan); assert.equal(h.calls.length, 1); assert.equal(h.render().error, 'Recuperación de baja en español');
  assert.equal(h.render().locked, true); assert.equal(h.render().busy, false); assert.ok(h.render().requestId);
});
