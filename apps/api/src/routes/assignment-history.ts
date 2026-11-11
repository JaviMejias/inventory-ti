import type { Assignment, Prisma } from '@prisma/client';

export const assignmentImportSelect = { id: true, applicationId: true, periodId: true, startEvidenceId: true, endEvidenceId: true,
  application: { select: { appliedById: true, appliedAt: true } } } satisfies Prisma.ImportAssignmentItemSelect;
export const groupAssignmentImportSelect = { id: true, applicationId: true, periodId: true, startLinkId: true, endLinkId: true,
  evidenceUses: { select: { evidenceId: true, linkId: true, endpoint: true } },
  application: { select: { itemId: true, appliedById: true, appliedAt: true } } } satisfies Prisma.ImportGroupAssignmentItemSelect;

type HistoryAssignment = Assignment & {
  createdBy: { displayName: string } | null;
  endedBy: { displayName: string } | null;
  importHistory?: { applicationId: string; application: { appliedById: string; appliedAt: Date } } | null;
  groupImportHistory?: { applicationId: string; application: { itemId: string; appliedById: string; appliedAt: Date } } | null;
  historyCorrection?: { id: string; version: number; correctedById: string | null; correctedAt: Date | null };
  originalAssignment?: Assignment;
};

export function assignmentHistoryEvents(assignment: HistoryAssignment) {
  const grouped = assignment.groupImportHistory;
  const origin = grouped ?? assignment.importHistory;
  const recipient = {
    kind: 'assignment',
    person: assignment.personName,
    recipientType: assignment.recipientType,
    recipientName: assignment.recipientType === 'OFFICE' ? assignment.officeName : assignment.personName,
    officeName: assignment.officeName,
    assignmentType: assignment.assignmentType,
    ...(assignment.historyCorrection ? { historyCorrection: assignment.historyCorrection, originalAssignment: assignment.originalAssignment } : {}),
    expectedReturnAt: assignment.expectedReturnAt,
    ...(assignment.importedHistory ? { source: 'IMPORTED_HISTORY', importApplicationId: origin?.applicationId ?? null,
      recordedById: origin?.application.appliedById ?? null,
      ...(grouped ? { importScope: 'GROUP_CLOSED_ASSIGNMENT_HISTORY', importGroupItemId: grouped.application.itemId } : {}) } : {})
  };
  return [
    {
      ...recipient, id: 'assignment-start-' + assignment.id, action: 'ASSET_ASSIGNED',
      effectiveAt: assignment.startedAt, recordedAt: assignment.createdAt, actor: assignment.createdBy?.displayName ?? null,
      ticketReference: assignment.ticketReference, otReference: assignment.otReference, notes: assignment.notes
    },
    ...(assignment.endedAt ? [{
      ...recipient, id: 'assignment-end-' + assignment.id, action: 'ASSET_RETURNED',
      effectiveAt: assignment.endedAt, recordedAt: assignment.returnRecordedAt, actor: assignment.endedBy?.displayName ?? null,
      ticketReference: assignment.returnTicketReference, otReference: assignment.returnOtReference, notes: assignment.returnNotes,
      returnStatus: assignment.returnStatus
    }] : [])
  ];
}
