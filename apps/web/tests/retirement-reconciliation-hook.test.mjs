import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { retirementReconciliationFixture } from './fixtures/retirement-reconciliation.mjs';

function harness(read) {
  const slots = []; const cleanup = []; const calls = []; const failures = []; let cursor = 0;
  const modules = {
    react: {
      useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
      useRef: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
      useEffect: (effect) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanup.push(effect()); } }
    },
    '../../ui': { useRequestError: () => (error, fallback) => { failures.push(error); return fallback; } },
    './retirement-reconciliation-api': { readRetirementReconciliation: async (id, evidenceId, signal) => { calls.push({ id, evidenceId, signal }); return read(evidenceId, signal, calls.length); } }
  };
  const exports = {}; const source = readFileSync(new URL('../src/features/imports/useRetirementReconciliation.ts', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; }, globalThis: { AbortController: globalThis.AbortController } });
  const f = retirementReconciliationFixture();
  return { calls, failures, render: () => { cursor = 0; return exports.useRetirementReconciliation(f.assetId); }, unmount: () => cleanup.forEach((fn) => fn?.()) };
}
test('reconciliation consults explicitly and prevents synchronous duplicate reads', async () => {
  const f = retirementReconciliationFixture(); let finish; const held = new Promise((resolve) => { finish = resolve; });
  const h = harness(async () => { await held; return f.assessmentFor(); }); const hook = h.render();
  assert.equal(h.calls.length, 0); const first = hook.consult(f.evidenceId); await hook.consult(f.evidenceId); assert.equal(h.calls.length, 1); assert.equal(h.render().busy, true);
  finish(); await first; assert.equal(h.render().fresh, true); assert.equal(h.render().busy, false); assert.equal(h.render().assessment.canApply, false);
});
test('selection refresh cancels an old assessment and its late response cannot overwrite a newer one', async () => {
  const f = retirementReconciliationFixture(); let finish; const held = new Promise((resolve) => { finish = resolve; });
  const h = harness(async (_id, _signal, number) => { if (number === 1) await held; return { ...f.assessmentFor(), assessmentId: String(number).repeat(64) }; });
  const first = h.render().consult(f.evidenceId); h.render().invalidate(); assert.equal(h.calls[0].signal.aborted, true);
  await h.render().consult(f.evidenceId); finish(); await first; assert.equal(h.render().assessment.assessmentId, '2'.repeat(64)); assert.equal(h.render().fresh, true);
});
test('failed refresh retains the previous assessment as stale with Spanish recovery, not empty or eligible', async () => {
  const f = retirementReconciliationFixture();
  const h = harness(async (_id, _signal, number) => { if (number > 1) throw new Error('PRIVATE_SERVER_ERROR'); return f.assessmentFor(); });
  await h.render().consult(f.evidenceId); await h.render().consult(f.evidenceId);
  assert.ok(h.render().assessment); assert.equal(h.render().fresh, false); assert.equal(h.render().busy, false); assert.equal(h.failures.length, 1);
  assert.match(h.render().error, /Se conserva la selección/); assert.doesNotMatch(h.render().error, /PRIVATE_SERVER_ERROR/); assert.equal(h.calls.length, 2);
});
test('closing cancels pending consultation and detached callbacks cannot publish or request more data', async () => {
  const f = retirementReconciliationFixture(); let finish; const held = new Promise((resolve) => { finish = resolve; });
  const h = harness(async () => { await held; return f.assessmentFor(); }); const stale = h.render(); const request = stale.consult(f.evidenceId);
  h.unmount(); assert.equal(h.calls[0].signal.aborted, true); finish(); assert.equal(await request, undefined);
  await stale.consult(f.evidenceId); assert.equal(h.calls.length, 1); assert.equal(h.render().assessment, null); assert.equal(h.failures.length, 0);
});
