import { z } from 'zod';

import { importPlanDigest } from './plan.js';
import { retirementDocumentPlanSchema } from './retirement-document-schemas.js';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const groupRetirementDocumentPlanSchema = z.object({
  expectedBatchVersion: z.number().int().min(1).max(2147483647), expectedSourceRevision: z.number().int().min(0).max(1000),
  expectedDecisionVersion: z.number().int().min(1).max(2147483647), projectionId: digest, groupKey: digest, decisionId: uuid,
  expectedEvidenceVersion: z.number().int().min(0).max(1000),
  acknowledgedGroupWarnings: z.array(digest).max(500).refine((values) => new Set(values).size === values.length, 'Group warnings must be unique'),
  document: retirementDocumentPlanSchema
}).strict();
export const groupRetirementDocumentApplySchema = z.object({ requestId: uuid, planId: digest,
  confirmation: z.literal('RECONCILE_GROUP_RETIREMENT_DOCUMENT_ONLY'), plan: groupRetirementDocumentPlanSchema }).strict();
export const groupRetirementDocumentParamsSchema = z.object({ id: uuid, reviewId: uuid, reconciliationId: uuid }).strict();
export type GroupRetirementDocumentPlanInput = z.infer<typeof groupRetirementDocumentPlanSchema>;
export type GroupRetirementDocumentApplyInput = z.infer<typeof groupRetirementDocumentApplySchema>;
export function groupRetirementDocumentRequestDigest(input: GroupRetirementDocumentApplyInput) {
  return importPlanDigest({ ...input, plan: { ...input.plan, acknowledgedGroupWarnings: [...input.plan.acknowledgedGroupWarnings].sort(),
    document: { ...input.plan.document, acknowledgedWarnings: [...input.plan.document.acknowledgedWarnings].sort() } } });
}
