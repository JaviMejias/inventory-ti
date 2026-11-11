import { z } from 'zod';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const confirmedInstant = z.string().datetime({ offset: true }).refine((value) => {
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant >= new Date('1900-01-01T00:00:00Z') && value.slice(0, 10) >= '1900-01-01' &&
    !/\.\d{4,}/.test(value);
}, 'Historical instants must be valid and no earlier than 1900');
const endpoint = z.object({
  evidenceId: uuid,
  confirmedAt: confirmedInstant.nullable().default(null),
  dateEvidenceReference: z.string().trim().min(1).max(500).nullable().default(null)
}).strict();
const recipient = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PERSON'), name: z.string().trim().min(2).max(150).regex(/\s+\S+/) }).strict(),
  z.object({ type: z.literal('OFFICE'), name: z.string().trim().min(1).max(160) }).strict()
]);

export const closedAssignmentPlanSchema = z.object({
  periods: z.array(z.object({
    periodId: uuid, confirmation: z.literal('VERIFIED_CLOSED_ASSIGNMENT'),
    start: endpoint, end: endpoint, recipient: recipient.nullable().default(null),
    assignmentType: z.enum(['STANDARD', 'LOAN']),
    returnStatus: z.enum(['AVAILABLE', 'UNDER_REVIEW', 'IN_REPAIR']).nullable().default(null),
    note: z.string().trim().min(1).max(2000), evidenceReference: z.string().trim().min(1).max(500),
    acknowledgedWarnings: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000).default([])
  }).strict()).min(1).max(25)
}).strict().superRefine((input, context) => {
  const ids = input.periods.map((period) => period.periodId);
  const evidenceIds = input.periods.flatMap((period) => [period.start.evidenceId, period.end.evidenceId]);
  if (new Set(ids).size !== ids.length || new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({ code: 'custom', message: 'Periods and endpoint observations must be distinct' });
  }
  for (const period of input.periods) {
    if (new Set(period.acknowledgedWarnings).size !== period.acknowledgedWarnings.length) context.addIssue({ code: 'custom', message: 'Warning acknowledgements must be distinct' });
  }
});
export type ClosedAssignmentPlanInput = z.infer<typeof closedAssignmentPlanSchema>;
