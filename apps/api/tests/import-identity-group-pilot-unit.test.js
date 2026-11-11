import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { identityGroupDecisionDigest, identityGroupDecisionSchema } from '../src/imports/identity-group-decision-schemas.js';
import { buildIdentityGroupPlan } from '../src/imports/identity-group-plan.js';
import { identityGroupPilotSchema } from '../src/imports/identity-group-pilot-schemas.js';
import { buildIdentityGroupPilot } from '../src/imports/identity-group-pilot.js';
import { buildIdentityGroupProjection } from '../src/imports/identity-group-projection.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { numberCell, receptionRow, retirementRow, textCell, workbook } from './fixtures/workbook-preview.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture(extra = {}, sheet = 'Recepción', merged = false) {
  const row = sheet === 'Recepción' ? (position) => receptionRow(position, 'REPEATED', { K: textCell('Disponible'), ...extra })
    : (position) => retirementRow(sheet, position, 'REPEATED', extra);
  const original = workbook(sheet, [row(4), row(5)]);
  const baseline = buildWorkbookPreview(original, [], '2026-10-05');
  const context = { batchId: randomUUID(), batchVersion: 1, sourceContext: { revision: 0, corrections: [], identityRevisions: [] } };
  const proposal = { expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: baseline.candidates.map((entry) => entry.id), note: 'Independent physical labels',
    groups: baseline.records.map((record, index) => ({ groupId: randomUUID(), recordIds: [record.id], serialNumber: 'GROUP-PILOT-' + index,
      assetTag: record.tagKey, evidenceReference: 'Physical verification checklist' })) };
  if (merged) proposal.groups = [{ ...proposal.groups[0], recordIds: proposal.groups.flatMap((group) => group.recordIds) }];
  const saved = buildIdentityGroupPlan(original, original, [], context, proposal, undefined, '2026-10-05'); assert.equal(saved.proposalValidationComplete, true);
  const review = { id: randomUUID(), batchId: context.batchId, batchVersion: 1, sourceRevision: 0, sourceHash: original.source.sha256,
    planId: saved.planId, plan: saved, release: null, rows: [] };
  review.rows = saved.observations.map((observation) => ({ reviewId: review.id, recordId: observation.recordId, sourceHash: review.sourceHash,
    originalCandidateId: observation.originalCandidateId, groupId: observation.proposedGroupId, snapshot: clone(observation), isReserved: true }));
  const project = (existing = [], evidence = [], asOf = '2026-10-05', selectedReview = review) => buildIdentityGroupProjection(original, original, existing, context, selectedReview,
    { decisions: [], pilotItems: [], evidence }, asOf);
  const projection = project();
  const product = { id: randomUUID(), name: 'Group pilot notebook', trackingMode: 'ASSET', isActive: true,
    equipmentType: 'Notebook', brand: 'HP', model: 'Model G9', updatedAt: new Date('2026-01-01') };
  const decisionsFor = (current, action = 'PROPOSE_NEW', linkedAssetId = null) => current.groups.map((group, index) => {
    const groupAction = action === 'LINK_EXISTING' && index > 0 ? 'HOLD' : action;
    const linkedAsset = groupAction === 'LINK_EXISTING' ? linkedAssetId : null;
    const intent = identityGroupDecisionSchema.parse({ requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
      expectedDecisionVersion: index, expectedBatchVersion: current.batchVersion, expectedSourceRevision: current.sourceRevision,
      projectionId: current.projectionId, groupKey: group.groupKey, action: groupAction, ...(linkedAsset ? { linkedAssetId: linkedAsset } : {}),
      note: 'Independent group intent', evidenceReference: 'Reviewed physical and archival documents',
      evidenceReviews: group.evidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion,
        disposition: 'EXCLUDE_FROM_GROUP_PILOT', evidenceReference: 'Archive stays separate', note: 'Retain original captured link' })) });
    return { id: randomUUID(), reviewId: current.reviewId, version: index + 1, requestId: intent.requestId, requestDigest: identityGroupDecisionDigest(intent),
      rulesVersion: 'mda-identity-group-decision-1', groupId: group.groupId, groupKey: group.groupKey,
      batchVersion: current.batchVersion, sourceRevision: current.sourceRevision, projectionId: current.projectionId,
      projection: clone(current), action: groupAction, linkedAssetId: linkedAsset, note: intent.note, evidenceReference: intent.evidenceReference,
      evidenceReviews: intent.evidenceReviews, reviewedById: randomUUID(), createdAt: new Date('2026-10-05') };
  });
  const decisions = decisionsFor(projection);
  const inputFor = (current, currentDecisions, all = false) => identityGroupPilotSchema.parse({
    expectedBatchVersion: current.batchVersion, expectedSourceRevision: current.sourceRevision,
    expectedDecisionVersion: Math.max(0, ...currentDecisions.map((entry) => entry.version)), projectionId: current.projectionId,
    operations: current.groups.slice(0, all ? 25 : 1).map((group) => ({ type: 'CREATE_ASSET', groupKey: group.groupKey,
      decisionId: currentDecisions.find((entry) => entry.groupKey === group.groupKey)?.id ?? randomUUID(),
      note: 'Available unassigned physical asset', confirmation: 'AVAILABLE_UNASSIGNED',
      values: { productId: product.id, serialNumber: group.serialNumber, assetTag: group.assetTag, location: 'Bodega' } }))
  });
  const input = inputFor(projection, decisions);
  const plan = (change = {}) => buildIdentityGroupPilot(change.projection ?? projection, change.decisions ?? decisions,
    change.products ?? [product], change.assets ?? [], change.input ?? input);
  return { projection, project, product, decisions, decisionsFor, input, inputFor, plan, review };
}
const has = (plan, code) => plan.operations[0].blockers.some((entry) => entry.code === code);
function assetFor(f, status = 'AVAILABLE') {
  return { id: randomUUID(), productId: f.product.id, serialNumber: f.projection.groups[0].serialNumber, assetTag: null,
    status, isActive: true, updatedAt: new Date('2026-01-01'), product: { name: f.product.name },
    technicalCondition: null, usagePurpose: null, location: 'Old storage', sector: null, ipAddress: null, hostname: null, loanCode: null, notes: null };
}

test('group pilot consumption blocks only selected consumed groups and changes the plan digest without removing lineage', () => {
  const f = fixture(); const input = f.inputFor(f.projection, f.decisions, true);
  const baseline = buildIdentityGroupPilot(f.projection, f.decisions, [f.product], [], input);
  const applied = buildIdentityGroupPilot(f.projection, f.decisions, [f.product], [], input, [{ recordId: f.projection.groups[0].recordIds[0] }]);
  assert.equal(applied.planValidationComplete, false); assert.notEqual(applied.planId, baseline.planId);
  const consumed = applied.operations.find((entry) => entry.groupKey === f.projection.groups[0].groupKey);
  const original = baseline.operations.find((entry) => entry.groupKey === consumed.groupKey);
  assert.equal(consumed.blockers.some((entry) => entry.code === 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED'), true);
  assert.equal(applied.operations.find((entry) => entry.groupKey !== consumed.groupKey).valid, true);
  assert.deepEqual(consumed.source, original.source); assert.deepEqual(consumed.deduplication, original.deduplication);
});

test('group pilot DTO bounds operations and accepts only stable groups, exact receipts and non-operational metadata', () => {
  const f = fixture(); const operation = f.input.operations[0];
  const update = { type: 'UPDATE_METADATA', groupKey: operation.groupKey, decisionId: operation.decisionId,
    assetId: randomUUID(), note: 'Verified metadata', values: { location: null } };
  assert.equal(identityGroupPilotSchema.safeParse({ ...f.input, operations: [update] }).success, true);
  for (const change of [{ force: true }, { expectedDecisionVersion: -1 }, { expectedSourceRevision: '0' }, { operations: [] },
    { operations: Array(26).fill(operation) }, { operations: [operation, operation] },
    { operations: [{ ...operation, candidateId: 'a'.repeat(64) }] },
    { operations: [{ ...operation, confirmation: 'ASSIGNED' }] },
    { operations: [{ ...operation, values: { ...operation.values, status: 'AVAILABLE' } }] },
    { operations: [{ ...update, values: { serialNumber: 'New identity' } }] }, { operations: [{ ...update, values: {} }] },
    { operations: [{ ...update, values: { ipAddress: 'bad' } }] },
    { operations: [{ ...operation, acknowledgedWarnings: ['a'.repeat(64), 'a'.repeat(64)] }] }]) {
    assert.equal(identityGroupPilotSchema.safeParse({ ...f.input, ...change }).success, false, JSON.stringify(change));
  }
  const parsed = identityGroupPilotSchema.parse({ ...f.input, operations: [{ ...operation, decisionId: operation.decisionId.toUpperCase(),
    values: { ...operation.values, productId: f.product.id.toUpperCase() } }] }); assert.equal(parsed.operations[0].values.productId, f.product.id);
});

test('clean group pilot is deterministic and partial with complete selected row lineage and stable global deduplication keys', () => {
  const f = fixture(); const before = clone(f.projection); const result = f.plan();
  assert.equal(result.planValidationComplete, true); assert.equal(result.canApply, false); assert.equal(result.persisted, false); assert.equal(result.affectsCurrentState, false);
  assert.equal(result.groupedPilotPlanImplemented, true); assert.equal(result.groupedPilotImplemented, false);
  assert.equal(result.summary.omittedGroupCount, 1); assert.equal(result.summary.selectedObservationCount, 1);
  assert.equal(result.operations[0].source[0].originalCandidateId, f.projection.groups[0].originalCandidateIds[0]);
  assert.equal(result.operations[0].deduplication[0].recordId, result.operations[0].source[0].recordId);
  assert.equal(result.operations[0].changes.find((entry) => entry.field === 'serialNumber').after, f.projection.groups[0].serialNumber);
  assert.equal(result.planId, f.plan().planId); assert.deepEqual(f.projection, before);
  const all = f.inputFor(f.projection, f.decisions, true); const reversed = { ...all, operations: [...all.operations].reverse() };
  assert.equal(f.plan({ input: all }).planId, f.plan({ input: reversed }).planId);
  assert.equal(f.plan({ input: all }).summary.omittedGroupCount, 0);
  assert.notEqual(f.plan({ products: [{ ...f.product, updatedAt: new Date('2026-02-01') }] }).planId, result.planId);
});

test('group pilot requires current envelope versions, latest explicit receipt and independent operational intent', () => {
  const f = fixture();
  for (const [change, code] of [[{ expectedBatchVersion: 2 }, 'REVIEW_VERSION_CONFLICT'], [{ expectedSourceRevision: 1 }, 'SOURCE_REVISION_CONFLICT'],
    [{ expectedDecisionVersion: 1 }, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT'], [{ projectionId: '0'.repeat(64) }, 'IDENTITY_GROUP_PROJECTION_CHANGED']]) {
    assert.throws(() => f.plan({ input: { ...f.input, ...change } }), (error) => error.code === code);
  }
  assert.equal(has(f.plan({ decisions: [], input: { ...f.input, expectedDecisionVersion: 0 } }), 'GROUP_DECISION_REQUIRED'), true);
  assert.equal(has(f.plan({ input: { ...f.input, operations: [{ ...f.input.operations[0], decisionId: randomUUID() }] } }), 'GROUP_DECISION_NOT_LATEST'), true);
  for (const action of ['HOLD', 'EXCLUDE']) assert.equal(has(f.plan({ decisions: f.decisionsFor(f.projection, action) }), 'NEW_GROUP_ASSET_REVIEW_REQUIRED'), true);
  assert.throws(() => f.plan({ input: { ...f.input, operations: [{ ...f.input.operations[0], groupKey: f.projection.groups[0].simulatedCandidateIds[0] }] } }), (error) => error.code === 'INVALID_IDENTITY_GROUP_TARGET');
});

test('group pilot never silently renews stale decisions after a new projection or a new day', () => {
  const f = fixture(); const next = f.project([], [], '2026-10-06'); const input = f.inputFor(next, f.decisions);
  assert.equal(has(f.plan({ projection: next, input }), 'GROUP_DECISION_STALE'), true);
  assert.equal(f.plan({ projection: next, input }).operations[0].deduplication[0].key, f.plan().operations[0].deduplication[0].key);
  const fresh = f.decisionsFor(next);
  assert.equal(f.plan({ projection: next, decisions: fresh, input: f.inputFor(next, fresh) }).planValidationComplete, true);
});

test('group pilot catalog rules match the legacy pilot and reject inactive, quantity or inconsistent products', () => {
  const f = fixture();
  for (const [change, code] of [[{ isActive: false }, 'PRODUCT_INACTIVE'], [{ trackingMode: 'QUANTITY' }, 'PRODUCT_NOT_ASSET'],
    [{ equipmentType: 'Monitor' }, 'SELECTED_PRODUCT_EQUIPMENTTYPE_CONFLICT'], [{ brand: 'Dell' }, 'SELECTED_PRODUCT_BRAND_CONFLICT'], [{ model: 'Model G10' }, 'SELECTED_PRODUCT_MODEL_CONFLICT']]) {
    assert.equal(has(f.plan({ products: [{ ...f.product, ...change }] }), code), true);
  }
  assert.equal(has(f.plan({ products: [] }), 'PRODUCT_NOT_FOUND'), true);
});

test('group pilot cannot invent, drop or substitute verified physical identifiers', () => {
  const f = fixture(); const operation = f.input.operations[0];
  for (const values of [{ serialNumber: 'OTHER' }, { serialNumber: null }, { serialNumber: 'N/A' }, { assetTag: 'INVENTED' }]) {
    assert.equal(has(f.plan({ input: { ...f.input, operations: [{ ...operation, values: { ...operation.values, ...values } }] } }), 'GROUP_IDENTITY_MISMATCH'), true);
  }
  assert.equal(has(f.plan({ input: { ...f.input, operations: [{ ...operation, values: { ...operation.values, assetTag: 'N/A' } }] } }), 'IDENTITY_PLACEHOLDER_NOT_ALLOWED'), true);
  const lower = { ...operation, values: { ...operation.values, serialNumber: operation.values.serialNumber.toLowerCase() } };
  assert.equal(f.plan({ input: { ...f.input, operations: [lower] } }).planValidationComplete, true);
});

test('group pilot keeps unknown availability, outgoing use, office and retirement outside available creation', () => {
  for (const extra of [{ K: textCell('No Disponible') }, { K: textCell('') }, { M: textCell('2025-01-01') }, { N: textCell('OUT') }, { P: textCell('Sent to office') }]) {
    assert.equal(fixture(extra).plan().planValidationComplete, false);
  }
  assert.equal(has(fixture({}, 'Baja 2026').plan(), 'RETIREMENT_REQUIRES_SEPARATE_WORKFLOW'), true);
});

test('group pilot warnings require exact acknowledgement and cannot waive grouping blockers', () => {
  const f = fixture({ E: textCell('') }); const first = f.plan(); assert.equal(first.planValidationComplete, false);
  const warnings = first.operations[0].warnings.map((entry) => entry.id); assert.ok(warnings.length > 0);
  const input = { ...f.input, operations: [{ ...f.input.operations[0], acknowledgedWarnings: warnings }] };
  assert.equal(f.plan({ input }).planValidationComplete, true);
  assert.equal(has(f.plan({ input: { ...input, operations: [{ ...input.operations[0], acknowledgedWarnings: ['f'.repeat(64)] }] } }), 'UNKNOWN_WARNING_ACKNOWLEDGEMENT'), true);
  const blocked = { ...f.projection, projectionValidationComplete: false };
  assert.equal(has(f.plan({ projection: blocked, input }), 'IDENTITY_GROUP_PROJECTION_BLOCKED'), true);
});

test('group metadata pilot preserves assigned state and identity, distinguishes null and refuses no-op or wrong links', () => {
  const f = fixture(); const asset = assetFor(f, 'ASSIGNED'); const projection = f.project([asset]);
  const decisions = f.decisionsFor(projection, 'LINK_EXISTING', asset.id);
  const group = projection.groups[0];
  const input = { ...f.inputFor(projection, decisions), operations: [{ type: 'UPDATE_METADATA', groupKey: group.groupKey,
    decisionId: decisions[0].id, assetId: asset.id, note: 'Verified metadata only', acknowledgedWarnings: [], values: { location: null } }] };
  const result = f.plan({ projection, decisions, assets: [asset], input });
  assert.equal(result.planValidationComplete, true); assert.equal(result.operations[0].resultingStatus, 'ASSIGNED');
  assert.deepEqual(result.operations[0].changes, [{ field: 'location', before: 'Old storage', after: null }]);
  assert.equal(has(f.plan({ projection, decisions, assets: [asset], input: { ...input, operations: [{ ...input.operations[0], values: { location: 'Old storage' } }] } }), 'NO_METADATA_CHANGE'), true);
  assert.equal(has(f.plan({ projection, decisions, assets: [], input }), 'ASSET_NOT_FOUND'), true);
  assert.equal(has(f.plan({ projection, decisions, assets: [{ ...asset, isActive: false, status: 'DECOMMISSIONED' }], input }), 'ASSET_DECOMMISSIONED'), true);
  assert.equal(has(f.plan({ projection, decisions, assets: [asset], input: { ...input, operations: [{ ...input.operations[0], assetId: randomUUID() }] } }), 'EXISTING_GROUP_ASSET_REVIEW_REQUIRED'), true);
});

test('group pilot preserves evidence dispositions and explicit null but never applies or relinks archived history', () => {
  const f = fixture(); const group = f.projection.groups[0]; const evidence = { id: randomUUID(), recordId: group.recordIds[0],
    candidateId: group.originalCandidateIds[0], captureId: randomUUID(), captureBatchId: f.projection.batchId, capturedSourceRevision: 0,
    capturedAssetId: randomUUID(), currentAssetId: null, evidenceVersion: 1, amendmentId: randomUUID(), sourceRevision: 0, assignmentUse: null, retirementUse: null };
  const projection = f.project([], [evidence]); const decisions = f.decisionsFor(projection); const input = f.inputFor(projection, decisions);
  const result = f.plan({ projection, decisions, input }); assert.equal(result.planValidationComplete, true);
  assert.equal(result.operations[0].evidence[0].review.disposition, 'EXCLUDE_FROM_GROUP_PILOT');
  assert.equal(result.operations[0].evidence[0].currentAssetId, null); assert.equal(result.operations[0].evidence[0].capturedAssetId, evidence.capturedAssetId);
  assert.equal(result.operations[0].evidence[0].appliedByThisPlan, false); assert.equal(result.evidenceRelinked, false);
});

test('group pilot fails closed for corrupt immutable decision hashes, rules, ownership or duplicate latest rows', () => {
  const f = fixture(); const first = f.decisions[0];
  for (const change of [{ requestDigest: 'e'.repeat(64) }, { rulesVersion: 'unsupported' }, { reviewId: randomUUID() },
    { groupId: randomUUID() }, { projection: { ...first.projection, sourceHash: 'e'.repeat(64) } },
    { evidenceReviews: [{ evidenceId: randomUUID() }] }]) {
    assert.throws(() => f.plan({ decisions: [{ ...first, ...change }, ...f.decisions.slice(1)] }), (error) => error.code === 'INVALID_IDENTITY_GROUP_DECISION');
  }
  assert.throws(() => f.plan({ decisions: [first, first] }), (error) => error.code === 'INVALID_IDENTITY_GROUP_DECISION');
});

test('group pilot uses verified text without losing numeric original cell provenance', () => {
  const f = fixture({ F: numberCell(1234567890123) }); const result = f.plan();
  assert.equal(result.planValidationComplete, true);
  assert.equal(result.operations[0].source[0].originalIdentityCells.serialNumber.type, 'number');
  assert.equal(result.operations[0].source[0].originalIdentityCells.serialNumber.value, 1234567890123);
  assert.equal(result.operations[0].source[0].projectedIdentity.serialKey, f.projection.groups[0].serialNumber);
});

test('one multi-observation group plans one asset with complete unique source row coverage', () => {
  const f = fixture({}, 'Recepción', true); const result = f.plan();
  assert.equal(result.planValidationComplete, true); assert.equal(result.operations.length, 1);
  assert.equal(result.summary.selectedObservationCount, 2); assert.equal(result.operations[0].source.length, 2);
  assert.equal(result.operations[0].deduplication.length, 2);
  assert.equal(new Set(result.operations[0].deduplication.map((entry) => entry.key)).size, 2);
});

test('global source row deduplication keys survive a replacement review without transferring its group decisions', () => {
  const f = fixture(); const replacement = clone(f.review); replacement.id = randomUUID();
  for (const row of replacement.rows) row.reviewId = replacement.id;
  const projection = f.project([], [], '2026-10-05', replacement);
  assert.notEqual(projection.groups[0].groupKey, f.projection.groups[0].groupKey);
  assert.throws(() => f.plan({ projection, input: f.inputFor(projection, f.decisions) }), (error) => error.code === 'INVALID_IDENTITY_GROUP_DECISION');
  const decisions = f.decisionsFor(projection); const plan = f.plan({ projection, decisions, input: f.inputFor(projection, decisions) });
  assert.equal(plan.planValidationComplete, true); assert.equal(plan.operations[0].deduplication[0].key, f.plan().operations[0].deduplication[0].key);
});
