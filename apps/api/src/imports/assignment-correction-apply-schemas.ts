import { z } from 'zod';

import { assignmentCorrectionParamsSchema, assignmentCorrectionPlanSchema } from './assignment-correction-schemas.js';
import { importPlanDigest } from './plan.js';

export const assignmentCorrectionApplySchema = z.object({ requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  correctionPlanId: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('APPLY_LEGACY_ASSIGNMENT_CORRECTION'), plan: assignmentCorrectionPlanSchema }).strict();
export const assignmentCorrectionReceiptParamsSchema = assignmentCorrectionParamsSchema.extend({ correctionId: z.string().uuid().transform((value) => value.toLowerCase()) }).strict();
export type AssignmentCorrectionApplyInput = z.infer<typeof assignmentCorrectionApplySchema>;
export function assignmentCorrectionRequestDigest(input: AssignmentCorrectionApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, correction: { ...input.plan.correction, acknowledgedWarnings: [...input.plan.correction.acknowledgedWarnings].sort() } } });
}
