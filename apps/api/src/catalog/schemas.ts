import { z } from 'zod';

import { maximumQuantity } from '../lib/quantity.js';
import { nullableText } from '../lib/nullable-text.js';

const nameSchema = z.string().trim().min(1).max(160);
const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0)
});
const trackingModeSchema = z.enum(['QUANTITY', 'ASSET']);

export const catalogIdSchema = z.object({ id: z.string().uuid() });

export const productCreateSchema = z.object({
  name: nameSchema,
  sku: z.string().trim().max(100).nullable().optional(),
  equipmentType: nullableText(100),
  brand: nullableText(100),
  model: nullableText(160),
  trackingMode: trackingModeSchema,
  lowStockThreshold: z.number().int().min(0).max(maximumQuantity).default(0)
}).strict();

export const productUpdateSchema = productCreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const productListQuerySchema = paginationQuerySchema.extend({
  active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  equipmentType: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  search: z.string().trim().max(160).optional()
}).strict();
