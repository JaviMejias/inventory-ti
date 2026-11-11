import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';

function load(path, modules = {}) {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; } });
  return exports;
}
const dates = load('../src/lib/date-range.ts');
const model = load('../src/features/home/assignment-model.ts', { '../../lib/date-range': dates });
const badge = load('../src/ui/primitives/Badge.tsx', { 'react/jsx-runtime': jsxRuntime, '../utils': load('../src/ui/utils.ts') });
const provenance = load('../src/features/home/AssignmentHistoryProvenance.tsx', {
  'react/jsx-runtime': jsxRuntime, '../../lib/date-range': dates, '../../ui': badge,
  './assignment-model': model, './asset-status': load('../src/features/home/asset-status.ts')
});
const { AssignmentHistoryProvenance } = provenance;
const { AssignmentEventProvenance } = load('../src/features/home/AssignmentEventProvenance.tsx', {
  'react/jsx-runtime': jsxRuntime, '../../lib/date-range': dates, '../../ui': badge, './AssignmentHistoryProvenance': provenance,
  './assignment-model': model, './asset-status': load('../src/features/home/asset-status.ts')
});
function render(record) { return renderToStaticMarkup(jsxRuntime.jsx(AssignmentHistoryProvenance, { record })); }
function section(html, label) {
  const match = html.match(new RegExp('<section aria-label="' + label + '">([\\s\\S]*?)</section>'));
  assert.ok(match, label);
  return match[1];
}
function value(html, label) {
  const match = html.match(new RegExp('<dt>' + label + '</dt><dd>([\\s\\S]*?)</dd>'));
  assert.ok(match, label);
  return match[1];
}
function fixture(grouped = false) {
  const original = {
    id: 'assignment', personName: 'Persona original', recipientType: 'PERSON', officeName: null, assignmentType: 'STANDARD',
    startedAt: '2020-01-02T12:00:00.000Z', endedAt: '2020-02-03T15:00:00.000Z',
    expectedReturnAt: null, returnStatus: 'AVAILABLE', ticketReference: 'TK-original', otReference: 'OT-original', notes: 'Nota original',
    returnTicketReference: 'TK-entrada-original', returnOtReference: 'OT-entrada-original', returnNotes: 'Retorno original',
    createdBy: null, endedBy: null, importedHistory: true,
    createdAt: '2026-09-01T13:00:00.000Z', returnRecordedAt: '2026-09-01T13:01:00.000Z',
    importHistory: null, groupImportHistory: null
  };
  const application = { appliedById: 'original-importer', appliedAt: '2026-09-01T13:02:00.000Z' };
  if (grouped) original.groupImportHistory = {
    id: 'group-assignment-item', applicationId: 'group-receipt', periodId: 'group-period', startLinkId: 'start-link', endLinkId: 'end-link',
    evidenceUses: [{ evidenceId: 'start-evidence', linkId: 'start-link', endpoint: 'START' }, { evidenceId: 'end-evidence', linkId: 'end-link', endpoint: 'END' }],
    application: { ...application, itemId: 'group-item' }
  };
  else original.importHistory = {
    id: 'legacy-assignment-item', applicationId: 'legacy-receipt', periodId: 'legacy-period', startEvidenceId: 'start-evidence', endEvidenceId: 'end-evidence', application
  };
  return {
    ...original, recipientType: 'OFFICE', officeName: 'Oficina efectiva', personName: null, assignmentType: 'LOAN',
    startedAt: '2020-01-04T12:00:00.000Z', endedAt: '2020-02-05T15:00:00.000Z', expectedReturnAt: '2020-02-04T15:00:00.000Z',
    returnStatus: 'UNDER_REVIEW', ticketReference: 'TK-efectivo', otReference: 'OT-efectiva', notes: 'Nota efectiva',
    returnTicketReference: 'TK-entrada-efectivo', returnOtReference: 'OT-entrada-efectiva', returnNotes: 'Retorno efectivo',
    originalAssignment: original,
    historyCorrection: { id: 'same-correction-id', version: 2, correctedById: 'correction-author', correctedAt: '2026-10-01T14:00:00.000Z' }
  };
}

test('effective and original facts remain distinct across every presented historical field', () => {
  const record = fixture();
  const before = JSON.stringify(record);
  const html = render(record);
  const original = section(html, 'Registro original');
  const effective = section(html, 'Valores efectivos');
  for (const [label, oldValue, newValue] of [
    ['Destinatario', 'Persona original', 'Oficina efectiva'], ['Tipo de destinatario', 'Persona', 'Oficina'],
    ['Tipo de entrega', 'Entrega estándar', 'Préstamo'], ['Estado al devolver', 'Disponible', 'En revisión'],
    ['Ticket de salida', 'TK-original', 'TK-efectivo'], ['OT de salida', 'OT-original', 'OT-efectiva'],
    ['Ticket de entrada', 'TK-entrada-original', 'TK-entrada-efectivo'], ['OT de entrada', 'OT-entrada-original', 'OT-entrada-efectiva'],
    ['Observaciones de entrega', 'Nota original', 'Nota efectiva'], ['Observaciones de devolución', 'Retorno original', 'Retorno efectivo'],
    ['Entrega histórica', dates.formatInventoryDateTime(record.originalAssignment.startedAt), dates.formatInventoryDateTime(record.startedAt)],
    ['Devolución histórica', dates.formatInventoryDateTime(record.originalAssignment.endedAt), dates.formatInventoryDateTime(record.endedAt)],
    ['Devolución prevista', 'Fecha no informada', dates.formatInventoryDateTime(record.expectedReturnAt)]
  ]) {
    assert.equal(value(original, label), oldValue, label);
    assert.equal(value(effective, label), newValue, label);
  }
  assert.equal(JSON.stringify(record), before);
});

for (const grouped of [false, true]) test(`${grouped ? 'grouped V27' : 'legacy V34'} provenance separates evidence, capture and correction without inferring origin from correction ID`, () => {
  const record = fixture(grouped);
  const html = render(record);
  const origin = section(html, grouped ? 'Importación agrupada' : 'Importación legacy');
  assert.equal(value(html, 'Ejecutor histórico de entrega'), 'Ejecutor histórico desconocido');
  assert.equal(value(html, 'Ejecutor histórico de devolución'), 'Ejecutor histórico desconocido');
  assert.equal(value(html, 'Captura de entrega en la app'), dates.formatInventoryDateTime(record.createdAt));
  assert.equal(value(html, 'Captura de devolución en la app'), dates.formatInventoryDateTime(record.returnRecordedAt));
  assert.equal(value(origin, 'Registrado por \\(ID\\)'), 'original-importer');
  assert.equal(value(origin, 'Captura de importación'), dates.formatInventoryDateTime('2026-09-01T13:02:00.000Z'));
  for (const supplied of grouped
    ? ['group-receipt', 'group-assignment-item', 'group-item', 'group-period', 'start-link', 'end-link', 'start-evidence', 'end-evidence']
    : ['legacy-receipt', 'legacy-assignment-item', 'legacy-period', 'start-evidence', 'end-evidence']) assert.ok(origin.includes(supplied), supplied);
  assert.equal(html.includes(grouped ? 'Importación legacy' : 'Importación agrupada'), false);
  const correction = section(html, 'Rectificación histórica');
  assert.match(correction, /versión 2/);
  assert.equal(value(correction, 'Rectificación \\(ID\\)'), 'same-correction-id');
  assert.equal(value(correction, 'Rectificada por \\(ID\\)'), 'correction-author');
  assert.equal(value(correction, 'Captura de rectificación'), dates.formatInventoryDateTime(record.historyCorrection.correctedAt));
  assert.match(html, /America\/Santiago/);
  assert.doesNotMatch(html, /<(button|input|form|a)\b/);
});

test('ordinary old DTOs keep real actors and capture times with no import or correction claim', () => {
  const record = { id: 'old', personName: 'Ana Pérez', startedAt: '2025-01-01T12:00:00Z', endedAt: '2025-02-01T12:00:00Z', createdAt: '2025-01-02T12:00:00Z', returnRecordedAt: '2025-02-02T12:00:00Z', createdBy: { displayName: 'Operador entrega' }, endedBy: { displayName: 'Operador retorno' } };
  const html = render(record);
  assert.equal(model.isImportedAssignment(record), false);
  assert.equal(model.assignmentRecipient(record), 'Ana Pérez');
  assert.equal(value(html, 'Entrega realizada por'), 'Operador entrega');
  assert.equal(value(html, 'Devolución realizada por'), 'Operador retorno');
  assert.equal(value(html, 'Captura de entrega en la app'), dates.formatInventoryDateTime(record.createdAt));
  assert.doesNotMatch(html, /Periodo histórico importado|Procedencia de importación|Historia rectificada|Valores originales y efectivos/);
});

for (const grouped of [false, true]) test(`uncorrected ${grouped ? 'grouped V25' : 'legacy V11'} history preserves its receipt without inventing version zero`, () => {
  const record = fixture(grouped).originalAssignment;
  const html = render(record);
  assert.match(html, /Periodo histórico importado/);
  assert.ok(html.includes(grouped ? 'group-receipt' : 'legacy-receipt'));
  assert.equal(value(html, 'Registrado por \\(ID\\)'), 'original-importer');
  assert.doesNotMatch(html, /Historia rectificada|Rectificada por|Valores originales y efectivos|versión 0/);
});

test('nullable old import DTOs show unknowns without inventing provenance, correction or people', () => {
  const record = { id: 'old', personName: null, startedAt: '2020-01-01T12:00:00Z', endedAt: '2020-02-01T12:00:00Z', importedHistory: true, importHistory: null, groupImportHistory: null, createdBy: null, endedBy: null, historyCorrection: null, originalAssignment: null };
  const html = render(record);
  assert.equal(model.isImportedAssignment(record), true);
  assert.equal(model.assignmentRecipient(record), 'Destinatario no registrado');
  assert.equal(value(html, 'Captura de entrega en la app'), 'Fecha no informada');
  assert.equal(value(html, 'Captura de devolución en la app'), 'Fecha no informada');
  assert.match(html, /Procedencia de importación no informada/);
  assert.doesNotMatch(html, /Importación legacy|Importación agrupada|Historia rectificada|undefined|Invalid Date/);
});

test('supplied group provenance works without the older boolean flag and keeps historical actor names when supplied', () => {
  const record = fixture(true);
  delete record.importedHistory;
  record.createdBy = { displayName: 'Ejecutor conocido' };
  assert.equal(model.isImportedAssignment(record), true);
  const html = render(record);
  assert.equal(value(html, 'Ejecutor histórico de entrega'), 'Ejecutor conocido');
  assert.match(html, /Importación agrupada/);
});

test('incomplete correction metadata never falls back to importer or import time, and missing original stays unknown', () => {
  const record = fixture();
  record.historyCorrection = { id: 'correction', version: null, correctedById: null, correctedAt: null };
  delete record.originalAssignment;
  const html = render(record);
  const correction = section(html, 'Rectificación histórica');
  assert.match(correction, /versión no informada/);
  assert.equal(value(correction, 'Rectificada por \\(ID\\)'), 'No informado');
  assert.equal(value(correction, 'Captura de rectificación'), 'Fecha no informada');
  assert.doesNotMatch(correction, /original-importer/);
  assert.match(html, /Registro original no informado/);
  assert.doesNotMatch(html, /aria-label="Registro original"/);
});

test('missing original metadata is not filled from the effective record, and text remains escaped', () => {
  const record = fixture();
  record.originalAssignment = { id: 'assignment', personName: null, startedAt: '', endedAt: null, recipientType: undefined, assignmentType: undefined };
  record.notes = '<script>alert(1)</script>';
  const html = render(record);
  const original = section(html, 'Registro original');
  assert.equal(value(original, 'Ticket de salida'), 'No informado');
  assert.equal(value(original, 'Tipo de entrega'), 'No informado');
  assert.equal(value(original, 'Entrega histórica'), 'Fecha no informada');
  assert.doesNotMatch(original, /TK-efectivo|Oficina efectiva/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('active records keep the delivery capture and never invent a return or correction', () => {
  const html = render({ id: 'active', personName: 'Ana Pérez', startedAt: '2026-01-01T12:00:00Z', endedAt: null });
  assert.equal(value(html, 'Captura de entrega en la app'), 'Fecha no informada');
  assert.doesNotMatch(html, /Captura de devolución|Rectificación histórica|Periodo histórico importado/);
});

for (const returned of [false,true]) test(`timeline ${returned ? 'return' : 'delivery'} compares only the actual event and preserves original and effective references`,()=>{
  const record=fixture(true);
  const event={...record, action:returned?'ASSET_RETURNED':'ASSET_ASSIGNED',effectiveAt:returned?record.endedAt:record.startedAt,
    recipientName:record.personName,source:'IMPORTED_HISTORY',importScope:'GROUP_CLOSED_ASSIGNMENT_HISTORY',importGroupItemId:'group-item',
    ticketReference:returned?record.returnTicketReference:record.ticketReference,otReference:returned?record.returnOtReference:record.otReference,
    notes:returned?record.returnNotes:record.notes};
  const html=renderToStaticMarkup(jsxRuntime.jsx(AssignmentEventProvenance,{event}));
  const original=section(html,'Evento original');const effective=section(html,'Evento efectivo');
  assert.equal(value(original,'Destinatario'),'Persona original');assert.equal(value(effective,'Destinatario'),'Oficina efectiva');
  assert.equal(value(original,'Ticket'),returned?'TK-entrada-original':'TK-original');
  assert.equal(value(effective,'Ticket'),returned?'TK-entrada-efectivo':'TK-efectivo');
  assert.equal(value(original,returned?'Devolución histórica':'Entrega histórica'),dates.formatInventoryDateTime(returned?record.originalAssignment.endedAt:record.originalAssignment.startedAt));
  assert.equal(value(effective,returned?'Devolución histórica':'Entrega histórica'),dates.formatInventoryDateTime(event.effectiveAt));
  assert.equal(original.includes('<dt>Estado al devolver</dt>'),returned);
  assert.match(html,/Historia de identidad agrupada/);assert.match(html,/group-item/);assert.match(html,/correction-author/);
  assert.doesNotMatch(html,/<(button|form|input)\b/);
});
test('timeline optional legacy provenance stays unknown instead of inventing group origin, actor or opposite endpoint',()=>{
  const event={action:'ASSET_ASSIGNED',effectiveAt:'2020-01-02T12:00:00Z',source:'IMPORTED_HISTORY',historyCorrection:{id:'correction',version:null,correctedById:null,correctedAt:null}};
  const html=renderToStaticMarkup(jsxRuntime.jsx(AssignmentEventProvenance,{event}));
  assert.match(html,/Historia importada de activo/);assert.match(html,/Registro original no informado/);
  assert.doesNotMatch(html,/Historia de identidad agrupada|Ítem de grupo|Evento original|Evento efectivo|Invalid Date|undefined/);
});
