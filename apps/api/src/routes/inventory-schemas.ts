import { z } from 'zod';

import { maximumQuantity, minimumQuantity } from '../lib/quantity.js';

const uuid = z.string().uuid();
const positiveQuantity = z.coerce.number().int().positive().max(maximumQuantity);
const effectiveAt = z.coerce.date().optional();

export const idSchema = z.object({ id: uuid });

const movementBaseSchema = z.object({
  productId: uuid,
  quantity: positiveQuantity,
  reason: z.string().trim().max(10_000).nullable().optional(),
  reference: z.string().trim().max(160).nullable().optional(),
  effectiveAt
});

export const stockListQuerySchema = z.object({ productId: uuid.optional() });
export const movementListQuerySchema = z.object({
  productId: uuid.optional(),
  performedById: uuid.optional(),
  movementType: z.enum(['INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'ADJUSTMENT']).optional(),
  from: effectiveAt,
  to: effectiveAt
});

export type MovementListQuery = z.infer<typeof movementListQuerySchema>;

export const initialSchema = movementBaseSchema;
export const entrySchema = movementBaseSchema;
export const exitSchema = movementBaseSchema;
export const returnSchema = movementBaseSchema;
export const adjustmentSchema = z.object({
  productId: uuid,
  quantity: z.coerce.number().int().min(minimumQuantity).max(maximumQuantity).refine((value) => value !== 0, 'Adjustment cannot be zero'),
  reason: z.string().trim().min(1).max(10_000),
  reference: z.string().trim().max(160).nullable().optional(),
  effectiveAt
});
