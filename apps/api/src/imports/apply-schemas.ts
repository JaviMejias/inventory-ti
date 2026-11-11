import { z } from 'zod';

import { pilotPlanSchema } from './plan-schemas.js';

export const pilotApplySchema = z.object({
  requestId: z.string().uuid(), planId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('APPLY_ASSET_PILOT'), plan: pilotPlanSchema
}).strict();
export const applicationIdSchema = z.object({ id: z.string().uuid(), applicationId: z.string().uuid() }).strict();
export const applicationListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(2147483647).default(0)
}).strict();
export type PilotApplyInput = z.infer<typeof pilotApplySchema>;
export type ApplicationListQuery = z.infer<typeof applicationListSchema>;
