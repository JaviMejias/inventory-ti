import { Prisma, type PrismaClient } from '@prisma/client';

import { readGroupRetirementPlan } from './group-retirement-plan-service.js';
import { readGroupRetirementReconciliation } from './group-retirement-reconciliation-service.js';
import type { GroupRetirementDocumentPlanInput } from './group-retirement-document-schemas.js';
import { importPlanDigest } from './plan.js';

export const groupRetirementDocumentRulesVersion = 'mda-group-retirement-document-1';
export function planGroupRetirementDocument(database: PrismaClient, batchId: string, reviewId: string, input: GroupRetirementDocumentPlanInput) {
  return database.$transaction((transaction) => readGroupRetirementDocumentPlan(transaction, batchId, reviewId, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}
export async function readGroupRetirementDocumentPlan(transaction: Prisma.TransactionClient, batchId: string, reviewId: string, input: GroupRetirementDocumentPlanInput) {
  const { document, ...groupInput } = input;
  const reviewed = await readGroupRetirementPlan(transaction, batchId, reviewId, { ...groupInput, plan: { ...document,
    confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: null, dateEvidenceReference: null } });
  const assessment = await readGroupRetirementReconciliation(transaction, batchId, reviewId, { groupKey: input.groupKey,
    assetId: reviewed.assetBefore.id, evidenceId: document.evidenceId });
  const ownRetirement = assessment.retirementReceipts.find((receipt) => receipt.origin === 'GROUP' && receipt.assetId === reviewed.assetBefore.id &&
    receipt.batchId === batchId && receipt.reviewId === reviewId && receipt.groupKey === input.groupKey);
  const ownConsumption = !!ownRetirement && assessment.sourceConsumption.length === reviewed.sourceRows.length &&
    assessment.sourceConsumption.every((row) => row.origin === 'GROUP_RETIREMENT' && row.applicationId === ownRetirement.id && row.reviewId === reviewId &&
      row.batchId === batchId && row.assetId === reviewed.assetBefore.id);
  const excluded = new Set(['EXACT_RETIREMENT_DATE_REQUIRED', 'EXACT_RETIREMENT_DATE_PROOF_REQUIRED', 'EXISTING_RETIREMENT_REQUIRES_RECONCILIATION']);
  const blockers = reviewed.blockers.filter((issue) => !excluded.has(issue.code) && !(ownConsumption && issue.code === 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED'));
  for (const issue of assessment.diagnostics) if (!excluded.has(issue.code) && !blockers.some((entry) => entry.code === issue.code && entry.relatedId === issue.relatedId)) blockers.push(issue);
  if (!['TERMINAL_DATED', 'TERMINAL_UNDATED'].includes(assessment.currentState)) blockers.push({ code: 'EXISTING_TERMINAL_RETIREMENT_REQUIRED' });
  if (assessment.sourceConsumption.length > 0 && !ownConsumption) blockers.push({ code: 'GROUP_DOCUMENT_SOURCE_CONSUMPTION_REQUIRES_REVIEW' });
  if (assessment.documentAssociations.some((entry) => entry.evidenceVersion === reviewed.source.evidenceVersion)) blockers.push({ code: 'RETIREMENT_DOCUMENT_ALREADY_RECONCILED' });
  const previous = await transaction.importGroupRetirementDocument.findUnique({ where: { evidenceId_evidenceVersion: {
    evidenceId: document.evidenceId, evidenceVersion: reviewed.source.evidenceVersion } }, select: { id: true } });
  if (previous) blockers.push({ code: 'RETIREMENT_DOCUMENT_ALREADY_RECONCILED', relatedId: previous.id });
  const assetSnapshot = await transaction.asset.findUniqueOrThrow({ where: { id: reviewed.assetBefore.id } });
  const content = { rulesVersion: groupRetirementDocumentRulesVersion, scope: 'GROUP_RETIREMENT_DOCUMENT_RECONCILIATION',
    batchId, reviewId, groupId: reviewed.groupId, groupKey: reviewed.groupKey, sourceHash: reviewed.sourceHash,
    batchVersion: input.expectedBatchVersion, sourceRevision: input.expectedSourceRevision, decisionId: reviewed.decisionId,
    decisionVersion: reviewed.decisionVersion, decisionProofDigest: reviewed.decisionProofDigest, projectionId: reviewed.projectionId,
    checkedAsOf: reviewed.checkedAsOf, timeZone: reviewed.timeZone, request: { ...input, acknowledgedGroupWarnings: [...input.acknowledgedGroupWarnings].sort(),
      document: { ...document, acknowledgedWarnings: [...document.acknowledgedWarnings].sort() } },
    assetBefore: reviewed.assetBefore, assetSnapshot, sourceRows: reviewed.sourceRows,
    originalEvidence: reviewed.originalEvidence, currentEvidence: reviewed.currentEvidence, proposedEvidenceProjection: reviewed.proposedEvidenceProjection,
    source: reviewed.source, sourceRetirement: reviewed.sourceRetirement, existingRetirement: assessment.existingRetirement,
    retirementReceipts: assessment.retirementReceipts, sourceConsumption: assessment.sourceConsumption,
    evidenceCoverage: assessment.groupArchive, currentAssignmentsDigest: reviewed.currentAssignmentsDigest, sourceRevisionsDigest: reviewed.sourceRevisionsDigest,
    warnings: reviewed.warnings, groupWarnings: reviewed.groupWarnings, blockers,
    affectsCurrentState: false, evidenceRelinked: false, confirmsSourceDate: false, consumesOperationalEvidence: false, historicalActorKnown: false };
  return { ...content, planId: importPlanDigest(content), mode: 'GROUP_RETIREMENT_DOCUMENT_PLAN', persisted: false, canApply: false,
    planValidationComplete: blockers.length === 0 };
}
