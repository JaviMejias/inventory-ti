import { z } from 'zod';

import { workbookPreviewSchema } from './schemas.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const page = { limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(2147483647).default(0) };

export const batchCreateSchema = z.object({ workbook: workbookPreviewSchema, previewId: digest }).strict();
export const batchIdSchema = z.object({ id: z.string().uuid() }).strict();
export const batchListSchema = z.object({ ...page, sourceHash: digest.optional() }).strict();
export const decisionListSchema = z.object({
  ...page, mode: z.enum(['latest', 'history']).default('latest'),
  targetType: z.enum(['CANDIDATE', 'RECORD']).optional(), targetId: digest.optional()
}).strict().refine((query) => !query.targetId || query.targetType !== undefined, 'targetId requires targetType');
export const reviewDecisionSchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483646), requestId: z.string().uuid(),
  expectedSourceRevision: z.number().int().min(0).max(1000).default(0),
  targetType: z.enum(['CANDIDATE', 'RECORD']), targetId: digest,
  action: z.enum(['HOLD', 'EXCLUDE', 'LINK_EXISTING', 'PROPOSE_NEW']), linkedAssetId: z.string().uuid().optional(),
  note: z.string().trim().min(1).max(2000)
}).strict().superRefine((decision, context) => {
  if ((decision.action === 'LINK_EXISTING') !== Boolean(decision.linkedAssetId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only LINK_EXISTING requires linkedAssetId' });
  if (decision.targetType === 'RECORD' && !['HOLD', 'EXCLUDE'].includes(decision.action)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stand-alone records support HOLD or EXCLUDE only' });
});

export type BatchCreateInput = z.infer<typeof batchCreateSchema>;
export type BatchListQuery = z.infer<typeof batchListSchema>;
export type DecisionListQuery = z.infer<typeof decisionListSchema>;
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
