import { z } from 'zod';

import { closedAssignmentPlanSchema } from './assignment-plan-schemas.js';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const period = closedAssignmentPlanSchema.innerType().shape.periods.element;
export const assignmentCorrectionParamsSchema = z.object({ id: uuid, applicationId: uuid, assignmentItemId: uuid }).strict();
export const assignmentCorrectionPlanSchema = z.object({
  expectedOriginPlanId: z.string().regex(/^[a-f0-9]{64}$/),
  expectedCorrectionVersion: z.number().int().min(0).max(1000).default(0),
  reason: z.string().trim().min(1).max(2000), supportingReference: z.string().trim().min(1).max(500),
  correction: period.omit({ periodId: true, confirmation: true }).extend({
    start: period.shape.start.omit({ evidenceId: true }), end: period.shape.end.omit({ evidenceId: true })
  }).strict()
}).strict().superRefine((input, context) => {
  if (new Set(input.correction.acknowledgedWarnings).size !== input.correction.acknowledgedWarnings.length) {
    context.addIssue({ code: 'custom', message: 'Warning acknowledgements must be distinct' });
  }
});
export type AssignmentCorrectionPlanInput = z.infer<typeof assignmentCorrectionPlanSchema>;
