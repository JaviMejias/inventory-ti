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

// Run the actual item's handlers/effects with a deterministic clock and hook lifecycle.
function setupToastItem(duration = null) {
  const slots = [];
  const timers = new Map();
  let cursor = 0;
  let timerId = 0;
  let now = 0;
  let dirty = false;
  let tree;
  let dismissals = 0;
  let toast = { title: 'Operación completada', tone: 'success', duration, version: 0 };
  const dismiss = () => { dismissals++; };
  const sameDeps = (previous, next) => previous && next && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, (value) => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!sameDeps(previous?.deps, deps)) slots[index] = { effect, deps, cleanup: previous?.cleanup, pending: true };
    }
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: hooks,
    'react-dom': {},
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './toast-context': {}
  };
  const exports = {};
  runInNewContext(compiled + '\nexports.TestToastItem = ToastItem;', {
    exports,
    require: (name) => modules[name],
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = timerId++; timers.set(id, { callback, time: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });

  function render() {
    let renders = 0;
    do {
      assert.ok(++renders < 10, 'Hook lifecycle must settle');
      dirty = false;
      cursor = 0;
      tree = exports.TestToastItem({ toast, dismiss });
      const pending = slots.filter((slot) => slot.pending);
      for (const slot of pending) slot.cleanup?.();
      for (const slot of pending) { slot.pending = false; slot.cleanup = slot.effect(); }
    } while (dirty);
  }

  render();
  return {
    get state() { return tree.props['data-state']; },
    get dismissals() { return dismissals; },
    close() { tree.props.children.find((child) => child?.type === 'button').props.onClick(); render(); },
    refresh() { toast = { ...toast, version: toast.version + 1 }; render(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.time <= end).sort((a, b) => a[1].time - b[1].time)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.time;
        timer.callback();
        render();
      }
      now = end;
    }
  };
}

test('refreshing a persistent toast during its exit cancels the old dismissal', () => {
  const fixture = setupToastItem();
  fixture.close();
  assert.equal(fixture.state, 'closing');
  fixture.advance(70);
  fixture.refresh();
  assert.equal(fixture.state, 'open');
  fixture.advance(5000);
  assert.equal(fixture.dismissals, 0);
  fixture.close();
  fixture.advance(180);
  assert.equal(fixture.dismissals, 1);
});

test('refreshing an auto-closing toast starts a complete new lifetime', () => {
  const fixture = setupToastItem(5000);
  fixture.advance(5000);
  assert.equal(fixture.state, 'closing');
  fixture.advance(70);
  fixture.refresh();
  fixture.advance(4999);
  assert.equal(fixture.state, 'open');
  assert.equal(fixture.dismissals, 0);
  fixture.advance(1);
  assert.equal(fixture.state, 'closing');
  fixture.advance(180);
  assert.equal(fixture.dismissals, 1);
});

test('unmounting a toast cancels its exit even when the timer identifier is zero', () => {
  const fixture = setupToastItem();
  fixture.close();
  fixture.unmount();
  fixture.advance(180);
  assert.equal(fixture.dismissals, 0);
});
