import { z } from 'zod';

import { groupRetirementPlanSchema } from './group-retirement-plan-schemas.js';
import { importPlanDigest } from './plan.js';

export const groupRetirementApplySchema = z.object({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()), planId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT'), plan: groupRetirementPlanSchema
}).strict();
export const groupRetirementReceiptParamsSchema = z.object({ id: z.string().uuid().transform((value) => value.toLowerCase()),
  reviewId: z.string().uuid().transform((value) => value.toLowerCase()), groupRetirementApplicationId: z.string().uuid().transform((value) => value.toLowerCase()) }).strict();
export type GroupRetirementApplyInput = z.infer<typeof groupRetirementApplySchema>;
export function groupRetirementRequestDigest(input: GroupRetirementApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, acknowledgedGroupWarnings: [...input.plan.acknowledgedGroupWarnings].sort(),
    plan: { ...input.plan.plan, acknowledgedWarnings: [...input.plan.plan.acknowledgedWarnings].sort() } } });
}
