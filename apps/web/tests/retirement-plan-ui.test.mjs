import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { retirementFixture } from './fixtures/retirement-plan.mjs';

test('retirement findings bound display to25, preserve blocker meaning/codes, require exact individual acknowledgements and explicitly clear obsolete IDs', () => {
  const jsx = (type, props, key) => ({ type, props, key }); const stub = () => null;
  const modules = {
    react: { useState: (value) => [value, stub] }, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../lib/date-range': { formatInventoryDateTime: (value) => value }, '../../ui': { Alert: stub, Badge: stub, Button: stub, Field: stub, Pagination: stub, Select: stub },
    '../home/asset-status': { assetStatusLabels: { AVAILABLE: 'Disponible' } }, './closed-assignment-labels': { closedBlockerLabel: (code) => 'Origen: ' + code },
    './history-evidence-model': { historyDay: (value) => value ?? 'Desconocida' }, './SourceEvidence': { IssueBadge: stub, SourceFields: stub }, './import-issue-labels': { importIssueLabels: {} }
  };
  const labels = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/imports/retirement-labels.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports: labels, require: (name) => modules[name] });
  modules['./retirement-labels'] = labels;
  const exports = {}; const source = readFileSync(new URL('../src/features/imports/RetirementPlanDetails.tsx', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; } });
  const f = retirementFixture(); const d = f.draftFor(); const plan = f.planFor({ evidenceId: d.evidenceId, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: d.confirmedAt,
    dateEvidenceReference: d.dateEvidenceReference, note: d.note, evidenceReference: d.reference, acknowledgedWarnings: [] });
  plan.warnings = Array.from({ length: 27 }, (_, index) => ({ ...f.warning, id: String(index + 1).padStart(64, '0') }));
  plan.blockers = Array.from({ length: 27 }, () => ({ code: 'ACTIVE_ASSIGNMENT_REQUIRES_RETURN', relatedId: 'assignment-id' }));
  const obsolete = 'f'.repeat(64); let recognition;
  function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(2).flatMap(nodes)]; }
  const tree = exports.RetirementPlanDetails({ plan, fresh: false, recognized: [obsolete], disabled: false, recognize: (ids) => { recognition = Array.from(ids); } });
  const all = nodes(tree); assert.equal(all.filter((node) => node.type === 'li').length, 25);
  assert.equal(all.filter((node) => node.props?.label === 'Reconocimiento de advertencia').length, 25);
  assert.equal(all.filter((node) => node.props?.pageCount === 2).length, 2);
  const field = all.find((node) => node.props?.label === 'Reconocimiento de advertencia'); field.props.children.props.onChange('yes'); assert.deepEqual(recognition, [obsolete, plan.warnings[0].id]);
  const remove = all.find((node) => node.props?.action?.props?.children === 'Retirar reconocimientos anteriores').props.action;
  remove.props.onClick(); assert.deepEqual(recognition, []);
  const literals = all.flatMap((node) => [node.props?.children].flat(2)).filter((value) => typeof value === 'string').join(' ');
  assert.match(literals, /El borrador o la consulta cambió/); assert.match(literals, /Existe una entrega vigente/); assert.match(literals, /ACTIVE_ASSIGNMENT_REQUIRES_RETURN/);
  assert.match(literals, /No guardado/); assert.match(literals, /No se atribuye al revisor/);
  assert.equal(all.some((node) => node.props?.children === 'Aplicar baja histórica'), false);
  const dialog = readFileSync(new URL('../src/features/imports/RetirementPlanDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /RetirementPlanDetails key=\{workflow.plan.planId\}/);
  assert.match(dialog, /noValidate/); assert.match(dialog, /resize-none/);
});
