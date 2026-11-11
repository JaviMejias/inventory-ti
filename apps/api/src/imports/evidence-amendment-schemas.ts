import { z } from 'zod';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const evidenceAmendmentPlanSchema = z.object({ assetId: uuid.nullable() }).strict();
export const evidenceAmendmentParamsSchema = z.object({ id: uuid, amendmentId: uuid }).strict();
export const evidenceAmendmentSchema = z.object({
  requestId: uuid, amendmentPlanId: z.string().regex(/^[a-f0-9]{64}$/),
  expectedEvidenceVersion: z.number().int().min(0).max(999), expectedBatchVersion: z.number().int().min(1).max(2147483647),
  expectedSourceRevision: z.number().int().min(0).max(1000), confirmation: z.literal('AMEND_HISTORICAL_EVIDENCE_ONLY'),
  assetId: uuid.nullable(), note: z.string().trim().min(1).max(2000), evidenceReference: z.string().trim().min(1).max(500)
}).strict();
export type EvidenceAmendmentInput = z.infer<typeof evidenceAmendmentSchema>;
