import { z } from 'zod';

import { identityGroupPilotSchema } from './identity-group-pilot-schemas.js';
import { importPlanDigest } from './plan.js';

export const identityGroupApplySchema = z.object({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  planId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('APPLY_IDENTITY_GROUP_ASSET_PILOT'),
  plan: identityGroupPilotSchema
}).strict();
export const identityGroupApplicationParamsSchema = z.object({
  id: z.string().uuid().transform((value) => value.toLowerCase()),
  reviewId: z.string().uuid().transform((value) => value.toLowerCase()),
  applicationId: z.string().uuid().transform((value) => value.toLowerCase())
}).strict();
export type IdentityGroupApplyInput = z.infer<typeof identityGroupApplySchema>;

export function identityGroupApplyDigest(input: IdentityGroupApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, operations: [...input.plan.operations]
    .sort((a, b) => a.groupKey.localeCompare(b.groupKey))
    .map((operation) => ({ ...operation, acknowledgedWarnings: [...operation.acknowledgedWarnings].sort() })) } });
}
