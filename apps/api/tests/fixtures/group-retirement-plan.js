import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildHistoricalObservations } from '../../src/imports/history.js';
import { identityGroupDecisionDigest, identityGroupDecisionSchema } from '../../src/imports/identity-group-decision-schemas.js';
import { buildIdentityGroupPlan } from '../../src/imports/identity-group-plan.js';
import { buildIdentityGroupProjection } from '../../src/imports/identity-group-projection.js';
import { buildWorkbookPreview } from '../../src/imports/preview.js';
import { dateCell, retirementRow, workbook } from './workbook-preview.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
export function groupRetirementPlanFixture({ sheet = 'Baja 2026', sourceIssue = null } = {}) {
  const now = new Date('2026-10-20T15:00:00Z'); const actorId = randomUUID();
  const source = workbook(sheet, [retirementRow(sheet, 5, 'ORIGINAL-RETIREMENT', { A: dateCell('2000-01-01') }), retirementRow(sheet, 6, 'ORIGINAL-RETIREMENT')]);
  const baseline = buildWorkbookPreview(source, [], '2026-10-20');
  const context = { batchId: randomUUID(), batchVersion: 1, sourceContext: { revision: 0, corrections: [], identityRevisions: [] } };
  const proposal = { expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: baseline.candidates.map((entry) => entry.id), note: 'Physical identity verified for separate retirement review',
    groups: [{ groupId: randomUUID(), recordIds: baseline.records.map((entry) => entry.id), serialNumber: 'VERIFIED-RETIREMENT', assetTag: null, evidenceReference: 'Physical label and disposal archive' }] };
  const plan = buildIdentityGroupPlan(source, source, [], context, proposal, undefined, '2026-10-20'); assert.equal(plan.proposalValidationComplete, true);
  const review = { id: randomUUID(), batchId: context.batchId, batchVersion: 1, sourceRevision: 0, sourceHash: source.source.sha256, planId: plan.planId, plan, release: null,
    rows: plan.observations.map((observation) => ({ reviewId: null, recordId: observation.recordId, sourceHash: source.source.sha256,
      originalCandidateId: observation.originalCandidateId, groupId: observation.proposedGroupId, snapshot: clone(observation), isReserved: true })) };
  review.rows.forEach((row) => { row.reviewId = review.id; });
  const product = { id: randomUUID(), name: 'Retirement notebook', trackingMode: 'ASSET', isActive: true, updatedAt: now };
  const asset = { id: randomUUID(), productId: product.id, serialNumber: 'VERIFIED-RETIREMENT', assetTag: null, status: 'AVAILABLE', isActive: true,
    decommissionedAt: null, updatedAt: now, product };
  const capture = { id: randomUUID(), batchId: context.batchId, sourceHash: source.source.sha256, sourceRevision: 0, rulesVersion: 'mda-history-evidence-1' };
  const evidence = buildHistoricalObservations(baseline, baseline, context.sourceContext).map((observation) => {
    if (sourceIssue) observation.issues.push({ code: sourceIssue, severity: 'BLOCKING', sheet, row: observation.original.row, cell: null, candidateId: observation.candidateId });
    return { id: randomUUID(), captureId: capture.id, sourceHash: source.source.sha256, recordId: observation.recordId, candidateId: observation.candidateId,
      kind: observation.kind, effectiveDay: observation.effectiveDay, assetId: null, snapshot: { ...clone(observation), assetId: null }, capturedAt: now,
      capture, amendments: [], assignmentUse: null, retirementUse: null, groupAssignmentUse: null, groupHistoryLink: null };
  });
  const impacts = { decisions: [], pilotItems: [], evidence: evidence.map((entry) => ({ id: entry.id, recordId: entry.recordId, candidateId: entry.candidateId,
    captureId: capture.id, capturedAssetId: null, currentAssetId: null, evidenceVersion: 0, amendmentId: null, sourceRevision: 0,
    captureBatchId: capture.batchId, capturedSourceRevision: 0, assignmentUse: null, retirementUse: null })) };
  const projection = buildIdentityGroupProjection(source, source, [{ ...asset, product: { name: product.name } }], context, review, impacts, '2026-10-20');
  assert.equal(projection.projectionValidationComplete, true);
  const group = projection.groups[0];
  const intent = identityGroupDecisionSchema.parse({ requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
    expectedDecisionVersion: 0, expectedBatchVersion: 1, expectedSourceRevision: 0, projectionId: projection.projectionId,
    groupKey: group.groupKey, action: 'LINK_EXISTING', linkedAssetId: asset.id, note: 'Verified unique physical asset', evidenceReference: 'Physical inventory verification',
    evidenceReviews: group.evidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion, disposition: 'EXCLUDE_FROM_GROUP_PILOT',
      note: 'Requires separate retirement workflow', evidenceReference: 'Archived original disposal records' })) });
  const decision = { id: randomUUID(), reviewId: review.id, version: 1, requestId: intent.requestId, requestDigest: identityGroupDecisionDigest(intent), rulesVersion: 'mda-identity-group-decision-1',
    groupId: group.groupId, groupKey: group.groupKey, batchVersion: 1, sourceRevision: 0, projectionId: projection.projectionId, projection: clone(projection),
    action: intent.action, linkedAssetId: asset.id, note: intent.note, evidenceReference: intent.evidenceReference, evidenceReviews: intent.evidenceReviews, reviewedById: actorId, createdAt: now };
  const retirement = evidence.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION' && entry.snapshot.original.row === 5);
  const input = { expectedBatchVersion: 1, expectedSourceRevision: 0, expectedDecisionVersion: 1, projectionId: projection.projectionId, groupKey: group.groupKey,
    decisionId: decision.id, expectedEvidenceVersion: 0, acknowledgedGroupWarnings: [],
    plan: { evidenceId: retirement.id, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: '2005-01-01T09:00:00-03:00', dateEvidenceReference: 'Signed disposal timestamp including timezone',
      note: 'Independently verified retirement', evidenceReference: 'Signed disposal certificate', acknowledgedWarnings: [] } };
  return { source, now, asset, evidence, retirement, projection, decisions: [decision], assignments: [], revisions: [], consumedRows: [], input, review };
}
