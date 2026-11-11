import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import type { HistoryPageQuery } from './history-schemas.js';
import { importPlanDigest } from './plan.js';
import { readHistoricalRetirementPlan } from './retirement-plan-service.js';
import { retirementDocumentRequestDigest, type RetirementDocumentApplyInput, type RetirementDocumentPlanInput } from './retirement-document-schemas.js';

export const retirementDocumentRulesVersion = 'mda-retirement-document-1';
const scope = { scope: 'EXISTING_RETIREMENT_DOCUMENT_RECONCILIATION' as const, affectsCurrentState: false, confirmsSourceDate: false,
  consumesOperationalEvidence: false, historicalActorKnown: false };
const metadataSelect = { id: true, assetId: true, evidenceId: true, evidenceVersion: true, amendmentId: true, sourceRevision: true,
  requestId: true, planId: true, rulesVersion: true, recordedById: true, recordedAt: true };
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

export async function readRetirementDocumentPlan(transaction: Prisma.TransactionClient, assetId: string, input: RetirementDocumentPlanInput) {
  const historical = await readHistoricalRetirementPlan(transaction, assetId, { evidenceId: input.evidenceId,
    confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: null, dateEvidenceReference: null, note: input.note,
    evidenceReference: input.evidenceReference, acknowledgedWarnings: input.acknowledgedWarnings });
  const asset = await transaction.asset.findUniqueOrThrow({ where: { id: assetId } });
  const excluded = new Set(['EXISTING_RETIREMENT_REQUIRES_RECONCILIATION', 'EXACT_RETIREMENT_DATE_REQUIRED', 'EXACT_RETIREMENT_DATE_PROOF_REQUIRED']);
  const blockers = historical.blockers.filter((issue) => !excluded.has(issue.code));
  const block = (code: string, relatedId?: string) => blockers.push({ code, ...(relatedId ? { relatedId } : {}) });
  if (asset.status !== 'DECOMMISSIONED' || asset.isActive) block('EXISTING_TERMINAL_RETIREMENT_REQUIRED');
  if (asset.decommissionedAt && (!Number.isFinite(asset.decommissionedAt.getTime()) || asset.decommissionedAt < new Date('1900-01-01') || asset.decommissionedAt > new Date())) {
    block('CURRENT_RETIREMENT_DATE_UNCONFIRMED');
  }
  if (asset.decommissionedAt && historical.source.sourceReceivedDay && asset.decommissionedAt.toISOString().slice(0, 10) < historical.source.sourceReceivedDay) {
    block('CURRENT_RETIREMENT_BEFORE_SOURCE_RECEIPT');
  }
  const conflicts = await transaction.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AssignmentEffective" WHERE "assetId" = ${assetId}::uuid AND
    ("endedAt" IS NULL OR "endedAt" <= "startedAt" OR (${asset.decommissionedAt}::timestamp IS NOT NULL AND "endedAt" > ${asset.decommissionedAt}::timestamp)) ORDER BY "id" LIMIT 1`;
  if (conflicts[0]) block('CURRENT_CUSTODY_REQUIRES_REVIEW', conflicts[0].id);
  const legacy = await transaction.importRetirementApplication.findUnique({ where: { assetId }, select: { id: true, decommissionedAt: true } });
  const grouped = await transaction.importGroupRetirementApplication.findUnique({ where: { assetId }, select: { id: true, batchId: true, reviewId: true, decommissionedAt: true } });
  if ((legacy && grouped) || [legacy, grouped].some((receipt) => receipt && receipt.decommissionedAt.getTime() !== asset.decommissionedAt?.getTime())) block('IMPORTED_RETIREMENT_STATE_CONFLICT');
  const prior = await transaction.importRetirementReconciliation.findUnique({ where: { evidenceId_evidenceVersion: {
    evidenceId: input.evidenceId, evidenceVersion: historical.source.evidenceVersion } }, select: { id: true } });
  if (prior) block('RETIREMENT_DOCUMENT_ALREADY_RECONCILED', prior.id);
  const priorGroup = await transaction.importGroupRetirementDocument.findUnique({ where: { evidenceId_evidenceVersion: {
    evidenceId: input.evidenceId, evidenceVersion: historical.source.evidenceVersion } }, select: { id: true } });
  if (priorGroup) block('RETIREMENT_DOCUMENT_ALREADY_RECONCILED', priorGroup.id);
  const content = { rulesVersion: retirementDocumentRulesVersion, ...scope, checkedAsOf: historical.checkedAsOf,
    request: { ...input, acknowledgedWarnings: [...input.acknowledgedWarnings].sort() }, assetBefore: asset, productBefore: historical.assetBefore.product,
    source: historical.source, currentAssignmentsDigest: historical.currentAssignmentsDigest, sourceRevisionsDigest: historical.sourceRevisionsDigest,
    existingRetirement: asset.status === 'DECOMMISSIONED' && !asset.isActive ? { effectiveAt: asset.decommissionedAt, datePrecision: asset.decommissionedAt === null ? 'UNKNOWN' : 'INSTANT',
      dateOrigin: grouped ? 'GROUP_VERIFIED_IMPORT_RECEIPT' : legacy ? 'VERIFIED_IMPORT_RECEIPT' : 'CURRENT_ASSET',
      legacyApplicationId: legacy?.id ?? null, groupApplicationId: grouped?.id ?? null, confirmsSourceDate: false } : null,
    sourceRetirement: historical.source.kind === 'RETIREMENT_OBSERVATION' ? { effectiveAt: null, datePrecision: 'UNKNOWN', historicalActorId: null } : null,
    warnings: historical.warnings, blockers };
  return { ...content, planId: importPlanDigest(content), mode: 'RETIREMENT_DOCUMENT_PLAN', persisted: false, canApply: false,
    planValidationComplete: blockers.length === 0 };
}

export async function planRetirementDocument(database: PrismaClient, assetId: string, input: RetirementDocumentPlanInput) {
  return database.$transaction((transaction) => readRetirementDocumentPlan(transaction, assetId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function recordRetirementDocument(database: PrismaClient, assetId: string, input: RetirementDocumentApplyInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      const requestDigest = retirementDocumentRequestDigest(input);
      const lookup = () => transaction.importRetirementReconciliation.findUnique({ where: { assetId_requestId: { assetId, requestId: input.requestId } } });
      const reuse = (reconciliation: NonNullable<Awaited<ReturnType<typeof lookup>>>) => {
        if (reconciliation.recordedById !== actorId || reconciliation.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to a different document reconciliation');
        return { ...scope, mode: 'DOCUMENT_RECONCILED', persisted: true, reused: true, reconciliation };
      };
      const previous = await lookup(); if (previous) return reuse(previous);
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      const evidence = await transaction.importHistoricalEvidence.findUnique({ where: { id: input.plan.evidenceId }, select: { sourceHash: true } });
      if (!evidence) throw new ApiError(404, 'NOT_FOUND', 'Historical retirement evidence not found');
      await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${evidence.sourceHash}, 0))`;
      await transaction.$executeRawUnsafe('LOCK TABLE "Asset", "Product", "Assignment", "User", "ImportHistoricalEvidence", "ImportEvidenceAmendment", "ImportSourceRevision", "ImportIdentityGroupReview", "ImportIdentityGroupRow", "ImportIdentityGroupRelease", "ImportIdentityGroupRowUse", "ImportGroupRetirementRowUse", "ImportGroupAssignmentCorrection", "ImportRetirementReconciliation" IN EXCLUSIVE MODE NOWAIT');
      const recovered = await lookup(); if (recovered) return reuse(recovered);
      const actor = await transaction.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true, passwordHash: true } });
      if (!actor?.isActive || actor.role !== 'JEFE' || !actor.passwordHash) throw new ApiError(403, 'FORBIDDEN', 'Only an active configured JEFE can reconcile retirement documents');
      const plan = await readRetirementDocumentPlan(transaction, assetId, input.plan);
      if (!plan.planValidationComplete) throw new ApiError(409, 'RETIREMENT_DOCUMENT_BLOCKED', 'Review all document reconciliation conflicts', { blockers: plan.blockers });
      if (plan.planId !== input.planId) throw new ApiError(409, 'RETIREMENT_DOCUMENT_PLAN_CHANGED', 'Generate and review the current documentary reconciliation plan');
      const [clock] = await transaction.$queryRaw<{ recordedAt: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "recordedAt"`;
      const reconciliation = await transaction.importRetirementReconciliation.create({ data: { assetId, evidenceId: input.plan.evidenceId,
        evidenceVersion: plan.source.evidenceVersion, amendmentId: plan.source.amendmentId, sourceRevision: plan.source.sourceRevision,
        requestId: input.requestId, requestDigest, planId: plan.planId, rulesVersion: retirementDocumentRulesVersion,
        plan: json(plan), recordedById: actorId, recordedAt: clock!.recordedAt } });
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_RETIREMENT_DOCUMENT_RECONCILED', entityType: 'ImportRetirementReconciliation',
        entityId: reconciliation.id, metadata: { assetId, evidenceId: reconciliation.evidenceId, evidenceVersion: reconciliation.evidenceVersion,
          planId: plan.planId, affectsCurrentState: false, confirmsSourceDate: false, consumesOperationalEvidence: false } } });
      return { ...scope, mode: 'DOCUMENT_RECONCILED', persisted: true, reused: false, reconciliation };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'RETIREMENT_DOCUMENT_CONFLICT', 'This evidence version has already been reconciled; retrieve its receipt');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'RETIREMENT_DOCUMENT_BUSY', 'Document reconciliation is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

export async function listRetirementDocuments(database: PrismaClient, assetId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.asset.findUnique({ where: { id: assetId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
    const reconciliations = await transaction.importRetirementReconciliation.findMany({ where: { assetId }, select: metadataSelect,
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importRetirementReconciliation.count({ where: { assetId } });
    return { ...scope, reconciliations, total, limit: query.limit, offset: query.offset, hasMore: query.offset + reconciliations.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getRetirementDocument(database: PrismaClient, assetId: string, reconciliationId: string) {
  const reconciliation = await database.importRetirementReconciliation.findFirst({ where: { id: reconciliationId, assetId } });
  if (!reconciliation) throw new ApiError(404, 'NOT_FOUND', 'Document reconciliation not found for this asset');
  return { ...scope, mode: 'DOCUMENT_RECONCILED', persisted: true, reconciliation };
}
