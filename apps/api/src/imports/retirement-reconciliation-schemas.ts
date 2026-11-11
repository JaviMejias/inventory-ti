import { z } from 'zod';

export const retirementReconciliationSchema = z.object({
  evidenceId: z.string().uuid().transform((value) => value.toLowerCase())
}).strict();

export type RetirementReconciliationInput = z.infer<typeof retirementReconciliationSchema>;
