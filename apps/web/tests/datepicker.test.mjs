import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/ui/primitives/DatePicker.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText;

// Execute the shared calendar's real handlers; browser checks cover popup geometry and native focus.
function setup({ value = '', open = true, allowFuture = false } = {}) {
  const effects = [];
  const updates = [];
  const changes = [];
  const listeners = new Map();
  const timers = [];
  const focus = [];
  class Node {}
  class Element extends Node { closest() { return null; } }
  const inside = new Element();
  const trigger = { focus: (options) => focus.push(options) };
  const root = { contains: (target) => target === inside, querySelector: () => trigger };
  const refs = [{ current: root }, { current: undefined }];
  let refIndex = 0;
  let stateIndex = 0;
  const hooks = {
    useId: () => 'calendar-error-test',
    useEffect: (effect) => effects.push(effect),
    useRef: () => refs[refIndex++],
    useState: (initial) => {
      const index = stateIndex++;
      return [index === 0 ? open : typeof initial === 'function' ? initial() : initial, (next) => updates.push({ index, value: next })];
    }
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'date-fns/locale/es': { es: {} },
    'react-day-picker/style.css': {},
    'react-day-picker': { DayPicker: () => null },
    '../../lib/date-range': { inventoryDate: () => '2026-10-03' },
    './Select': { Select: () => null },
    './Icon': { Icon: () => null }
  };
  const exports = {};
  runInNewContext(compiled, {
    exports, Node, Element,
    require: (name) => { assert.ok(name in modules, 'Unexpected import: ' + name); return modules[name]; },
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name) => listeners.delete(name)
    },
    window: { setTimeout: (callback) => { timers.push(callback); return timers.length; } },
    clearTimeout: () => {}
  });
  const tree = exports.DatePicker({ label: 'Desde', value, allowFuture, onChange: (next) => changes.push(next) });
  const calendar = open ? tree.props.children[2].props.children.props : null;
  return { tree, calendar, changes, updates, listeners, timers, focus, inside, Element, commit: effects[1] };
}

test('empty optional dates show the localized placeholder without selecting today', () => {
  const fixture = setup();
  assert.equal(fixture.tree.props.children[1].props['aria-label'], 'Desde: Seleccionar fecha');
  assert.equal(fixture.calendar.selected, undefined);
});

test('malformed date values do not crash the shared calendar or its formatter', () => {
  for (const value of ['not-a-date', '2026-99-99', '2026-00-00']) {
    const fixture = setup({ value });
    assert.ok(Number.isFinite(fixture.calendar.selected.getTime()));
    assert.match(fixture.tree.props.children[1].props['aria-label'], /2026/);
  }
});

test('month and year selection updates only the displayed calendar, not the chosen date', () => {
  const fixture = setup({ value: '2026-10-03' });
  const captionElement = fixture.calendar.components.MonthCaption({ calendarMonth: { date: new Date(2026, 9, 1) } });
  const caption = captionElement.type(captionElement.props);
  caption.props.children[0].props.onChange('0');
  caption.props.children[1].props.onChange('2025');
  assert.deepEqual(fixture.changes, []);
  assert.equal(fixture.updates.length, 2);
  assert.equal(fixture.updates[0].value.getMonth(), 0);
  assert.equal(fixture.updates[1].value.getFullYear(), 2025);
});

test('pointer interaction with the portalled month select does not close the calendar', () => {
  const fixture = setup();
  const cleanup = fixture.commit();
  const portal = new fixture.Element();
  portal.closest = () => ({});
  fixture.listeners.get('pointerdown')({ target: portal });
  fixture.listeners.get('pointerdown')({ target: fixture.inside });
  assert.deepEqual(fixture.updates, []);
  fixture.listeners.get('pointerdown')({ target: new fixture.Element() });
  assert.equal(fixture.timers.length, 1);
  fixture.timers[0]();
  assert.ok(fixture.updates.some((update) => update.index === 0 && update.value === false));
  cleanup();
  assert.equal(fixture.listeners.size, 0);
});

test('Escape closes the calendar and restores focus, but respects Escape consumed by a select', () => {
  const fixture = setup();
  fixture.tree.props.onKeyDown({ key: 'Escape', defaultPrevented: true });
  assert.equal(fixture.timers.length, 0);
  let prevented = false;
  fixture.tree.props.onKeyDown({ key: 'Escape', defaultPrevented: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.focus[0].preventScroll, true);
});

test('a closed calendar registers no outside-pointer listener', () => {
  const fixture = setup({ open: false });
  assert.equal(fixture.commit(), undefined);
  assert.equal(fixture.listeners.size, 0);
});

test('expected-return calendars allow future navigation while ordinary calendars remain bounded', () => {
  assert.ok(Number.isFinite(setup().calendar.endMonth.getTime()));
  const fixture = setup({ allowFuture: true });
  assert.equal(fixture.calendar.endMonth, undefined);
  const captionElement = fixture.calendar.components.MonthCaption({ calendarMonth: { date: new Date(2026, 9, 1) } });
  const caption = captionElement.type(captionElement.props);
  const years = caption.props.children[1].props.options;
  assert.ok(years.some((option) => Number(option.value) > new Date().getFullYear()));
});
