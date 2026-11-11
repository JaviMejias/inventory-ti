import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { groupRetirementReconciliationSchema } from '../src/imports/group-retirement-reconciliation-schemas.js';
import { buildGroupRetirementReconciliation } from '../src/imports/group-retirement-reconciliation.js';
import { validateIdentityGroupReview, validateIdentityGroupReviewLineage } from '../src/imports/identity-group-projection.js';
import { importPlanDigest } from '../src/imports/plan.js';
import { groupRetirementPlanFixture } from './fixtures/group-retirement-plan.js';

function fixture(terminal = true) {
  const f = groupRetirementPlanFixture();
  if (terminal) Object.assign(f.asset, { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2005-01-01') });
  const saved = validateIdentityGroupReviewLineage(f.review, f.source, '2026-10-20');
  const context = { review: f.review, saved, batchVersion: 1, sourceRevision: 0, identityRevisedRecordIds: [], reviewSourceRevisedRecordIds: [], asset: f.asset, evidence: f.evidence,
    assignments: [], revisions: [], consumption: [], reservations: f.review.rows.map((row) => ({ recordId: row.recordId, reviewId: f.review.id, groupId: row.groupId })),
    receipts: [], documents: [], latestDecision: null };
  const input = { groupKey: f.input.groupKey, assetId: f.asset.id, evidenceId: f.retirement.id };
  return { ...f, context, input, build: () => buildGroupRetirementReconciliation(context, input, f.now) };
}
function receipt(f, origin = 'GROUP') {
  return { id: randomUUID(), assetId: f.asset.id, evidenceId: f.retirement.id, evidenceVersion: 0, amendmentId: null, sourceRevision: 0,
    decommissionedAt: f.asset.decommissionedAt, appliedAt: f.now, appliedById: randomUUID(), origin,
    ...(origin === 'GROUP' ? { batchId: f.review.batchId, reviewId: f.review.id, groupId: f.projection.groups[0].groupId, groupKey: f.input.groupKey } : {}) };
}
const codes = (assessment) => assessment.diagnostics.map((issue) => issue.code);
test('group retirement reconciliation DTO permits only a diagnostic group, asset and evidence selection', () => {
  const f = fixture(); assert.equal(groupRetirementReconciliationSchema.safeParse(f.input).success, true);
  assert.equal(groupRetirementReconciliationSchema.parse({ ...f.input, assetId: f.asset.id.toUpperCase() }).assetId, f.asset.id);
  for (const change of [{ groupKey: 'invalid' }, { assetId: 'invalid' }, { evidenceId: 'invalid' }, { force: true }, { confirmation: 'APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT' },
    { confirmedAt: '2005-01-01' }, { note: 'Approve without proof' }, { acknowledgedWarnings: [] }, { planId: 'a'.repeat(64) }]) {
    assert.equal(groupRetirementReconciliationSchema.safeParse({ ...f.input, ...change }).success, false);
  }
});
test('historical group lineage validation accepts released rows without restoring active projection authority', () => {
  const f = fixture(); f.review.release = { id: randomUUID() }; f.review.rows.forEach((row) => { row.isReserved = false; });
  assert.equal(validateIdentityGroupReviewLineage(f.review, f.source, '2026-10-20').planId, f.review.planId);
  assert.throws(() => validateIdentityGroupReview(f.review, f.source, '2026-10-20'), (error) => error.code === 'IDENTITY_GROUP_ALREADY_RELEASED');
  f.review.rows[0].isReserved = true;
  assert.throws(() => validateIdentityGroupReviewLineage(f.review, f.source, '2026-10-20'), (error) => error.code === 'INVALID_IDENTITY_GROUP_REVIEW');
});
test('historical group lineage validation still rejects altered hashes, physical coverage and sealed snapshots', () => {
  for (const mutate of [(f) => { f.review.planId = 'f'.repeat(64); }, (f) => { f.review.rows.pop(); },
    (f) => { f.review.rows[0].snapshot = {}; }, (f) => { f.review.rows[0].isReserved = false; }]) {
    const f = fixture(); mutate(f); assert.throws(() => validateIdentityGroupReviewLineage(f.review, f.source, '2026-10-20'), (error) => error.code === 'INVALID_IDENTITY_GROUP_REVIEW');
  }
});
test('group retirement reconciliation preserves unknown source dates and dated or undated current terminals without inventing authority', () => {
  const f = fixture(); const before = importPlanDigest(f.context); const result = f.build();
  assert.equal(result.classification, 'EXISTING_DATED_RETIREMENT'); assert.equal(result.currentState, 'TERMINAL_DATED');
  assert.equal(result.currentEvidence.assetId, null); assert.equal(result.sourceRetirement.effectiveAt, null); assert.equal(result.sourceRetirement.historicalActorId, null);
  assert.equal(result.diagnosticEvidenceProjection.linkBasis.authorizationGranted, false); assert.equal(result.currentLinkAuthorized, false);
  assert.equal(result.planId, undefined); assert.equal(result.canApply, false); assert.equal(result.persisted, false); assert.equal(result.affectsCurrentState, false);
  assert.equal(result.evidenceRelinked, false); assert.equal(result.documentConfirmationImplemented, false); assert.equal(result.operationalResolutionImplemented, false);
  assert.equal(importPlanDigest(f.context), before); assert.equal(f.build().assessmentId, result.assessmentId);
  f.asset.decommissionedAt = null; const unknown = f.build(); assert.equal(unknown.classification, 'EXISTING_UNDATED_RETIREMENT');
  assert.equal(unknown.existingRetirement.effectiveAt, null); assert.equal(unknown.existingRetirement.confirmsSourceDate, false);
  f.context.documents = [{ id: randomUUID(), assetId: randomUUID(), evidenceId: f.retirement.id, evidenceVersion: 0, amendmentId: null,
    sourceRevision: 0, planId: 'a'.repeat(64), recordedById: randomUUID(), recordedAt: f.now }];
  const documented = f.build(); assert.notEqual(documented.assessmentId, unknown.assessmentId); assert.equal(documented.documentAssociations.length, 1);
  assert.equal(documented.currentLinkAuthorized, false); assert.equal(documented.sourceRetirement.effectiveAt, null);
});
test('group retirement reconciliation leaves nonterminal evidence pending and never relabels reception as a retirement', () => {
  const f = fixture(false); const result = f.build(); assert.equal(result.currentState, 'NONTERMINAL'); assert.equal(result.classification, 'RETIREMENT_DATE_UNCONFIRMED');
  assert.equal(result.existingRetirement, null); assert.ok(codes(result).includes('EXACT_RETIREMENT_DATE_REQUIRED'));
  f.input.evidenceId = f.evidence.find((entry) => entry.kind === 'RECEIPT_OBSERVATION').id;
  const reception = f.build(); assert.equal(reception.sourceRetirement, null); assert.ok(codes(reception).includes('RETIREMENT_EVIDENCE_KIND_REQUIRED'));
});
test('group retirement reconciliation separates a consumed physical row from the single evidence actually used for retirement', () => {
  const f = fixture(); const applied = receipt(f); f.context.receipts = [applied];
  f.context.consumption = f.review.rows.map((row) => ({ sourceHash: f.review.sourceHash, recordId: row.recordId, reviewId: f.review.id,
    applicationId: applied.id, batchId: f.review.batchId, assetId: f.asset.id, origin: 'GROUP_RETIREMENT' }));
  assert.equal(f.build().classification, 'ALREADY_GROUP_IMPORTED_RETIREMENT'); assert.equal(f.build().evidenceState, 'USED_FOR_THIS_RETIREMENT');
  f.input.evidenceId = f.evidence.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION' && entry.id !== f.retirement.id).id;
  const omitted = f.build(); assert.equal(omitted.classification, 'EXISTING_GROUP_IMPORTED_RETIREMENT'); assert.equal(omitted.evidenceState, 'SOURCE_ROW_CONSUMED');
  assert.equal(omitted.sourceRowState, 'CONSUMED'); assert.equal(omitted.sourceRetirement.effectiveAt, null);
  assert.equal(omitted.links[0].url, `/inventory/imports/batches/${applied.batchId}/identity-group-reviews/${applied.reviewId}/retirement-applications/${applied.id}`);
});
test('group retirement reconciliation exposes conflicting consumption and foreign reservation without changing either', () => {
  const f = fixture(); f.context.consumption = [{ sourceHash: f.review.sourceHash, recordId: f.retirement.recordId, reviewId: randomUUID(), applicationId: randomUUID(),
    batchId: randomUUID(), assetId: randomUUID(), origin: 'GROUP_ASSET_PILOT' }];
  f.context.reservations[0].reviewId = randomUUID(); const before = importPlanDigest(f.context); const result = f.build();
  assert.equal(result.classification, 'GROUP_SOURCE_CONSUMPTION_REVIEW_REQUIRED'); assert.equal(result.sourceRowState, 'PARTIALLY_CONSUMED');
  assert.ok(codes(result).includes('GROUP_SOURCE_RESERVED_BY_ANOTHER_REVIEW')); assert.equal(importPlanDigest(f.context), before);
});
test('group retirement reconciliation exposes all archive conflicts and preserves foreign retirement receipt parents', () => {
  const f = fixture(); const other = f.evidence.find((entry) => entry.id !== f.retirement.id);
  other.snapshot.issues.push({ code: 'ARCHIVE_CONFLICT', severity: 'BLOCKING', sheet: null, row: null, cell: null, candidateId: other.candidateId });
  f.context.identityRevisedRecordIds = [f.retirement.recordId]; const result = f.build();
  assert.equal(result.classification, 'EVIDENCE_REVIEW_REQUIRED'); assert.ok(codes(result).includes('GROUP_ARCHIVE_SOURCE_ARCHIVE_CONFLICT'));
  assert.ok(codes(result).includes('GROUP_SOURCE_IDENTITY_REVISED')); assert.ok(result.groupArchive.some((entry) => entry.issues.some((issue) => issue.code === 'ARCHIVE_CONFLICT')));
  const foreign = receipt(f, 'LEGACY'); foreign.assetId = randomUUID(); f.context.receipts = [foreign];
  assert.equal(f.build().evidenceState, 'USED_FOR_OTHER_RETIREMENT'); assert.equal(f.build().links[0].url, `/assets/${foreign.assetId}/imported-retirement-applications/${foreign.id}`);
});
test('group retirement reconciliation reports inconsistent flags, custody chronology and receipt contradictions without modifying dates', () => {
  const f = fixture(); f.asset.isActive = true; f.asset.decommissionedAt = null; assert.equal(f.build().classification, 'CURRENT_STATE_REVIEW_REQUIRED');
  f.asset.isActive = false; f.asset.decommissionedAt = new Date('2999-01-01'); assert.equal(f.build().classification, 'CURRENT_STATE_REVIEW_REQUIRED');
  f.asset.decommissionedAt = new Date('2005-01-01'); f.context.receipts = [{ ...receipt(f), decommissionedAt: new Date('2006-01-01') }];
  assert.ok(codes(f.build()).includes('IMPORTED_RETIREMENT_STATE_CONFLICT')); assert.equal(f.build().existingRetirement.dateOrigin, 'CURRENT_ASSET');
  f.context.receipts = []; f.context.assignments = [{ id: randomUUID(), startedAt: new Date('2001-01-01'), endedAt: new Date('2006-01-01'),
    recipientType: 'PERSON', personName: 'Historical recipient', officeName: null, assignmentType: 'STANDARD', returnStatus: 'AVAILABLE' }];
  assert.equal(f.build().classification, 'CURRENT_STATE_REVIEW_REQUIRED'); assert.ok(codes(f.build()).includes('ASSIGNMENT_AFTER_RETIREMENT'));
});
test('group retirement reconciliation bounds every collection and rejects cross-group or damaged archival context', () => {
  for (const [key, size] of [['evidence',101],['assignments',10001],['revisions',1001],['consumption',51],['reservations',26],['documents',1002],['receipts',5]]) {
    const f = fixture(); f.context[key] = Array(size).fill({}); assert.throws(f.build, (error) => error.code === 'GROUP_RECONCILIATION_LIMIT');
  }
  const f = fixture(); f.input.evidenceId = randomUUID(); assert.throws(f.build, (error) => error.code === 'NOT_FOUND');
  f.input.evidenceId = f.retirement.id; f.retirement.snapshot.effective.row = 999;
  assert.throws(f.build, (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
});
