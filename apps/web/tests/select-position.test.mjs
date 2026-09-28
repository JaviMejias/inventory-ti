import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/ui/primitives/Select.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText;

// Commit the positioning effect with controlled bounds; browser checks cover the native dialog animation.
function setup({ open = true, insideDialog = true } = {}) {
  const effects = [];
  const positions = [];
  const dialogListeners = new Map();
  const windowListeners = new Map();
  let bounds = { left: 124, top: 200, bottom: 244, width: 538 };
  const dialog = {
    getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 600, width: 588 }),
    addEventListener: (name, listener) => dialogListeners.set(name, listener),
    removeEventListener: (name, listener) => { if (dialogListeners.get(name) === listener) dialogListeners.delete(name); }
  };
  const trigger = {
    getBoundingClientRect: () => bounds,
    closest: () => insideDialog ? dialog : null
  };
  const refs = [null, trigger, null, null, undefined];
  let refIndex = 0;
  let stateIndex = 0;
  const hooks = {
    useEffect: (effect) => effects.push(effect),
    useId: () => 'test-select',
    useMemo: (factory) => factory(),
    useRef: () => ({ current: refs[refIndex++] }),
    useState: (initial) => {
      const index = stateIndex++;
      return [index === 0 ? open : initial, (next) => { if (index === 5) positions.push({ ...next }); }];
    }
  };
  const modules = {
    react: hooks,
    'react-dom': { createPortal: (content) => content },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    '../utils': { cx: () => '' },
    './Icon': { Icon: () => null }
  };
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: (name) => { assert.ok(name in modules, 'Unexpected import: ' + name); return modules[name]; },
    document: { body: {} },
    HTMLDialogElement: class {},
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: (name, listener) => { if (windowListeners.get(name) === listener) windowListeners.delete(name); }
  });
  exports.Select({ value: '', options: [], onChange: () => {} });
  return { dialog, dialogListeners, windowListeners, positions, setBounds: (next) => { bounds = next; }, commit: effects[2] };
}

test('a popup remeasures its anchor when the dialog finishes entering, ignoring child animations', () => {
  const fixture = setup();
  const cleanup = fixture.commit();
  assert.equal(fixture.positions[0].width, 538);
  assert.equal(fixture.positions[0].left, 24);
  fixture.setBounds({ left: 124, top: 200, bottom: 244, width: 546 });
  const animationEnd = fixture.dialogListeners.get('animationend');
  assert.equal(typeof animationEnd, 'function');
  animationEnd({ target: {} });
  assert.equal(fixture.positions.length, 1);
  animationEnd({ target: fixture.dialog });
  assert.equal(fixture.positions.at(-1).width, 546);
  assert.equal(fixture.positions.at(-1).left, 24);
  cleanup();
  assert.equal(fixture.dialogListeners.size, 0);
  assert.equal(fixture.windowListeners.size, 0);
});

test('a closed select does not measure or register dialog listeners', () => {
  const fixture = setup({ open: false });
  assert.equal(fixture.commit(), undefined);
  assert.equal(fixture.positions.length, 0);
  assert.equal(fixture.dialogListeners.size, 0);
  assert.equal(fixture.windowListeners.size, 0);
});

test('a page select keeps viewport positioning and its resize and scroll updates', () => {
  const fixture = setup({ insideDialog: false });
  const cleanup = fixture.commit();
  assert.equal(fixture.positions[0].top, 252);
  assert.equal(fixture.positions[0].left, 124);
  assert.equal(fixture.dialogListeners.size, 0);
  fixture.setBounds({ left: 140, top: 260, bottom: 304, width: 546 });
  fixture.windowListeners.get('resize')();
  assert.equal(fixture.positions.at(-1).left, 140);
  fixture.windowListeners.get('scroll')();
  assert.equal(fixture.positions.length, 3);
  cleanup();
  assert.equal(fixture.windowListeners.size, 0);
});
