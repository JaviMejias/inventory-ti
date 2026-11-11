import type { Asset, Assignment, ImportHistoricalEvidence } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { historicalKindSchema } from './history-schemas.js';
import { historyRulesVersion } from './history.js';
import { importPlanDigest } from './plan.js';
import { identifierKey, previewDate } from './preview.js';
import type { ClosedAssignmentPlanInput } from './assignment-plan-schemas.js';

export const closedAssignmentRulesVersion = 'mda-closed-assignment-plan-2';
export type HistoricalPlanAsset = Pick<Asset, 'id' | 'productId' | 'serialNumber' | 'assetTag' | 'status' | 'isActive' | 'decommissionedAt' | 'updatedAt'> & {
  product: { id: string; trackingMode: string; isActive: boolean; updatedAt: Date }
};
export type HistoricalPlanAssignment = Pick<Assignment, 'id' | 'startedAt' | 'endedAt' | 'recipientType' | 'personName' | 'officeName' | 'assignmentType' | 'returnStatus'>;
export type HistoricalPlanEvidence = ImportHistoricalEvidence & { capture: { batchId: string; sourceRevision: number; rulesVersion: string };
  effectiveSourceRevision?: number; evidenceVersion?: number; amendmentId?: string | null };
export type HistoricalPlanRevision = { batchId: string; revision: number; changes: unknown };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const record = z.object({ id: digest, sheet: z.string(), row: z.number().int().positive() });
const snapshotSchema = z.object({
  recordId: digest, candidateId: digest, kind: historicalKindSchema,
  effectiveDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), datePrecision: z.enum(['DAY', 'UNKNOWN']),
  historicalActorId: z.null(), affectsCurrentState: z.literal(false), identityLinkBlocked: z.boolean(),
  original: record, effective: record.extend({ fields: z.record(z.string().nullable()), serialKey: z.string().nullable(), tagKey: z.string().nullable() }),
  issues: z.array(z.object({ code: z.string(), severity: z.enum(['BLOCKING', 'WARNING', 'INFO']),
    sheet: z.string().nullable(), row: z.number().nullable(), cell: z.string().nullable(), candidateId: z.string().nullable() }))
});
const revisionChangesSchema = z.array(z.object({ candidateId: digest })).min(1).max(25);
export { snapshotSchema as historicalEvidenceSnapshotSchema, revisionChangesSchema as historicalRevisionChangesSchema };
const contextualStateIssues = new Set(['EXISTING_TERMINAL_STATE_CONFLICT', 'CROSS_SHEET_STATE_CONFLICT', 'AVAILABILITY_ASSIGNMENT_CONFLICT']);

export function buildClosedAssignmentPlan(asset: HistoricalPlanAsset, evidence: HistoricalPlanEvidence[], assignments: HistoricalPlanAssignment[],
  revisions: HistoricalPlanRevision[], input: ClosedAssignmentPlanInput, now = new Date(), usedEvidence: { evidenceId: string; itemId: string }[] = []) {
  const parsedRevisions = revisions.map((event) => {
    const changes = revisionChangesSchema.safeParse(event.changes);
    if (!changes.success) throw new ApiError(409, 'INVALID_SOURCE_REVISION', 'Saved source revisions cannot be interpreted for historical planning');
    return { ...event, changes: changes.data };
  });
  const evidenceById = new Map(evidence.map((entry) => {
    const parsed = snapshotSchema.safeParse(entry.snapshot);
    if (!parsed.success || parsed.data.recordId !== entry.recordId || parsed.data.candidateId !== entry.candidateId || parsed.data.kind !== entry.kind ||
      parsed.data.effectiveDay !== entry.effectiveDay || parsed.data.original.id !== entry.recordId || parsed.data.effective.id !== entry.recordId ||
      parsed.data.original.sheet !== parsed.data.effective.sheet || parsed.data.original.row !== parsed.data.effective.row ||
      (entry.effectiveDay === null) !== (parsed.data.datePrecision === 'UNKNOWN')) {
      throw new ApiError(409, 'INVALID_HISTORICAL_EVIDENCE', 'Saved historical evidence cannot be interpreted safely');
    }
    return [entry.id, { entry, snapshot: parsed.data }] as const;
  }));
  const periods = [...input.periods].sort((a, b) => a.periodId.localeCompare(b.periodId)).map((period) => {
    const blockers: { code: string; endpoint?: 'start' | 'end'; relatedId?: string }[] = [];
    const block = (code: string, endpoint?: 'start' | 'end', relatedId?: string) => { blockers.push({ code, ...(endpoint ? { endpoint } : {}), ...(relatedId ? { relatedId } : {}) }); };
    const warnings: { id: string; evidenceId: string; issue: z.infer<typeof snapshotSchema>['issues'][number]; contextualOnly: boolean }[] = [];
    const sources = (['start', 'end'] as const).map((side) => {
      const value = period[side];
      const saved = evidenceById.get(value.evidenceId);
      if (!saved) throw new ApiError(404, 'NOT_FOUND', 'Historical endpoint evidence not found');
      const { entry, snapshot } = saved;
      const used = usedEvidence.find((use) => use.evidenceId === entry.id);
      if (used) block('ENDPOINT_EVIDENCE_ALREADY_APPLIED', side, used.itemId);
      if (entry.assetId === null) block('EVIDENCE_ASSET_LINK_REQUIRED', side);
      else if (entry.assetId !== asset.id) block('EVIDENCE_ASSET_MISMATCH', side);
      if (snapshot.identityLinkBlocked) block('EVIDENCE_IDENTITY_UNRESOLVED', side);
      if (entry.capture.rulesVersion !== historyRulesVersion) block('EVIDENCE_RULES_CHANGED', side);
      if (parsedRevisions.some((event) => event.batchId === entry.capture.batchId && event.revision > (entry.effectiveSourceRevision ?? entry.capture.sourceRevision) &&
        event.changes.some((change) => change.candidateId === entry.candidateId))) block('EVIDENCE_SOURCE_REVISED', side);
      if ((snapshot.effective.serialKey && snapshot.effective.serialKey !== identifierKey(asset.serialNumber)) ||
        (snapshot.effective.tagKey && snapshot.effective.tagKey !== identifierKey(asset.assetTag))) block('CURRENT_ASSET_IDENTITY_CONFLICT', side);
      const allowedKinds = side === 'start' ? ['USAGE_OBSERVATION', 'LOAN_OBSERVATION'] : ['RECEIPT_OBSERVATION', 'USAGE_OBSERVATION'];
      if (!allowedKinds.includes(entry.kind)) block('EVIDENCE_ENDPOINT_KIND_INVALID', side);
      if (!value.confirmedAt) block('EXACT_DATE_REQUIRED', side);
      else {
        if (new Date(value.confirmedAt) > now) block('HISTORICAL_DATE_IN_FUTURE', side);
        if (entry.effectiveDay && value.confirmedAt.slice(0, 10) !== entry.effectiveDay) block('SOURCE_DAY_MISMATCH', side);
      }
      if (!value.dateEvidenceReference) block('EXACT_DATE_PROOF_REQUIRED', side);
      for (const issue of snapshot.issues) {
        const contextualOnly = contextualStateIssues.has(issue.code);
        if (issue.severity === 'BLOCKING' && !contextualOnly) block('SOURCE_' + issue.code, side);
        else if (issue.severity === 'WARNING' || contextualOnly) warnings.push({
          id: importPlanDigest({ evidenceId: entry.id, issue }), evidenceId: entry.id, issue, contextualOnly
        });
      }
      return { endpoint: side, evidenceId: entry.id, captureId: entry.captureId, batchId: entry.capture.batchId,
        sourceHash: entry.sourceHash, recordId: entry.recordId, candidateId: entry.candidateId, kind: entry.kind,
        sheet: snapshot.original.sheet, row: snapshot.original.row, sourceRevision: entry.effectiveSourceRevision ?? entry.capture.sourceRevision,
        evidenceVersion: entry.evidenceVersion ?? 0, amendmentId: entry.amendmentId ?? null, capturedSourceRevision: entry.capture.sourceRevision,
        effectiveDay: entry.effectiveDay, datePrecision: snapshot.datePrecision, fields: snapshot.effective.fields,
        snapshotDigest: importPlanDigest(entry.snapshot) };
    });
    if (sources[0].sourceHash === sources[1].sourceHash && sources[0].recordId === sources[1].recordId) block('DISTINCT_ENDPOINT_RECORDS_REQUIRED');
    if (period.start.confirmedAt && period.end.confirmedAt && new Date(period.end.confirmedAt) <= new Date(period.start.confirmedAt)) block('HISTORICAL_PERIOD_ORDER_INVALID');
    if (!period.recipient || !identifierKey(period.recipient.name)) block('CONFIRMED_RECIPIENT_REQUIRED');
    else {
      const fields = sources[0].fields;
      const reported = identifierKey(fields.officeText ?? null) ?? identifierKey(fields.recipientText ?? null);
      if (reported && reported !== identifierKey(period.recipient.name)) block('SOURCE_RECIPIENT_MISMATCH');
      if (identifierKey(fields.officeText ?? null) && period.recipient.type !== 'OFFICE') block('SOURCE_RECIPIENT_TYPE_MISMATCH');
    }
    if ((sources[0].kind === 'LOAN_OBSERVATION' || sources[0].sheet === 'NB Prestamo' ||
      identifierKey(sources[0].fields.loanCode ?? null) || identifierKey(sources[0].fields.loanDate ?? null)) && period.assignmentType !== 'LOAN') block('SOURCE_LOAN_TYPE_MISMATCH');
    if (!period.returnStatus) block('CONFIRMED_RETURN_STATUS_REQUIRED');
    if (asset.product.trackingMode !== 'ASSET') block('PRODUCT_NOT_ASSET');
    const activeCount = assignments.filter((entry) => entry.endedAt === null).length;
    if (asset.status === 'ASSIGNED' ? activeCount !== 1 : activeCount !== 0) block('CURRENT_ASSIGNMENT_STATE_INCONSISTENT');
    if (asset.status === 'DECOMMISSIONED' && !asset.decommissionedAt) block('DECOMMISSION_DATE_UNCONFIRMED');
    if (asset.decommissionedAt && period.end.confirmedAt && new Date(period.end.confirmedAt) > asset.decommissionedAt) block('HISTORICAL_PERIOD_AFTER_DECOMMISSION');
    if (period.start.confirmedAt && period.end.confirmedAt) {
      const start = new Date(period.start.confirmedAt); const end = new Date(period.end.confirmedAt);
      for (const assignment of assignments) if (start < (assignment.endedAt ?? new Date(8640000000000000)) && end > assignment.startedAt) {
        block('OPERATIONAL_ASSIGNMENT_OVERLAP', undefined, assignment.id);
      }
      for (const other of input.periods) if (other.periodId !== period.periodId && other.start.confirmedAt && other.end.confirmedAt &&
        start < new Date(other.end.confirmedAt) && end > new Date(other.start.confirmedAt)) block('PROPOSED_PERIOD_OVERLAP', undefined, other.periodId);
    }
    if (warnings.some((warning) => !period.acknowledgedWarnings.includes(warning.id))) block('WARNINGS_NOT_ACKNOWLEDGED');
    if (period.acknowledgedWarnings.some((id) => !warnings.some((warning) => warning.id === id))) block('UNKNOWN_WARNING_ACKNOWLEDGEMENT');
    const reference = (value: string | null | undefined, field: string) => {
      if (!value || !identifierKey(value)) return null;
      if (value.length > 160) { block('SOURCE_REFERENCE_TOO_LONG', undefined, field); return null; }
      return value;
    };
    const proposedAssignment = { assetId: asset.id, personId: null, recipientType: period.recipient?.type ?? null,
      personName: period.recipient?.type === 'PERSON' ? period.recipient.name : null,
      officeName: period.recipient?.type === 'OFFICE' ? period.recipient.name : null, assignmentType: period.assignmentType,
      startedAt: period.start.confirmedAt ? new Date(period.start.confirmedAt).toISOString() : null,
      endedAt: period.end.confirmedAt ? new Date(period.end.confirmedAt).toISOString() : null,
      returnStatus: period.returnStatus, assignedById: null, returnedById: null,
      ticketReference: reference(sources[0].fields.outgoingTicket, 'ticketReference'),
      otReference: reference(sources[0].fields.outgoingOt, 'otReference'),
      returnTicketReference: reference(sources[1].kind === 'RECEIPT_OBSERVATION' ? sources[1].fields.incomingTicket : null, 'returnTicketReference'),
      returnOtReference: reference(sources[1].kind === 'RECEIPT_OBSERVATION' ? sources[1].fields.incomingOt : null, 'returnOtReference') };
    return { ...period, acknowledgedWarnings: [...period.acknowledgedWarnings].sort(), sources, proposedAssignment, warnings, blockers, valid: blockers.length === 0 };
  });
  const content = { planRulesVersion: closedAssignmentRulesVersion, scope: 'CLOSED_ASSIGNMENT_HISTORY_PLAN' as const,
    checkedAsOf: previewDate(now), assetBefore: asset,
    currentAssignmentsDigest: importPlanDigest([...assignments].sort((a, b) => a.id.localeCompare(b.id))),
    sourceRevisionsDigest: importPlanDigest([...parsedRevisions].sort((a, b) => a.batchId.localeCompare(b.batchId) || a.revision - b.revision)), periods };
  return { ...content, planId: importPlanDigest(content), mode: 'CLOSED_ASSIGNMENT_PLAN', canApply: false, persisted: false, affectsCurrentState: false,
    planValidationComplete: periods.every((period) => period.valid),
    summary: { periodCount: periods.length, validCount: periods.filter((period) => period.valid).length,
      blockingCount: periods.reduce((count, period) => count + period.blockers.length, 0), warningCount: periods.reduce((count, period) => count + period.warnings.length, 0) } };
}
