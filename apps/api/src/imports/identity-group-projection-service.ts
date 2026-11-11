import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { readIdentityGroupImpacts } from './identity-group-plan-service.js';
import { buildIdentityGroupProjection, validateIdentityGroupReview } from './identity-group-projection.js';
import { previewDate } from './preview.js';
import { readPreviewAssets } from './snapshot.js';
import { readResolvedSource } from './source-service.js';

export async function getIdentityGroupProjection(database: PrismaClient, batchId: string, reviewId: string) {
  return database.$transaction((transaction) => readIdentityGroupProjection(transaction, batchId, reviewId),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function readIdentityGroupProjection(transaction: Prisma.TransactionClient, batchId: string, reviewId: string) {
  const review = await transaction.importIdentityGroupReview.findFirst({ where: { id: reviewId, batchId },
    include: { rows: { orderBy: { recordId: 'asc' }, take: 26 }, release: { select: { id: true } } } });
  if (!review) throw new ApiError(404, 'NOT_FOUND', 'Identity review not found in this batch');
  const resolved = await readResolvedSource(transaction, batchId);
  const asOf = previewDate();
  const saved = validateIdentityGroupReview(review, resolved.original, asOf);
  const impacts = await readIdentityGroupImpacts(transaction, batchId, review.sourceHash, saved.request.candidateIds, review.rows.map((row) => row.recordId));
  return buildIdentityGroupProjection(resolved.original, resolved.workbook, await readPreviewAssets(transaction),
    { batchId: resolved.batch.id, batchVersion: resolved.batch.version, sourceContext: resolved.sourceContext }, review, impacts, asOf);
}
