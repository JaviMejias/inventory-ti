import { z } from 'zod';

import { groupClosedAssignmentPlanSchema } from './group-assignment-plan-schemas.js';
import { identityGroupHistoryParamsSchema } from './identity-group-history-schemas.js';
import { importPlanDigest } from './plan.js';

export const groupClosedAssignmentApplySchema = z.object({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  planId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('APPLY_GROUP_CLOSED_ASSIGNMENT_HISTORY'),
  plan: groupClosedAssignmentPlanSchema
}).strict();
export const groupAssignmentApplicationParamsSchema = identityGroupHistoryParamsSchema.extend({
  groupApplicationId: z.string().uuid().transform((value) => value.toLowerCase())
}).strict();
export type GroupClosedAssignmentApplyInput = z.infer<typeof groupClosedAssignmentApplySchema>;

export function groupClosedAssignmentApplyDigest(input: GroupClosedAssignmentApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan,
    links: [...input.plan.links].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
    plan: { periods: [...input.plan.plan.periods].sort((a, b) => a.periodId.localeCompare(b.periodId))
      .map((period) => ({ ...period, acknowledgedWarnings: [...period.acknowledgedWarnings].sort() })) }
  } });
}
