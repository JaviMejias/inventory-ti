import { Prisma, type Assignment } from '@prisma/client';

import type { HistoricalPlanAssignment } from './assignment-plan.js';

export type EffectiveAssignment = Assignment & { correctionId: string | null; correctionVersion: number | null; correctedById: string | null; correctedAt: Date | null };
type EffectiveQuery = { id?: string; assetId?: string; personId?: string; recipientType?: string; assignmentType?: string; officeName?: string; active?: boolean };
export function effectiveAssignmentWhere(query: EffectiveQuery) {
  const clauses = [Prisma.sql`true`];
  if (query.id) clauses.push(Prisma.sql`"id" = ${query.id}::uuid`);
  if (query.assetId) clauses.push(Prisma.sql`"assetId" = ${query.assetId}::uuid`);
  if (query.personId) clauses.push(Prisma.sql`"personId" = ${query.personId}::uuid`);
  if (query.recipientType) clauses.push(Prisma.sql`"recipientType"::text = ${query.recipientType}`);
  if (query.assignmentType) clauses.push(Prisma.sql`"assignmentType"::text = ${query.assignmentType}`);
  if (query.officeName) clauses.push(Prisma.sql`"officeName" ILIKE ${'%' + query.officeName + '%'}`);
  if (query.active !== undefined) clauses.push(query.active ? Prisma.sql`"endedAt" IS NULL` : Prisma.sql`"endedAt" IS NOT NULL`);
  return Prisma.join(clauses, ' AND ');
}
export async function effectiveAssignmentRows(transaction: Prisma.TransactionClient, query: EffectiveQuery, limit: number, offset = 0) {
  return transaction.$queryRaw<EffectiveAssignment[]>`SELECT * FROM "AssignmentEffective" WHERE ${effectiveAssignmentWhere(query)}
    ORDER BY "startedAt" DESC, "id" DESC LIMIT ${limit} OFFSET ${offset}`;
}
export async function effectiveHistoricalAssignments(transaction: Prisma.TransactionClient, assignments: HistoricalPlanAssignment[]) {
  if (assignments.length === 0) return assignments;
  return transaction.$queryRaw<HistoricalPlanAssignment[]>`SELECT "id", "startedAt", "endedAt", "recipientType", "personName", "officeName", "assignmentType", "returnStatus"
    FROM "AssignmentEffective" WHERE "id" IN (${Prisma.join(assignments.map((entry) => Prisma.sql`${entry.id}::uuid`))}) ORDER BY "id"`;
}

export function withEffectiveAssignment<T extends Assignment>(original: T, effective: EffectiveAssignment) {
  if (!effective.correctionId) return original;
  const { correctionId, correctionVersion, correctedById, correctedAt, ...values } = effective;
  return { ...original, ...values, originalAssignment: { ...original }, historyCorrection: { id: correctionId, version: correctionVersion, correctedById, correctedAt } };
}
