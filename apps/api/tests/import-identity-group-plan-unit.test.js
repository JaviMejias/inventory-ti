import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { buildWorkbookPreview } from '../src/imports/preview.js';
import { sheetDictionary } from '../src/imports/dictionary.js';
import { identityGroupPlanSchema } from '../src/imports/identity-group-plan-schemas.js';
import { buildIdentityGroupPlan } from '../src/imports/identity-group-plan.js';
import { buildResolvedPreview } from '../src/imports/identity.js';
import { numberCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

function fixture(rows = [receptionRow(4, 'REPEATED'), receptionRow(5, 'REPEATED')]) {
  const original = workbook('Recepción', rows); const preview = buildWorkbookPreview(original, [], '2026-10-05');
  const context = { batchId: randomUUID(), batchVersion: 1, sourceContext: { revision: 0, corrections: [], identityRevisions: [] } };
  const group = (recordIds, serialNumber, assetTag = null) => ({ groupId: randomUUID(), recordIds, serialNumber, assetTag, evidenceReference: 'Physical labels checked independently' });
  const input = identityGroupPlanSchema.parse({ expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: preview.candidates.map((candidate) => candidate.id), note: 'Physical grouping explicitly reviewed',
    groups: preview.records.slice(0, 25).map((record, index) => group([record.id], 'VERIFIED-' + index)) });
  const build = (change = {}) => buildIdentityGroupPlan(original, change.effective ?? original, change.existing ?? [], change.context ?? context,
    change.input ?? input, change.impacts, '2026-10-05');
  return { original, preview, context, input, group, build };
}
const codes = (plan) => plan.blockers.map((issue) => issue.code);

test('identity group plan DTO requires distinct bounded complete groups, explicit text identities and physical verification', () => {
  const { input } = fixture(); assert.equal(identityGroupPlanSchema.safeParse(input).success, true);
  for (const change of [{ force: true }, { expectedSourceRevision: undefined }, { confirmation: 'APPLY' }, { candidateIds: [...input.candidateIds, ...input.candidateIds] },
    { groups: [input.groups[0], input.groups[0]] }, { groups: [{ ...input.groups[0], serialNumber: 123 }] },
    { groups: [{ ...input.groups[0], serialNumber: null, assetTag: null }] }, { groups: [{ ...input.groups[0], serialNumber: 'N/A' }] },
    { groups: [{ ...input.groups[0], recordIds: [input.groups[0].recordIds[0], input.groups[0].recordIds[0]] }] },
    { groups: Array.from({ length: 26 }, () => ({ ...input.groups[0], groupId: randomUUID(), recordIds: ['a'.repeat(64)] })) }]) {
    assert.equal(identityGroupPlanSchema.safeParse({ ...input, ...change }).success, false);
  }
});

test('identity group plan splits explicitly verified observations, preserves original IDs/cells and never creates application targets', () => {
  const { original, preview, build } = fixture(); const snapshot = JSON.parse(JSON.stringify(original)); const plan = build();
  assert.equal(plan.operationKind, 'SPLIT'); assert.equal(plan.proposalValidationComplete, true);
  assert.equal(plan.summary.originalCandidateCount, 1); assert.equal(plan.summary.proposedGroupCount, 2);
  assert.equal(plan.canApply, false); assert.equal(plan.persisted, false); assert.equal(plan.affectsCurrentState, false);
  assert.equal(plan.lineagePersistenceImplemented, false); assert.equal(plan.nextWorkflow, 'LINEAGE_WORKFLOW_NOT_IMPLEMENTED');
  assert.equal(plan.originalCandidates[0].candidateId, preview.candidates[0].id); assert.deepEqual(original, snapshot);
  assert.equal(plan.changes[0].originalCell.value, 'REPEATED'); assert.equal(plan.changes[0].beforeCell.value, 'REPEATED');
  assert.equal(plan.changes[0].candidateId, preview.candidates[0].id);
  const simulated = JSON.parse(JSON.stringify(original));
  for (const change of plan.changes) simulated.sheets[0].rows.find((row) => row.row === change.row).cells[change.column] = change.afterCell;
  assert.throws(() => buildResolvedPreview(original, simulated), (error) => error.code === 'IDENTITY_GROUP_CHANGE_REQUIRES_REVIEW');
});

test('identity group plan supports proposed merge and repartition but routes unchanged grouping to the existing V8 workflow', () => {
  const merged = fixture([receptionRow(4, 'ONE'), receptionRow(5, 'TWO')]);
  const mergeInput = { ...merged.input, groups: [merged.group(merged.preview.records.map((record) => record.id), 'VERIFIED-SAME')] };
  const merge = merged.build({ input: mergeInput }); assert.equal(merge.operationKind, 'MERGE'); assert.equal(merge.proposalValidationComplete, true);
  assert.equal(merge.proposedGroups[0].originalCandidateIds.length, 2);
  const partition = fixture([receptionRow(4, 'ONE'), receptionRow(5, 'ONE'), receptionRow(6, 'TWO'), receptionRow(7, 'TWO')]);
  const ids = partition.preview.records.map((record) => record.id);
  const repartition = partition.build({ input: { ...partition.input, groups: [partition.group([ids[0], ids[2]], 'NEW-A'), partition.group([ids[1], ids[3]], 'NEW-B')] } });
  assert.equal(repartition.operationKind, 'REPARTITION'); assert.equal(repartition.proposalValidationComplete, true);
  const same = fixture(); const input = { ...same.input, groups: [same.group(same.preview.records.map((record) => record.id), 'REPEATED')] };
  const noChanges = same.build({ input }); assert.equal(noChanges.operationKind, 'IDENTITY_ONLY'); assert.equal(noChanges.summary.changedCellCount, 0);
  assert.equal(noChanges.nextWorkflow, 'V8_IDENTITY_REVIEW'); assert.equal(noChanges.canApply, false);
});

test('identity group plan requires all original observations exactly once and refuses headers, notes, external rows and overlarge scopes', () => {
  const { input, build } = fixture();
  for (const change of [{ candidateIds: ['f'.repeat(64)] }, { groups: [input.groups[0]] },
    { groups: [input.groups[0], { ...input.groups[1], recordIds: ['f'.repeat(64)] }] }]) {
    assert.throws(() => build({ input: { ...input, ...change } }), (error) => ['INVALID_SOURCE_TARGET', 'IDENTITY_GROUP_COVERAGE_REQUIRED'].includes(error.code));
  }
  const oversized = fixture(Array.from({ length: 26 }, (_, index) => receptionRow(index + 4, 'SAME')));
  // The public DTO is capped first; use a valid small request against an oversized original candidate.
  assert.throws(() => oversized.build({ input: { ...oversized.input, groups: oversized.input.groups.slice(0, 25) } }), (error) => error.code === 'IDENTITY_GROUP_SCOPE_LIMIT');
});

test('identity group plan does not silently absorb outside candidates or accept two declared groups with the same physical identifiers', () => {
  const { input, preview, build } = fixture([receptionRow(4, 'ONE'), receptionRow(5, 'OUTSIDE', { G: textCell('TAG-OUT') })]);
  const first = preview.candidates.find((candidate) => candidate.serials.includes('ONE'));
  const record = preview.records.find((entry) => entry.serialKey === 'ONE');
  const clash = build({ input: { ...input, candidateIds: [first.id], groups: [{ ...input.groups[0], recordIds: [record.id], serialNumber: 'OUTSIDE', assetTag: 'TAG-OUT' }] } });
  assert.ok(codes(clash).includes('IDENTITY_OVERLAP_OUTSIDE_SCOPE')); assert.ok(codes(clash).includes('PROPOSED_GROUP_NOT_REALIZABLE'));
  assert.equal(clash.proposedGroups[0].candidates[0].outsideRecordCount, 1);
  const same = fixture(); const colliding = same.build({ input: { ...same.input, groups: same.input.groups.map((group) => ({ ...group, serialNumber: 'IDENTICAL' })) } });
  assert.ok(codes(colliding).includes('PROPOSED_GROUP_NOT_REALIZABLE')); assert.equal(colliding.proposalValidationComplete, false);
});

test('identity group plan cannot drop populated original/current identity or invent missing contextual columns', () => {
  const populated = fixture([receptionRow(4, 'ONE', { G: numberCell(1234) })]);
  assert.ok(codes(populated.build()).includes('IDENTITY_CANNOT_DROP_SOURCE_VALUE'));
  const numeric = fixture([receptionRow(4, '', { F: numberCell(1600000000000) })]);
  const resolved = numeric.build(); assert.equal(resolved.proposalValidationComplete, true);
  assert.equal(resolved.changes[0].originalCell.type, 'number'); assert.equal(resolved.changes[0].afterCell.type, 'text');
  const raw = fixture(); const effective = JSON.parse(JSON.stringify(raw.original)); effective.sheets[0].rows[1].cells.G = textCell('ADDED-TAG');
  assert.ok(codes(raw.build({ effective })).includes('IDENTITY_CANNOT_DROP_SOURCE_VALUE'));
});

test('identity group plan preserves model/formula/state conflicts and existing operational identity ambiguity instead of treating a grouping as approval', () => {
  const conflict = fixture([receptionRow(4, 'ONE', { E: textCell('G9'), K: textCell('Disponible') }), receptionRow(5, 'TWO', { E: textCell('G10'), K: textCell('Baja'), L: { type: 'formula', value: '=1+1' } })]);
  const input = { ...conflict.input, groups: [conflict.group(conflict.preview.records.map((record) => record.id), 'NEW')] };
  const result = conflict.build({ input }); assert.ok(codes(result).includes('SOURCE_PRODUCT_MODEL_CONFLICT'));
  assert.ok(codes(result).includes('SOURCE_CROSS_SHEET_STATE_CONFLICT')); assert.ok(codes(result).includes('SOURCE_FORMULA_REQUIRES_REVIEW'));
  const same = fixture(); const asset = { id: randomUUID(), productId: randomUUID(), serialNumber: 'VERIFIED-0', assetTag: null, status: 'AVAILABLE', isActive: true,
    updatedAt: '2026-10-05T12:00:00Z', product: { name: 'Existing model' } };
  const ambiguous = same.build({ existing: [asset, { ...asset, id: randomUUID() }] }); assert.ok(codes(ambiguous).includes('SOURCE_AMBIGUOUS_EXISTING_ASSET'));
});

test('identity group plan exposes archived evidence/review impacts and blocks operational consumption from pilot, assignment or retirement', () => {
  const { input, build } = fixture();
  const evidence = { id: randomUUID(), recordId: input.groups[0].recordIds[0], candidateId: input.candidateIds[0], captureId: randomUUID(),
    capturedAssetId: null, currentAssetId: null, evidenceVersion: 0, amendmentId: null, sourceRevision: 0,
    captureBatchId: randomUUID(), capturedSourceRevision: 0, assignmentUse: null, retirementUse: null };
  const impacts = { pilotItems: [], decisions: [], evidence: [evidence] };
  const archived = build({ impacts }); assert.equal(archived.requiresEvidenceLineageReview, true); assert.equal(archived.proposalValidationComplete, true);
  for (const use of [{ assignmentUse: { itemId: randomUUID(), endpoint: 'START' } }, { retirementUse: { id: randomUUID(), assetId: randomUUID() } }]) {
    assert.ok(codes(build({ impacts: { ...impacts, evidence: [{ ...evidence, ...use }] } })).includes('SOURCE_OBSERVATION_ALREADY_APPLIED'));
  }
  const applied = build({ impacts: { ...impacts, pilotItems: [{ id: randomUUID(), candidateId: input.candidateIds[0], assetId: randomUUID(), applicationId: randomUUID() }] } });
  assert.ok(codes(applied).includes('SOURCE_CANDIDATE_ALREADY_APPLIED'));
});

test('identity group plan hash ignores request ordering but binds evidence, source versions, current database and rationale', () => {
  const { context, input, build } = fixture(); const first = build();
  assert.equal(build({ input: { ...input, candidateIds: [...input.candidateIds].reverse(), groups: [...input.groups].reverse() } }).planId, first.planId);
  assert.notEqual(build({ input: { ...input, note: 'Another verified rationale' } }).planId, first.planId);
  assert.notEqual(build({ context: { ...context, sourceContext: { ...context.sourceContext, revision: 1 } } }).planId, first.planId);
  const asset = { id: randomUUID(), productId: randomUUID(), serialNumber: 'VERIFIED-0', assetTag: null, status: 'AVAILABLE', isActive: true,
    updatedAt: '2026-10-05T12:00:00Z', product: { name: 'Current product' } };
  assert.notEqual(build({ existing: [asset] }).planId, first.planId);
});

test('identity group plan never adds an identity column missing from the contextual sheet mapping', () => {
  const mapping = sheetDictionary['NB Prestamo'];
  const serialColumn = Object.entries(mapping.columns).find(([, definition]) => definition.field === 'serialNumber')[0];
  assert.equal(Object.values(mapping.columns).some((definition) => definition.field === 'assetTag'), false);
  const original = workbook('NB Prestamo', [{ row: mapping.headerRow + 1, cells: { [serialColumn]: textCell('LOAN-SERIAL') } }]);
  const preview = buildWorkbookPreview(original); const base = fixture();
  const input = { ...base.input, candidateIds: preview.candidates.map((candidate) => candidate.id), groups: [base.group(preview.records.map((record) => record.id), 'VERIFIED-LOAN', 'VERIFIED-TAG')] };
  const result = buildIdentityGroupPlan(original, original, [], base.context, input);
  assert.ok(codes(result).includes('IDENTITY_FIELD_NOT_MAPPED')); assert.equal(result.proposalValidationComplete, false);
  assert.equal(result.observations[0].originalIdentityCells.assetTag, null); assert.equal(result.changes.some((change) => change.field === 'assetTag'), false);
});

test('identity group plan does not route identity swaps or candidates larger than twelve observations to incompatible V8 writes', () => {
  const swap = fixture([receptionRow(4, 'ONE'), receptionRow(5, 'TWO')]);
  const plan = swap.build({ input: { ...swap.input, groups: swap.input.groups.map((group, index) => ({ ...group, serialNumber: index === 0 ? 'TWO' : 'ONE' })) } });
  assert.equal(plan.operationKind, 'IDENTITY_ONLY'); assert.equal(plan.proposalValidationComplete, true);
  assert.equal(plan.requiresCoordinatedIdentityReview, true); assert.equal(plan.nextWorkflow, 'COORDINATED_IDENTITY_WORKFLOW_NOT_IMPLEMENTED');
  const large = fixture(Array.from({ length: 13 }, (_, index) => receptionRow(4 + index, 'SAME')));
  const oversized = large.build({ input: { ...large.input, groups: [large.group(large.preview.records.map((record) => record.id), 'VERIFIED-WHOLE')] } });
  assert.equal(oversized.operationKind, 'IDENTITY_ONLY'); assert.equal(oversized.nextWorkflow, 'IDENTITY_REVIEW_SCOPE_WORKFLOW_NOT_IMPLEMENTED');
  assert.equal(oversized.canApply, false);
});
