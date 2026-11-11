import { z } from 'zod';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const identityGroupHistoryParamsSchema = z.object({ id: uuid, reviewId: uuid, applicationId: uuid, itemId: uuid }).strict();
export const identityGroupHistoryPlanSchema = z.object({
  expectedApplicationPlanId: digest,
  operations: z.array(z.object({
    evidenceId: uuid,
    expectedEvidenceVersion: z.number().int().min(0).max(1000),
    action: z.literal('LINK_TO_APPLIED_GROUP'),
    note: z.string().trim().min(1).max(2000),
    evidenceReference: z.string().trim().min(1).max(500),
    acknowledgedWarnings: z.array(digest).max(50).default([])
  }).strict()).min(1).max(25)
}).strict().superRefine((input, context) => {
  if (new Set(input.operations.map((operation) => operation.evidenceId)).size !== input.operations.length ||
    input.operations.some((operation) => new Set(operation.acknowledgedWarnings).size !== operation.acknowledgedWarnings.length)) {
    context.addIssue({ code: 'custom', message: 'Evidence and warning acknowledgements must be distinct' });
  }
});
export type IdentityGroupHistoryPlanInput = z.infer<typeof identityGroupHistoryPlanSchema>;
