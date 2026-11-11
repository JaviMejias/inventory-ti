import { z } from 'zod';

import { historicalRetirementPlanSchema } from './retirement-plan-schemas.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const groupRetirementPlanSchema = z.object({
  expectedBatchVersion: z.number().int().min(1).max(2147483647),
  expectedSourceRevision: z.number().int().min(0).max(1000),
  expectedDecisionVersion: z.number().int().min(1).max(2147483647),
  projectionId: digest, groupKey: digest,
  decisionId: z.string().uuid().transform((value) => value.toLowerCase()),
  expectedEvidenceVersion: z.number().int().min(0).max(1000),
  acknowledgedGroupWarnings: z.array(digest).max(500).default([]),
  plan: historicalRetirementPlanSchema
}).strict().refine((input) => new Set(input.acknowledgedGroupWarnings).size === input.acknowledgedGroupWarnings.length, 'Group warning acknowledgements must be distinct');

export type GroupRetirementPlanInput = z.infer<typeof groupRetirementPlanSchema>;
