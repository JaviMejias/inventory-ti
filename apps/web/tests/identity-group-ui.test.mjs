import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { identityGroupFixture } from './fixtures/identity-group.mjs';

const stub = () => null;
function renderer() {
  const slots = []; let cursor = 0;
  const jsx = (type, props, key) => typeof type === 'function' && type.name === 'IdentityGroupResultTable' ? type(props) : { type, props, key };
  const modules = {
    react: { useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx }, '../../ui': { Alert: stub, Badge: stub, Icon: stub, DataTable: stub, EmptyState: stub, Pagination: stub },
    '../home/asset-status': { assetStatusLabels: { AVAILABLE: 'Disponible' } }, './import-issue-labels': { importIssueLabels: {} },
    './history-evidence-model': { historyDay: (value) => value }, './SourceEvidence': { IssueBadge: stub, OriginalCells: stub }
  };
  function load(path) { const exports = {}; runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; } }); return exports; }
  modules['./identity-group-model'] = load('../src/features/imports/identity-group-model.ts');
  modules['./identity-group-labels'] = load('../src/features/imports/identity-group-labels.ts');
  const component = load('../src/features/imports/IdentityGroupPlanDetails.tsx').IdentityGroupPlanDetails;
  return { render: (plan, fresh = true, groupOrder) => { cursor = 0; return component({ plan, fresh, groupOrder }); } };
}
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(2).flatMap(nodes)]; }
function text(node) { return nodes(node).flatMap((entry) => [entry.props?.children].flat(2)).filter((value) => typeof value === 'string' || typeof value === 'number').join(' '); }
test('split, merge, redistribution and identity-only results remain simulations with no application controls or approval claim', () => {
  const labels = { split: 'Separación', merge: 'Fusión', repartition: 'Redistribución', identity: 'Solo identidad' };
  for (const [fixture, label] of Object.entries(labels)) {
    const tree = renderer().render(identityGroupFixture(fixture).plan); const copy = text(tree);
    assert.ok(copy.includes(label)); assert.match(copy, /Simulación · sin guardar/); assert.match(copy, /no aprueba una importación/);
    assert.match(copy, /no es un activo/); assert.equal(nodes(tree).some((entry) => ['button', 'input', 'select'].includes(entry.type)), false);
    assert.doesNotMatch(copy, /Aplicar agrupación|Grupo guardado|Importación aprobada/);
  }
});
test('existing ambiguity, previous consumption and cross-batch evidence retain distinct provenance and null current links', () => {
  const f = identityGroupFixture('rich'); const tree = renderer().render(f.plan); const copy = text(tree);
  assert.match(copy, /12/); assert.match(copy, /hay más coincidencias/); assert.match(copy, /Sus comprobantes no se reinterpretan|Sus comprobantes|comprobantes no se reinterpretan/);
  const evidence = nodes(tree).find((node) => node.props?.caption === 'Evidencia archivada y usos anteriores' && node.props.rows);
  const row = evidence.props.rows[0]; const link = evidence.props.columns.find((column) => column.key === 'link').render(row);
  assert.ok(text(link).includes(row.capturedAssetId)); assert.match(text(link), /Sin vínculo/);
  const origin = evidence.props.columns.find((column) => column.key === 'origin').render(row);
  assert.ok(text(origin).includes(row.captureBatchId)); assert.ok(text(origin).includes('9'));
});
test('before/original identity cells keep numeric raw values and number formats instead of inferring digits', () => {
  const f = identityGroupFixture('numeric'); const tree = renderer().render(f.plan);
  const observations = nodes(tree).find((node) => node.props?.caption === 'Procedencia de las observaciones seleccionadas' && node.props.rows);
  const cell = observations.props.columns.find((column) => column.key === 'cells').render(observations.props.rows[0]);
  const original = nodes(cell).find((node) => node.props?.cells?.Serie);
  assert.equal(original.props.cells.Serie.value, 12); assert.equal(original.props.cells.Serie.rawValue, '0012'); assert.equal(original.props.cells.Serie.numberFormat, '000000');
  assert.equal(original.props.showRowAddress, false);
});
test('all large result sections page in25 while preserving the remaining records and complete blocker context', () => {
  const f = identityGroupFixture(); const plan = f.plan;
  plan.changes = Array.from({ length: 50 }, (_, index) => ({ ...f.plan.changes[0], recordId: String(index + 1).padStart(64, '0') }));
  plan.blockers = Array.from({ length: 27 }, () => ({ code: 'IDENTITY_OVERLAP_OUTSIDE_SCOPE', groupId: plan.request.groups[0].groupId }));
  plan.issues = Array.from({ length: 27 }, (_, index) => ({ code: 'QA_' + index, severity: index % 2 ? 'INFO' : 'BLOCKING', sheet: 'Recepción', row: index + 4, cell: null, candidateId: null }));
  plan.proposalValidationComplete = false;
  const r = renderer(); let tree = r.render(plan); let all = nodes(tree);
  const changes = all.find((node) => node.props?.caption === 'Cambios de identidad simulados, no guardados' && node.props.rows); assert.equal(changes.props.rows.length, 25);
  const pages = all.filter((node) => node.props?.pageCount === 2); assert.equal(pages.length, 3); pages.forEach((page) => page.props.onPageChange(2));
  tree = r.render(plan); all = nodes(tree);
  assert.equal(all.find((node) => node.props?.caption === 'Cambios de identidad simulados, no guardados' && node.props.rows).props.rows.length, 25);
  assert.equal(all.find((node) => node.props?.caption === 'Incidencias del análisis simulado' && node.props.rows).props.rows.length, 2);
  const block = all.find((node) => node.props?.['aria-label'] === 'Bloqueos de la agrupación'); assert.equal(nodes(block).filter((node) => node.type === 'li').length, 2);
  assert.match(text(block), /alcance/);
});
test('a changed draft is explicitly stale and informational issues keep their original level without consent controls', () => {
  const f = identityGroupFixture('rich'); const tree = renderer().render(f.plan, false); assert.match(text(tree), /Este resultado es anterior/);
  const table = nodes(tree).find((node) => node.props?.caption === 'Incidencias del análisis simulado' && node.props.rows);
  for (const row of table.props.rows) {
    const rendered = table.props.columns.find((column) => column.key === 'severity').render(row);
    assert.equal(nodes(rendered).find((node) => node.props?.issue)?.props.issue.severity, row.severity);
  }
  assert.equal(nodes(tree).some((node) => node.props?.label === 'Reconocimiento de advertencia'), false);
});
test('group numbers retain the reviewed creation order even when the server normalizes UUID order', () => {
  const f = identityGroupFixture(); const plan = f.plan; const originalOrder = [...plan.proposedGroups].reverse().map((group) => group.groupId);
  const tree = renderer().render(plan, true, originalOrder); const groups = nodes(tree).find((node) => node.props?.['aria-label'] === 'Grupos simulados');
  const first = nodes(groups).find((node) => node.type === 'summary');
  assert.match(text(first), /Grupo 1/); assert.ok(text(first).includes(plan.proposedGroups[1].serialNumber));
  assert.deepEqual(plan.proposedGroups.map((group) => group.groupId), [...originalOrder].reverse());
});
