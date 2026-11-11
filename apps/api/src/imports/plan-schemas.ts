import { z } from 'zod';

import { assetCreateSchema } from '../routes/assets-schemas.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  candidateId: digest, note: z.string().trim().min(1).max(2000),
  acknowledgedWarnings: z.array(digest).max(500).default([])
};
export const assetPilotMetadataSchema = assetCreateSchema.omit({ productId: true, serialNumber: true, assetTag: true })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'At least one metadata field is required');

export const pilotPlanSchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483647),
  expectedSourceRevision: z.number().int().min(0).max(1000).default(0),
  operations: z.array(z.discriminatedUnion('type', [
    z.object({ ...common, type: z.literal('CREATE_ASSET'), values: assetCreateSchema,
      confirmation: z.literal('AVAILABLE_UNASSIGNED') }).strict(),
    z.object({ ...common, type: z.literal('UPDATE_METADATA'), assetId: z.string().uuid(), values: assetPilotMetadataSchema }).strict()
  ])).min(1).max(25)
}).strict().superRefine((input, context) => {
  const candidates = input.operations.map((operation) => operation.candidateId);
  const assets = input.operations.flatMap((operation) => operation.type === 'UPDATE_METADATA' ? [operation.assetId] : []);
  if (new Set(candidates).size !== candidates.length || new Set(assets).size !== assets.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Each candidate and existing asset may occur only once' });
  }
  for (const operation of input.operations) {
    if (new Set(operation.acknowledgedWarnings).size !== operation.acknowledgedWarnings.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Warning acknowledgements must be unique' });
    }
  }
});

export type PilotPlanInput = z.infer<typeof pilotPlanSchema>;
