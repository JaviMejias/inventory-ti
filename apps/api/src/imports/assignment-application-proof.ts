import { AssetStatus, type Assignment, type AuditLog, type ImportAssignmentApplication, type ImportAssignmentEvidenceUse, type ImportAssignmentItem } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { closedAssignmentApplySchema, closedAssignmentRequestDigest } from './assignment-apply-schemas.js';
import { buildClosedAssignmentPlan, closedAssignmentRulesVersion, type HistoricalPlanAsset, type HistoricalPlanEvidence } from './assignment-plan.js';
import { historicalAssignmentValues } from './historical-assignment-values.js';
import { importPlanDigest } from './plan.js';
import { previewDate } from './preview.js';

export type AssignmentApplicationProof = ImportAssignmentApplication & { items: (ImportAssignmentItem & {
  assignment: Assignment & { groupImportHistory: { id: string } | null }; evidenceUses: ImportAssignmentEvidenceUse[]
})[] };
export type AssignmentOriginAudit = Pick<AuditLog, 'action' | 'entityType' | 'entityId' | 'userId' | 'metadata'>;
export type AssignmentOriginEvidence = HistoricalPlanEvidence & { assignmentUse: { itemId: string; endpoint: string } | null;
  groupAssignmentUse: { itemId: string } | null; retirementUse: { id: string } | null; groupRetirementUse: { id: string } | null;
  groupHistoryLink: { id: string } | null; amendedAt?: Date | null };
const digest = z.string().regex(/^[a-f0-9]{64}$/); const uuid = z.string().uuid(); const instant = z.string().datetime();
const assetSchema = z.object({ id: uuid, productId: uuid, serialNumber: z.string().nullable(), assetTag: z.string().nullable(), status: z.nativeEnum(AssetStatus),
  isActive: z.boolean(), decommissionedAt: instant.nullable(), updatedAt: instant,
  product: z.object({ id: uuid, trackingMode: z.literal('ASSET'), isActive: z.boolean(), updatedAt: instant }) }).strict();
const savedPlanSchema = z.object({ planId: digest, planRulesVersion: z.literal(closedAssignmentRulesVersion), scope: z.literal('CLOSED_ASSIGNMENT_HISTORY_PLAN'),
  checkedAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), assetBefore: assetSchema, currentAssignmentsDigest: digest, sourceRevisionsDigest: digest,
  periods: z.array(z.record(z.unknown())).min(1).max(25), mode: z.literal('CLOSED_ASSIGNMENT_PLAN'), canApply: z.literal(false), persisted: z.literal(false),
  affectsCurrentState: z.literal(false), planValidationComplete: z.literal(true), summary: z.record(z.unknown()) }).strict();
const requestKeys = new Set(['periodId','confirmation','start','end','recipient','assignmentType','returnStatus','note','evidenceReference','acknowledgedWarnings']);
const envelopeKeys = new Set(['planId','mode','persisted','canApply','affectsCurrentState','planValidationComplete','summary']);
const same = (left: unknown, right: unknown) => importPlanDigest(left) === importPlanDigest(right);
function invalid(): never { throw new ApiError(409, 'INVALID_ASSIGNMENT_APPLICATION', 'Saved legacy assignment receipt cannot establish complete immutable origin'); }

export function validateAssignmentApplicationProof(receipt: AssignmentApplicationProof, evidence: AssignmentOriginEvidence[], audits: AssignmentOriginAudit[], now = new Date()) {
  if (receipt.rulesVersion !== closedAssignmentRulesVersion) throw new ApiError(409, 'ASSIGNMENT_ORIGIN_RULES_UNSUPPORTED', 'This origin needs explicit review under its original historical rules');
  const parsed = savedPlanSchema.safeParse(receipt.plan); if (!parsed.success) return invalid(); const plan = parsed.data;
  const request = closedAssignmentApplySchema.safeParse({ requestId: receipt.requestId, planId: receipt.planId, confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY',
    plan: { periods: plan.periods.map((period) => Object.fromEntries(Object.entries(period).filter(([key]) => requestKeys.has(key)))) } });
  if (!request.success || !uuid.safeParse(receipt.id).success || !uuid.safeParse(receipt.appliedById).success || plan.planId !== receipt.planId || plan.assetBefore.id !== receipt.assetId ||
    plan.assetBefore.product.id !== plan.assetBefore.productId || !(receipt.appliedAt instanceof Date) || !Number.isFinite(receipt.appliedAt.getTime()) || receipt.appliedAt > now ||
    plan.checkedAsOf > previewDate(receipt.appliedAt) ||
    importPlanDigest(Object.fromEntries(Object.entries(plan).filter(([key]) => !envelopeKeys.has(key)))) !== receipt.planId ||
    closedAssignmentRequestDigest(request.data) !== receipt.requestDigest || receipt.items.length !== plan.periods.length ||
    new Set(receipt.items.map((item) => item.id)).size !== receipt.items.length || new Set(receipt.items.map((item) => item.periodId)).size !== receipt.items.length ||
    new Set(receipt.items.map((item) => item.assignmentId)).size !== receipt.items.length || evidence.length !== receipt.items.length * 2 ||
    new Set(evidence.map((entry) => entry.id)).size !== evidence.length || audits.length !== receipt.items.length + 1) return invalid();
  const capturedAsset: HistoricalPlanAsset = { ...plan.assetBefore, updatedAt: new Date(plan.assetBefore.updatedAt),
    decommissionedAt: plan.assetBefore.decommissionedAt ? new Date(plan.assetBefore.decommissionedAt) : null,
    product: { ...plan.assetBefore.product, updatedAt: new Date(plan.assetBefore.product.updatedAt) } };
  // V11 retained only the old custody digest; replay immutable period facts and evaluate current custody separately.
  const rebuilt = buildClosedAssignmentPlan(capturedAsset, evidence, [], [], request.data.plan, receipt.appliedAt);
  const rootAudit = audits.filter((entry) => entry.action === 'IMPORT_CLOSED_ASSIGNMENTS_APPLIED' && entry.entityType === 'ImportAssignmentApplication' && entry.entityId === receipt.id && entry.userId === receipt.appliedById &&
    same(entry.metadata, { assetId: receipt.assetId, planId: receipt.planId, periodCount: receipt.items.length, affectsCurrentState: false }));
  if (rootAudit.length !== 1 || !same(plan.summary, { periodCount: receipt.items.length, validCount: receipt.items.length, blockingCount: 0, warningCount: rebuilt.summary.warningCount })) return invalid();
  const owned = new Set<string>();
  for (const item of receipt.items) {
    const period = plan.periods.find((entry) => entry.periodId === item.periodId); const checked = rebuilt.periods.find((entry) => entry.periodId === item.periodId);
    if (!period || !checked || !uuid.safeParse(item.id).success || item.applicationId !== receipt.id || !same(item.snapshot, period) || period.valid !== true || !same(period.blockers, []) ||
      item.startEvidenceId === item.endEvidenceId || item.evidenceUses.length !== 2 || new Set(item.evidenceUses.map((use) => use.endpoint)).size !== 2 ||
      checked.blockers.some((issue) => issue.code !== 'CURRENT_ASSIGNMENT_STATE_INCONSISTENT') ||
      !same(period.proposedAssignment, checked.proposedAssignment) || !same(period.sources, checked.sources) || !same(period.warnings, checked.warnings) ||
      !same(period.acknowledgedWarnings, checked.acknowledgedWarnings)) return invalid();
    for (const [endpoint, evidenceId] of [['START', item.startEvidenceId], ['END', item.endEvidenceId]] as const) {
      const use = item.evidenceUses.find((entry) => entry.endpoint === endpoint); const source = evidence.find((entry) => entry.id === evidenceId);
      if (!use || !source || owned.has(evidenceId) || use.evidenceId !== evidenceId || use.itemId !== item.id || source.assignmentUse?.itemId !== item.id || source.assignmentUse.endpoint !== endpoint ||
        !(source.capturedAt instanceof Date) || !Number.isFinite(source.capturedAt.getTime()) || source.capturedAt > receipt.appliedAt ||
        ((source.evidenceVersion ?? 0) > 0 && (!uuid.safeParse(source.amendmentId).success || !(source.amendedAt instanceof Date) || !Number.isFinite(source.amendedAt.getTime()) || source.amendedAt > receipt.appliedAt)) ||
        source.groupAssignmentUse !== null || source.retirementUse !== null || source.groupRetirementUse !== null || source.groupHistoryLink !== null) return invalid();
      owned.add(evidenceId);
    }
    const assignment = item.assignment;
    if (assignment.id !== item.assignmentId || assignment.assetId !== receipt.assetId || assignment.groupImportHistory !== null || !assignment.importedHistory || !assignment.endedAt ||
      !same(historicalAssignmentValues(assignment), checked.proposedAssignment) || assignment.personId !== null || assignment.createdById !== null || assignment.endedById !== null ||
      assignment.expectedReturnAt !== null || !same(assignment.createdAt, receipt.appliedAt) || !same(assignment.returnRecordedAt, receipt.appliedAt) ||
      assignment.notes !== period.note || assignment.returnNotes !== period.evidenceReference ||
      audits.filter((entry) => entry.action === 'IMPORT_CLOSED_ASSIGNMENT_ADDED' && entry.entityType === 'Assignment' && entry.entityId === assignment.id && entry.userId === receipt.appliedById &&
        same(entry.metadata, { assetId: receipt.assetId, applicationId: receipt.id, periodId: item.periodId, historicalActorsKnown: false, affectsCurrentState: false })).length !== 1) return invalid();
  }
  return { plan, request: request.data.plan };
}
