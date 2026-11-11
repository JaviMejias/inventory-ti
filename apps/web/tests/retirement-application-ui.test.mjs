import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { retirementApplicationFixture } from './fixtures/retirement-application.mjs';

const stub = () => null;
const jsx = (type, props, key) => ({ type, props, key });
function render(path, component, props, extra = {}) {
  const modules = {
    react: { useState: (value) => [value, stub] }, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../lib/date-range': { formatInventoryDateTime: (value) => 'Fecha: ' + value },
    '../../ui': { Alert: stub, Badge: stub, Icon: stub, Button: stub, Field: stub, Pagination: stub, Select: stub },
    '../home/asset-status': { assetStatusLabels: { AVAILABLE: 'Disponible' } },
    './retirement-labels': { retirementBlockerLabel: (code) => code },
    './history-evidence-model': { historyDay: (value) => value ?? 'Desconocida' },
    './SourceEvidence': { IssueBadge: stub, SourceFields: stub }, './import-issue-labels': { importIssueLabels: {} },
    ...extra
  };
  const exports = {}; const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; } });
  return exports[component](props);
}
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(2).flatMap(nodes)]; }
function text(node) { return nodes(node).flatMap((entry) => [entry.props?.children].flat(2)).filter((value) => typeof value === 'string').join(' '); }

test('retirement receipt separates historical date, recorder and capture and reuses an applied read-only plan', () => {
  const fixture = retirementApplicationFixture();
  const tree = render('../src/features/imports/RetirementApplicationDetails.tsx', 'RetirementApplicationDetails', { application: fixture.receipt.application }, { './RetirementPlanDetails': { RetirementPlanDetails: stub } });
  const all = nodes(tree); const literals = text(tree);
  assert.ok(all.some((entry) => entry.props?.['data-retirement-application-result'] !== undefined && entry.props.tabIndex === -1));
  assert.match(literals, /Fecha: 2025-01-02/); assert.match(literals, /Fecha: 2026-10-05/);
  assert.match(literals, /Ejecutor del retiro histórico/); assert.match(literals, /Desconocido/); assert.match(literals, /permanente/);
  assert.match(literals, /stock por cantidad no|stock por cantidad ni/);
  const snapshot = all.find((entry) => entry.props?.plan);
  assert.equal(snapshot.props.applied, true); assert.equal(snapshot.props.disabled, true);
  assert.equal(all.some((entry) => entry.type === 'input' || entry.type === 'button'), false);
});

test('applied retirement snapshot never claims no changes or offers editable warning acknowledgements', () => {
  const fixture = retirementApplicationFixture(); const plan = fixture.plan;
  const tree = render('../src/features/imports/RetirementPlanDetails.tsx', 'RetirementPlanDetails', { plan, fresh: true, recognized: plan.request.acknowledgedWarnings, disabled: true, recognize: () => assert.fail('immutable snapshot'), applied: true });
  const literals = text(tree); assert.match(literals, /Revisión aplicada/); assert.match(literals, /Baja terminal registrada/);
  assert.match(literals, /Estado anterior a la aplicación/); assert.match(literals, /Reconocida al aplicar/);
  assert.doesNotMatch(literals, /No guardado|Sin cambios de estado o stock|aún no disponible/);
  assert.equal(nodes(tree).some((entry) => entry.props?.label === 'Reconocimiento de advertencia'), false);
});

test('V14 has an independent false default and guarded receipt consultation; applying requires V13 and a separate typed confirmation', () => {
  const environment = readFileSync(new URL('../src/config/environment.ts', import.meta.url), 'utf8');
  const inventory = readFileSync(new URL('../src/features/home/InventoryPage.tsx', import.meta.url), 'utf8');
  const dialog = readFileSync(new URL('../src/features/imports/RetirementPlanDialog.tsx', import.meta.url), 'utf8');
  assert.match(environment, /inventoryImportRetirementApplyV14: import\.meta\.env\.VITE_INVENTORY_IMPORT_RETIREMENT_APPLY_V14 === 'true'/);
  assert.match(inventory, /inventoryImportRetirementApplyV14 && product\.assetId && user && canReviewImports\(user\.role\)/);
  assert.match(inventory, /inventoryImportRetirementPlanV13 && user && canReviewImports\(user\.role\).*<RetirementPlanDialog/);
  assert.match(dialog, /confirmation !== 'DAR DE BAJA'/); assert.match(dialog, /workflow\.fresh/); assert.match(dialog, /application\.submitting\(\)/);
  assert.match(dialog, /if \(receipt\) onApplied\(receipt\)/); assert.match(dialog, /busy=\{application\.busy\}/); assert.match(dialog, /data-retirement-safe-action/);
});

test('read-only retirement receipts keep warning navigation available without enabling edits', () => {
  const fixture = retirementApplicationFixture(); const plan = fixture.plan;
  plan.warnings = Array.from({ length: 27 }, (_, index) => ({ ...fixture.review.warning, id: String(index + 1).padStart(64, '0') }));
  const tree = render('../src/features/imports/RetirementPlanDetails.tsx', 'RetirementPlanDetails', { plan, fresh: true, recognized: plan.warnings.map((entry) => entry.id), disabled: true, recognize: () => assert.fail('immutable receipt'), applied: true });
  const pages = nodes(tree).filter((entry) => entry.props?.pageCount === 2);
  assert.equal(pages.length, 1); assert.equal(pages[0].props.loading, false);
  assert.equal(text(tree).match(/Reconocida al aplicar/g)?.length, 25);
});
