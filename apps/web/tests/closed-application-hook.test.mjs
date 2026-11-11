import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { closedActorId, closedApplicationFixture } from './fixtures/closed-application.mjs';
import { assetId } from './fixtures/import-pilot.mjs';

function harness(save) {
  const fixture = closedApplicationFixture(); const slots = []; let cursor = 0; const cleanup = []; const toasts = []; const calls = []; let sequence = 200;
  const exports = {};
  const modules = {
    react: { useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
      useRef: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
      useEffect: (effect) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanup.push(effect()); } } },
    '../../ui': { useRequestError: () => () => 'Error localizado', useToast: () => ({ showToast: (value) => toasts.push(value) }) },
    './closed-application-api': { closedApplicationNeedsRecovery: (error) => error.unknown === true, saveClosedApplication: async (id, intent, actor) => { calls.push({ id, intent: globalThis.structuredClone(intent), actor }); return save(intent, fixture); } },
    './closed-application-model': { createClosedApplicationIntent: (plan, requestId) => ({ requestId, planId: plan.planId, confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: globalThis.structuredClone(fixture.input) }) }
  };
  const source = readFileSync(new URL('../src/features/imports/useClosedApplication.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, { exports, require: (name) => { assert.ok(name in modules,name); return modules[name]; }, globalThis: { crypto: { randomUUID: () => '00000000-0000-4000-8000-' + (++sequence).toString().padStart(12,'0') } } });
  return { fixture, calls, toasts, render: () => { cursor = 0; return exports.useClosedApplication(assetId,closedActorId); }, unmount: () => cleanup.forEach((fn) => fn?.()) };
}
test('duplicate activation is synchronously blocked; even stale callbacks cannot save again after confirmed receipt', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const h = harness(async (intent,fixture) => { await held; return fixture.receiptFor(intent); }); const hook = h.render();
  const first = hook.save(h.fixture.plan); await hook.save(h.fixture.plan); assert.equal(h.calls.length,1); assert.equal(hook.submitting(),true);
  release(); await first; await hook.save(h.fixture.plan); assert.equal(h.calls.length,1); assert.equal(h.toasts.length,1); assert.ok(h.render().saved); assert.equal(hook.blocked(),true);
});
test('unknown completion freezes one UUID/body, preserves draft and requires explicit identical recovery without a new plan', async () => {
  let attempt = 0;
  const h = harness(async (intent,fixture) => { if (!attempt++) throw { unknown: true }; return fixture.receiptFor(intent,true); });
  await h.render().save(h.fixture.plan); const next = h.render(); assert.equal(next.uncertain,true); assert.ok(next.requestId); assert.equal(h.toasts.length,0);
  h.fixture.plan.periods[0].note = 'Edited externally'; next.reviewed(); assert.equal(h.calls.length,1);
  await next.save(); assert.equal(h.calls.length,2); assert.deepEqual(h.calls[0],h.calls[1]); assert.equal(h.render().uncertain,false); assert.ok(h.render().saved);
});
test('known conflict blocks even stale callback; only explicit newly reviewed plan permits a new request UUID', async () => {
  let attempt = 0;
  const h = harness(async (intent,fixture) => { if (!attempt++) throw { unknown: false }; return fixture.receiptFor(intent); }); const old = h.render();
  await old.save(h.fixture.plan); await old.save(h.fixture.plan); assert.equal(h.calls.length,1); assert.equal(h.render().needsPlan,true);
  h.render().reviewed(); await h.render().save(h.fixture.plan); assert.equal(h.calls.length,2); assert.notEqual(h.calls[0].intent.requestId,h.calls[1].intent.requestId);
});
test('late write completion after unmount never publishes success or returns a receipt to a detached dialog', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const h = harness(async (intent,fixture) => { await held; return fixture.receiptFor(intent); });
  const promise = h.render().save(h.fixture.plan); h.unmount(); release(); assert.equal(await promise,undefined); assert.equal(h.toasts.length,0);
});
