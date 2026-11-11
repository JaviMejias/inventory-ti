import { ApiError } from '../lib/errors.js';
import { historicalEvidenceSnapshotSchema, historicalRevisionChangesSchema,
  type HistoricalPlanAsset, type HistoricalPlanAssignment, type HistoricalPlanEvidence, type HistoricalPlanRevision } from './assignment-plan.js';
import { historyRulesVersion } from './history.js';
import { importPlanDigest } from './plan.js';
import { identifierKey, previewDate } from './preview.js';
import type { HistoricalRetirementPlanInput } from './retirement-plan-schemas.js';

export const historicalRetirementRulesVersion = 'mda-retirement-plan-1';

export function buildHistoricalRetirementPlan(asset: HistoricalPlanAsset, evidence: HistoricalPlanEvidence,
  assignments: HistoricalPlanAssignment[], revisions: HistoricalPlanRevision[], input: HistoricalRetirementPlanInput,
  now = new Date(), usedEvidence: { evidenceId: string; itemId: string }[] = []) {
  const parsed = historicalEvidenceSnapshotSchema.safeParse(evidence.snapshot);
  if (!parsed.success || evidence.id !== input.evidenceId || parsed.data.recordId !== evidence.recordId ||
    parsed.data.candidateId !== evidence.candidateId || parsed.data.kind !== evidence.kind ||
    parsed.data.effectiveDay !== evidence.effectiveDay || parsed.data.original.id !== evidence.recordId ||
    parsed.data.effective.id !== evidence.recordId || parsed.data.original.sheet !== parsed.data.effective.sheet ||
    parsed.data.original.row !== parsed.data.effective.row || (evidence.effectiveDay === null) !== (parsed.data.datePrecision === 'UNKNOWN') ||
    (evidence.kind === 'RETIREMENT_OBSERVATION' && evidence.effectiveDay !== null)) {
    throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Saved retirement evidence cannot be interpreted safely');
  }
  const snapshot = parsed.data;
  const parsedRevisions = revisions.map((event) => {
    const changes = historicalRevisionChangesSchema.safeParse(event.changes);
    if (!changes.success) throw new ApiError(409, 'INVALID_SOURCE_REVISION', 'Saved source revisions cannot be interpreted for retirement planning');
    return { ...event, changes: changes.data };
  }).sort((a, b) => a.batchId.localeCompare(b.batchId) || a.revision - b.revision);
  const blockers: { code: string; relatedId?: string }[] = [];
  const block = (code: string, relatedId?: string) => { blockers.push({ code, ...(relatedId ? { relatedId } : {}) }); };
  if (evidence.kind !== 'RETIREMENT_OBSERVATION') block('RETIREMENT_EVIDENCE_KIND_REQUIRED');
  if (evidence.assetId === null) block('EVIDENCE_ASSET_LINK_REQUIRED');
  else if (evidence.assetId !== asset.id) block('EVIDENCE_ASSET_MISMATCH');
  if (snapshot.identityLinkBlocked) block('EVIDENCE_IDENTITY_UNRESOLVED');
  if (evidence.capture.rulesVersion !== historyRulesVersion) block('EVIDENCE_RULES_CHANGED');
  const sourceRevision = evidence.effectiveSourceRevision ?? evidence.capture.sourceRevision;
  if (parsedRevisions.some((event) => event.batchId === evidence.capture.batchId && event.revision > sourceRevision &&
    event.changes.some((change) => change.candidateId === evidence.candidateId))) block('EVIDENCE_SOURCE_REVISED');
  if ((snapshot.effective.serialKey && snapshot.effective.serialKey !== identifierKey(asset.serialNumber)) ||
    (snapshot.effective.tagKey && snapshot.effective.tagKey !== identifierKey(asset.assetTag))) block('CURRENT_ASSET_IDENTITY_CONFLICT');
  for (const use of [...usedEvidence].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    if (use.evidenceId === evidence.id) block('EVIDENCE_ALREADY_APPLIED', use.itemId);
  }
  if (asset.product.trackingMode !== 'ASSET') block('PRODUCT_NOT_ASSET');
  if (!asset.isActive || asset.status === 'DECOMMISSIONED' || asset.decommissionedAt !== null) block('EXISTING_RETIREMENT_REQUIRES_RECONCILIATION');
  const activeCount = assignments.filter((assignment) => assignment.endedAt === null).length;
  if (asset.status === 'ASSIGNED' ? activeCount !== 1 : activeCount !== 0) block('CURRENT_ASSIGNMENT_STATE_INCONSISTENT');
  if (asset.status === 'ASSIGNED' || activeCount > 0) block('ACTIVE_ASSIGNMENT_REQUIRES_RETURN');

  const confirmedAt = input.confirmedAt ? new Date(input.confirmedAt) : null;
  if (!confirmedAt) block('EXACT_RETIREMENT_DATE_REQUIRED');
  else if (confirmedAt > now) block('HISTORICAL_DATE_IN_FUTURE');
  if (!input.dateEvidenceReference) block('EXACT_RETIREMENT_DATE_PROOF_REQUIRED');
  // ReceivedDate is only a chronology bound, never a retirement timestamp.
  const receivedText = snapshot.effective.fields.receivedDate ?? null;
  const receivedDay = receivedText?.slice(0, 10) ?? null;
  let sourceReceivedDay: string | null = null;
  if (identifierKey(receivedText)) {
    const receivedInstant = receivedDay && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.test(receivedText!) ? new Date(receivedDay + 'T00:00:00Z') : null;
    if (!receivedInstant || !Number.isFinite(receivedInstant.getTime()) || receivedInstant.toISOString().slice(0, 10) !== receivedDay ||
      receivedDay! < '1900-01-01' || receivedDay! > previewDate(now)) block('SOURCE_RECEIPT_DATE_UNCONFIRMED');
    else {
      sourceReceivedDay = receivedDay;
      if (input.confirmedAt && input.confirmedAt.slice(0, 10) < receivedDay!) block('RETIREMENT_BEFORE_RECEIPT_DAY');
    }
  }
  const sortedAssignments = [...assignments].sort((a, b) => a.id.localeCompare(b.id));
  for (const assignment of sortedAssignments) {
    if (confirmedAt && assignment.endedAt && assignment.endedAt > confirmedAt) block('ASSIGNMENT_AFTER_RETIREMENT', assignment.id);
    if (assignment.endedAt && assignment.endedAt <= assignment.startedAt) block('OPERATIONAL_ASSIGNMENT_PERIOD_INVALID', assignment.id);
  }
  // Unlike a closed-history plan, a future retirement would change current state.
  const warnings = snapshot.issues.filter((issue) => issue.severity === 'WARNING').map((issue) => ({
    id: importPlanDigest({ evidenceId: evidence.id, issue }), evidenceId: evidence.id, issue
  }));
  for (const issue of snapshot.issues) if (issue.severity === 'BLOCKING') block('SOURCE_' + issue.code);
  if (warnings.some((warning) => !input.acknowledgedWarnings.includes(warning.id))) block('WARNINGS_NOT_ACKNOWLEDGED');
  if (input.acknowledgedWarnings.some((id) => !warnings.some((warning) => warning.id === id))) block('UNKNOWN_WARNING_ACKNOWLEDGEMENT');

  const content = { planRulesVersion: historicalRetirementRulesVersion, scope: 'HISTORICAL_RETIREMENT_PLAN' as const,
    checkedAsOf: previewDate(now), assetBefore: asset, request: { ...input, acknowledgedWarnings: [...input.acknowledgedWarnings].sort() },
    currentAssignmentsDigest: importPlanDigest(sortedAssignments), sourceRevisionsDigest: importPlanDigest(parsedRevisions),
    source: { evidenceId: evidence.id, captureId: evidence.captureId, batchId: evidence.capture.batchId,
      sourceHash: evidence.sourceHash, recordId: evidence.recordId, candidateId: evidence.candidateId, kind: evidence.kind,
      sheet: snapshot.original.sheet, row: snapshot.original.row, sourceRevision, capturedSourceRevision: evidence.capture.sourceRevision,
      evidenceVersion: evidence.evidenceVersion ?? 0, amendmentId: evidence.amendmentId ?? null,
      effectiveDay: evidence.effectiveDay, datePrecision: snapshot.datePrecision, sourceReceivedDay,
      fields: snapshot.effective.fields, snapshotDigest: importPlanDigest(evidence.snapshot) },
    proposedRetirement: { assetId: asset.id, status: 'DECOMMISSIONED' as const, isActive: false,
      decommissionedAt: confirmedAt?.toISOString() ?? null, historicalActorId: null }, warnings, blockers };
  return { ...content, planId: importPlanDigest(content), mode: 'HISTORICAL_RETIREMENT_PLAN', canApply: false, persisted: false,
    affectsCurrentState: false, planValidationComplete: blockers.length === 0,
    summary: { retirementCount: 1, validCount: blockers.length === 0 ? 1 : 0, blockingCount: blockers.length, warningCount: warnings.length } };
}
