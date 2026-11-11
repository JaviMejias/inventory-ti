import { z } from 'zod';

import { identityGroupPlanSchema } from './identity-group-plan-schemas.js';
import { importPlanDigest } from './plan.js';

const requestId = z.string().uuid().transform((value) => value.toLowerCase());
export const identityGroupReviewSchema = z.object({
  requestId, planId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('RESERVE_IDENTITY_GROUP_REVIEW_ONLY'), plan: identityGroupPlanSchema
}).strict();
export const identityGroupReleaseSchema = z.object({
  requestId, confirmation: z.literal('RELEASE_IDENTITY_GROUP_REVIEW_ONLY'), note: z.string().trim().min(1).max(2000)
}).strict();
export const identityGroupReviewParamsSchema = z.object({ id: z.string().uuid(), reviewId: z.string().uuid() }).strict();
export type IdentityGroupReviewInput = z.infer<typeof identityGroupReviewSchema>;
export type IdentityGroupReleaseInput = z.infer<typeof identityGroupReleaseSchema>;

export function identityGroupReviewDigest(input: IdentityGroupReviewInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, candidateIds: [...input.plan.candidateIds].sort(),
    groups: input.plan.groups.map((group) => ({ ...group, recordIds: [...group.recordIds].sort() })).sort((a, b) => a.groupId.localeCompare(b.groupId)) } });
}
