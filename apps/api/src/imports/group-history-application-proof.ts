import type { ImportGroupHistoryApplication, ImportGroupHistoryLink, Prisma } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { historicalEvidenceSnapshotSchema } from './assignment-plan.js';
import { groupHistoryApplyDigest, groupHistoryApplySchema } from './identity-group-history-apply-schemas.js';
import { buildGroupHistoryProjection, groupHistoryApplicationRulesVersion } from './identity-group-history-apply-service.js';
import { groupHistoryPlanRulesVersion } from './identity-group-history-plan.js';
import { importPlanDigest } from './plan.js';
import { identifierKey } from './preview.js';
import type { validateGroupApplicationProof } from './identity-group-application-proof.js';

export type GroupHistoryApplicationProof = ImportGroupHistoryApplication & { links: ImportGroupHistoryLink[] };
type AppliedGroupProof = ReturnType<typeof validateGroupApplicationProof>[number];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const operationSchema = z.object({
  evidenceId: uuid, expectedEvidenceVersion: z.number().int().min(0).max(1000), action: z.literal('LINK_TO_APPLIED_GROUP'),
  note: z.string().min(1).max(2000), evidenceReference: z.string().min(1).max(500), acknowledgedWarnings: z.array(digest),
  evidenceVersion: z.number().int().min(0).max(1000), amendmentId: uuid.nullable(), captureId: uuid, captureBatchId: uuid,
  recordId: digest, originalCandidateId: digest, sheet: z.string(), row: z.number().int().positive(), kind: z.string(),
  capturedAssetId: uuid.nullable(), currentAssetId: uuid.nullable(), proposedAssetId: uuid,
  effectiveSourceRevision: z.number().int().min(0).max(1000), capturedSourceRevision: z.number().int().min(0).max(1000),
  effectiveDay: z.string().nullable(), datePrecision: z.enum(['DAY', 'UNKNOWN']), historicalActorId: z.null(),
  requiresIdentityProjection: z.boolean(), proposedIdentity: z.object({ serialNumber: z.string().nullable(), assetTag: z.string().nullable() }),
  originalSnapshot: historicalEvidenceSnapshotSchema, currentSnapshot: historicalEvidenceSnapshotSchema,
  savedGroupLink: z.null(), assignmentUse: z.null(), retirementUse: z.null(), valid: z.literal(true), blockers: z.array(z.unknown()).length(0),
  warnings: z.array(z.object({ id: digest, code: z.literal('GROUP_HISTORY_IDENTITY_PROJECTION_REQUIRED') }))
});
const requestKeys = new Set(['evidenceId', 'expectedEvidenceVersion', 'action', 'note', 'evidenceReference', 'acknowledgedWarnings']);
const envelopeKeys = new Set(['historyLinkPlanId', 'persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked',
  'historyLinkApplicationImplemented', 'planValidationComplete', 'summary']);
function invalid(): never { throw new ApiError(409, 'INVALID_GROUP_HISTORY_APPLICATION', 'Saved history confirmation cannot establish complete projection provenance'); }

export function validateGroupHistoryApplicationProof(receipt: GroupHistoryApplicationProof, proof: AppliedGroupProof,
  parents: { batchId: string; reviewId: string; id: string; planId: string; sourceHash: string }) {
  const parsed = z.record(z.unknown()).safeParse(receipt.plan);
  if (!parsed.success) return invalid();
  const plan = parsed.data;
  const savedAsset = z.object({ id: uuid, productId: uuid, serialNumber: z.string().nullable(), assetTag: z.string().nullable() }).safeParse(plan.asset);
  if (receipt.itemId !== proof.item.id || receipt.rulesVersion !== groupHistoryApplicationRulesVersion ||
    plan.scope !== 'IDENTITY_GROUP_HISTORY_LINK_PLAN' || plan.rulesVersion !== groupHistoryPlanRulesVersion ||
    plan.itemId !== proof.item.id || plan.groupKey !== proof.item.groupKey || plan.groupId !== proof.item.groupId ||
    plan.batchId !== parents.batchId || plan.reviewId !== parents.reviewId || plan.applicationId !== parents.id ||
    plan.applicationPlanId !== parents.planId || plan.sourceHash !== parents.sourceHash ||
    plan.persisted !== false || plan.canApply !== false || plan.affectsCurrentState !== false || plan.evidenceRelinked !== false ||
    plan.historyLinkApplicationImplemented !== false || plan.planValidationComplete !== true ||
    !savedAsset.success || savedAsset.data.id !== proof.item.assetId || savedAsset.data.productId !== proof.identity.productId ||
    identifierKey(savedAsset.data.serialNumber) !== identifierKey(proof.identity.serialNumber) || identifierKey(savedAsset.data.assetTag) !== identifierKey(proof.identity.assetTag) ||
    plan.historyLinkPlanId !== receipt.planId ||
    importPlanDigest(Object.fromEntries(Object.entries(plan).filter(([key]) => !envelopeKeys.has(key)))) !== receipt.planId ||
    importPlanDigest(plan.sourceRows) !== importPlanDigest(proof.item.rows) ||
    !Array.isArray(plan.operations) || plan.operations.length < 1 || plan.operations.length > 25 ||
    receipt.links.length !== plan.operations.length || new Set(receipt.links.map((entry) => entry.evidenceId)).size !== receipt.links.length ||
    new Set(receipt.links.map((entry) => entry.id)).size !== receipt.links.length) return invalid();
  const operations = plan.operations.map((operation) => {
    const raw = z.record(z.unknown()).safeParse(operation); const parsedOperation = operationSchema.safeParse(operation);
    if (!raw.success || !parsedOperation.success) return invalid();
    return { raw: raw.data, operation: parsedOperation.data };
  });
  const request = groupHistoryApplySchema.safeParse({ requestId: receipt.requestId, historyLinkPlanId: receipt.planId, confirmation: 'SAVE_GROUP_HISTORY_LINKS_ONLY',
    plan: { expectedApplicationPlanId: parents.planId, operations: operations.map(({ raw }) => Object.fromEntries(Object.entries(raw).filter(([key]) => requestKeys.has(key)))) } });
  if (!request.success || groupHistoryApplyDigest(request.data) !== receipt.requestDigest) return invalid();
  return operations.map(({ raw, operation }) => {
    const link = receipt.links.find((entry) => entry.evidenceId === operation.evidenceId);
    const source = proof.source.find((row) => row.recordId === operation.recordId);
    if (!link || !source || link.historyApplicationId !== receipt.id || link.version !== 1 || link.assetId !== proof.item.assetId ||
      link.evidenceVersion !== operation.evidenceVersion || link.evidenceVersion !== operation.expectedEvidenceVersion ||
      link.amendmentId !== operation.amendmentId || link.sourceRevision !== operation.effectiveSourceRevision ||
      source.originalCandidateId !== operation.originalCandidateId || source.sheet !== operation.sheet || source.row !== operation.row ||
      operation.proposedAssetId !== proof.item.assetId || (operation.currentAssetId !== null && operation.currentAssetId !== proof.item.assetId) ||
      importPlanDigest(link.operation) !== importPlanDigest(raw) ||
      importPlanDigest(raw.originalSnapshot && (raw.originalSnapshot as Prisma.JsonObject).original) !== importPlanDigest(raw.currentSnapshot && (raw.currentSnapshot as Prisma.JsonObject).original) ||
      operation.proposedIdentity.serialNumber !== proof.identity.serialNumber || operation.proposedIdentity.assetTag !== proof.identity.assetTag ||
      (operation.evidenceVersion === 0) !== (operation.amendmentId === null) || operation.effectiveSourceRevision < operation.capturedSourceRevision) return invalid();
    for (const snapshot of [operation.originalSnapshot, operation.currentSnapshot]) {
      if (snapshot.recordId !== operation.recordId || snapshot.candidateId !== operation.originalCandidateId || snapshot.kind !== operation.kind ||
        snapshot.original.id !== operation.recordId || snapshot.effective.id !== operation.recordId ||
        snapshot.original.sheet !== source.sheet || snapshot.effective.sheet !== source.sheet ||
        snapshot.original.row !== source.row || snapshot.effective.row !== source.row) return invalid();
    }
    if (operation.effectiveDay !== operation.currentSnapshot.effectiveDay || operation.datePrecision !== operation.currentSnapshot.datePrecision ||
      (operation.effectiveDay === null) !== (operation.datePrecision === 'UNKNOWN')) return invalid();
    const requiredProjection = operation.currentSnapshot.effective.serialKey !== identifierKey(proof.identity.serialNumber) ||
      operation.currentSnapshot.effective.tagKey !== identifierKey(proof.identity.assetTag);
    const warnings = requiredProjection ? [{ code: 'GROUP_HISTORY_IDENTITY_PROJECTION_REQUIRED',
      id: importPlanDigest({ evidenceId: link.evidenceId, evidenceVersion: link.evidenceVersion, itemId: proof.item.id, code: 'GROUP_HISTORY_IDENTITY_PROJECTION_REQUIRED' }) }] : [];
    if (operation.requiresIdentityProjection !== requiredProjection || importPlanDigest(operation.warnings) !== importPlanDigest(warnings) ||
      importPlanDigest([...operation.acknowledgedWarnings].sort()) !== importPlanDigest(warnings.map((warning) => warning.id).sort()) ||
      (operation.currentAssetId === proof.item.assetId && !requiredProjection)) return invalid();
    const stored = link.operation as Prisma.JsonObject;
    const projection = buildGroupHistoryProjection({ currentSnapshot: stored.currentSnapshot ?? null,
      proposedAssetId: operation.proposedAssetId, proposedIdentity: operation.proposedIdentity }, proof.item.id);
    if (importPlanDigest(projection) !== importPlanDigest(link.projection)) return invalid();
    return { receipt, link, operation, raw };
  });
}
