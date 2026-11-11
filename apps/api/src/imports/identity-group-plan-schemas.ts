import { z } from 'zod';

import { identifierKey } from './preview.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = (max: number) => z.string().trim().min(1).max(max).refine((value) => identifierKey(value) !== null).nullable();
export const identityGroupPlanSchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483647),
  expectedSourceRevision: z.number().int().min(0).max(1000),
  confirmation: z.literal('REVIEW_PHYSICAL_IDENTITY_GROUPS'),
  candidateIds: z.array(digest).min(1).max(25),
  note: z.string().trim().min(1).max(2000),
  groups: z.array(z.object({
    groupId: z.string().uuid().transform((value) => value.toLowerCase()),
    recordIds: z.array(digest).min(1).max(25),
    serialNumber: identity(160), assetTag: identity(100),
    evidenceReference: z.string().trim().min(1).max(500)
  }).strict().refine((group) => group.serialNumber !== null || group.assetTag !== null, 'Verify at least one identifier')).min(1).max(25)
}).strict().superRefine((input, context) => {
  const records = input.groups.flatMap((group) => group.recordIds);
  if (new Set(input.candidateIds).size !== input.candidateIds.length || new Set(input.groups.map((group) => group.groupId)).size !== input.groups.length ||
    new Set(records).size !== records.length || records.length > 25) {
    context.addIssue({ code: 'custom', message: 'Distinct candidates/groups/records and at most twenty-five observations are required' });
  }
});

export type IdentityGroupPlanInput = z.infer<typeof identityGroupPlanSchema>;
