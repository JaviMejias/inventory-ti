import { z } from 'zod';

import { nullableText } from '../lib/nullable-text.js';

const uuid = z.string().uuid();
const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(2_147_483_647).default(0)
};

const effectiveDate = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const assetIdSchema = z.object({ id: uuid });
export const assignmentParamsSchema = z.object({ id: uuid, assignmentId: uuid });

export const assignmentCreateSchema = z.object({
  recipientType: z.enum(['PERSON', 'OFFICE']).default('PERSON'),
  personName: z.string().trim().min(2).max(150).regex(/\s+\S+/, 'Enter the recipient first and last name').optional(),
  // Kept optional for backwards compatibility with assignments created before
  // the free-text recipient flow was introduced.
  personId: uuid.optional(),
  officeName: z.string().trim().min(1).max(160).optional(),
  assignmentType: z.enum(['STANDARD', 'LOAN']).default('STANDARD'),
  expectedReturnAt: effectiveDate.nullable().optional(),
  effectiveAt: effectiveDate.optional(),
  ticketReference: nullableText(160),
  otReference: nullableText(160),
  notes: nullableText(10_000)
}).strict().superRefine((input, context) => {
  if (input.recipientType === 'PERSON') {
    if (!input.personName && !input.personId) context.addIssue({ code: 'custom', path: ['personName'], message: 'A recipient name is required' });
    if (input.officeName !== undefined) context.addIssue({ code: 'custom', path: ['officeName'], message: 'A person assignment cannot have an office recipient' });
  } else {
    if (!input.officeName) context.addIssue({ code: 'custom', path: ['officeName'], message: 'An office name is required' });
    if (input.personName !== undefined || input.personId !== undefined) context.addIssue({ code: 'custom', path: ['recipientType'], message: 'An office assignment cannot have a person recipient' });
  }
  if (input.expectedReturnAt && input.assignmentType !== 'LOAN') context.addIssue({ code: 'custom', path: ['expectedReturnAt'], message: 'Only loans have an expected return date' });
});

export const assignmentReturnSchema = z.object({
  effectiveAt: effectiveDate.optional(),
  returnStatus: z.enum(['AVAILABLE', 'UNDER_REVIEW', 'IN_REPAIR']).default('AVAILABLE'),
  ticketReference: nullableText(160),
  otReference: nullableText(160),
  notes: nullableText(10_000)
}).strict();

export const assignmentListQuerySchema = z.object({
  assetId: uuid.optional(),
  personId: uuid.optional(),
  recipientType: z.enum(['PERSON', 'OFFICE']).optional(),
  assignmentType: z.enum(['STANDARD', 'LOAN']).optional(),
  officeName: z.string().trim().min(1).max(160).optional(),
  active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  ...pagination
});

export const assignmentUserQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  ...pagination
});

export type AssignmentCreateInput = z.infer<typeof assignmentCreateSchema>;
export type AssignmentReturnInput = z.infer<typeof assignmentReturnSchema>;
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;
export type AssignmentUserQuery = z.infer<typeof assignmentUserQuerySchema>;
