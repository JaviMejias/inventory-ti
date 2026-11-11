import type { Assignment, AuditLog, ImportGroupAssignmentApplication, ImportGroupAssignmentEvidenceUse, ImportGroupAssignmentItem } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { groupClosedAssignmentApplyDigest, groupClosedAssignmentApplySchema } from './group-assignment-apply-schemas.js';
import { groupAssignmentApplicationRulesVersion } from './group-assignment-apply-service.js';
import { buildGroupClosedAssignmentPlan, groupClosedAssignmentRulesVersion } from './group-assignment-plan.js';
import type { GroupClosedAssignmentContext } from './group-assignment-plan-service.js';
import { importPlanDigest } from './plan.js';
import { historicalAssignmentValues } from './historical-assignment-values.js';

export { historicalAssignmentValues } from './historical-assignment-values.js';

export type GroupAssignmentApplicationProof = ImportGroupAssignmentApplication & {
  items: (ImportGroupAssignmentItem & { assignment: Assignment & { importHistory?: { id: string } | null }; evidenceUses: ImportGroupAssignmentEvidenceUse[] })[]
};
export type GroupAssignmentAuditProof = Pick<AuditLog, 'action' | 'entityType' | 'entityId' | 'userId'>;
const uuid = z.string().uuid(); const digest = z.string().regex(/^[a-f0-9]{64}$/);
const savedPlanSchema = z.object({
  planId: digest, rulesVersion: z.literal(groupClosedAssignmentRulesVersion), scope: z.literal('GROUP_CLOSED_ASSIGNMENT_HISTORY_PLAN'),
  applicationPlanId: digest, applicationProofDigest: digest, batchId: uuid, reviewId: uuid, applicationId: uuid, itemId: uuid, groupId: uuid, groupKey: z.string(), sourceHash: digest,
  assetBefore: z.object({ id: uuid, productId: uuid, serialNumber: z.string().nullable(), assetTag: z.string().nullable(), status: z.string(), isActive: z.boolean() }),
  sourceRows: z.array(z.record(z.unknown())).min(1).max(25), historyReceiptProofs: z.array(z.record(z.unknown())).min(1).max(100),
  periods: z.array(z.record(z.unknown())).min(1).max(25), historyLinks: z.array(z.record(z.unknown())).min(2).max(50),
  planValidationComplete: z.literal(true), persisted: z.literal(false), canApply: z.literal(false), affectsCurrentState: z.literal(false),
  evidenceRelinked: z.literal(false), operationalHistoryApplied: z.literal(false), closedAssignmentApplicationImplemented: z.literal(false)
});
const requestKeys = new Set(['periodId', 'confirmation', 'start', 'end', 'recipient', 'assignmentType', 'returnStatus', 'note', 'evidenceReference', 'acknowledgedWarnings']);
const envelopeKeys = new Set(['planId', 'persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'operationalHistoryApplied',
  'closedAssignmentApplicationImplemented', 'planValidationComplete', 'summary']);
export function invalidGroupAssignmentApplication(): never {
  throw new ApiError(409, 'INVALID_GROUP_ASSIGNMENT_APPLICATION', 'Saved grouped assignment receipt cannot establish complete immutable origin');
}
const invalid = invalidGroupAssignmentApplication;
const same = (left: unknown, right: unknown) => importPlanDigest(left) === importPlanDigest(right);

export function validateGroupAssignmentApplicationProof(context: GroupClosedAssignmentContext, receipt: GroupAssignmentApplicationProof,
  audits: GroupAssignmentAuditProof[], now = new Date()) {
  const rawPlan = z.record(z.unknown()).safeParse(receipt.plan);
  const parsed = savedPlanSchema.safeParse(receipt.plan); if (!parsed.success || !rawPlan.success) return invalid();
  const plan = parsed.data;
  const request = groupClosedAssignmentApplySchema.safeParse({ requestId: receipt.requestId, planId: receipt.planId,
    confirmation: 'APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY', plan: { expectedApplicationPlanId: plan.applicationPlanId,
      links: plan.historyLinks.map((link) => ({ evidenceId: link.evidenceId, linkId: link.id, expectedLinkVersion: link.version, expectedEvidenceVersion: link.evidenceVersion })),
      plan: { periods: plan.periods.map((period) => Object.fromEntries(Object.entries(period).filter(([key]) => requestKeys.has(key)))) } } });
  const assetSnapshot = z.record(z.unknown()).safeParse(receipt.assetSnapshot);
  const custody = z.array(z.object({ id: uuid, assetId: uuid, endedAt: z.null() }).passthrough()).safeParse(receipt.custodySnapshot);
  if (!request.success || receipt.rulesVersion !== groupAssignmentApplicationRulesVersion || receipt.itemId !== context.item.id ||
    receipt.assetId !== context.item.assetId || plan.assetBefore.id !== receipt.assetId || plan.planId !== receipt.planId ||
    !(receipt.appliedAt instanceof Date) || !Number.isFinite(receipt.appliedAt.getTime()) || receipt.appliedAt > now ||
    !uuid.safeParse(receipt.id).success || !uuid.safeParse(receipt.appliedById).success || !/^[1-9][0-9]{0,19}$/.test(receipt.createdTransactionId) ||
    !same(groupClosedAssignmentApplyDigest(request.data), receipt.requestDigest) ||
    importPlanDigest(Object.fromEntries(Object.entries(rawPlan.data).filter(([key]) => !envelopeKeys.has(key)))) !== receipt.planId ||
    !assetSnapshot.success || !custody.success || custody.data.length !== (plan.assetBefore.status === 'ASSIGNED' ? 1 : 0) ||
    custody.data.some((entry) => entry.assetId !== receipt.assetId) ||
    Object.entries(plan.assetBefore).some(([key, value]) => !same(assetSnapshot.data[key], value)) ||
    receipt.items.length !== plan.periods.length || new Set(receipt.items.map((item) => item.id)).size !== receipt.items.length ||
    new Set(receipt.items.map((item) => item.assignmentId)).size !== receipt.items.length ||
    new Set(receipt.items.map((item) => item.periodId)).size !== receipt.items.length || audits.length > 26 ||
    !audits.some((entry) => entry.action === 'IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED' && entry.entityType === 'ImportGroupAssignmentApplication' &&
      entry.entityId === receipt.id && entry.userId === receipt.appliedById)) return invalid();
  const owned = new Set<string>();
  for (const item of receipt.items) {
    const period = plan.periods.find((entry) => entry.periodId === item.periodId);
    if (!period || item.applicationId !== receipt.id || !same(item.snapshot, period) || period.valid !== true || !same(period.blockers, []) ||
      !Array.isArray(period.sources) || period.sources.length !== 2 || item.startLinkId === item.endLinkId || item.evidenceUses.length !== 2 ||
      new Set(item.evidenceUses.map((use) => use.endpoint)).size !== 2) return invalid();
    for (const [endpoint, linkId] of [['START', item.startLinkId], ['END', item.endLinkId]]) {
      const use = item.evidenceUses.find((entry) => entry.endpoint === endpoint);
      const source = period.sources.find((entry) => typeof entry === 'object' && entry !== null && 'endpoint' in entry && entry.endpoint === endpoint.toLowerCase());
      const sourceRecord = z.record(z.unknown()).safeParse(source);
      const evidence = context.evidence.find((entry) => entry.id === use?.evidenceId);
      if (!use || !sourceRecord.success || use.itemId !== item.id || use.linkId !== linkId || owned.has(use.evidenceId) ||
        sourceRecord.data.evidenceId !== use.evidenceId || sourceRecord.data.groupHistoryLinkId !== linkId || !evidence ||
        evidence.groupAssignmentUse?.itemId !== item.id || evidence.groupAssignmentUse.endpoint !== endpoint || evidence.assignmentUse || evidence.retirementUse) return invalid();
      owned.add(use.evidenceId);
    }
    const assignment = item.assignment;
    if (assignment.id !== item.assignmentId || assignment.assetId !== receipt.assetId || assignment.importHistory || !assignment.importedHistory || !assignment.endedAt ||
      !same(historicalAssignmentValues(assignment), period.proposedAssignment) || assignment.expectedReturnAt !== null ||
      assignment.personId !== null || assignment.createdById !== null || assignment.endedById !== null ||
      !same(assignment.createdAt, receipt.appliedAt) || !same(assignment.returnRecordedAt, receipt.appliedAt) ||
      assignment.notes !== period.note || assignment.returnNotes !== period.evidenceReference ||
      !context.assignments.some((entry) => entry.id === assignment.id && same(entry.startedAt, assignment.startedAt) && same(entry.endedAt, assignment.endedAt)) ||
      !audits.some((entry) => entry.action === 'IMPORT_GROUP_CLOSED_ASSIGNMENT_ADDED' && entry.entityType === 'Assignment' &&
        entry.entityId === assignment.id && entry.userId === receipt.appliedById)) return invalid();
  }
  // The exemption is local to this proven receipt; normal V24/V25 consumers remain blocked.
  const evidence = context.evidence.map((entry) => owned.has(entry.id) ? { ...entry, groupAssignmentUse: null } : entry);
  const assignmentIds = new Set(receipt.items.map((item) => item.assignmentId));
  const rebuilt = buildGroupClosedAssignmentPlan(context.application, context.item.id, context.asset, context.receipts, evidence,
    context.assignments.filter((entry) => !assignmentIds.has(entry.id)), context.revisions, request.data.plan, now);
  for (const key of ['applicationId', 'applicationPlanId', 'applicationProofDigest', 'batchId', 'reviewId', 'itemId', 'groupId', 'groupKey', 'sourceHash', 'sourceRows'] as const) {
    if (!same(plan[key], rebuilt[key])) return invalid();
  }
  if (!same(plan.historyLinks, rebuilt.historyLinks) || plan.historyReceiptProofs.some((entry) => !rebuilt.historyReceiptProofs.some((proof) => same(entry, proof)))) return invalid();
  for (const period of plan.periods) {
    const current = rebuilt.periods.find((entry) => entry.periodId === period.periodId);
    if (!current || !same(period.sources, current.sources) || !same(period.proposedAssignment, current.proposedAssignment) ||
      !same(period.warnings, current.warnings) || !same(period.acknowledgedWarnings, current.acknowledgedWarnings)) return invalid();
  }
  return { plan, request: request.data.plan };
}
