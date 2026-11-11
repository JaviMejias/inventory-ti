import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { pilotFixture } from './fixtures/import-pilot.mjs';
import { legacyPilotFixture } from './fixtures/legacy-pilot.mjs';

const stub = () => null;
const currentDetails = () => null;
const warnings = () => null;
const modules = {
  react: { useState: (initial) => [initial, stub] },
  'react/jsx-runtime': { jsx: node, jsxs: node },
  '../../lib/date-range': { formatInventoryDateTime: (value) => 'Captura: ' + value },
  '../../ui': { Alert: stub, Badge: stub, DataTable: stub, ListFooter: stub },
  '../home/asset-status': { assetStatusLabels: { AVAILABLE: 'Disponible', ASSIGNED: 'Asignado' } },
  './PilotPlanDetails': { ApplicationDetails: currentDetails }, './PilotWarnings': { PilotWarnings: warnings }
};
function node(type, props, key) {
  return typeof type === 'function' && ['LegacyPilotDetails', 'LegacyPilotSources'].includes(type.name) ? type(props) : { type, props, key };
}
function load(path, dependencies) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return exports;
}
modules['./pilot-model'] = load('../src/features/imports/pilot-model.ts', { '../home/inventory-metadata': load('../src/features/home/inventory-metadata.ts', {}) });
const { PilotApplicationReader } = load('../src/features/imports/PilotApplicationReader.tsx', modules);
function nodes(value) { return !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children].flat(2).flatMap(nodes)]; }
function text(value) { return nodes(value).flatMap((entry) => [entry.props?.children].flat(2)).filter((entry) => typeof entry === 'string' || typeof entry === 'number').join(' '); }

test('V6 reader shows original receipt, author, capture, plan and source without V7 defaults or write controls', () => {
  const { receipt } = legacyPilotFixture(); const before = JSON.stringify(receipt);
  const tree = PilotApplicationReader({ receipt }); const all = nodes(tree); const copy = text(tree);
  for (const value of [receipt.id, receipt.batchId, receipt.appliedById, receipt.createdAt, receipt.planId, receipt.sourceHash, receipt.requestId]) assert.ok(copy.includes(value), value);
  assert.match(copy, /solo lectura/); assert.match(copy, /anterior a las revisiones de origen V7/);
  assert.equal(all.some((entry) => entry.type === currentDetails), false);
  assert.equal(all.some((entry) => ['input', 'select', 'button', 'form'].includes(entry.type)), false);
  const savedWarnings = all.find((entry) => entry.type === warnings);
  assert.equal(savedWarnings.props.planned, receipt.plan.operations); assert.equal(savedWarnings.props.update, undefined);
  const table = all.find((entry) => entry.props?.caption === 'Resultados originales del piloto');
  assert.equal(table.props.rows, receipt.items);
  assert.equal(JSON.stringify(receipt), before);
  assert.equal(Object.hasOwn(receipt.plan, 'sourceRevision'), false);
});

test('current receipts still use the existing strict current renderer', () => {
  const fixture = pilotFixture(); const receipt = fixture.receiptFor({ requestId: 'request', planId: 'd'.repeat(64), plan: fixture.request });
  const tree = PilotApplicationReader({ receipt });
  assert.equal(tree.type, currentDetails); assert.equal(tree.props.receipt, receipt);
});

test('legacy source disclosures bound their first render and keep all remaining provenance reachable', () => {
  const { receipt } = legacyPilotFixture(1);
  receipt.plan.operations[0].source = Array.from({ length: 27 }, (_, index) => ({ recordId: index.toString(16).padStart(64, '0'), sheet: 'Recepción', row: index + 4 }));
  const all = nodes(PilotApplicationReader({ receipt }));
  assert.equal(all.filter((entry) => entry.type === 'li').length, 25);
  const footer = all.find((entry) => entry.props?.total === 27);
  assert.equal(footer.props.loaded, 25); assert.equal(footer.props.hasMore, true); assert.equal(typeof footer.props.onLoadMore, 'function');
  assert.equal(receipt.plan.operations[0].source.length, 27);
});
