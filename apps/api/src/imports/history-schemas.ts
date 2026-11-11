import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const historicalKindSchema = z.enum(['RECEIPT_OBSERVATION', 'USAGE_OBSERVATION', 'LOAN_OBSERVATION', 'RETIREMENT_OBSERVATION']);
export const historyCaptureSchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483647), expectedSourceRevision: z.number().int().min(0).max(1000),
  requestId: z.string().uuid(), historyPreviewId: digest, confirmation: z.literal('STORE_HISTORICAL_EVIDENCE_ONLY'),
  note: z.string().trim().min(1).max(2000), evidenceReference: z.string().trim().min(1).max(500),
  records: z.array(z.object({ recordId: digest, kind: historicalKindSchema, assetId: z.string().uuid().transform((value) => value.toLowerCase()).nullable().default(null) }).strict()).min(1).max(25)
}).strict().refine((input) => new Set(input.records.map((entry) => entry.recordId + ':' + entry.kind)).size === input.records.length, 'Each source observation may occur only once');
export const historyPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(2147483647).default(0)
}).strict();
export const historyCaptureIdSchema = z.object({ id: z.string().uuid(), captureId: z.string().uuid() }).strict();
export type HistoricalKind = z.infer<typeof historicalKindSchema>;
export type HistoryCaptureInput = z.infer<typeof historyCaptureSchema>;
export type HistoryPageQuery = z.infer<typeof historyPageSchema>;
