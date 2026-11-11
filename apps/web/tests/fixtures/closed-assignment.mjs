import { assetId, candidateId, receiptId } from './import-pilot.mjs';
import { assetEvidenceFixture } from './asset-evidence.mjs';

// Explicit, isolated browser/unit fixture. This is not a replacement for the server's planning rules.
export function closedAssignmentFixture() {
  const documents = assetEvidenceFixture();
  const start = documents.evidence[0]; const end = documents.evidence[25];
  start.kind = 'USAGE_OBSERVATION'; start.snapshot.kind = start.kind;
  start.snapshot.dateField = 'usedDate'; start.snapshot.effective.fields = { serialNumber: '000012', usedDate: '2025-01-02', recipientText: 'Persona Prueba', outgoingTicket: 'T-SALIDA', outgoingOt: 'OT-SALIDA' };
  end.effectiveDay = '2025-02-02'; end.capturedEffectiveDay = end.effectiveDay; end.snapshot.effectiveDay = end.effectiveDay;
  end.snapshot.sourceDateText = end.effectiveDay; end.snapshot.original.fields.receivedDate = end.effectiveDay; end.snapshot.effective.fields.receivedDate = end.effectiveDay;
  const warning = { id: 'd'.repeat(64), evidenceId: start.id, contextualOnly: false, issue: { code: 'FORMULA_REQUIRES_REVIEW', severity: 'WARNING', sheet: start.snapshot.original.sheet, row: start.snapshot.original.row, cell: 'B4', candidateId } };
  start.snapshot.issues = [warning.issue];
  let sequence = 100;
  function draftFor() {
    return { periodId: receiptId, startId: start.id, endId: end.id, startAt: '2025-01-02T10:30:00-03:00', endAt: '2025-02-02T18:00:00-03:00',
      startProof: 'Acta de entrega QA, hora contrastada', endProof: 'Acta de retorno QA, hora contrastada', recipientType: 'PERSON', recipientName: 'Persona Prueba',
      assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW', note: 'Periodo cerrado contrastado con actas QA', reference: 'Archivo y actas QA', confirmed: true, acknowledgedWarnings: [] };
  }
  function planFor(input, patch = {}) {
    const period = globalThis.structuredClone(input.periods[0]);
    const sources = ['start', 'end'].map((endpoint) => {
      const entry = documents.evidence.find((row) => row.id === period[endpoint].evidenceId);
      return { endpoint, evidenceId: entry.id, captureId: entry.captureId, batchId: entry.capture.batchId, sourceHash: entry.sourceHash, recordId: entry.recordId, candidateId: entry.candidateId,
        kind: entry.kind, sheet: entry.snapshot.original.sheet, row: entry.snapshot.original.row, sourceRevision: entry.effectiveSourceRevision, evidenceVersion: entry.evidenceVersion,
        amendmentId: entry.amendmentId, capturedSourceRevision: entry.capturedSourceRevision, effectiveDay: entry.effectiveDay, datePrecision: entry.snapshot.datePrecision,
        fields: globalThis.structuredClone(entry.snapshot.effective.fields), snapshotDigest: 'c'.repeat(64) };
    });
    const blockers = [];
    for (const endpoint of ['start', 'end']) {
      if (!period[endpoint].confirmedAt) blockers.push({ code: 'EXACT_DATE_REQUIRED', endpoint });
      if (!period[endpoint].dateEvidenceReference) blockers.push({ code: 'EXACT_DATE_PROOF_REQUIRED', endpoint });
    }
    if (!period.recipient) blockers.push({ code: 'CONFIRMED_RECIPIENT_REQUIRED' });
    if (!period.returnStatus) blockers.push({ code: 'CONFIRMED_RETURN_STATUS_REQUIRED' });
    if (!period.acknowledgedWarnings.includes(warning.id)) blockers.push({ code: 'WARNINGS_NOT_ACKNOWLEDGED' });
    const proposedAssignment = { assetId, personId: null, recipientType: period.recipient?.type ?? null,
      personName: period.recipient?.type === 'PERSON' ? period.recipient.name : null, officeName: period.recipient?.type === 'OFFICE' ? period.recipient.name : null,
      assignmentType: period.assignmentType, startedAt: period.start.confirmedAt ? new Date(period.start.confirmedAt).toISOString() : null,
      endedAt: period.end.confirmedAt ? new Date(period.end.confirmedAt).toISOString() : null, returnStatus: period.returnStatus, assignedById: null, returnedById: null,
      ticketReference: 'T-SALIDA', otReference: 'OT-SALIDA', returnTicketReference: 'T-01', returnOtReference: 'OT-01' };
    return { planRulesVersion: 'mda-closed-assignment-plan-2', scope: 'CLOSED_ASSIGNMENT_HISTORY_PLAN', mode: 'CLOSED_ASSIGNMENT_PLAN', checkedAsOf: '2026-10-05',
      assetBefore: { id: assetId, productId: candidateId.slice(0,8)+'-0000-4000-8000-000000000001', serialNumber: '000012', assetTag: null, status: 'AVAILABLE', isActive: true, decommissionedAt: null, updatedAt: '2026-10-05T10:00:00Z',
        product: { id: candidateId.slice(0,8)+'-0000-4000-8000-000000000001', trackingMode: 'ASSET', isActive: true, updatedAt: '2026-10-05T10:00:00Z' } },
      currentAssignmentsDigest: 'e'.repeat(64), sourceRevisionsDigest: 'f'.repeat(64), periods: [{ ...period, acknowledgedWarnings: [...period.acknowledgedWarnings].sort(), sources, proposedAssignment, warnings: [warning], blockers, valid: blockers.length === 0 }],
      planId: (++sequence).toString(16).padStart(64,'0'), canApply: false, persisted: false, affectsCurrentState: false, planValidationComplete: blockers.length === 0,
      summary: { periodCount: 1, validCount: blockers.length ? 0 : 1, blockingCount: blockers.length, warningCount: 1 }, ...patch };
  }
  return { documents, start, end, warning, draftFor, planFor };
}
