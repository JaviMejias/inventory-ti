import { z } from 'zod';

import { closedAssignmentPlanSchema } from './assignment-plan-schemas.js';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const groupClosedAssignmentPlanSchema = z.object({
  expectedApplicationPlanId: z.string().regex(/^[a-f0-9]{64}$/),
  links: z.array(z.object({
    evidenceId: uuid, linkId: uuid,
    expectedLinkVersion: z.number().int().min(1).max(1000),
    expectedEvidenceVersion: z.number().int().min(0).max(1000)
  }).strict()).min(2).max(50),
  plan: closedAssignmentPlanSchema
}).strict().superRefine((input, context) => {
  const endpoints = input.plan.periods.flatMap((period) => [period.start.evidenceId, period.end.evidenceId]);
  if (input.links.length !== endpoints.length || new Set(input.links.map((entry) => entry.evidenceId)).size !== input.links.length ||
    new Set(input.links.map((entry) => entry.linkId)).size !== input.links.length ||
    input.links.some((entry) => !endpoints.includes(entry.evidenceId))) {
    context.addIssue({ code: 'custom', message: 'Select exactly one distinct saved link for each endpoint evidence' });
  }
});
export type GroupClosedAssignmentPlanInput = z.infer<typeof groupClosedAssignmentPlanSchema>;
