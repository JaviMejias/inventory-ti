import { z } from 'zod';

import { groupAssignmentCorrectionParamsSchema, groupAssignmentCorrectionPlanSchema } from './group-assignment-correction-schemas.js';
import { importPlanDigest } from './plan.js';

export const groupCorrectionApplySchema = z.object({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  correctionPlanId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('APPLY_GROUP_ASSIGNMENT_CORRECTION'),
  plan: groupAssignmentCorrectionPlanSchema
}).strict();
export const groupCorrectionReceiptParamsSchema = groupAssignmentCorrectionParamsSchema.extend({ correctionId: z.string().uuid().transform((value) => value.toLowerCase()) }).strict();
export type GroupCorrectionApplyInput = z.infer<typeof groupCorrectionApplySchema>;
export function groupCorrectionRequestDigest(input: GroupCorrectionApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, correction: { ...input.plan.correction,
    acknowledgedWarnings: [...input.plan.correction.acknowledgedWarnings].sort() } } });
}
