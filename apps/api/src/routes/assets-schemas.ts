import { z } from 'zod';

const assetStatuses = ['AVAILABLE', 'ASSIGNED', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR', 'IN_WARRANTY', 'LOST', 'DECOMMISSIONED'] as const;
const uuid = z.string().uuid();

function nullableIdentifier(maximum: number) {
  return z.union([z.string().trim().max(maximum), z.null()]).optional().transform((value) => {
    if (value === undefined) return undefined;
    return value || null;
  });
}

export const assetIdSchema = z.object({ id: uuid });

export const assetListQuerySchema = z.object({
  productId: uuid.optional(),
  status: z.enum(assetStatuses).optional(),
  assetTag: z.string().trim().max(100).optional(),
  serialNumber: z.string().trim().max(160).optional(),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  search: z.string().trim().max(160).optional()
});

export const assetCreateSchema = z.object({
  productId: uuid,
  assetTag: nullableIdentifier(100),
  serialNumber: nullableIdentifier(160)
});

export const assetUpdateSchema = z.object({
  assetTag: nullableIdentifier(100),
  serialNumber: nullableIdentifier(160)
}).refine((value) => Object.values(value).some((field) => field !== undefined), 'At least one field is required');

export const assetStatusSchema = z.object({ status: z.enum(assetStatuses) });

export type AssetCreateInput = z.infer<typeof assetCreateSchema>;
export type AssetUpdateInput = z.infer<typeof assetUpdateSchema>;
export type AssetStatusInput = z.infer<typeof assetStatusSchema>;
