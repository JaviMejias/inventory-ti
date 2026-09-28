import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/ui/feedback/ToastProvider.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText;

// Exercise the provider's commit effects without a DOM dependency; browser checks cover native behavior.
function setup({ host, dialogs = [], connected = true, hasToasts = true, supportsPopover = true }) {
  const body = { name: 'body', isConnected: true };
  const calls = [];
  const hostUpdates = [];
  const effects = [];
  let open = false;
  const viewport = {
    isConnected: connected,
    matches: () => open,
    showPopover: supportsPopover ? () => {
      assert.equal(viewport.isConnected, true, 'Never open a disconnected popover');
      calls.push('show');
      open = true;
    } : undefined,
    hidePopover: () => {
      assert.equal(viewport.isConnected, true, 'Never close a disconnected popover');
      calls.push('hide');
      open = false;
    }
  };
  const hooks = {
    useCallback: (callback) => callback,
    useEffect: () => {},
    useLayoutEffect: (effect) => effects.push(effect),
    useMemo: (factory) => factory(),
    useRef: () => ({ current: viewport }),
    useState: (initial) => Array.isArray(initial)
      ? [hasToasts ? [{ id: 'toast-1', title: 'Activo devuelto', tone: 'success' }] : [], () => {}]
      : [host ?? body, (next) => hostUpdates.push(next)]
  };
  const modules = {
    react: hooks,
    'react-dom': { createPortal: (content) => content },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    './toast-context': { ToastContext: { Provider: () => null } }
  };
  const exports = {};
  const document = { body, querySelectorAll: () => dialogs };
  runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in modules, 'Unexpected import: ' + name);
      return modules[name];
    },
    document,
    MutationObserver: class { observe() {} disconnect() {} }
  });
  exports.ToastProvider({ children: null });
  return { body, calls, hostUpdates, viewport, commit: effects.at(-1) };
}

test('a removed dialog redirects the toast before attempting to open its detached viewport', () => {
  const removed = { name: 'removed dialog', isConnected: false };
  const fixture = setup({ host: removed, connected: false });
  assert.equal(fixture.commit(), undefined);
  assert.deepEqual(fixture.hostUpdates, [fixture.body]);
  assert.deepEqual(fixture.calls, []);

  const nextCommit = setup({});
  nextCommit.commit();
  assert.deepEqual(nextCommit.calls, ['show']);
});

test('a closed but connected dialog redirects the toast to the page', () => {
  const fixture = setup({ host: { name: 'closed dialog', isConnected: true } });
  fixture.commit();
  assert.deepEqual(fixture.hostUpdates, [fixture.body]);
  assert.deepEqual(fixture.calls, []);
});

test('closing a nested dialog transfers the notification to the remaining open dialog', () => {
  const parent = { name: 'open parent', isConnected: true };
  const fixture = setup({ host: { name: 'removed child', isConnected: false }, dialogs: [parent], connected: false });
  fixture.commit();
  assert.deepEqual(fixture.hostUpdates, [parent]);
  assert.deepEqual(fixture.calls, []);
});

test('an open dialog hosts a visible notification and connected cleanup closes it', () => {
  const dialog = { name: 'open dialog', isConnected: true };
  const fixture = setup({ host: dialog, dialogs: [dialog] });
  const cleanup = fixture.commit();
  assert.deepEqual(fixture.hostUpdates, []);
  assert.deepEqual(fixture.calls, ['show']);
  cleanup();
  assert.deepEqual(fixture.calls, ['show', 'hide']);
});

test('cleanup does not call native popover methods after the host was removed', () => {
  const fixture = setup({});
  const cleanup = fixture.commit();
  fixture.viewport.isConnected = false;
  cleanup();
  assert.deepEqual(fixture.calls, ['show']);
});

test('an empty toast stack never opens the popover', () => {
  const fixture = setup({ hasToasts: false });
  fixture.commit()?.();
  assert.deepEqual(fixture.calls, []);
});

test('browsers without the Popover API do not call unsupported methods', () => {
  const fixture = setup({ supportsPopover: false });
  assert.equal(fixture.commit(), undefined);
  assert.deepEqual(fixture.calls, []);
});
