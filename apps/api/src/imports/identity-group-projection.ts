import type { ImportIdentityGroupReview, ImportIdentityGroupRow } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { identityGroupPlanSchema } from './identity-group-plan-schemas.js';
import { buildIdentityGroupPlan, projectIdentityGroupWorkbook, selectIdentityGroupScope, type IdentityGroupImpacts } from './identity-group-plan.js';
import { importPlanDigest } from './plan.js';
import { buildWorkbookPreview, previewDate, type ExistingAsset } from './preview.js';
import { sourceCellSchema, type WorkbookPreviewInput } from './schemas.js';
import type { SourceContext } from './source.js';

export const identityGroupProjectionRulesVersion = 'mda-identity-group-projection-1';
export const identityGroupProjectionQuerySchema = z.object({}).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identityCells = z.object({ serialNumber: sourceCellSchema.nullable(), assetTag: sourceCellSchema.nullable() }).strict();
const observationSchema = z.object({
  recordId: digest, sheet: z.string().min(1).max(100), row: z.number().int().min(1).max(1048576),
  originalCandidateId: digest, proposedGroupId: z.string().uuid(),
  originalIdentityCells: identityCells, currentIdentityCells: identityCells
}).strict();
const savedPlanSchema = z.object({
  scope: z.literal('PHYSICAL_IDENTITY_GROUP_PLAN'), rulesVersion: z.literal('mda-identity-group-plan-1'),
  batchId: z.string().uuid(), batchVersion: z.number().int().min(1), sourceRevision: z.number().int().min(0).max(1000),
  sourceHash: digest, planId: digest, asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currentPreviewDigest: digest, sourceContextDigest: digest, request: identityGroupPlanSchema,
  canApply: z.literal(false), persisted: z.literal(false), affectsCurrentState: z.literal(false), proposalValidationComplete: z.literal(true),
  observations: z.array(observationSchema).min(1).max(25), blockers: z.array(z.unknown()).length(0)
}).passthrough();
export type IdentityGroupReviewSource = Pick<ImportIdentityGroupReview, 'id' | 'batchId' | 'batchVersion' | 'sourceRevision' | 'sourceHash' | 'planId' | 'plan'> & {
  rows: Pick<ImportIdentityGroupRow, 'reviewId' | 'recordId' | 'sourceHash' | 'originalCandidateId' | 'groupId' | 'snapshot' | 'isReserved'>[];
  release: { id: string } | null;
};

function invalidReview(): never { throw new ApiError(409, 'INVALID_IDENTITY_GROUP_REVIEW', 'Saved identity review lineage cannot be interpreted consistently'); }

export function validateIdentityGroupReview(review: IdentityGroupReviewSource, original: WorkbookPreviewInput, asOf = previewDate()) {
  if (review.release) throw new ApiError(409, 'IDENTITY_GROUP_ALREADY_RELEASED', 'Released groups are historical proposals; retrieve the review receipt');
  return validateIdentityGroupReviewLineage(review, original, asOf);
}

// Historical lineage validation does not restore reservations or authorize a current projection.
export function validateIdentityGroupReviewLineage(review: IdentityGroupReviewSource, original: WorkbookPreviewInput, asOf = previewDate()) {
  const raw = z.record(z.unknown()).safeParse(review.plan);
  const parsed = savedPlanSchema.safeParse(review.plan);
  if (!raw.success || !parsed.success) return invalidReview();
  const saved = parsed.data;
  const nonContentKeys = new Set(['planId', 'canApply', 'persisted', 'affectsCurrentState', 'lineagePersistenceImplemented', 'proposalValidationComplete', 'summary']);
  const content = Object.fromEntries(Object.entries(raw.data).filter(([key]) => !nonContentKeys.has(key)));
  if (importPlanDigest(content) !== review.planId || saved.planId !== review.planId || saved.batchId !== review.batchId ||
    saved.batchVersion !== review.batchVersion || saved.sourceRevision !== review.sourceRevision ||
    saved.sourceHash !== review.sourceHash || review.sourceHash !== original.source.sha256 ||
    saved.request.expectedVersion !== review.batchVersion || saved.request.expectedSourceRevision !== review.sourceRevision) return invalidReview();
  const baseline = buildWorkbookPreview(original, [], asOf);
  let scope: ReturnType<typeof selectIdentityGroupScope>;
  try { scope = selectIdentityGroupScope(baseline, saved.request); }
  catch (error) { if (error instanceof ApiError) return invalidReview(); throw error; }
  const { selected, selectedRecords } = scope;
  if (review.rows.length !== selectedRecords.size || saved.observations.length !== selectedRecords.size ||
    new Set(review.rows.map((row) => row.recordId)).size !== review.rows.length ||
    new Set(saved.observations.map((row) => row.recordId)).size !== saved.observations.length) return invalidReview();
  for (const row of review.rows) {
    const observation = saved.observations.find((entry) => entry.recordId === row.recordId);
    const record = baseline.records.find((entry) => entry.id === row.recordId);
    const candidate = selected.find((entry) => entry.recordIds.includes(row.recordId));
    const group = saved.request.groups.find((entry) => entry.recordIds.includes(row.recordId));
    if (!observation || !record || !candidate || !group || row.isReserved !== (review.release === null) || row.reviewId !== review.id ||
      row.sourceHash !== review.sourceHash || row.originalCandidateId !== candidate.id || row.groupId !== group.groupId ||
      observation.originalCandidateId !== candidate.id || observation.proposedGroupId !== group.groupId ||
      observation.sheet !== record.sheet || observation.row !== record.row ||
      importPlanDigest(row.snapshot) !== importPlanDigest(observation)) return invalidReview();
  }
  return saved;
}

export function buildIdentityGroupProjection(original: WorkbookPreviewInput, effective: WorkbookPreviewInput, existing: ExistingAsset[],
  context: { batchId: string; batchVersion: number; sourceContext: SourceContext }, review: IdentityGroupReviewSource,
  impacts: IdentityGroupImpacts = { decisions: [], pilotItems: [], evidence: [] }, asOf = previewDate()) {
  const saved = validateIdentityGroupReview(review, original, asOf);
  if (context.batchId !== review.batchId || context.batchVersion < review.batchVersion || context.sourceContext.revision < review.sourceRevision) return invalidReview();
  const current = buildIdentityGroupPlan(original, effective, existing, context,
    { ...saved.request, expectedVersion: context.batchVersion, expectedSourceRevision: context.sourceContext.revision }, impacts, asOf);
  for (const observation of current.observations) {
    const stored = saved.observations.find((entry) => entry.recordId === observation.recordId)!;
    // Active reservations seal selected identity cells, even when unrelated source revisions advance.
    if (importPlanDigest(observation.originalIdentityCells) !== importPlanDigest(stored.originalIdentityCells) ||
      importPlanDigest(observation.currentIdentityCells) !== importPlanDigest(stored.currentIdentityCells)) return invalidReview();
  }
  const projected = buildWorkbookPreview(projectIdentityGroupWorkbook(effective, current.changes), existing, asOf, 'DATABASE');
  const groups = current.proposedGroups.map((group) => {
    const groupKey = importPlanDigest(['IMPORT_IDENTITY_GROUP', review.sourceHash, review.id, group.groupId]);
    const observations = current.observations.filter((entry) => group.recordIds.includes(entry.recordId)).map((observation) => {
      const record = projected.records.find((entry) => entry.id === observation.recordId)!;
      const stored = saved.observations.find((entry) => entry.recordId === observation.recordId)!;
      return { recordId: record.id, sheet: record.sheet, row: record.row, hidden: record.hidden, kind: record.kind,
        originalCandidateId: observation.originalCandidateId, groupKey,
        originalIdentityCells: observation.originalIdentityCells, reviewedIdentityCells: stored.currentIdentityCells,
        currentIdentityCells: observation.currentIdentityCells,
        projectedIdentity: { serialKey: record.serialKey, tagKey: record.tagKey }, fields: record.fields, statusEvidence: record.statusEvidence };
    });
    const evidence = current.impacts.evidence.filter((entry) => group.recordIds.includes(entry.recordId)).map((entry) => ({
      ...entry, linkedToGroup: false, requiresExplicitLineageReview: true
    }));
    return { ...group, groupKey, reviewId: review.id, observations, evidence,
      originalDecisions: current.impacts.decisions.filter((entry) => group.originalCandidateIds.includes(entry.targetId)),
      requiresNewDecision: true, requiresEvidenceLineageReview: evidence.length > 0 };
  });
  const content = { rulesVersion: identityGroupProjectionRulesVersion, scope: 'IDENTITY_GROUP_EFFECTIVE_PREVIEW',
    reviewId: review.id, sourceHash: review.sourceHash, batchId: context.batchId, batchVersion: context.batchVersion,
    sourceRevision: context.sourceContext.revision, asOf, timeZone: 'America/Santiago', reviewedPlanId: review.planId, currentScenarioPlanId: current.planId,
    currentPreviewDigest: current.currentPreviewDigest, projectedPreviewDigest: projected.previewId, sourceContextDigest: current.sourceContextDigest,
    freshness: { reviewSnapshotCurrent: review.planId === current.planId, batchVersionChanged: review.batchVersion !== context.batchVersion,
      sourceRevisionChanged: review.sourceRevision !== context.sourceContext.revision, asOfChanged: saved.asOf !== asOf,
      sourceContextChanged: saved.sourceContextDigest !== current.sourceContextDigest, currentPreviewChanged: saved.currentPreviewDigest !== current.currentPreviewDigest },
    operationKind: current.operationKind, groups, changes: current.changes, blockers: current.blockers, issues: current.issues, warnings: current.warnings,
    impacts: current.impacts, requiresNewDecisions: true, requiresEvidenceLineageReview: current.requiresEvidenceLineageReview };
  return { ...content, projectionId: importPlanDigest(content), persisted: false, reviewPersisted: true, canApply: false,
    affectsCurrentState: false, groupedPilotImplemented: false, projectionValidationComplete: current.proposalValidationComplete, summary: current.summary };
}
