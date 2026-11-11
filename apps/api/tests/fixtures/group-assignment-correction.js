import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { groupClosedAssignmentApplyDigest, groupClosedAssignmentApplySchema } from '../../src/imports/group-assignment-apply-schemas.js';
import { buildGroupClosedAssignmentPlan } from '../../src/imports/group-assignment-plan.js';
import { groupAssignmentPlanFixture } from './group-assignment-plan.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
export function groupAssignmentCorrectionFixture(options = {}) {
  const f = groupAssignmentPlanFixture(options);
  let plan = buildGroupClosedAssignmentPlan(f.application, f.item.id, f.asset, f.receipts, f.evidence, [], f.revisions, f.input, f.now);
  f.input.plan.periods.forEach((period) => { period.acknowledgedWarnings = plan.periods.find((entry) => entry.periodId === period.periodId).warnings.map((warning) => warning.id); });
  plan = buildGroupClosedAssignmentPlan(f.application, f.item.id, f.asset, f.receipts, f.evidence, [], f.revisions, f.input, f.now);
  assert.equal(plan.planValidationComplete, true);
  const request = groupClosedAssignmentApplySchema.parse({ requestId: randomUUID(), planId: plan.planId, confirmation: 'APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY', plan: f.input });
  const asset = omit(f.asset, ['product']);
  const receipt = { id: randomUUID(), itemId: f.item.id, assetId: asset.id, requestId: request.requestId,
    requestDigest: groupClosedAssignmentApplyDigest(request), planId: plan.planId, rulesVersion: 'mda-group-closed-assignment-application-1',
    plan: clone(plan), appliedById: randomUUID(), appliedAt: new Date('2026-10-20T14:00:00Z'), createdTransactionId: '123456',
    assetSnapshot: clone(asset), custodySnapshot: [], items: [] };
  receipt.items = plan.periods.map((period) => {
    const item = { id: randomUUID(), applicationId: receipt.id, periodId: period.periodId, assignmentId: randomUUID(),
      startLinkId: period.sources.find((source) => source.endpoint === 'start').groupHistoryLinkId,
      endLinkId: period.sources.find((source) => source.endpoint === 'end').groupHistoryLinkId, snapshot: clone(period), evidenceUses: [] };
    item.assignment = { id: item.assignmentId, assetId: asset.id, personId: null, recipientType: period.recipient.type,
      personName: period.proposedAssignment.personName, officeName: period.proposedAssignment.officeName,
      assignmentType: period.assignmentType, startedAt: new Date(period.proposedAssignment.startedAt), endedAt: new Date(period.proposedAssignment.endedAt),
      expectedReturnAt: null, createdById: null, endedById: null, importedHistory: true, returnStatus: period.returnStatus,
      createdAt: receipt.appliedAt, returnRecordedAt: receipt.appliedAt, importHistory: null,
      ticketReference: period.proposedAssignment.ticketReference, otReference: period.proposedAssignment.otReference,
      returnTicketReference: period.proposedAssignment.returnTicketReference, returnOtReference: period.proposedAssignment.returnOtReference,
      notes: period.note, returnNotes: period.evidenceReference };
    item.evidenceUses = period.sources.map((source) => ({ evidenceId: source.evidenceId, linkId: source.groupHistoryLinkId, itemId: item.id, endpoint: source.endpoint.toUpperCase() }));
    for (const use of item.evidenceUses) f.evidence.find((entry) => entry.id === use.evidenceId).groupAssignmentUse = { itemId: item.id, endpoint: use.endpoint };
    return item;
  });
  const assignments = receipt.items.map(({ assignment }) => Object.fromEntries(['id', 'startedAt', 'endedAt', 'recipientType', 'personName', 'officeName', 'assignmentType', 'returnStatus']
    .map((key) => [key, assignment[key]])));
  const context = { ...f, assignments };
  const item = receipt.items[0]; const period = f.input.plan.periods[0];
  const correction = omit(clone(period), ['periodId', 'confirmation', 'start', 'end']);
  const startConfirmation = omit(period.start, ['evidenceId']); const endConfirmation = omit(period.end, ['evidenceId']);
  const input = { expectedOriginPlanId: receipt.planId, reason: 'Correct transcription against signed documents', supportingReference: 'Verified recipient copy',
    correction: { ...correction, start: startConfirmation, end: endConfirmation, note: 'Corrected historical note' } };
  const audits = [{ action: 'IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED', entityType: 'ImportGroupAssignmentApplication', entityId: receipt.id, userId: receipt.appliedById },
    ...receipt.items.map((entry) => ({ action: 'IMPORT_GROUP_CLOSED_ASSIGNMENT_ADDED', entityType: 'Assignment', entityId: entry.assignmentId, userId: receipt.appliedById }))];
  return { ...f, context, receipt, assignmentItem: item, input, audits, currentState: { asset, custody: [] } };
}
