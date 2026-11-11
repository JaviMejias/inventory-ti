import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { legacyClosedApplicationFixture } from './fixtures/legacy-closed-application.mjs';
import { closedApplicationFixture } from './fixtures/closed-application.mjs';

const jsx = (type, props, key) => ({ type, props, key });
const noop = () => {};
const ui = { Alert: () => null, Badge: () => null, Pagination: () => null };
const fields = { IssueBadge: () => null, SourceFields: () => null };
const dates = { formatInventoryDateTime: (value) => 'Chile: ' + value };
function component(path, modules) {
  const source = readFileSync(new URL('../src/features/imports/' + path + '.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; } });
  return exports;
}
const legacy = component('LegacyClosedApplicationPeriods', {
  react: { useState: (value) => [value, noop] }, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../lib/date-range': dates, '../../ui': ui,
  '../home/asset-status': { assetStatusLabels: { AVAILABLE: 'Disponible', UNDER_REVIEW: 'En revisión' } },
  './history-evidence-model': { historyDay: (value) => value ?? 'Fecha desconocida', historyKindLabels: { USAGE_OBSERVATION: 'Uso observado', RECEIPT_OBSERVATION: 'Recepción observada' } },
  './SourceEvidence': fields
});
const currentDetails = () => null;
const shared = component('ClosedApplicationDetails', {
  'react/jsx-runtime': { jsx, jsxs: jsx }, '../../lib/date-range': dates, '../../ui': ui,
  './LegacyClosedApplicationPeriods': legacy, './ClosedAssignmentPlanDetails': { ClosedAssignmentPlanDetails: currentDetails }
});
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(3).flatMap(nodes)]; }
function text(node) { return !node || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : [node.props?.children].flat(3).map(text).join(' '); }

test('shared saved/read result discriminates rules1 without handing it to current plan UI; current receipts keep their renderer', () => {
  const application = legacyClosedApplicationFixture().application;
  const tree = shared.ClosedApplicationDetails({ application }); const all = nodes(tree); const content = text(tree);
  const owner = all.find((node) => node.type === legacy.LegacyClosedApplicationPeriods);
  assert.equal(owner.props.application, application); assert.equal(all.some((node) => node.type === currentDetails), false);
  assert.match(content, /Ejecutores de entrega y devolución antiguas/); assert.match(content, /Desconocidos/);
  assert.ok(content.includes(application.appliedById)); assert.ok(content.includes(application.appliedAt));
  assert.ok(all.some((node) => Object.hasOwn(node.props ?? {}, 'data-closed-application-result') && node.props.tabIndex === -1));
  const current = nodes(shared.ClosedApplicationDetails({ application: closedApplicationFixture().receipt.application }));
  assert.ok(current.some((node) => node.type === currentDetails && node.props.applied === true));
  assert.equal(current.some((node) => node.type === legacy.LegacyClosedApplicationPeriods), false);
});

test('legacy period UI exposes exact original dates, capture provenance and unknown source date with no correction or replay controls', () => {
  const application = legacyClosedApplicationFixture().application;
  const original = globalThis.structuredClone(application);
  const tree = legacy.LegacyClosedApplicationPeriods({ application }); const all = nodes(tree); const content = text(tree);
  assert.match(content, /Solo lectura/); assert.match(content, /versiones de evidencia ni enmiendas/); assert.match(content, /datos son desconocidos/);
  assert.ok(content.includes(application.items[0].snapshot.start.confirmedAt)); assert.ok(content.includes(application.items[0].snapshot.end.confirmedAt));
  assert.match(content, /Fecha desconocida/); assert.match(content, /revisión de origen al capturar/);
  assert.ok(content.includes(application.items[0].snapshot.sources[0].snapshotDigest));
  assert.ok(content.includes(application.items[0].snapshot.sources[0].captureId));
  assert.ok(content.includes(application.items[0].snapshot.sources[0].candidateId));
  assert.ok(content.includes(application.plan.planId)); assert.ok(content.includes(application.plan.planRulesVersion));
  assert.doesNotMatch(content, /v0|Sin enmienda|Enmienda vigente|No guardado|Corregir|Recuperar|Reaplicar/);
  assert.equal(all.some((node) => ['input', 'select', 'form', 'button'].includes(node.type)), false);
  assert.equal(all.filter((node) => node.type === fields.SourceFields).length, 2);
  assert.equal(all.find((node) => node.type === fields.SourceFields).props.fields, application.items[0].snapshot.sources[0].fields);
  assert.deepEqual(application, original);
});

test('legacy warnings preserve original severity/context, paginate at 25 and never expose editable acknowledgements', () => {
  const application = legacyClosedApplicationFixture().application;
  const period = application.items[0].snapshot;
  period.warnings = Array.from({ length: 27 }, (_, index) => ({ ...period.warnings[0], id: index.toString(16).padStart(64, '0') }));
  const tree = legacy.LegacyClosedApplicationPeriods({ application });
  const owner = nodes(tree).find((node) => typeof node.type === 'function' && node.props.period);
  const warnings = owner.type(owner.props); const all = nodes(warnings);
  assert.equal(all.filter((node) => node.type === 'li').length, 25);
  assert.equal(all.filter((node) => node.type === fields.IssueBadge).length, 25);
  assert.equal(all.find((node) => node.type === fields.IssueBadge).props.issue.severity, 'BLOCKING');
  assert.match(text(warnings), /Contexto; no elimina la incidencia/);
  assert.ok(all.some((node) => node.type === ui.Pagination && node.props.pageCount === 2));
  assert.equal(all.some((node) => node.props.onChange || node.props.recognize), false);
});
