import { z } from 'zod';

import { nullableText } from '../lib/nullable-text.js';

const assetStatuses = ['AVAILABLE', 'ASSIGNED', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR', 'IN_WARRANTY', 'LOST', 'DECOMMISSIONED'] as const;
const uuid = z.string().uuid();

const assetMetadata = {
  assetTag: nullableText(100),
  serialNumber: nullableText(160),
  technicalCondition: nullableText(100),
  usagePurpose: nullableText(100),
  location: nullableText(160),
  sector: nullableText(100),
  ipAddress: nullableText(45).refine((value) => value == null || z.string().ip().safeParse(value).success, 'Enter a valid IPv4 or IPv6 address'),
  hostname: nullableText(160),
  loanCode: nullableText(100),
  notes: nullableText(10_000)
};

export const assetIdSchema = z.object({ id: uuid });

export const assetListQuerySchema = z.object({
  productId: uuid.optional(),
  status: z.enum(assetStatuses).optional(),
  assetTag: z.string().trim().max(100).optional(),
  serialNumber: z.string().trim().max(160).optional(),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  technicalCondition: z.string().trim().min(1).max(100).optional(),
  usagePurpose: z.string().trim().min(1).max(100).optional(),
  location: z.string().trim().min(1).max(160).optional(),
  sector: z.string().trim().min(1).max(100).optional(),
  equipmentType: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  search: z.string().trim().max(160).optional()
});

export const assetCreateSchema = z.object({
  productId: uuid,
  ...assetMetadata
}).strict();

export const assetUpdateSchema = z.object({
  ...assetMetadata
}).strict().refine((value) => Object.values(value).some((field) => field !== undefined), 'At least one field is required');

export const assetAvailabilityQuerySchema = z.object({
  productId: uuid.optional(),
  equipmentType: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(2_147_483_647).default(0)
}).strict();

export const assetStatusSchema = z.object({ status: z.enum(assetStatuses) });

export type AssetCreateInput = z.infer<typeof assetCreateSchema>;
export type AssetUpdateInput = z.infer<typeof assetUpdateSchema>;
export type AssetStatusInput = z.infer<typeof assetStatusSchema>;
export type AssetAvailabilityQuery = z.infer<typeof assetAvailabilityQuerySchema>;
