import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { assertIdentityGroupUnreserved } from './identity-group-reservations.js';
import { identifierKey, previewDate } from './preview.js';
import { buildResolvedPreview, prepareIdentityChanges, validateIdentityPreview } from './identity.js';
import type { IdentityRevisionInput } from './identity-schemas.js';
import { importPlanDigest } from './plan.js';
import { workbookPreviewSchema, type WorkbookPreviewInput } from './schemas.js';
import { readPreviewAssets } from './snapshot.js';
import { prepareSourceChanges, resolveWorkbook, sourceRequestDigest } from './source.js';
import type { SourcePageQuery, SourceRevisionInput } from './source-schemas.js';

export async function readResolvedSource(transaction: Prisma.TransactionClient, id: string) {
  const batch = await transaction.importBatch.findUnique({ where: { id } });
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
  const original = workbookPreviewSchema.safeParse(batch.workbook);
  if (!original.success) throw new ApiError(409, 'INVALID_REVIEW_SNAPSHOT', 'Saved source cannot be interpreted');
  const revisions = await transaction.importSourceRevision.findMany({ where: { batchId: id }, orderBy: { revision: 'asc' }, take: 1001 });
  if (revisions.length > 1000) throw new ApiError(409, 'SOURCE_REVISION_LIMIT', 'Source review exceeds its revision limit');
  const resolved = resolveWorkbook(original.data, revisions);
  const parsed = workbookPreviewSchema.safeParse(resolved.workbook);
  if (!parsed.success) throw new ApiError(409, 'INVALID_SOURCE_REVISION', 'Effective source exceeds the supported shape or limits');
  return { batch, original: original.data, ...resolved, workbook: parsed.data };
}

export async function appendSourceRevision(database: PrismaClient, id: string, input: SourceRevisionInput, actorId: string) {
  return appendRevision(database, id, input, actorId);
}

export async function appendIdentityRevision(database: PrismaClient, id: string, input: IdentityRevisionInput, actorId: string) {
  return appendRevision(database, id, input, actorId);
}

async function appendRevision(database: PrismaClient, id: string, input: SourceRevisionInput | IdentityRevisionInput, actorId: string) {
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`;
    const batch = await transaction.importBatch.findUnique({ where: { id } });
    if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
    if ('candidateId' in input) await transaction.importReviewDecision.findFirst({ where: { batchId: id }, select: { sourceRevision: true } });
    const previous = await transaction.importSourceRevision.findUnique({ where: { batchId_requestId: { batchId: id, requestId: input.requestId } } });
    const requestDigest = 'candidateId' in input ? importPlanDigest(input) : sourceRequestDigest(input);
    if (previous) {
      if (previous.reviewedById !== actorId || previous.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id already belongs to a different source correction');
      return { event: previous, reused: true, canApply: false };
    }
    if (batch.version !== input.expectedBatchVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the batch before correcting source fields', { currentVersion: batch.version });
    const resolved = await readResolvedSource(transaction, id);
    if (resolved.sourceContext.revision !== input.expectedRevision) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload source revisions before saving', { currentRevision: resolved.sourceContext.revision });
    const changes = 'candidateId' in input ? prepareIdentityChanges(resolved.original, resolved.workbook, resolved.sourceContext, input)
      : prepareSourceChanges(resolved.original, resolved.workbook, input);
    // Share this source lock with application, including applications from another batch.
    await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${batch.sourceHash}, 0))`;
    await assertIdentityGroupUnreserved(transaction, batch.sourceHash, changes.map((change) => change.candidateId), changes.map((change) => change.recordId));
    const proposed: WorkbookPreviewInput = JSON.parse(JSON.stringify(resolved.workbook));
    for (const change of changes) {
      const row = proposed.sheets.find((sheet) => sheet.name === change.sheet)!.rows.find((row) => row.row === change.row)!;
      if (change.afterCell === null) delete row.cells[change.column];
      else row.cells[change.column] = change.afterCell;
    }
    if (!workbookPreviewSchema.safeParse(proposed).success) throw new ApiError(400, 'SOURCE_CORRECTION_LIMIT', 'The proposed corrections exceed source shape or size limits');
    if ('candidateId' in input) validateIdentityPreview(resolved.original, proposed, input);
    const applied = await transaction.importApplicationItem.findFirst({ where: { sourceHash: batch.sourceHash, candidateId: { in: changes.map((change) => change.candidateId) } } });
    if (applied) throw new ApiError(409, 'SOURCE_TARGET_ALREADY_APPLIED', 'An applied source candidate cannot be reinterpreted; use operational correction workflows');
    const event = await transaction.importSourceRevision.create({ data: { batchId: id, revision: input.expectedRevision + 1,
      expectedBatchVersion: input.expectedBatchVersion, requestId: input.requestId, requestDigest, note: input.note,
      evidenceReference: input.evidenceReference, changes: JSON.parse(JSON.stringify(changes)) as Prisma.InputJsonValue, reviewedById: actorId } });
    await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_SOURCE_CORRECTED', entityType: 'ImportBatch', entityId: id,
      metadata: { revisionId: event.id, revision: event.revision, sourceHash: batch.sourceHash, fields: changes.map((change) => ({ recordId: change.recordId, field: change.field, action: change.action })) } } });
    return { event, reused: false, canApply: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 });
}

export async function listSourceRevisions(database: PrismaClient, id: string, query: SourcePageQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.importBatch.findUnique({ where: { id }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
    const events = await transaction.importSourceRevision.findMany({ where: { batchId: id }, orderBy: { revision: 'desc' }, take: query.limit, skip: query.offset });
    const total = await transaction.importSourceRevision.count({ where: { batchId: id } });
    return { events, revision: total, total, limit: query.limit, offset: query.offset, hasMore: query.offset + events.length < total, canApply: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getResolvedPreview(database: PrismaClient, id: string) {
  return database.$transaction(async (transaction) => {
    const resolved = await readResolvedSource(transaction, id);
    const preview = buildResolvedPreview(resolved.original, resolved.workbook, await readPreviewAssets(transaction), previewDate(), 'DATABASE');
    return { batchId: id, batchVersion: resolved.batch.version, sourceContext: resolved.sourceContext, preview,
      originalPayloadDigest: resolved.batch.payloadDigest, effectivePayloadDigest: preview.payloadDigest, canApply: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function getSourceCatalog(database: PrismaClient, id: string, query: SourcePageQuery) {
  return database.$transaction(async (transaction) => {
    const resolved = await readResolvedSource(transaction, id);
    const preview = buildResolvedPreview(resolved.original, resolved.workbook, [], previewDate());
    const products = await transaction.product.findMany({ where: { trackingMode: 'ASSET', isActive: true }, select: {
      id: true, name: true, sku: true, equipmentType: true, brand: true, model: true, updatedAt: true
    }, orderBy: { id: 'asc' }, take: 5001 });
    if (products.length > 5000) throw new ApiError(409, 'IMPORT_CATALOG_LIMIT', 'Catalog exceeds the review suggestion limit');
    const candidates = preview.candidates.slice(query.offset, query.offset + query.limit).map((candidate) => {
      const observations = preview.records.filter((record) => candidate.recordIds.includes(record.id));
      const attributes = Object.fromEntries(['equipmentType', 'brand', 'model'].map((field) => [field,
        [...new Set(observations.map((record) => identifierKey(record.fields[field] ?? null)).filter((value): value is string => value !== null))].sort()
      ])) as Record<'equipmentType' | 'brand' | 'model', string[]>;
      const conflict = Object.values(attributes).some((values) => values.length > 1);
      const hasEvidence = Object.values(attributes).some((values) => values.length > 0);
      const matches = conflict || !hasEvidence ? [] : products.filter((product) => Object.entries(attributes).every(([field, values]) =>
        values.length === 0 || identifierKey(product[field as keyof typeof attributes]) === values[0]));
      return { candidateId: candidate.id, attributes, conflict, hasEvidence, suggestedProducts: matches.slice(0, 10), matchCount: matches.length,
        hasMoreSuggestions: matches.length > 10, requiresExplicitChoice: true, source: observations.map((record) => ({ recordId: record.id, sheet: record.sheet, row: record.row })) };
    });
    const total = preview.candidates.length;
    return { batchId: id, sourceRevision: resolved.sourceContext.revision, candidates, total, limit: query.limit, offset: query.offset,
      hasMore: query.offset + candidates.length < total, canApply: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}
