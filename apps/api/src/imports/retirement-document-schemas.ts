import { z } from 'zod';

import { importPlanDigest } from './plan.js';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const retirementDocumentPlanSchema = z.object({ evidenceId: uuid, note: z.string().trim().min(1).max(2000),
  evidenceReference: z.string().trim().min(1).max(500), acknowledgedWarnings: z.array(digest).max(1000)
    .refine((values) => new Set(values).size === values.length, 'Warning acknowledgements must be unique') }).strict();
export const retirementDocumentApplySchema = z.object({ requestId: uuid, planId: digest,
  confirmation: z.literal('RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY'), plan: retirementDocumentPlanSchema }).strict();
export const retirementDocumentParamsSchema = z.object({ id: uuid, reconciliationId: uuid }).strict();
export type RetirementDocumentPlanInput = z.infer<typeof retirementDocumentPlanSchema>;
export type RetirementDocumentApplyInput = z.infer<typeof retirementDocumentApplySchema>;
export function retirementDocumentRequestDigest(input: RetirementDocumentApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, acknowledgedWarnings: [...input.plan.acknowledgedWarnings].sort() } });
}
