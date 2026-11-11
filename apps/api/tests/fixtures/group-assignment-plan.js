import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { groupHistoryApplyDigest, groupHistoryApplySchema } from '../../src/imports/identity-group-history-apply-schemas.js';
import { buildGroupHistoryProjection } from '../../src/imports/identity-group-history-apply-service.js';
import { buildGroupHistoryPlan } from '../../src/imports/identity-group-history-plan.js';
import { groupHistoryFixture } from './group-history-plan.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
export function groupAssignmentPlanFixture(options = {}) {
  const f = groupHistoryFixture({ ...options, metadata: true, assignment: true });
  if (options.sourceWarning) {
    const entry = f.evidence.find((value) => value.kind === 'USAGE_OBSERVATION');
    entry.snapshot.issues.push({ code: 'DATE_REQUIRES_REVIEW', severity: 'WARNING', sheet: 'Recepción', row: 4, cell: 'M4', candidateId: entry.candidateId });
  }
  const selections = options.separateConfirmations ? f.evidence.map((entry) => [entry]) : [f.evidence];
  const receipts = selections.map((selection) => {
    const request = { ...f.input, operations: selection.map((entry) => ({ ...f.input.operations[0], evidenceId: entry.id })) };
    const first = buildGroupHistoryPlan(f.application, f.item.id, f.asset, f.evidence, f.revisions, request, '2026-10-20');
    request.operations.forEach((operation) => { operation.acknowledgedWarnings = first.operations.find((entry) => entry.evidenceId === operation.evidenceId).warnings.map((warning) => warning.id); });
    const plan = buildGroupHistoryPlan(f.application, f.item.id, f.asset, f.evidence, f.revisions, request, '2026-10-20');
    assert.equal(plan.planValidationComplete, true);
    const intent = groupHistoryApplySchema.parse({ requestId: randomUUID(), historyLinkPlanId: plan.historyLinkPlanId, confirmation: 'SAVE_GROUP_HISTORY_LINKS_ONLY', plan: request });
    const receipt = { id: randomUUID(), itemId: f.item.id, requestId: intent.requestId, requestDigest: groupHistoryApplyDigest(intent),
      planId: plan.historyLinkPlanId, rulesVersion: 'mda-group-history-link-application-1', plan: clone(plan), appliedById: randomUUID(), appliedAt: new Date('2026-10-20T12:00:00Z'), links: [] };
    receipt.links = plan.operations.map((operation) => ({ id: randomUUID(), historyApplicationId: receipt.id, evidenceId: operation.evidenceId,
      assetId: f.item.assetId, version: 1, evidenceVersion: operation.evidenceVersion, amendmentId: operation.amendmentId,
      sourceRevision: operation.effectiveSourceRevision, operation: clone(operation), projection: clone(buildGroupHistoryProjection(operation, f.item.id)) }));
    if (options.separateConfirmations) for (const link of receipt.links) {
      f.evidence.find((entry) => entry.id === link.evidenceId).groupHistoryLink = { id: link.id, historyApplicationId: receipt.id, assetId: link.assetId, version: 1 };
    }
    return receipt;
  });
  const start = f.evidence.find((entry) => entry.kind === 'USAGE_OBSERVATION'); const end = f.evidence.find((entry) => entry.kind === 'RECEIPT_OBSERVATION');
  const input = { expectedApplicationPlanId: f.application.planId,
    links: [start, end].map((entry) => ({ evidenceId: entry.id, linkId: receipts.flatMap((receipt) => receipt.links).find((link) => link.evidenceId === entry.id).id, expectedLinkVersion: 1, expectedEvidenceVersion: 0 })),
    plan: { periods: [{ periodId: randomUUID(), confirmation: 'VERIFIED_CLOSED_ASSIGNMENT',
      start: { evidenceId: start.id, confirmedAt: '2001-01-01T09:00:00-03:00', dateEvidenceReference: 'Delivery signed timestamp' },
      end: { evidenceId: end.id, confirmedAt: '2002-01-01T10:00:00-03:00', dateEvidenceReference: 'Return signed timestamp' },
      recipient: { type: 'OFFICE', name: 'Central office' }, assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW',
      note: 'Independently verified closed period', evidenceReference: 'Signed dispatch and return records', acknowledgedWarnings: [] }] } };
  return { ...f, receipts, assignments: [], input, start, end, now: new Date('2026-10-20T15:00:00Z') };
}
