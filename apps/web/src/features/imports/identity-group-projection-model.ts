import type { IdentityGroupPlan } from './identity-group-model';
import type { SourceRecord } from './import-review-model';

export type IdentityGroupProjection = {
  rulesVersion: 'mda-identity-group-projection-1'; scope: 'IDENTITY_GROUP_EFFECTIVE_PREVIEW';
  projectionId: string; reviewId: string; sourceHash: string; batchId: string; batchVersion: number; sourceRevision: number;
  asOf: string; timeZone: 'America/Santiago'; reviewedPlanId: string; currentScenarioPlanId: string;
  currentPreviewDigest: string; projectedPreviewDigest: string; sourceContextDigest: string;
  freshness: { reviewSnapshotCurrent: boolean; batchVersionChanged: boolean; sourceRevisionChanged: boolean; asOfChanged: boolean; sourceContextChanged: boolean; currentPreviewChanged: boolean };
  operationKind: IdentityGroupPlan['operationKind'];
  groups: Array<IdentityGroupPlan['proposedGroups'][number] & {
    groupKey: string; reviewId: string;
    observations: Array<{
      recordId: string; sheet: string; row: number; hidden: boolean; kind: SourceRecord['kind']; originalCandidateId: string; groupKey: string;
      originalIdentityCells: IdentityGroupPlan['observations'][number]['originalIdentityCells'];
      reviewedIdentityCells: IdentityGroupPlan['observations'][number]['currentIdentityCells'];
      currentIdentityCells: IdentityGroupPlan['observations'][number]['currentIdentityCells'];
      projectedIdentity: { serialKey: string | null; tagKey: string | null }; fields: Record<string, string | null>; statusEvidence: SourceRecord['statusEvidence'];
    }>;
    evidence: Array<IdentityGroupPlan['impacts']['evidence'][number] & { linkedToGroup: false; requiresExplicitLineageReview: true }>;
    originalDecisions: IdentityGroupPlan['impacts']['decisions']; requiresNewDecision: true; requiresEvidenceLineageReview: boolean;
  }>;
  changes: IdentityGroupPlan['changes']; blockers: IdentityGroupPlan['blockers']; issues: IdentityGroupPlan['issues']; warnings: IdentityGroupPlan['warnings']; impacts: IdentityGroupPlan['impacts'];
  requiresNewDecisions: true; requiresEvidenceLineageReview: boolean; persisted: false; reviewPersisted: true;
  canApply: false; affectsCurrentState: false; groupedPilotImplemented: false; projectionValidationComplete: boolean; summary: IdentityGroupPlan['summary'];
};
