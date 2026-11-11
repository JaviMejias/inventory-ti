import { z } from 'zod';

import { importPlanDigest } from './plan.js';
import { historicalRetirementPlanSchema } from './retirement-plan-schemas.js';

export const historicalRetirementApplySchema = z.object({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()), planId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('APPLY_VERIFIED_HISTORICAL_RETIREMENT'), plan: historicalRetirementPlanSchema
}).strict();
export const retirementApplicationParamsSchema = z.object({ id: z.string().uuid(), applicationId: z.string().uuid() }).strict();
export type HistoricalRetirementApplyInput = z.infer<typeof historicalRetirementApplySchema>;

export function retirementRequestDigest(input: HistoricalRetirementApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, acknowledgedWarnings: [...input.plan.acknowledgedWarnings].sort() } });
}
