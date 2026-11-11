import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { closedAssignmentFixture } from './fixtures/closed-assignment.mjs';

test('regenerating a closed plan gives independent keys to blocker and warning owners, without retaining previous DOM', () => {
  const source = readFileSync(new URL('../src/features/imports/ClosedAssignmentPlanDetails.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const jsx = (type, props, key) => ({ type, props, key });
  const stub = () => null;
  const pages=new Map();let ownerKey='';
  const modules = {
    react: { useState: (value) => { const key=ownerKey;return [pages.get(key)??value,next=>pages.set(key,next)]; } }, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../lib/date-range': { formatInventoryDateTime: (value) => value }, '../../ui': { Alert: () => null, Badge: stub, Field: stub, Pagination: stub, Select: stub },
    '../home/asset-status': { assetStatusLabels: { AVAILABLE: 'Disponible', UNDER_REVIEW: 'En revisión' } },
    './closed-assignment-labels': { closedBlockerLabel: stub }, './history-evidence-model': { historyDay: (value) => value, historyKindLabels: {} },
    './import-issue-labels': { importIssueLabels: {} }, './SourceEvidence': { IssueBadge: stub, SourceFields: stub }
  };
  const exports = {};
  runInNewContext(compiled, { exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; } });
  const fixture = closedAssignmentFixture(); const draft = fixture.draftFor();
  const period = { periodId: draft.periodId, confirmation: 'VERIFIED_CLOSED_ASSIGNMENT', start: { evidenceId: draft.startId, confirmedAt: draft.startAt, dateEvidenceReference: draft.startProof },
    end: { evidenceId: draft.endId, confirmedAt: draft.endAt, dateEvidenceReference: draft.endProof }, recipient: { type: 'PERSON', name: draft.recipientName },
    assignmentType: draft.assignmentType, returnStatus: draft.returnStatus, note: draft.note, evidenceReference: draft.reference, acknowledgedWarnings: [] };
  const plan = fixture.planFor({ periods: [period] });
  const tree = exports.ClosedAssignmentPlanDetails({ plan, fresh: true, recognized: [], disabled: false, recognize: stub });
  const keys = Array.from(tree.props.children).filter((entry) => entry?.key).map((entry) => entry.key);
  assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 2);
  const suffix=plan.planId+':'+period.periodId;
  assert.ok(keys.includes('blockers:' + suffix)); assert.ok(keys.includes('warnings:' + suffix));
  plan.periods[0].warnings = Array.from({ length: 27 }, (_, index) => ({ ...fixture.warning, id: (index + 1).toString(16).padStart(64, '0') }));
  plan.periods[0].blockers = Array.from({ length: 27 }, () => ({ code: 'EXACT_DATE_REQUIRED' }));
  const paged = exports.ClosedAssignmentPlanDetails({ plan, fresh: true, recognized: [], disabled: false, recognize: stub });
  function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(2).flatMap(nodes)]; }
  const renderOwner=owner=>{ownerKey=owner.key;return nodes(owner.type(owner.props));};
  const warningOwner = paged.props.children.find((entry) => entry?.key === 'warnings:' + suffix);
  const warningNodes = renderOwner(warningOwner);
  assert.equal(warningNodes.filter((entry) => entry.props?.label !== undefined).length, 25);
  assert.ok(warningNodes.some((entry) => entry.props?.pageCount === 2));
  const blockerOwner = paged.props.children.find((entry) => entry?.key === 'blockers:' + suffix);
  const blockerNodes = renderOwner(blockerOwner);
  assert.equal(blockerNodes.filter((entry) => entry.type === 'li').length, 25);
  assert.ok(blockerNodes.some((entry) => entry.props?.pageCount === 2));
  const applied = exports.ClosedAssignmentPlanDetails({ plan, fresh: true, recognized: [], disabled: true, recognize: stub, applied: true });
  const appliedNodes = nodes(applied);
  assert.equal(appliedNodes.filter((entry) => entry.type === modules['../../ui'].Alert).length, 0);
  assert.equal(appliedNodes.some((entry) => entry.props?.children === 'No guardado'), false);
  const savedWarningOwner = applied.props.children.find((entry) => entry?.key === 'warnings:' + suffix);
  const savedWarnings = renderOwner(savedWarningOwner);
  assert.equal(savedWarnings.filter((entry) => entry.type === 'li').length, 25);
  assert.equal(savedWarnings.filter((entry) => entry.props?.label !== undefined).length, 0);
  assert.ok(savedWarnings.some((entry) => entry.props?.pageCount === 2));
  for(const owner of [warningOwner,blockerOwner]){
    renderOwner(owner).find(node=>node.props?.pageCount===2).props.onPageChange(2);
    assert.equal(renderOwner(owner).filter(node=>node.type==='li'||owner===warningOwner&&node.props?.label!==undefined).length,2);
  }
  const next={...plan.periods[0],periodId:'00000000-0000-4000-8000-000000000999',warnings:[fixture.warning],blockers:[{code:'EXACT_DATE_REQUIRED'}]};
  plan.periods.push(next);
  const switched=exports.ClosedAssignmentPlanDetails({plan,periodId:next.periodId,fresh:true,recognized:[],disabled:false,recognize:stub});
  for(const prefix of ['warnings:','blockers:']){
    const owner=switched.props.children.find(entry=>entry?.key===prefix+plan.planId+':'+next.periodId);
    assert.ok(owner);const rows=renderOwner(owner);
    assert.equal(rows.filter(node=>prefix==='warnings:'?node.props?.label!==undefined:node.type==='li').length,1,'New period starts at first page');
  }
});
