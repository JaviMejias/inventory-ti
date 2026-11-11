import { assetId, receiptId } from './import-pilot.mjs';

// Contract fixture for pre-V12 V10/V11 snapshots, not a renamed rules2 response or operational data.
// See contrato-api-v10.md (Sources), contrato-api-v11.md (receipt), and migration 0020 guards.
export function legacyClosedApplicationFixture() {
  const applicationId = '00000000-0000-4000-8000-000000000051';
  const assignmentId = '00000000-0000-4000-8000-000000000052';
  const appliedAt = '2026-10-05T14:00:00.000Z';
  const appliedById = '00000000-0000-4000-8000-000000000053';
  const productId = '00000000-0000-4000-8000-000000000054';
  const startId = '00000000-0000-4000-8000-000000000055';
  const endId = '00000000-0000-4000-8000-000000000056';
  const source = { captureId: '00000000-0000-4000-8000-000000000057', batchId: '00000000-0000-4000-8000-000000000058',
    sourceHash: 'a'.repeat(64), candidateId: 'b'.repeat(64), sheet: 'NB Uso', sourceRevision: 3, snapshotDigest: 'c'.repeat(64) };
  const period = {
    periodId: receiptId, confirmation: 'VERIFIED_CLOSED_ASSIGNMENT',
    start: { evidenceId: startId, confirmedAt: '2001-01-01T09:00:00-03:00', dateEvidenceReference: 'Acta original de entrega' },
    end: { evidenceId: endId, confirmedAt: '2002-01-01T10:00:00-03:00', dateEvidenceReference: 'Acta original de devolución' },
    recipient: { type: 'OFFICE', name: 'Oficina central' }, assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW',
    note: 'Periodo cerrado contrastado con actas', evidenceReference: 'Archivo documental original', acknowledgedWarnings: ['d'.repeat(64)],
    sources: [
      { ...source, endpoint: 'start', evidenceId: startId, recordId: 'e'.repeat(64), row: 4, kind: 'USAGE_OBSERVATION',
        effectiveDay: '2001-01-01', datePrecision: 'DAY', fields: { usedDate: '2001-01-01', officeText: 'Oficina central', outgoingTicket: 'T-SALIDA', outgoingOt: 'OT-SALIDA' } },
      { ...source, endpoint: 'end', evidenceId: endId, recordId: 'f'.repeat(64), row: 5, kind: 'RECEIPT_OBSERVATION',
        effectiveDay: null, datePrecision: 'UNKNOWN', fields: { receivedDate: null, incomingTicket: 'T-RETORNO', incomingOt: 'OT-RETORNO' } }
    ],
    proposedAssignment: { assetId, personId: null, recipientType: 'OFFICE', personName: null, officeName: 'Oficina central', assignmentType: 'STANDARD',
      startedAt: '2001-01-01T12:00:00.000Z', endedAt: '2002-01-01T13:00:00.000Z', returnStatus: 'UNDER_REVIEW', assignedById: null, returnedById: null,
      ticketReference: 'T-SALIDA', otReference: 'OT-SALIDA', returnTicketReference: 'T-RETORNO', returnOtReference: 'OT-RETORNO' },
    warnings: [{ id: 'd'.repeat(64), evidenceId: startId, contextualOnly: true, issue: { code: 'CROSS_SHEET_STATE_CONFLICT', severity: 'BLOCKING',
      sheet: 'NB Uso', row: 4, cell: null, candidateId: source.candidateId } }], blockers: [], valid: true
  };
  const plan = { planRulesVersion: 'mda-closed-assignment-plan-1', scope: 'CLOSED_ASSIGNMENT_HISTORY_PLAN', mode: 'CLOSED_ASSIGNMENT_PLAN',
    canApply: false, persisted: false, affectsCurrentState: false, checkedAsOf: '2026-10-05',
    assetBefore: { id: assetId, productId, serialNumber: '000012', assetTag: null, status: 'AVAILABLE', isActive: true, decommissionedAt: null,
      updatedAt: '2026-10-05T10:00:00.000Z', product: { id: productId, trackingMode: 'ASSET', isActive: true, updatedAt: '2026-10-05T10:00:00.000Z' } },
    currentAssignmentsDigest: '1'.repeat(64), sourceRevisionsDigest: '2'.repeat(64), planId: '3'.repeat(64), periods: [period], planValidationComplete: true,
    summary: { periodCount: 1, validCount: 1, blockingCount: 0, warningCount: 1 } };
  const proposal = period.proposedAssignment;
  const assignment = { id: assignmentId, assetId, importedHistory: true, personId: null, createdById: null, endedById: null, expectedReturnAt: null,
    recipientType: proposal.recipientType, personName: proposal.personName, officeName: proposal.officeName, assignmentType: proposal.assignmentType,
    startedAt: proposal.startedAt, endedAt: proposal.endedAt, returnStatus: proposal.returnStatus, ticketReference: proposal.ticketReference, otReference: proposal.otReference,
    returnTicketReference: proposal.returnTicketReference, returnOtReference: proposal.returnOtReference, notes: period.note, returnNotes: period.evidenceReference,
    createdAt: appliedAt, returnRecordedAt: appliedAt };
  return { scope: 'CLOSED_ASSIGNMENT_HISTORY', mode: 'APPLIED', affectsCurrentState: false, persisted: true, application: {
    id: applicationId, assetId, requestId: '00000000-0000-4000-8000-000000000059', requestDigest: '4'.repeat(64), planId: plan.planId,
    rulesVersion: plan.planRulesVersion, plan, appliedById, appliedAt,
    items: [{ id: '00000000-0000-4000-8000-000000000060', applicationId, periodId: period.periodId, assignmentId,
      startEvidenceId: startId, endEvidenceId: endId, snapshot: globalThis.structuredClone(period), assignment }]
  } };
}
