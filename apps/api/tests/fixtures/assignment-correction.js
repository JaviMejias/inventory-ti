import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closedAssignmentApplySchema, closedAssignmentRequestDigest } from '../../src/imports/assignment-apply-schemas.js';
import { closedAssignmentPlanSchema } from '../../src/imports/assignment-plan-schemas.js';
import { buildClosedAssignmentPlan } from '../../src/imports/assignment-plan.js';
import { buildHistoricalObservations } from '../../src/imports/history.js';
import { buildWorkbookPreview } from '../../src/imports/preview.js';
import { dateCell, receptionRow, textCell, workbook } from './workbook-preview.js';

const json = (value) => JSON.parse(JSON.stringify(value));
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
export function assignmentCorrectionFixture({ count = 1, unknownEndDate = false, status = 'AVAILABLE' } = {}) {
  const now = new Date('2026-10-20T17:00:00Z'); const appliedAt = new Date('2026-10-20T14:00:00Z');
  const productId = randomUUID();
  const asset = { id: randomUUID(), productId, serialNumber: 'LEGACY-CORRECTION-' + randomUUID(), assetTag: null, status, isActive: true,
    decommissionedAt: null, updatedAt: appliedAt, product: { id: productId, trackingMode: 'ASSET', isActive: true, updatedAt: appliedAt } };
  const source = workbook('Recepción', Array.from({ length: count }, (_, index) => {
    const year = 2001 + index * 2;
    return [receptionRow(4 + index * 2, asset.serialNumber, { M: dateCell(`${year}-01-01`), N: textCell('Outgoing ticket') }),
      receptionRow(5 + index * 2, asset.serialNumber, { ...(unknownEndDate ? {} : { A: dateCell(`${year + 1}-01-01`) }), H: textCell('Incoming ticket') })];
  }).flat());
  const preview = buildWorkbookPreview(source, [], '2026-10-20'); const captureId = randomUUID(); const batchId = randomUUID();
  const evidence = buildHistoricalObservations(preview, preview, { revision: 0, corrections: [] }).map((snapshot) => ({
    id: randomUUID(), captureId, sourceHash: source.source.sha256, recordId: snapshot.recordId, candidateId: snapshot.candidateId,
    kind: snapshot.kind, effectiveDay: snapshot.effectiveDay, assetId: asset.id, snapshot, capturedAt: new Date('2026-10-20T12:00:00Z'),
    capture: { batchId, sourceRevision: 0, rulesVersion: 'mda-history-evidence-1' }, assignmentUse: null, groupAssignmentUse: null,
    retirementUse: null, groupRetirementUse: null, groupHistoryLink: null
  })).filter((entry) => entry.kind === 'USAGE_OBSERVATION' || (entry.kind === 'RECEIPT_OBSERVATION' && entry.snapshot.original.row % 2 === 1));
  const originalInput = closedAssignmentPlanSchema.parse({ periods: Array.from({ length: count }, (_, index) => {
    const year = 2001 + index * 2;
    return { periodId: randomUUID(), confirmation: 'VERIFIED_CLOSED_ASSIGNMENT',
      start: { evidenceId: evidence.find((entry) => entry.kind === 'USAGE_OBSERVATION' && entry.snapshot.original.row === 4 + index * 2).id,
        confirmedAt: `${year}-01-01T09:00:00-03:00`, dateEvidenceReference: 'Signed delivery timestamp' },
      end: { evidenceId: evidence.find((entry) => entry.kind === 'RECEIPT_OBSERVATION' && entry.snapshot.original.row === 5 + index * 2).id,
        confirmedAt: `${year + 1}-01-01T10:00:00-03:00`, dateEvidenceReference: 'Signed return timestamp' },
      recipient: { type: 'OFFICE', name: 'Central office' }, assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW', note: 'Original closed period', evidenceReference: 'Delivery and return records' };
  }) });
  let built = buildClosedAssignmentPlan(asset, evidence, [], [], originalInput, appliedAt);
  originalInput.periods.forEach((period) => { period.acknowledgedWarnings = built.periods.find((entry) => entry.periodId === period.periodId).warnings.map((entry) => entry.id); });
  built = buildClosedAssignmentPlan(asset, evidence, [], [], originalInput, appliedAt); assert.equal(built.planValidationComplete, true);
  const request = closedAssignmentApplySchema.parse({ requestId: randomUUID(), planId: built.planId, confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: originalInput });
  const receipt = { id: randomUUID(), assetId: asset.id, requestId: request.requestId, requestDigest: closedAssignmentRequestDigest(request), planId: built.planId,
    rulesVersion: built.planRulesVersion, plan: json(built), appliedById: randomUUID(), appliedAt, items: [] };
  receipt.items = built.periods.map((period) => {
    const item = { id: randomUUID(), applicationId: receipt.id, periodId: period.periodId, assignmentId: randomUUID(),
      startEvidenceId: period.start.evidenceId, endEvidenceId: period.end.evidenceId, snapshot: json(period), evidenceUses: [] };
    item.assignment = { ...omit(period.proposedAssignment, ['assignedById','returnedById']), id: item.assignmentId, createdById: null, endedById: null,
      startedAt: new Date(period.proposedAssignment.startedAt), endedAt: new Date(period.proposedAssignment.endedAt), expectedReturnAt: null,
      importedHistory: true, groupImportHistory: null, notes: period.note, returnNotes: period.evidenceReference, createdAt: appliedAt, returnRecordedAt: appliedAt };
    item.evidenceUses = [{ evidenceId: item.startEvidenceId, itemId: item.id, endpoint: 'START' }, { evidenceId: item.endEvidenceId, itemId: item.id, endpoint: 'END' }];
    for (const use of item.evidenceUses) evidence.find((entry) => entry.id === use.evidenceId).assignmentUse = { itemId: item.id, endpoint: use.endpoint };
    return item;
  });
  const audits = [{ action: 'IMPORT_CLOSED_ASSIGNMENTS_APPLIED', entityType: 'ImportAssignmentApplication', entityId: receipt.id, userId: receipt.appliedById,
    metadata: { assetId: asset.id, planId: receipt.planId, periodCount: count, affectsCurrentState: false } }, ...receipt.items.map((item) => ({
      action: 'IMPORT_CLOSED_ASSIGNMENT_ADDED', entityType: 'Assignment', entityId: item.assignmentId, userId: receipt.appliedById,
      metadata: { assetId: asset.id, applicationId: receipt.id, periodId: item.periodId, historicalActorsKnown: false, affectsCurrentState: false } }))];
  const assignmentItem = receipt.items.find((entry) => entry.periodId === originalInput.periods[0].periodId); const period = originalInput.periods[0];
  const input = { expectedOriginPlanId: receipt.planId, reason: 'Correct transcription against signed records', supportingReference: 'Verified rectification document',
    correction: { ...omit(period, ['periodId','confirmation','start','end']), start: omit(period.start, ['evidenceId']), end: omit(period.end, ['evidenceId']), note: 'Corrected historical note' } };
  const context = { asset, currentAsset: { ...omit(asset, ['product']), createdAt: appliedAt, notes: 'Unchanged current asset' }, custody: [],
    assignments: receipt.items.map(({ assignment }) => Object.fromEntries(['id','startedAt','endedAt','recipientType','personName','officeName','assignmentType','returnStatus'].map((key) => [key, assignment[key]]))), evidence, revisions: [] };
  return { now, receipt, assignmentItem, audits, context, input, originalInput };
}
