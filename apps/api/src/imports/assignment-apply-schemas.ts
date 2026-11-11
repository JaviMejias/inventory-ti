import { z } from 'zod';

import { closedAssignmentPlanSchema } from './assignment-plan-schemas.js';
import { importPlanDigest } from './plan.js';

export const closedAssignmentApplySchema = z.object({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()), planId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('APPLY_CLOSED_ASSIGNMENT_HISTORY'), plan: closedAssignmentPlanSchema
}).strict();
export const assignmentApplicationParamsSchema = z.object({ id: z.string().uuid(), applicationId: z.string().uuid() }).strict();
export type ClosedAssignmentApplyInput = z.infer<typeof closedAssignmentApplySchema>;

export function closedAssignmentRequestDigest(input: ClosedAssignmentApplyInput) {
  return importPlanDigest({ ...input, plan: { periods: [...input.plan.periods].sort((a, b) => a.periodId.localeCompare(b.periodId))
    .map((period) => ({ ...period, acknowledgedWarnings: [...period.acknowledgedWarnings].sort() })) } });
}
