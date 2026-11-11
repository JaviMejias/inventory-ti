import { z } from 'zod';

import { identityGroupHistoryParamsSchema, identityGroupHistoryPlanSchema } from './identity-group-history-schemas.js';
import { importPlanDigest } from './plan.js';

export const groupHistoryApplySchema = z.object({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  historyLinkPlanId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('SAVE_GROUP_HISTORY_LINKS_ONLY'),
  plan: identityGroupHistoryPlanSchema
}).strict();
export const groupHistoryReceiptParamsSchema = identityGroupHistoryParamsSchema.extend({
  historyApplicationId: z.string().uuid().transform((value) => value.toLowerCase())
}).strict();
export type GroupHistoryApplyInput = z.infer<typeof groupHistoryApplySchema>;

export function groupHistoryApplyDigest(input: GroupHistoryApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, operations: [...input.plan.operations]
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))
    .map((operation) => ({ ...operation, acknowledgedWarnings: [...operation.acknowledgedWarnings].sort() })) } });
}
