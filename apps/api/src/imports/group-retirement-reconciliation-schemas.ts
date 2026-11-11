import { z } from 'zod';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const groupRetirementReconciliationSchema = z.object({ groupKey: z.string().regex(/^[a-f0-9]{64}$/), assetId: uuid, evidenceId: uuid }).strict();
export type GroupRetirementReconciliationInput = z.infer<typeof groupRetirementReconciliationSchema>;
