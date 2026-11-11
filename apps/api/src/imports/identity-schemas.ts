import { z } from 'zod';

import { identifierKey } from './preview.js';

const common = {
  expectedRevision: z.number().int().min(0).max(999),
  expectedBatchVersion: z.number().int().min(1).max(2147483647),
  requestId: z.string().uuid(), candidateId: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().trim().min(1).max(2000), evidenceReference: z.string().trim().min(1).max(500)
};
const identifier = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => identifierKey(value) !== null, 'Use an explicitly verified identifier').nullable();
export const identityRevisionSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('VERIFY'), confirmation: z.literal('VERIFIED_PHYSICAL_IDENTITY'),
    serialNumber: identifier(160), assetTag: identifier(100) }).strict(),
  z.object({ ...common, action: z.literal('RESTORE'), confirmation: z.literal('RESTORE_ORIGINAL_IDENTITY') }).strict()
]).refine((input) => input.action !== 'VERIFY' || input.serialNumber !== null || input.assetTag !== null, 'At least one verified identifier is required');
export type IdentityRevisionInput = z.infer<typeof identityRevisionSchema>;
