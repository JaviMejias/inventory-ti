import { closedAssignmentFixture } from './closed-assignment.mjs';
import { assetId } from './import-pilot.mjs';

// Isolated UI/guard fixture, not an implementation of the server's business rules.
export function retirementFixture() {
  const base = closedAssignmentFixture(); const documents = base.documents;
  const evidence = documents.evidence[2];
  evidence.kind = 'RETIREMENT_OBSERVATION'; evidence.snapshot.kind = evidence.kind;
  evidence.effectiveDay = null; evidence.capturedEffectiveDay = null; evidence.snapshot.effectiveDay = null;
  evidence.snapshot.datePrecision = 'UNKNOWN'; evidence.snapshot.dateField = null; evidence.snapshot.sourceDateText = null;
  evidence.snapshot.dateUncertainty = 'RETIREMENT_DATE_NOT_MAPPED';
  evidence.snapshot.effective.fields = { serialNumber: '000012', receivedDate: '2024-12-01' };
  const second = documents.evidence[25];
  second.kind = 'RETIREMENT_OBSERVATION'; second.snapshot.kind = second.kind;
  second.effectiveDay = null; second.capturedEffectiveDay = null; second.snapshot.effectiveDay = null;
  second.snapshot.datePrecision = 'UNKNOWN'; second.snapshot.dateField = null; second.snapshot.sourceDateText = null;
  second.snapshot.dateUncertainty = 'RETIREMENT_DATE_NOT_MAPPED';
  const warning = { id: 'd'.repeat(64), evidenceId: evidence.id, issue: { code: 'FORMULA_REQUIRES_REVIEW', severity: 'WARNING', sheet: evidence.snapshot.original.sheet, row: evidence.snapshot.original.row, cell: 'B4', candidateId: evidence.candidateId } };
  evidence.snapshot.issues = [warning.issue];
  let sequence = 800;
  function draftFor() {
    return { evidenceId: evidence.id, confirmedAt: '2025-01-02T10:30:00-03:00', dateEvidenceReference: 'Acta QA, instante y zona verificados',
      note: 'Retiro contrastado con documentación QA', reference: 'Acta de baja QA', confirmed: true, acknowledgedWarnings: [] };
  }
  function planFor(input, patch = {}) {
    const entry = documents.evidence.find((row) => row.id === input.evidenceId);
    const blockers = [];
    if (!input.confirmedAt) blockers.push({ code: 'EXACT_RETIREMENT_DATE_REQUIRED' });
    if (!input.dateEvidenceReference) blockers.push({ code: 'EXACT_RETIREMENT_DATE_PROOF_REQUIRED' });
    if (!input.acknowledgedWarnings.includes(warning.id)) blockers.push({ code: 'WARNINGS_NOT_ACKNOWLEDGED' });
    return { planRulesVersion: 'mda-retirement-plan-1', scope: 'HISTORICAL_RETIREMENT_PLAN', mode: 'HISTORICAL_RETIREMENT_PLAN', checkedAsOf: '2026-10-05',
      assetBefore: base.planFor({ periods: [{ ...base.draftFor(), start: { evidenceId: base.start.id }, end: { evidenceId: base.end.id } }] }).assetBefore,
      request: { ...globalThis.structuredClone(input), acknowledgedWarnings: [...input.acknowledgedWarnings].sort() },
      currentAssignmentsDigest: 'e'.repeat(64), sourceRevisionsDigest: 'f'.repeat(64), planId: (++sequence).toString(16).padStart(64, '0'),
      source: { evidenceId: entry.id, captureId: entry.captureId, batchId: entry.capture.batchId, sourceHash: entry.sourceHash, recordId: entry.recordId, candidateId: entry.candidateId,
        kind: entry.kind, sheet: entry.snapshot.original.sheet, row: entry.snapshot.original.row, sourceRevision: entry.effectiveSourceRevision,
        evidenceVersion: entry.evidenceVersion, amendmentId: entry.amendmentId, capturedSourceRevision: entry.capturedSourceRevision,
        effectiveDay: null, datePrecision: 'UNKNOWN', sourceReceivedDay: '2024-12-01', fields: globalThis.structuredClone(entry.snapshot.effective.fields), snapshotDigest: 'c'.repeat(64) },
      proposedRetirement: { assetId, status: 'DECOMMISSIONED', isActive: false, decommissionedAt: input.confirmedAt ? new Date(input.confirmedAt).toISOString() : null, historicalActorId: null },
      warnings: [{ ...warning, evidenceId: entry.id }], blockers, canApply: false, persisted: false, affectsCurrentState: false, planValidationComplete: !blockers.length,
      summary: { retirementCount: 1, validCount: blockers.length ? 0 : 1, blockingCount: blockers.length, warningCount: 1 }, ...patch };
  }
  return { documents, evidence, second, warning, draftFor, planFor };
}
