import { createHash } from 'node:crypto';

import type { Asset, ImportReviewDecision, Product } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { assetPilotHistoryFields, assetPilotProductBlockers } from './asset-pilot-rules.js';
import type { PilotPlanInput } from './plan-schemas.js';
import { identifierKey, type buildWorkbookPreview } from './preview.js';
import type { SourceContext } from './source.js';

export const pilotPlanRulesVersion = 'mda-pilot-3';
type Preview = ReturnType<typeof buildWorkbookPreview>;
export type PlanProduct = Pick<Product, 'id' | 'name' | 'trackingMode' | 'isActive' | 'equipmentType' | 'brand' | 'model' | 'updatedAt'>;
export type PlanAsset = Pick<Asset, 'id' | 'productId' | 'serialNumber' | 'assetTag' | 'status' | 'isActive' | 'updatedAt' |
  'technicalCondition' | 'usagePurpose' | 'location' | 'sector' | 'ipAddress' | 'hostname' | 'loanCode' | 'notes'>;
export type PlanDecision = Pick<ImportReviewDecision, 'id' | 'targetType' | 'targetId' | 'action' | 'linkedAssetId' | 'batchVersion'> & { sourceRevision?: number };
type PlanBatch = { id: string; version: number; targetCount: number; previewId: string; rulesVersion: string; databaseSnapshotDigest: string; asOf: string };

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

export function importPlanDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

const digest = importPlanDigest;

export function buildPilotPlan(batch: PlanBatch, preview: Preview, decisions: PlanDecision[], products: PlanProduct[], assets: PlanAsset[], input: PilotPlanInput, sourceContext: SourceContext = { revision: 0, corrections: [] }) {
  if (batch.version !== input.expectedVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the batch before planning changes', { currentVersion: batch.version });
  if ((input.expectedSourceRevision ?? 0) !== sourceContext.revision) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload source corrections before planning changes', { currentRevision: sourceContext.revision });
  const rulesChanged = batch.rulesVersion !== preview.rulesVersion;
  const databaseChanged = batch.databaseSnapshotDigest !== preview.databaseSnapshotDigest;
  const freshness = { stale: rulesChanged || databaseChanged, rulesChanged, databaseChanged, reviewDateChanged: batch.asOf !== preview.asOf };
  const operations = [...input.operations].sort((a, b) => a.candidateId.localeCompare(b.candidateId)).map((operation) => {
    const candidate = preview.candidates.find((entry) => entry.id === operation.candidateId);
    if (!candidate) throw new ApiError(400, 'INVALID_REVIEW_TARGET', 'Pilot operations require a physical candidate in this batch');
    const observations = preview.records.filter((record) => candidate.recordIds.includes(record.id));
    const sourceIssues = preview.issues.filter((issue) => issue.candidateId === candidate.id || (issue.candidateId === null && observations.some((record) =>
      issue.sheet === record.sheet && (issue.row === null || issue.row === record.row))));
    const warnings = sourceIssues.filter((issue) => issue.severity === 'WARNING').map((issue) => ({ ...issue, id: digest(issue) }));
    const blockers: { code: string; issueId?: string }[] = sourceIssues.filter((issue) => issue.severity === 'BLOCKING').map((issue) => ({ code: issue.code, issueId: digest(issue) }));
    const block = (code: string) => { blockers.push({ code }); };
    if (freshness.stale) block('BATCH_SNAPSHOT_STALE');
    if (warnings.some((warning) => !operation.acknowledgedWarnings.includes(warning.id))) block('WARNINGS_NOT_ACKNOWLEDGED');
    if (operation.acknowledgedWarnings.some((id) => !warnings.some((warning) => warning.id === id))) block('UNKNOWN_WARNING_ACKNOWLEDGEMENT');
    const decision = decisions.find((entry) => entry.targetType === 'CANDIDATE' && entry.targetId === candidate.id);
    const identityRevision = Math.max(sourceContext.identityRevisions?.find((entry) => entry.candidateId === candidate.id)?.revision ?? 0,
      ...sourceContext.corrections.filter((entry) => entry.candidateId === candidate.id &&
      ['serialNumber', 'assetTag'].includes(entry.field)).map((entry) => entry.revision));
    if (identityRevision > (decision?.sourceRevision ?? 0)) block('IDENTITY_REVIEW_DECISION_REQUIRED');
    const product = products.find((entry) => entry.id === (operation.type === 'CREATE_ASSET' ? operation.values.productId : assets.find((asset) => asset.id === operation.assetId)?.productId));
    const current = operation.type === 'UPDATE_METADATA' ? assets.find((entry) => entry.id === operation.assetId) : undefined;
    for (const code of assetPilotProductBlockers(product, observations)) block(code);
    if (observations.some((record) => record.kind === 'RETIREMENT_HISTORY' || record.statusEvidence === 'DECOMMISSIONED')) block('RETIREMENT_REQUIRES_SEPARATE_WORKFLOW');
    if (operation.type === 'CREATE_ASSET') {
      if (decision?.action !== 'PROPOSE_NEW') block('NEW_ASSET_REVIEW_REQUIRED');
      if (candidate.existingAssets.length > 0) block('EXISTING_ASSET_MATCH');
      if (observations.some((record) => record.statusEvidence !== 'AVAILABLE')) block('SOURCE_AVAILABILITY_UNCONFIRMED');
      if (observations.some((record) => assetPilotHistoryFields
        .some((field) => identifierKey(record.fields[field] ?? null)))) block('SOURCE_HISTORY_REQUIRES_SEPARATE_WORKFLOW');
      const serial = identifierKey(operation.values.serialNumber ?? null);
      const tag = identifierKey(operation.values.assetTag ?? null);
      if (!serial && !tag) block('MISSING_ASSET_IDENTITY');
      if ((operation.values.serialNumber != null && !serial) || (operation.values.assetTag != null && !tag)) block('IDENTITY_PLACEHOLDER_NOT_ALLOWED');
      // A pilot cannot invent an identity, silently drop one, or repair damaged numeric identities.
      if ((serial !== (candidate.serials[0] ?? null)) || (tag !== (candidate.tags[0] ?? null))) block('SOURCE_IDENTITY_MISMATCH');
      if (preview.candidates.some((other) => other.id !== candidate.id &&
        ((serial && other.serials.includes(serial)) || (tag && other.tags.includes(tag))))) block('CROSS_CANDIDATE_IDENTITY_CONFLICT');
    } else {
      if (decision?.action !== 'LINK_EXISTING' || decision.linkedAssetId !== operation.assetId || !candidate.existingAssets.some((asset) => asset.id === operation.assetId)) block('EXISTING_ASSET_REVIEW_REQUIRED');
      if (!current) block('ASSET_NOT_FOUND');
      else if (!current.isActive || current.status === 'DECOMMISSIONED') block('ASSET_DECOMMISSIONED');
    }
    const changes = Object.entries(operation.values).filter(([field, value]) => field !== 'productId' && value !== undefined)
      .filter(([field, value]) => operation.type === 'CREATE_ASSET' || current?.[field as keyof PlanAsset] !== value)
      .map(([field, value]) => ({ field, before: current?.[field as keyof PlanAsset] ?? null, after: value }));
    if (operation.type === 'UPDATE_METADATA' && current && changes.length === 0) block('NO_METADATA_CHANGE');
    return { ...operation, acknowledgedWarnings: [...operation.acknowledgedWarnings].sort(), decisionId: decision?.id ?? null,
      identityRevision, decisionSourceRevision: decision?.sourceRevision ?? 0,
      sourceCorrections: sourceContext.corrections.filter((correction) => correction.candidateId === candidate.id),
      product: product ?? null, before: current ?? null, changes, resultingStatus: operation.type === 'CREATE_ASSET' ? 'AVAILABLE' : current?.status ?? null,
      source: observations.map((record) => ({ recordId: record.id, sheet: record.sheet, row: record.row })), warnings, blockers,
      valid: blockers.length === 0 };
  });
  const content = { planRulesVersion: pilotPlanRulesVersion, batchId: batch.id, batchVersion: batch.version,
    sourceRevision: sourceContext.revision,
    stagedPreviewId: batch.previewId, currentPreviewId: preview.previewId, checkedAsOf: preview.asOf, freshness,
    scope: 'ASSET_PILOT' as const, omittedTargetCount: batch.targetCount - operations.length, operations };
  return { ...content, planId: digest(content), mode: 'PILOT_PLAN' as const, persisted: false, canApply: false,
    planValidationComplete: operations.every((operation) => operation.valid),
    summary: { operationCount: operations.length, validCount: operations.filter((operation) => operation.valid).length,
      blockedCount: operations.filter((operation) => !operation.valid).length,
      createCount: operations.filter((operation) => operation.type === 'CREATE_ASSET').length,
      updateCount: operations.filter((operation) => operation.type === 'UPDATE_METADATA').length } };
}
