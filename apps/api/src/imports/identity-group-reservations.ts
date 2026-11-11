import type { Prisma } from '@prisma/client';

import { ApiError } from '../lib/errors.js';

export async function assertIdentityGroupUnreserved(transaction: Prisma.TransactionClient, sourceHash: string,
  candidateIds: string[] = [], recordIds: string[] = []) {
  if (candidateIds.length === 0 && recordIds.length === 0) return;
  const retirement = await transaction.importGroupRetirementRowUse.findFirst({ where: { sourceHash,
    OR: [{ originalCandidateId: { in: candidateIds } }, { recordId: { in: recordIds } }] }, select: { recordId: true, applicationId: true } });
  if (retirement) throw new ApiError(409, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED', 'Source belongs to an applied grouped retirement; release cannot undo consumption', retirement);
  const applied = await transaction.importIdentityGroupRowUse.findFirst({ where: { sourceHash,
    OR: [{ originalCandidateId: { in: candidateIds } }, { recordId: { in: recordIds } }] },
    select: { recordId: true, originalCandidateId: true, item: { select: { applicationId: true } } } });
  if (applied) throw new ApiError(409, 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED', 'Source was applied through a group pilot; release cannot undo consumption', {
    recordId: applied.recordId, candidateId: applied.originalCandidateId, applicationId: applied.item.applicationId
  });
  const row = await transaction.importIdentityGroupRow.findFirst({ where: { sourceHash, review: { release: null },
    OR: [{ originalCandidateId: { in: candidateIds } }, { recordId: { in: recordIds } }] },
    select: { reviewId: true, recordId: true, originalCandidateId: true, review: { select: { batchId: true } } }, orderBy: { recordId: 'asc' } });
  if (row) throw new ApiError(409, 'IDENTITY_GROUP_SOURCE_RESERVED', 'Source belongs to an active identity grouping review; release it before using legacy workflows', {
    reviewId: row.reviewId, batchId: row.review.batchId, recordId: row.recordId, candidateId: row.originalCandidateId
  });
}

export async function assertEvidenceIdentityUnreserved(transaction: Prisma.TransactionClient, evidenceIds: string[]) {
  const evidence = await transaction.importHistoricalEvidence.findMany({ where: { id: { in: evidenceIds } }, select: { sourceHash: true, recordId: true, candidateId: true } });
  for (const hash of [...new Set(evidence.map((entry) => entry.sourceHash))].sort()) {
    const selected = evidence.filter((entry) => entry.sourceHash === hash);
    await assertIdentityGroupUnreserved(transaction, hash, selected.map((entry) => entry.candidateId), selected.map((entry) => entry.recordId));
  }
}
