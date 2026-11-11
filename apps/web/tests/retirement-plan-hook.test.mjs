import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { assetId } from './fixtures/import-pilot.mjs';

function harness(read) {
  const slots = []; let cursor = 0; const cleanup = []; const calls = []; const errors = []; const exports = {};
  const modules = {
    react: {
      useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = value; }]; },
      useRef: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
      useEffect: (effect) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanup.push(effect()); } }
    },
    '../../ui': { useRequestError: () => (error) => { errors.push(error); return 'Error localizado'; } },
    './retirement-plan-api': { readRetirementPlan: async (id, input, signal) => { calls.push({ id, input, signal }); return read(input, signal, calls.length); } }
  };
  const source = readFileSync(new URL('../src/features/imports/useRetirementPlan.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; }, globalThis: { AbortController: globalThis.AbortController, structuredClone: globalThis.structuredClone } });
  return { calls, errors, render: () => { cursor = 0; return exports.useRetirementPlan(assetId); }, unmount: () => cleanup.forEach((fn) => fn?.()) };
}
test('retirement generates only explicitly, clones request and synchronously prevents duplicate POSTs', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const h = harness(async () => { await held; return { planId: 'confirmed' }; }); const hook = h.render(); assert.equal(h.calls.length, 0);
  const input = { note: 'original', acknowledgedWarnings: [] }; const first = hook.generate(input); input.note = 'modified';
  await hook.generate(input); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].input.note, 'original'); assert.equal(h.render().busy, true);
  release(); await first; assert.equal(h.render().plan.planId, 'confirmed'); assert.equal(h.render().fresh, true); assert.equal(h.render().busy, false);
});
test('invalidating cancels and marks previous plan stale; late old response cannot replace a newer plan', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const h = harness(async (input, signal, number) => { if (number === 2) await held; return { planId: String(number) }; });
  await h.render().generate({}); const old = h.render(); const pending = old.generate({}); old.invalidate();
  assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.render().fresh, false); assert.equal(h.render().plan.planId, '1');
  await h.render().generate({}); release(); assert.equal(await pending, undefined); assert.equal(h.render().plan.planId, '3'); assert.equal(h.render().fresh, true);
});
test('failure retains prior result explicitly stale, has localized recovery, no automatic retry; unmount ignores completion', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const h = harness(async (input, signal, number) => { if (number === 2) throw new Error('private'); if (number === 3) await held; return { planId: String(number) }; });
  await h.render().generate({}); await h.render().generate({}); assert.equal(h.calls.length, 2); assert.equal(h.render().plan.planId, '1');
  assert.equal(h.render().fresh, false); assert.equal(h.render().error, 'Error localizado');
  const callback = h.render(); const pending = callback.generate({}); h.unmount(); release();
  assert.equal(await pending, undefined); assert.equal(h.calls[2].signal.aborted, true); await callback.generate({}); assert.equal(h.calls.length, 3);
});
