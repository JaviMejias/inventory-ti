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
function setup({ open = true, insideDialog = true, options = [] } = {}) {
  const effects = [];
  const positions = [];
  const dialogListeners = new Map();
  const windowListeners = new Map();
  const timers = [];
  const focusedOption = {};
  const documentState = { body: {}, activeElement: focusedOption };
  let focusCount = 0;
  let bounds = { left: 124, top: 200, bottom: 244, width: 538 };
  const dialog = {
    getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 600, width: 588 }),
    addEventListener: (name, listener) => dialogListeners.set(name, listener),
    removeEventListener: (name, listener) => { if (dialogListeners.get(name) === listener) dialogListeners.delete(name); }
  };
  const trigger = {
    isConnected: true,
    focus: () => { focusCount += 1; documentState.activeElement = trigger; },
    getBoundingClientRect: () => bounds,
    closest: () => insideDialog ? dialog : null
  };
  const refs = [{ contains: (node) => node === trigger }, trigger, null, { contains: (node) => node === focusedOption }, undefined];
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
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../utils': { cx: () => '' },
    './Icon': { Icon: () => null }
  };
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: (name) => { assert.ok(name in modules, 'Unexpected import: ' + name); return modules[name]; },
    document: documentState,
    window: { setTimeout: (callback) => { timers.push(callback); return timers.length; } },
    HTMLDialogElement: class {},
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: (name, listener) => { if (windowListeners.get(name) === listener) windowListeners.delete(name); }
  });
  const tree = exports.Select({ value: '', options, onChange: () => {} });
  function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(2).flatMap(nodes)]; }
  return { dialog, dialogListeners, windowListeners, positions, documentState, trigger, focusedOption, timers,
    select: () => nodes(tree).find((node) => node.props?.role === 'option').props.onClick(), focusCount: () => focusCount,
    setBounds: (next) => { bounds = next; }, commit: effects[2] };
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

test('closing a selected option restores its trigger without scrolling while focus still belongs to that select', () => {
  const fixture = setup({ options: [{ value: 'chosen', label: 'Elegida' }] });
  fixture.select(); fixture.timers[0]();
  assert.equal(fixture.focusCount(), 1); assert.equal(fixture.documentState.activeElement, fixture.trigger);
});
test('animated select exit does not steal focus from a newly opened control or result heading', () => {
  const fixture = setup({ options: [{ value: 'chosen', label: 'Elegida' }] });
  fixture.select(); const nextControl = {}; fixture.documentState.activeElement = nextControl; fixture.timers[0]();
  assert.equal(fixture.focusCount(), 0); assert.equal(fixture.documentState.activeElement, nextControl);
});
test('a disconnected select never restores focus after its exit timer', () => {
  const fixture = setup({ options: [{ value: 'chosen', label: 'Elegida' }] });
  fixture.select(); fixture.trigger.isConnected = false; fixture.timers[0]();
  assert.equal(fixture.focusCount(), 0);
});
