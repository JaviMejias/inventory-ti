import { ApiError } from '../lib/errors.js';
import type { IdentityGroupDecisionInput } from './identity-group-decision-schemas.js';
import type { buildIdentityGroupProjection } from './identity-group-projection.js';

export const identityGroupDecisionRulesVersion = 'mda-identity-group-decision-1';
export type IdentityGroupProjection = ReturnType<typeof buildIdentityGroupProjection>;

export function validateIdentityGroupDecision(projection: IdentityGroupProjection, input: IdentityGroupDecisionInput) {
  if (input.expectedBatchVersion !== projection.batchVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the batch before reviewing groups');
  if (input.expectedSourceRevision !== projection.sourceRevision) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload the source interpretation');
  if (input.projectionId !== projection.projectionId) throw new ApiError(409, 'IDENTITY_GROUP_PROJECTION_CHANGED', 'Review the current effective grouping preview');
  const group = projection.groups.find((entry) => entry.groupKey === input.groupKey);
  if (!group) throw new ApiError(400, 'INVALID_IDENTITY_GROUP_TARGET', 'Choose a stable group key from this review');
  const actionable = ['LINK_EXISTING', 'PROPOSE_NEW'].includes(input.action);
  if (actionable && !projection.projectionValidationComplete) throw new ApiError(409, 'IDENTITY_GROUP_DECISION_BLOCKED', 'Resolve current grouping blockers before proposing an operational target');
  const matches = new Set(group.candidates.flatMap((candidate) => candidate.existingAssets.map((asset) => asset.id)));
  if (input.action === 'PROPOSE_NEW' && (matches.size > 0 || group.candidates.some((candidate) => candidate.existingAssetCount > 0))) {
    throw new ApiError(409, 'NEW_ASSET_PROPOSAL_CONFLICT', 'This group currently matches an existing asset');
  }
  if (input.action === 'LINK_EXISTING' && (matches.size !== 1 || !matches.has(input.linkedAssetId!) ||
    group.candidates.some((candidate) => candidate.existingAssetCount !== 1 || candidate.hasMoreExistingAssets))) {
    throw new ApiError(409, 'ASSET_NOT_SUGGESTED', 'Select the unique existing asset suggested by this group');
  }
  if (actionable || input.evidenceReviews.length > 0) {
    if (input.evidenceReviews.length !== group.evidence.length || input.evidenceReviews.some((review) => !group.evidence.some((entry) => entry.id === review.evidenceId))) {
      throw new ApiError(409, 'IDENTITY_GROUP_EVIDENCE_COVERAGE_REQUIRED', 'Explicitly review every archived evidence item of this group');
    }
    for (const review of input.evidenceReviews) {
      const evidence = group.evidence.find((entry) => entry.id === review.evidenceId)!;
      if (evidence.evidenceVersion !== review.expectedEvidenceVersion) throw new ApiError(409, 'EVIDENCE_VERSION_CONFLICT', 'Reload the latest evidence version');
      if (evidence.assignmentUse || evidence.retirementUse) throw new ApiError(409, 'EVIDENCE_ALREADY_APPLIED', 'Applied evidence cannot receive regrouping authority');
    }
  }
  return group;
}
