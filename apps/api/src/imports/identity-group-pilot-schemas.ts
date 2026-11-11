import { z } from 'zod';

import { assetCreateSchema } from '../routes/assets-schemas.js';
import { assetPilotMetadataSchema } from './plan-schemas.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const common = { groupKey: digest, decisionId: uuid, note: z.string().trim().min(1).max(2000),
  acknowledgedWarnings: z.array(digest).max(500).default([]) };
export const identityGroupPilotSchema = z.object({
  expectedBatchVersion: z.number().int().min(1).max(2147483647),
  expectedSourceRevision: z.number().int().min(0).max(1000),
  expectedDecisionVersion: z.number().int().min(0).max(2147483647),
  projectionId: digest,
  operations: z.array(z.discriminatedUnion('type', [
    z.object({ ...common, type: z.literal('CREATE_ASSET'), confirmation: z.literal('AVAILABLE_UNASSIGNED'),
      values: assetCreateSchema.extend({ productId: uuid }) }).strict(),
    z.object({ ...common, type: z.literal('UPDATE_METADATA'), assetId: uuid, values: assetPilotMetadataSchema }).strict()
  ])).min(1).max(25)
}).strict().superRefine((input, context) => {
  const keys = input.operations.map((entry) => entry.groupKey);
  const assets = input.operations.flatMap((entry) => entry.type === 'UPDATE_METADATA' ? [entry.assetId] : []);
  if (new Set(keys).size !== keys.length || new Set(assets).size !== assets.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Each group and existing asset may occur only once' });
  for (const operation of input.operations) if (new Set(operation.acknowledgedWarnings).size !== operation.acknowledgedWarnings.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Warning acknowledgements must be unique' });
  }
});
export type IdentityGroupPilotInput = z.infer<typeof identityGroupPilotSchema>;
