import type { ImportIdentityGroupApplication, ImportIdentityGroupApplicationItem, ImportIdentityGroupRowUse } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { identityGroupApplyDigest, identityGroupApplySchema } from './identity-group-apply-schemas.js';
import { identityGroupPilotRulesVersion } from './identity-group-pilot.js';
import { importPlanDigest } from './plan.js';
import { identifierKey } from './preview.js';

export type GroupApplicationProof = ImportIdentityGroupApplication & {
  items: (ImportIdentityGroupApplicationItem & { rows: ImportIdentityGroupRowUse[] })[]
};
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({ recordId: digest, originalCandidateId: digest, sheet: z.string(), row: z.number().int().positive() });
const operationSchema = z.object({ groupKey: digest, groupId: z.string().uuid(), decisionId: z.string().uuid(),
  decision: z.object({ id: z.string().uuid() }), valid: z.literal(true), blockers: z.array(z.unknown()).length(0),
  source: z.array(sourceSchema).min(1).max(25),
  evidence: z.array(z.object({ id: z.string().uuid(), recordId: digest, evidenceVersion: z.number().int().min(0).max(1000),
    appliedByThisPlan: z.literal(false), review: z.object({ disposition: z.enum(['CONFIRM_GROUP_MEMBERSHIP', 'EXCLUDE_FROM_GROUP_PILOT']) }).nullable() })).max(100),
  deduplication: z.array(z.object({ sourceHash: digest, recordId: digest, key: digest })).min(1).max(25) });
const resultSchema = z.object({ id: z.string().uuid(), productId: z.string().uuid(), serialNumber: z.string().nullable(), assetTag: z.string().nullable() });
const requestKeys = new Set(['type', 'groupKey', 'decisionId', 'note', 'acknowledgedWarnings', 'confirmation', 'values', 'assetId']);
const envelopeKeys = new Set(['planId', 'mode', 'persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked',
  'groupedPilotPlanImplemented', 'groupedPilotImplemented', 'planValidationComplete', 'summary']);
function invalid(): never { throw new ApiError(409, 'INVALID_IDENTITY_GROUP_APPLICATION', 'Saved group application cannot establish complete source ownership'); }

export function validateGroupApplicationProof(application: GroupApplicationProof) {
  const parsed = z.record(z.unknown()).safeParse(application.plan);
  if (!parsed.success) return invalid();
  const plan = parsed.data;
  if (plan.planId !== application.planId || plan.batchId !== application.batchId || plan.reviewId !== application.reviewId || plan.sourceHash !== application.sourceHash ||
    plan.planRulesVersion !== identityGroupPilotRulesVersion || plan.scope !== 'IDENTITY_GROUP_ASSET_PILOT' ||
    plan.persisted !== false || plan.canApply !== false || plan.affectsCurrentState !== false || plan.evidenceRelinked !== false ||
    plan.planValidationComplete !== true || !Array.isArray(plan.operations) || plan.operations.length < 1 || plan.operations.length > 25 ||
    application.items.length !== plan.operations.length || new Set(application.items.map((item) => item.groupKey)).size !== application.items.length ||
    importPlanDigest(Object.fromEntries(Object.entries(plan).filter(([key]) => !envelopeKeys.has(key)))) !== application.planId) return invalid();
  const rawOperations = plan.operations.map((operation) => {
    const value = z.record(z.unknown()).safeParse(operation);
    if (!value.success) return invalid();
    return value.data;
  });
  const request = identityGroupApplySchema.safeParse({ requestId: application.requestId, planId: application.planId,
    confirmation: 'APPLY_IDENTITY_GROUP_ASSET_PILOT', plan: { expectedBatchVersion: plan.batchVersion, expectedSourceRevision: plan.sourceRevision,
      expectedDecisionVersion: plan.decisionVersion, projectionId: plan.projectionId,
      operations: rawOperations.map((operation) => Object.fromEntries(Object.entries(operation).filter(([key]) => requestKeys.has(key)))) } });
  if (!request.success || identityGroupApplyDigest(request.data) !== application.requestDigest) return invalid();
  const records = new Set<string>();
  const items = application.items.map((item) => {
    const raw = rawOperations.find((operation) => operation.groupKey === item.groupKey);
    const operation = operationSchema.safeParse(item.operation); const result = resultSchema.safeParse(item.result);
    if (!raw || !operation.success || !result.success || item.applicationId !== application.id || item.assetId !== result.data.id ||
      item.groupId !== operation.data.groupId || item.groupKey !== operation.data.groupKey || item.decisionId !== operation.data.decisionId ||
      item.decisionId !== operation.data.decision.id || importPlanDigest(raw) !== importPlanDigest(item.operation)) return invalid();
    const requested = request.data.plan.operations.find((entry) => entry.groupKey === item.groupKey);
    const before = resultSchema.safeParse(raw.before);
    const expected = requested?.type === 'CREATE_ASSET' ? requested.values : before.success ? before.data : null;
    if (!expected || result.data.productId !== expected.productId || identifierKey(result.data.serialNumber) !== identifierKey(expected.serialNumber ?? null) ||
      identifierKey(result.data.assetTag) !== identifierKey(expected.assetTag ?? null)) return invalid();
    const source = operation.data.source;
    if (source.length !== item.rows.length || source.length !== operation.data.deduplication.length ||
      new Set(source.map((row) => row.recordId)).size !== source.length || new Set(operation.data.evidence.map((entry) => entry.id)).size !== operation.data.evidence.length ||
      operation.data.evidence.some((entry) => !source.some((row) => row.recordId === entry.recordId))) return invalid();
    for (const row of source) {
      const use = item.rows.find((entry) => entry.recordId === row.recordId);
      const key = operation.data.deduplication.find((entry) => entry.recordId === row.recordId);
      if (!use || !key || records.has(row.recordId) || use.itemId !== item.id || use.reviewId !== application.reviewId ||
        use.sourceHash !== application.sourceHash || use.originalCandidateId !== row.originalCandidateId || key.sourceHash !== application.sourceHash ||
        key.key !== importPlanDigest(['IMPORT_SOURCE_ROW', application.sourceHash, row.recordId])) return invalid();
      records.add(row.recordId);
    }
    return { item, source, identity: result.data, evidenceReviews: operation.data.evidence };
  });
  if (records.size > 25 || new Set(items.map(({ item }) => item.assetId)).size !== items.length) return invalid();
  return items;
}
