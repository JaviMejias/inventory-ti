import { z } from 'zod';

import { importPlanDigest } from './plan.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const identityGroupEvidenceReviewSchema = z.object({
  evidenceId: uuid, expectedEvidenceVersion: z.number().int().min(0).max(1000),
  disposition: z.enum(['CONFIRM_GROUP_MEMBERSHIP', 'EXCLUDE_FROM_GROUP_PILOT']),
  evidenceReference: z.string().trim().min(1).max(500), note: z.string().trim().min(1).max(2000)
}).strict();
export const identityGroupDecisionSchema = z.object({
  requestId: uuid, confirmation: z.literal('RECORD_IDENTITY_GROUP_DECISION_ONLY'),
  expectedDecisionVersion: z.number().int().min(0).max(2147483646),
  expectedBatchVersion: z.number().int().min(1).max(2147483647),
  expectedSourceRevision: z.number().int().min(0).max(1000),
  projectionId: digest, groupKey: digest,
  action: z.enum(['HOLD', 'EXCLUDE', 'LINK_EXISTING', 'PROPOSE_NEW']), linkedAssetId: uuid.optional(),
  note: z.string().trim().min(1).max(2000), evidenceReference: z.string().trim().min(1).max(500),
  evidenceReviews: z.array(identityGroupEvidenceReviewSchema).max(100)
}).strict().superRefine((input, context) => {
  if ((input.action === 'LINK_EXISTING') !== Boolean(input.linkedAssetId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only LINK_EXISTING requires an asset' });
  if (new Set(input.evidenceReviews.map((entry) => entry.evidenceId)).size !== input.evidenceReviews.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Evidence reviews must be distinct' });
});
export const identityGroupDecisionListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(2147483647).default(0),
  mode: z.enum(['latest', 'history']).default('latest'), groupKey: digest.optional()
}).strict();
export const identityGroupDecisionParamsSchema = z.object({ id: uuid, reviewId: uuid, decisionId: uuid }).strict();
export type IdentityGroupDecisionInput = z.infer<typeof identityGroupDecisionSchema>;
export type IdentityGroupDecisionListQuery = z.infer<typeof identityGroupDecisionListSchema>;

export function identityGroupDecisionDigest(input: IdentityGroupDecisionInput) {
  return importPlanDigest({ ...input, evidenceReviews: [...input.evidenceReviews].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)) });
}
