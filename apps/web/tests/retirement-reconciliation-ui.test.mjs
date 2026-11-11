import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { retirementReconciliationFixture } from './fixtures/retirement-reconciliation.mjs';

const stub = () => null;
function renderer() {
  const slots = []; let cursor = 0;
  const jsx = (type, props, key) => typeof type === 'function' && type.name === 'ReceiptMetadata' ? type(props) : { type, props, key };
  const modules = {
    react: { useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx }, '../../lib/date-range': { formatInventoryDateTime: (value) => 'Fecha: ' + value },
    '../../ui': { Alert: stub, Badge: stub, Icon: stub, Pagination: stub }, '../home/asset-status': { assetStatusLabels: { AVAILABLE: 'Disponible', ASSIGNED: 'Asignado', DECOMMISSIONED: 'Dado de baja' } },
    './history-evidence-model': { historyDay: (value) => value ?? 'Fecha desconocida', historyKindLabels: { RETIREMENT_OBSERVATION: 'Baja indicada' } },
    './import-issue-labels': { importIssueLabels: {} }, './SourceEvidence': { IssueBadge: stub, SourceFields: stub },
    './closed-assignment-labels': { closedBlockerLabel: (code) => 'Origen: ' + code }
  };
  function load(path) {
    const exports = {}; runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; } }); return exports;
  }
  modules['./retirement-reconciliation-model'] = load('../src/features/imports/retirement-reconciliation-model.ts');
  modules['./retirement-labels'] = load('../src/features/imports/retirement-labels.ts');
  const exports = load('../src/features/imports/RetirementReconciliationDetails.tsx');
  return { render: (assessment, fresh = true) => { cursor = 0; return exports.RetirementReconciliationDetails({ assessment, fresh }); }, labels: modules['./retirement-reconciliation-model'].retirementClassificationLabels };
}
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(2).flatMap(nodes)]; }
function text(node) { return nodes(node).flatMap((entry) => [entry.props?.children].flat(2)).filter((value) => typeof value === 'string').join(' '); }
test('each classification is readable Spanish, preserves uncertainty, and never offers application or warning consent', () => {
  const f = retirementReconciliationFixture(); const r = renderer();
  for (const [code, label] of Object.entries(r.labels)) {
    const tree = r.render(f.assessmentFor(code)); const copy = text(tree);
    assert.ok(copy.includes(label)); assert.match(copy, /Solo consulta/); assert.match(copy, /Fecha y ejecutor históricos desconocidos/);
    assert.match(copy, /no confirma la fecha desconocida/); assert.match(copy, /no reconoce estas advertencias/);
    assert.equal(nodes(tree).some((entry) => ['button', 'input', 'select'].includes(entry.type)), false);
  }
});
test('diagnostic and warning pages show25 then the remaining2 without acknowledging or dropping source blockers', () => {
  const f = retirementReconciliationFixture(); const r = renderer(); const assessment = f.assessmentFor();
  assessment.diagnostics = Array.from({ length: 27 }, (_, index) => ({ code: 'SOURCE_DIAGNOSTIC_' + index }));
  assessment.warnings = Array.from({ length: 27 }, (_, index) => ({ ...assessment.warnings[0], id: String(index + 1).padStart(64, '0') }));
  let tree = r.render(assessment); let all = nodes(tree); let diagnostic = all.find((entry) => entry.props?.['aria-label'] === 'Incidencias de la conciliación');
  assert.equal(nodes(diagnostic).filter((entry) => entry.type === 'li').length, 25);
  const pages = all.filter((entry) => entry.props?.pageCount === 2); assert.equal(pages.length, 2); pages.forEach((page) => page.props.onPageChange(2));
  tree = r.render(assessment); all = nodes(tree); diagnostic = all.find((entry) => entry.props?.['aria-label'] === 'Incidencias de la conciliación');
  assert.equal(nodes(diagnostic).filter((entry) => entry.type === 'li').length, 2); assert.match(text(diagnostic), /SOURCE_DIAGNOSTIC_26/);
  assert.equal(all.filter((entry) => entry.props?.issue).length, 2);
});
test('shared receipt renders once; a different evidence receipt remains separate and clearly belongs to another asset', () => {
  const f = retirementReconciliationFixture(); const r = renderer(); const same = r.render(f.assessmentFor('ALREADY_IMPORTED_RETIREMENT'));
  assert.equal(nodes(same).filter((entry) => String(entry.props?.['aria-label']).startsWith('Comprobante')).length, 1);
  const different = f.assessmentFor('EXISTING_IMPORTED_RETIREMENT'); different.evidenceApplication = f.assessmentFor('EVIDENCE_ALREADY_USED').evidenceApplication;
  const tree = r.render(different); assert.equal(nodes(tree).filter((entry) => String(entry.props?.['aria-label']).startsWith('Comprobante')).length, 2);
  assert.match(text(tree), /Pertenece a otro activo/); assert.match(text(tree), /Captura en la app/); assert.match(text(tree), /no es el ejecutor histórico/);
});
test('stale and invalid current dates stay visibly unconfirmed rather than becoming a verified source date', () => {
  const f = retirementReconciliationFixture(); const r = renderer(); const assessment = f.assessmentFor('EXISTING_DATED_RETIREMENT');
  assessment.existingRetirement.effectiveAt = '1800-01-01T00:00:00.000Z'; assessment.diagnostics.push({ code: 'CURRENT_RETIREMENT_DATE_UNCONFIRMED' });
  const tree = r.render(assessment, false); assert.match(text(tree), /Este diagnóstico es anterior/); assert.match(text(tree), /fecha por revisar/); assert.match(text(tree), /anterior a 1900/);
});
