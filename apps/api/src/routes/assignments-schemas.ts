import { z } from 'zod';

const uuid = z.string().uuid();
const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
};

export const assetIdSchema = z.object({ id: uuid });
export const assignmentParamsSchema = z.object({ id: uuid, assignmentId: uuid });

export const assignmentCreateSchema = z.object({
  personName: z.string().trim().min(2).max(150).regex(/\s+\S+/, 'Enter the recipient first and last name').optional(),
  // Kept optional for backwards compatibility with assignments created before
  // the free-text recipient flow was introduced.
  personId: uuid.optional()
}).refine((input) => Boolean(input.personName || input.personId), { message: 'A recipient name is required' });

export const assignmentListQuerySchema = z.object({
  assetId: uuid.optional(),
  personId: uuid.optional(),
  active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  ...pagination
});

export const assignmentUserQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  ...pagination
});

export type AssignmentCreateInput = z.infer<typeof assignmentCreateSchema>;
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;
export type AssignmentUserQuery = z.infer<typeof assignmentUserQuerySchema>;
