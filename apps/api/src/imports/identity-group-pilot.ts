import type { ImportIdentityGroupDecision } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { assetPilotHistoryFields, assetPilotProductBlockers } from './asset-pilot-rules.js';
import { identityGroupDecisionDigest, identityGroupDecisionSchema } from './identity-group-decision-schemas.js';
import { identityGroupDecisionRulesVersion, validateIdentityGroupDecision, type IdentityGroupProjection } from './identity-group-decision.js';
import type { IdentityGroupPilotInput } from './identity-group-pilot-schemas.js';
import { importPlanDigest, type PlanAsset, type PlanProduct } from './plan.js';
import { identifierKey } from './preview.js';

export const identityGroupPilotRulesVersion = 'mda-identity-group-pilot-1';
function invalidDecision(): never { throw new ApiError(409, 'INVALID_IDENTITY_GROUP_DECISION', 'Saved group decision cannot be interpreted consistently'); }

export function validateStoredDecision(decision: ImportIdentityGroupDecision, projection: IdentityGroupProjection) {
  const stored = z.record(z.unknown()).safeParse(decision.projection);
  const intent = identityGroupDecisionSchema.safeParse({ requestId: decision.requestId, confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
    expectedDecisionVersion: decision.version - 1, expectedBatchVersion: decision.batchVersion, expectedSourceRevision: decision.sourceRevision,
    projectionId: decision.projectionId, groupKey: decision.groupKey, action: decision.action,
    ...(decision.linkedAssetId ? { linkedAssetId: decision.linkedAssetId } : {}), note: decision.note,
    evidenceReference: decision.evidenceReference, evidenceReviews: decision.evidenceReviews });
  if (!stored.success || !intent.success || decision.rulesVersion !== identityGroupDecisionRulesVersion ||
    decision.reviewId !== projection.reviewId || !projection.groups.some((group) => group.groupKey === decision.groupKey && group.groupId === decision.groupId) ||
    identityGroupDecisionDigest(intent.data) !== decision.requestDigest) return invalidDecision();
  const saved = stored.data;
  const nonContentKeys = new Set(['projectionId', 'persisted', 'reviewPersisted', 'canApply', 'affectsCurrentState', 'groupedPilotImplemented', 'projectionValidationComplete', 'summary']);
  const content = Object.fromEntries(Object.entries(saved).filter(([key]) => !nonContentKeys.has(key)));
  if (importPlanDigest(content) !== decision.projectionId || saved.projectionId !== decision.projectionId ||
    saved.rulesVersion !== projection.rulesVersion || saved.scope !== projection.scope || saved.reviewId !== decision.reviewId ||
    saved.batchId !== projection.batchId || saved.sourceHash !== projection.sourceHash || saved.reviewedPlanId !== projection.reviewedPlanId ||
    saved.batchVersion !== decision.batchVersion || saved.sourceRevision !== decision.sourceRevision ||
    saved.canApply !== false || saved.persisted !== false || saved.reviewPersisted !== true || saved.affectsCurrentState !== false ||
    saved.groupedPilotImplemented !== false) return invalidDecision();
  return intent.data;
}

export function buildIdentityGroupPilot(projection: IdentityGroupProjection, decisions: ImportIdentityGroupDecision[], products: PlanProduct[], assets: PlanAsset[], input: IdentityGroupPilotInput,
  consumedRows: { recordId: string }[] = []) {
  if (projection.batchVersion !== input.expectedBatchVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the review batch');
  if (projection.sourceRevision !== input.expectedSourceRevision) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload the source interpretation');
  if (projection.projectionId !== input.projectionId) throw new ApiError(409, 'IDENTITY_GROUP_PROJECTION_CHANGED', 'Review the current grouping preview');
  if (decisions.length > 25 || new Set(decisions.map((entry) => entry.groupKey)).size !== decisions.length ||
    new Set(decisions.map((entry) => entry.version)).size !== decisions.length) return invalidDecision();
  const decisionVersion = Math.max(0, ...decisions.map((entry) => entry.version));
  if (decisionVersion !== input.expectedDecisionVersion) throw new ApiError(409, 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT', 'Reload latest group decisions', { currentVersion: decisionVersion });
  const intents = new Map(decisions.map((decision) => [decision.groupKey, validateStoredDecision(decision, projection)]));
  const operations = [...input.operations].sort((a, b) => a.groupKey.localeCompare(b.groupKey)).map((operation) => {
    const group = projection.groups.find((entry) => entry.groupKey === operation.groupKey);
    if (!group) throw new ApiError(400, 'INVALID_IDENTITY_GROUP_TARGET', 'Choose a physical group in this active review');
    const decision = decisions.find((entry) => entry.groupKey === group.groupKey);
    const intent = intents.get(group.groupKey);
    const blockers: { code: string; issueId?: string }[] = [];
    const block = (code: string) => blockers.push({ code });
    if (consumedRows.some((row) => group.recordIds.includes(row.recordId))) block('IDENTITY_GROUP_SOURCE_ALREADY_APPLIED');
    if (!projection.projectionValidationComplete) block('IDENTITY_GROUP_PROJECTION_BLOCKED');
    if (!decision) block('GROUP_DECISION_REQUIRED');
    else {
      if (decision.id !== operation.decisionId) block('GROUP_DECISION_NOT_LATEST');
      if (decision.projectionId !== projection.projectionId) block('GROUP_DECISION_STALE');
      else if (intent) {
        try { validateIdentityGroupDecision(projection, intent); }
        catch (error) { if (error instanceof ApiError) block(error.code); else throw error; }
      }
    }
    const positions = new Set(group.observations.map((entry) => entry.sheet + ':' + entry.row));
    const sheets = new Set(group.observations.map((entry) => entry.sheet));
    const sourceIssues = projection.issues.filter((issue) => issue.candidateId ? group.simulatedCandidateIds.includes(issue.candidateId) :
      issue.sheet === null || (issue.row === null ? sheets.has(issue.sheet) : positions.has(issue.sheet + ':' + issue.row)));
    for (const issue of sourceIssues) if (issue.severity === 'BLOCKING') blockers.push({ code: 'SOURCE_' + issue.code, issueId: importPlanDigest(issue) });
    const warnings = sourceIssues.filter((issue) => issue.severity === 'WARNING').map((issue) => ({ ...issue, id: importPlanDigest(issue) }));
    if (warnings.some((warning) => !operation.acknowledgedWarnings.includes(warning.id))) block('WARNINGS_NOT_ACKNOWLEDGED');
    if (operation.acknowledgedWarnings.some((id) => !warnings.some((warning) => warning.id === id))) block('UNKNOWN_WARNING_ACKNOWLEDGEMENT');
    const current = operation.type === 'UPDATE_METADATA' ? assets.find((asset) => asset.id === operation.assetId) : undefined;
    const product = products.find((entry) => entry.id === (operation.type === 'CREATE_ASSET' ? operation.values.productId : current?.productId));
    for (const code of assetPilotProductBlockers(product, group.observations)) block(code);
    if (group.observations.some((entry) => entry.kind === 'RETIREMENT_HISTORY' || entry.statusEvidence === 'DECOMMISSIONED')) block('RETIREMENT_REQUIRES_SEPARATE_WORKFLOW');
    if (operation.type === 'CREATE_ASSET') {
      if (decision?.action !== 'PROPOSE_NEW') block('NEW_GROUP_ASSET_REVIEW_REQUIRED');
      if (group.candidates.some((entry) => entry.existingAssetCount > 0)) block('EXISTING_ASSET_MATCH');
      if (group.observations.some((entry) => entry.statusEvidence !== 'AVAILABLE')) block('SOURCE_AVAILABILITY_UNCONFIRMED');
      if (group.observations.some((entry) => assetPilotHistoryFields.some((field) => identifierKey(entry.fields[field] ?? null)))) block('SOURCE_HISTORY_REQUIRES_SEPARATE_WORKFLOW');
      const serial = identifierKey(operation.values.serialNumber ?? null); const tag = identifierKey(operation.values.assetTag ?? null);
      if (!serial && !tag) block('MISSING_ASSET_IDENTITY');
      if ((operation.values.serialNumber != null && !serial) || (operation.values.assetTag != null && !tag)) block('IDENTITY_PLACEHOLDER_NOT_ALLOWED');
      if (serial !== identifierKey(group.serialNumber) || tag !== identifierKey(group.assetTag)) block('GROUP_IDENTITY_MISMATCH');
    } else {
      if (decision?.action !== 'LINK_EXISTING' || decision.linkedAssetId !== operation.assetId ||
        !group.candidates.some((entry) => entry.existingAssets.some((asset) => asset.id === operation.assetId))) block('EXISTING_GROUP_ASSET_REVIEW_REQUIRED');
      if (!current) block('ASSET_NOT_FOUND');
      else if (!current.isActive || current.status === 'DECOMMISSIONED') block('ASSET_DECOMMISSIONED');
    }
    const changes = Object.entries(operation.values).filter(([field, value]) => field !== 'productId' && value !== undefined)
      .filter(([field, value]) => operation.type === 'CREATE_ASSET' || current?.[field as keyof PlanAsset] !== value)
      .map(([field, value]) => ({ field, before: current?.[field as keyof PlanAsset] ?? null, after: value }));
    if (operation.type === 'UPDATE_METADATA' && current && changes.length === 0) block('NO_METADATA_CHANGE');
    return { ...operation, acknowledgedWarnings: [...operation.acknowledgedWarnings].sort(), groupId: group.groupId,
      decision: decision ? { id: decision.id, version: decision.version, action: decision.action, projectionId: decision.projectionId,
        projectionCurrent: decision.projectionId === projection.projectionId, linkedAssetId: decision.linkedAssetId,
        reviewedById: decision.reviewedById, note: decision.note, evidenceReference: decision.evidenceReference } : null,
      product: product ?? null, before: current ?? null, changes, resultingStatus: operation.type === 'CREATE_ASSET' ? 'AVAILABLE' : current?.status ?? null,
      source: group.observations, originalCandidateIds: group.originalCandidateIds,
      deduplication: group.recordIds.map((recordId) => ({ sourceHash: projection.sourceHash, recordId,
        key: importPlanDigest(['IMPORT_SOURCE_ROW', projection.sourceHash, recordId]) })),
      evidence: group.evidence.map((entry) => ({ ...entry, review: intent?.evidenceReviews.find((review) => review.evidenceId === entry.id) ?? null, appliedByThisPlan: false })),
      warnings, blockers, valid: blockers.length === 0 };
  });
  const selected = new Set(operations.map((entry) => entry.groupKey));
  const omittedGroups = projection.groups.filter((entry) => !selected.has(entry.groupKey)).map((group) => ({
    groupKey: group.groupKey, recordIds: group.recordIds, latestDecisionId: decisions.find((entry) => entry.groupKey === group.groupKey)?.id ?? null
  }));
  const content = { planRulesVersion: identityGroupPilotRulesVersion, scope: 'IDENTITY_GROUP_ASSET_PILOT', batchId: projection.batchId,
    reviewId: projection.reviewId, sourceHash: projection.sourceHash, batchVersion: projection.batchVersion, sourceRevision: projection.sourceRevision,
    decisionVersion, projectionId: projection.projectionId, reviewedPlanId: projection.reviewedPlanId, checkedAsOf: projection.asOf,
    timeZone: projection.timeZone, operations, omittedGroups };
  return { ...content, planId: importPlanDigest(content), mode: 'IDENTITY_GROUP_PILOT_PLAN', persisted: false, canApply: false,
    affectsCurrentState: false, evidenceRelinked: false, groupedPilotPlanImplemented: true, groupedPilotImplemented: false,
    planValidationComplete: operations.every((entry) => entry.valid),
    summary: { operationCount: operations.length, validCount: operations.filter((entry) => entry.valid).length,
      blockedCount: operations.filter((entry) => !entry.valid).length, createCount: operations.filter((entry) => entry.type === 'CREATE_ASSET').length,
      updateCount: operations.filter((entry) => entry.type === 'UPDATE_METADATA').length,
      selectedObservationCount: operations.reduce((total, entry) => total + entry.source.length, 0), omittedGroupCount: omittedGroups.length } };
}
