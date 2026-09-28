import { z } from 'zod';

const uuid = z.string().uuid();

export const correctionIdSchema = z.object({ id: uuid });
export const correctionMovementParamsSchema = z.object({ movementId: uuid });
const correctionReason = z.string().trim().min(1).max(10_000);
export const correctionCreateSchema = z.union([
  z.object({
    correctedQuantity: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    reason: correctionReason
  }).strict(),
  z.object({
    delta: z.coerce.number().int().min(-2_147_483_648).max(2_147_483_647).refine((value) => value !== 0, 'Correction delta cannot be zero'),
    reason: correctionReason
  }).strict()
]);
const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0)
});
export const correctionListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  movementType: z.enum(['INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'ADJUSTMENT']).optional(),
  search: z.string().trim().max(160).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
});

export type CorrectionCreateInput = z.infer<typeof correctionCreateSchema>;
export type CorrectionListQuery = z.infer<typeof correctionListQuerySchema>;
