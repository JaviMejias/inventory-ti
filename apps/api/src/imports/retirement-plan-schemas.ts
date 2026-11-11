import { z } from 'zod';

import { confirmedInstant } from './assignment-plan-schemas.js';

export const historicalRetirementPlanSchema = z.object({
  evidenceId: z.string().uuid().transform((value) => value.toLowerCase()),
  confirmation: z.literal('VERIFIED_HISTORICAL_RETIREMENT'),
  confirmedAt: confirmedInstant.nullable().default(null),
  dateEvidenceReference: z.string().trim().min(1).max(500).nullable().default(null),
  note: z.string().trim().min(1).max(2000),
  evidenceReference: z.string().trim().min(1).max(500),
  acknowledgedWarnings: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000).default([])
}).strict().refine((input) => new Set(input.acknowledgedWarnings).size === input.acknowledgedWarnings.length,
  'Warning acknowledgements must be distinct');

export type HistoricalRetirementPlanInput = z.infer<typeof historicalRetirementPlanSchema>;
