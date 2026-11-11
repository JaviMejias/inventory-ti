import { z } from 'zod';

import { identifierKey } from './preview.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const field = z.enum(['equipmentType', 'brand', 'model', 'receivedDate']);
const replacement = z.string().trim().min(1).max(160).refine((value) => identifierKey(value) !== null, 'A verified value is required');
const change = z.discriminatedUnion('action', [
  z.object({ recordId: digest, field, action: z.literal('REPLACE'), value: replacement }).strict(),
  z.object({ recordId: digest, field, action: z.literal('RESTORE') }).strict()
]);
export const sourceRevisionSchema = z.object({
  expectedRevision: z.number().int().min(0).max(999), expectedBatchVersion: z.number().int().min(1).max(2147483647),
  requestId: z.string().uuid(), note: z.string().trim().min(1).max(2000), evidenceReference: z.string().trim().min(1).max(500),
  changes: z.array(change).min(1).max(25)
}).strict().superRefine((input, context) => {
  const keys = input.changes.map((entry) => entry.recordId + ':' + entry.field);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'A source field may occur only once per revision' });
  for (const entry of input.changes) {
    if (entry.action !== 'REPLACE') continue;
    const max = entry.field === 'model' ? 160 : 100;
    if (entry.value.length > max) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Source value exceeds field limit' });
    if (entry.field === 'receivedDate') {
      const date = new Date(entry.value + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== entry.value || entry.value < '1900-01-01') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a real date in YYYY-MM-DD format' });
      }
    }
  }
});
export const sourcePageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(2147483647).default(0)
}).strict();
export type SourceRevisionInput = z.infer<typeof sourceRevisionSchema>;
export type SourceChangeInput = SourceRevisionInput['changes'][number];
export type SourcePageQuery = z.infer<typeof sourcePageSchema>;
