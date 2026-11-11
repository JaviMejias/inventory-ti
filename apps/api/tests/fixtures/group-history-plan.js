import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { identityGroupApplyDigest, identityGroupApplySchema } from '../../src/imports/identity-group-apply-schemas.js';
import { identityGroupDecisionDigest, identityGroupDecisionSchema } from '../../src/imports/identity-group-decision-schemas.js';
import { buildIdentityGroupPlan } from '../../src/imports/identity-group-plan.js';
import { buildIdentityGroupPilot } from '../../src/imports/identity-group-pilot.js';
import { identityGroupPilotSchema } from '../../src/imports/identity-group-pilot-schemas.js';
import { buildIdentityGroupProjection } from '../../src/imports/identity-group-projection.js';
import { buildHistoricalObservations } from '../../src/imports/history.js';
import { buildWorkbookPreview } from '../../src/imports/preview.js';
import { dateCell, receptionRow, textCell, workbook } from './workbook-preview.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
export function groupHistoryFixture({ split = false, metadata = false, assignment = false, unknownDates = false } = {}) {
  const original = workbook('Recepción', assignment ? [
    receptionRow(4, 'ORIGINAL-SERIAL', { ...(unknownDates ? {} : { M: dateCell('2001-01-01') }), N: textCell('OUT-TK'), O: textCell('OUT-OT') }),
    receptionRow(5, 'ORIGINAL-SERIAL', { ...(unknownDates ? {} : { A: dateCell('2002-01-01') }), H: textCell('IN-TK'), B: textCell('IN-OT') })
  ] : [4, 5].map((row) => receptionRow(row, 'ORIGINAL-SERIAL', { A: dateCell('2001-01-01'), K: textCell('Disponible') })));
  const baseline = buildWorkbookPreview(original, [], '2026-10-20'); const actorId = randomUUID();
  const context = { batchId: randomUUID(), batchVersion: 1, sourceContext: { revision: 0, corrections: [], identityRevisions: [] } };
  const proposal = { expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS', candidateIds: baseline.candidates.map((entry) => entry.id),
    note: 'Physical groups verified', groups: [{ groupId: randomUUID(), recordIds: baseline.records.map((entry) => entry.id), serialNumber: 'VERIFIED-GROUP', assetTag: null, evidenceReference: 'Physical label' }] };
  if (split) proposal.groups = baseline.records.map((record, index) => ({ ...proposal.groups[0], groupId: randomUUID(), recordIds: [record.id], serialNumber: 'VERIFIED-' + index }));
  const saved = buildIdentityGroupPlan(original, original, [], context, proposal, undefined, '2026-10-20'); assert.equal(saved.proposalValidationComplete, true);
  const review = { id: randomUUID(), batchId: context.batchId, batchVersion: 1, sourceRevision: 0, sourceHash: original.source.sha256, planId: saved.planId,
    plan: saved, release: null, rows: [] };
  review.rows = saved.observations.map((observation) => ({ reviewId: review.id, recordId: observation.recordId, sourceHash: review.sourceHash,
    originalCandidateId: observation.originalCandidateId, groupId: observation.proposedGroupId, snapshot: clone(observation), isReserved: true }));
  const product = { id: randomUUID(), name: 'Historical group notebook', trackingMode: 'ASSET', isActive: true, equipmentType: 'Notebook', brand: 'HP', model: 'Model G9', updatedAt: new Date('2026-01-01') };
  const existing = metadata ? [{ id: randomUUID(), productId: product.id, serialNumber: proposal.groups[0].serialNumber, assetTag: null, status: 'AVAILABLE', isActive: true,
    product: { name: product.name }, updatedAt: new Date('2026-01-01'), technicalCondition: null, usagePurpose: null, location: 'Old location', sector: null, ipAddress: null, hostname: null, loanCode: null, notes: null }] : [];
  const projection = buildIdentityGroupProjection(original, original, existing, context, review, undefined, '2026-10-20');
  const decisions = projection.groups.map((group, index) => {
    const intent = identityGroupDecisionSchema.parse({ requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY', expectedDecisionVersion: index,
      expectedBatchVersion: 1, expectedSourceRevision: 0, projectionId: projection.projectionId, groupKey: group.groupKey,
      action: metadata ? 'LINK_EXISTING' : 'PROPOSE_NEW', ...(metadata ? { linkedAssetId: existing[0].id } : {}),
      note: 'Verified group target', evidenceReference: 'Physical label', evidenceReviews: [] });
    return { id: randomUUID(), reviewId: review.id, version: index + 1, requestId: intent.requestId, requestDigest: identityGroupDecisionDigest(intent),
      rulesVersion: 'mda-identity-group-decision-1', groupId: group.groupId, groupKey: group.groupKey, batchVersion: 1, sourceRevision: 0,
      projectionId: projection.projectionId, projection: clone(projection), action: intent.action, linkedAssetId: intent.linkedAssetId ?? null,
      note: intent.note, evidenceReference: intent.evidenceReference, evidenceReviews: [], reviewedById: actorId, createdAt: new Date('2026-10-20') };
  });
  const planInput = identityGroupPilotSchema.parse({ expectedBatchVersion: 1, expectedSourceRevision: 0, expectedDecisionVersion: decisions.length, projectionId: projection.projectionId,
    operations: projection.groups.map((group) => metadata
      ? { type: 'UPDATE_METADATA', groupKey: group.groupKey, decisionId: decisions.find((entry) => entry.groupKey === group.groupKey).id,
        assetId: existing[0].id, note: 'Verified metadata', values: { location: 'New location' } }
      : { type: 'CREATE_ASSET', groupKey: group.groupKey, decisionId: decisions.find((entry) => entry.groupKey === group.groupKey).id,
        note: 'Available group', confirmation: 'AVAILABLE_UNASSIGNED', values: { productId: product.id, serialNumber: group.serialNumber, assetTag: group.assetTag } }) });
  let plan = buildIdentityGroupPilot(projection, decisions, [product], existing, planInput);
  if (assignment) {
    planInput.operations.forEach((operation) => { operation.acknowledgedWarnings = plan.operations.find((entry) => entry.groupKey === operation.groupKey).warnings.map((warning) => warning.id); });
    plan = buildIdentityGroupPilot(projection, decisions, [product], existing, planInput);
  }
  assert.equal(plan.planValidationComplete, true);
  const applyInput = identityGroupApplySchema.parse({ requestId: randomUUID(), planId: plan.planId, confirmation: 'APPLY_IDENTITY_GROUP_ASSET_PILOT', plan: planInput });
  const application = { id: randomUUID(), batchId: context.batchId, reviewId: review.id, sourceHash: review.sourceHash,
    requestId: applyInput.requestId, requestDigest: identityGroupApplyDigest(applyInput), planId: plan.planId, plan: clone(plan),
    appliedById: actorId, appliedAt: new Date('2026-10-20T10:00:00Z'), items: [] };
  application.items = plan.operations.map((operation) => {
    const itemId = randomUUID(); const assetId = metadata ? existing[0].id : randomUUID();
    return { id: itemId, applicationId: application.id, groupKey: operation.groupKey, groupId: operation.groupId, decisionId: operation.decisionId,
      assetId, operation: clone(operation), result: { id: assetId, productId: product.id, serialNumber: metadata ? existing[0].serialNumber : operation.values.serialNumber, assetTag: metadata ? existing[0].assetTag : operation.values.assetTag },
      rows: operation.source.map((row) => ({ sourceHash: review.sourceHash, recordId: row.recordId, originalCandidateId: row.originalCandidateId, reviewId: review.id, itemId })) };
  });
  const item = application.items[0]; const asset = { ...item.result, status: 'AVAILABLE', isActive: true, updatedAt: new Date('2026-10-20T10:00:00Z'), decommissionedAt: null,
    product: { id: product.id, trackingMode: 'ASSET', isActive: true, updatedAt: product.updatedAt } };
  const observations = buildHistoricalObservations(baseline, baseline, context.sourceContext);
  const capture = { id: randomUUID(), batchId: context.batchId, sourceHash: review.sourceHash, sourceRevision: 0, rulesVersion: 'mda-history-evidence-1' };
  const evidence = observations.filter((observation) => item.rows.some((row) => row.recordId === observation.recordId)).map((observation) => ({
    id: randomUUID(), captureId: capture.id, sourceHash: review.sourceHash, recordId: observation.recordId, candidateId: observation.candidateId,
    kind: observation.kind, effectiveDay: observation.effectiveDay, assetId: null, snapshot: { ...clone(observation), assetId: null, linkBasis: null },
    capturedAt: new Date('2026-10-19'), capture, amendments: [], assignmentUse: null, retirementUse: null
  }));
  const input = { expectedApplicationPlanId: application.planId, operations: [evidence[0]].map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: 0,
    action: 'LINK_TO_APPLIED_GROUP', note: 'Review physical source membership for history', evidenceReference: 'Independent archival proof', acknowledgedWarnings: [] })) };
  return { application, item, asset, evidence, input, revisions: [] };
}
