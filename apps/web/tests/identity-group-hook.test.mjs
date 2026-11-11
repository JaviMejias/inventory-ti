import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { identityGroupFixture } from './fixtures/identity-group.mjs';

class ApiError extends Error { constructor(code) { super(code); this.code = code; } }
function harness(read, generate) {
  const fixture = identityGroupFixture(); const slots = []; const cleanup = []; const reads = []; const plans = []; const failures = []; let cursor = 0;
  const reportError = (error, message) => { failures.push(error); return message; };
  const modules = {
    react: {
      useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
      useRef: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
      useCallback: (callback) => callback,
      useEffect: (effect) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanup.push(effect()); } }
    },
    '../../lib/api': { ApiRequestError: ApiError }, '../../ui': { useRequestError: () => reportError },
    './identity-group-api': {
      identityGroupErrorMessage: () => 'No se pudo simular la agrupación. El borrador se conserva.',
      readIdentityGroupContext: async (id, original, signal) => { reads.push({ id, original, signal }); return read ? read(signal, reads.length, fixture) : fixture.source; },
      readIdentityGroupPlan: async (id, input, original, signal) => { plans.push({ id, input, original, signal }); return generate ? generate(input, signal, plans.length, fixture) : fixture.plan; }
    }
  };
  const source = readFileSync(new URL('../src/features/imports/useIdentityGroupPlan.ts', import.meta.url), 'utf8'); const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; }, globalThis: { AbortController: globalThis.AbortController, structuredClone: globalThis.structuredClone } });
  return { fixture, reads, plans, failures, render: () => { cursor = 0; return exports.useIdentityGroupPlan(fixture.source.batchId, fixture.original); }, unmount: () => cleanup.forEach((callback) => callback?.()) };
}
test('opening reads coherent context only; explicit planning synchronously blocks duplicates and captures a detached request', async () => {
  let finish; const held = new Promise((resolve) => { finish = resolve; });
  const h = harness(undefined, async (_input, _signal, _number, f) => { await held; return f.plan; }); h.render(); await setImmediate();
  assert.equal(h.reads.length, 1); assert.equal(h.plans.length, 0); const hook = h.render(); assert.equal(hook.contextFresh, true);
  const input = globalThis.structuredClone(h.fixture.input); const pending = hook.generate(input); await hook.generate(input); assert.equal(h.plans.length, 1);
  input.note = 'Changed after activation'; assert.notEqual(h.plans[0].input.note, input.note); finish(); await pending;
  assert.equal(h.render().fresh, true); assert.equal(h.render().busy, false); assert.equal(h.render().plan.canApply, false);
});
test('invalidating aborts an old simulation and late completion cannot replace the new result', async () => {
  let finish; const held = new Promise((resolve) => { finish = resolve; });
  const h = harness(undefined, async (_input, _signal, number, f) => { if (number === 1) await held; return { ...f.plan, planId: String(number).repeat(64) }; });
  h.render(); await setImmediate(); const old = h.render().generate(h.fixture.input); h.render().invalidate(); assert.equal(h.plans[0].signal.aborted, true);
  await h.render().generate(h.fixture.input); finish(); await old; assert.equal(h.render().plan.planId, '2'.repeat(64)); assert.equal(h.render().fresh, true);
});
test('version conflict preserves prior plan as stale and blocks even a stale callback until a fresh context is reviewed', async () => {
  let version = 1;
  const h = harness(async (_signal, _number, f) => ({ ...f.source, batchVersion: version }), async (_input, _signal, number, f) => { if (number === 2) throw new ApiError('REVIEW_VERSION_CONFLICT'); return f.plan; });
  h.render(); await setImmediate(); const stale = h.render(); await stale.generate(h.fixture.input); await h.render().generate(h.fixture.input);
  assert.ok(h.render().plan); assert.equal(h.render().fresh, false); assert.equal(h.render().contextFresh, false); assert.equal(h.failures.length, 1);
  await stale.generate(h.fixture.input); assert.equal(h.plans.length, 2);
  version = 2; await h.render().refresh(); await stale.generate(h.fixture.input); assert.equal(h.plans.length, 2);
  await h.render().generate({ ...h.fixture.input, expectedVersion: 2 }); assert.equal(h.plans.length, 3);
});
test('context refresh failure retains draft context and last plan, reports Spanish recovery and never retries or simulates automatically', async () => {
  const h = harness(async (_signal, number, f) => { if (number > 1) throw new Error('PRIVATE_INTERNAL_ERROR'); return f.source; });
  h.render(); await setImmediate(); await h.render().generate(h.fixture.input); await h.render().refresh();
  assert.ok(h.render().context); assert.ok(h.render().plan); assert.equal(h.render().fresh, false); assert.equal(h.render().contextFresh, false);
  assert.match(h.render().readError, /Se conserva el borrador/); assert.doesNotMatch(h.render().readError, /PRIVATE_INTERNAL_ERROR/);
  await h.render().generate(h.fixture.input); assert.equal(h.plans.length, 1); assert.equal(h.reads.length, 2);
});
test('closing cancels reads and a detached dialog cannot publish results or start another request', async () => {
  let finish; const held = new Promise((resolve) => { finish = resolve; }); const h = harness(undefined, async (_input, _signal, _number, f) => { await held; return f.plan; });
  h.render(); await setImmediate(); const stale = h.render(); const request = stale.generate(h.fixture.input); h.unmount();
  assert.equal(h.plans[0].signal.aborted, true); finish(); assert.equal(await request, undefined); await stale.generate(h.fixture.input); await stale.refresh();
  assert.equal(h.plans.length, 1); assert.equal(h.reads.length, 1); assert.equal(h.failures.length, 0);
});
