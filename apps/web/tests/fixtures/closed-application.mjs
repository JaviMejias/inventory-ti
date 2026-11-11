import { assetId, receiptId } from './import-pilot.mjs';
import { closedAssignmentFixture } from './closed-assignment.mjs';

export const closedActorId = '00000000-0000-4000-8000-000000000009';
export function closedApplicationFixture() {
  const review = closedAssignmentFixture(); const draft = review.draftFor(); draft.acknowledgedWarnings = [review.warning.id];
  const input = { periods: [{ periodId: draft.periodId, confirmation: 'VERIFIED_CLOSED_ASSIGNMENT',
    start: { evidenceId: draft.startId, confirmedAt: draft.startAt, dateEvidenceReference: draft.startProof },
    end: { evidenceId: draft.endId, confirmedAt: draft.endAt, dateEvidenceReference: draft.endProof }, recipient: { type: draft.recipientType, name: draft.recipientName },
    assignmentType: draft.assignmentType, returnStatus: draft.returnStatus, note: draft.note, evidenceReference: draft.reference, acknowledgedWarnings: draft.acknowledgedWarnings }] };
  const plan = review.planFor(input);
  function receiptFor(intent, reused = false, selectedPlan = plan) {
    const stored = globalThis.structuredClone(selectedPlan); const appliedAt = '2026-10-05T14:00:00.000Z';
    const id = '00000000-0000-4000-8000-000000000006';
    return { scope: 'CLOSED_ASSIGNMENT_HISTORY', mode: 'APPLIED', affectsCurrentState: false, persisted: true, reused, application: {
      id, assetId, requestId: intent.requestId, requestDigest: 'b'.repeat(64), planId: stored.planId, rulesVersion: stored.planRulesVersion, appliedById: closedActorId, appliedAt, plan: stored,
      items: stored.periods.map((period) => { const proposal = period.proposedAssignment; const assignmentId = '00000000-0000-4000-8000-000000000008';
        return { id: '00000000-0000-4000-8000-000000000007', applicationId: id, periodId: period.periodId, assignmentId, startEvidenceId: period.start.evidenceId, endEvidenceId: period.end.evidenceId, snapshot: period,
          assignment: { id: assignmentId, assetId, importedHistory: true, personId: null, createdById: null, endedById: null, expectedReturnAt: null,
            recipientType: proposal.recipientType, personName: proposal.personName, officeName: proposal.officeName, assignmentType: proposal.assignmentType, startedAt: proposal.startedAt, endedAt: proposal.endedAt,
            returnStatus: proposal.returnStatus, ticketReference: proposal.ticketReference, otReference: proposal.otReference, returnTicketReference: proposal.returnTicketReference, returnOtReference: proposal.returnOtReference,
            notes: period.note, returnNotes: period.evidenceReference, createdAt: appliedAt, returnRecordedAt: appliedAt } };
      })
    } };
  }
  const intent = { requestId: receiptId, planId: plan.planId, confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: globalThis.structuredClone(input) };
  const receipt = receiptFor(intent);
  const applications = Array.from({ length: 27 }, (_, index) => ({ id: '00000000-0000-4000-8000-' + (100 - index).toString().padStart(12, '0'), assetId, requestId: receiptId, planId: plan.planId, rulesVersion: plan.planRulesVersion, appliedById: closedActorId, appliedAt: receipt.application.appliedAt }));
  function pageFor(offset = 0) { return { scope: 'CLOSED_ASSIGNMENT_HISTORY', affectsCurrentState: false, applications: applications.slice(offset, offset + 25), total: applications.length, limit: 25, offset, hasMore: offset + 25 < applications.length }; }
  return { review, input, plan, intent, receipt, receiptFor, applications, pageFor };
}
