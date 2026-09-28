import { z } from 'zod';

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(128)
});

const passwordSchema = z.string()
  .min(12, 'Password must contain at least 12 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

const roleSchema = z.enum(['JEFE', 'COORDINADOR', 'SOPORTE']);

const phoneSchema = z.string()
  .trim()
  .min(7, 'Phone must contain at least 7 characters')
  .max(40)
  .regex(/^[0-9+().\-\s]+$/, 'Phone contains invalid characters');

const userFieldsSchema = z.object({
  username: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._-]+$/),
  email: z.string().trim().email().max(255),
  displayName: z.string().trim().min(1).max(150),
  phone: phoneSchema,
  role: roleSchema
});

export const userCreateSchema = userFieldsSchema.strict();

export const accountUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(150).optional(),
  email: z.string().trim().email().max(255).nullable().optional(),
  phone: phoneSchema.nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const userUpdateSchema = z.object({
  username: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
  email: z.string().trim().email().max(255).nullable().optional(),
  displayName: z.string().trim().min(1).max(150).optional(),
  phone: phoneSchema.nullable().optional(),
  role: roleSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const bootstrapAdminSchema = userFieldsSchema.extend({ password: passwordSchema }).strict();

export const activationSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
  activationCode: z.string().trim().min(16).max(128),
  password: passwordSchema,
  passwordConfirmation: z.string().optional()
}).strict().refine((value) => value.passwordConfirmation === undefined || value.password === value.passwordConfirmation, {
  path: ['passwordConfirmation'],
  message: 'Passwords do not match'
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema
}).strict();

export const userIdSchema = z.object({ id: z.string().uuid() });
const userPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0)
});
export const userListQuerySchema = userPaginationSchema.extend({
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  search: z.string().trim().max(160).optional()
});
