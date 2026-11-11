import type { Assignment } from '@prisma/client';

export function historicalAssignmentValues(assignment: Assignment) {
  return { assetId: assignment.assetId, personId: assignment.personId, recipientType: assignment.recipientType,
    personName: assignment.personName, officeName: assignment.officeName, assignmentType: assignment.assignmentType,
    startedAt: assignment.startedAt, endedAt: assignment.endedAt, returnStatus: assignment.returnStatus,
    assignedById: assignment.createdById, returnedById: assignment.endedById, ticketReference: assignment.ticketReference,
    otReference: assignment.otReference, returnTicketReference: assignment.returnTicketReference, returnOtReference: assignment.returnOtReference };
}
