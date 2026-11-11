import type { Prisma } from '@prisma/client';

import { importPlanDigest } from './plan.js';
import type { buildHistoricalRetirementPlan } from './retirement-plan.js';

export const retirementReconciliationRulesVersion = 'mda-retirement-reconciliation-1';
export const reconciliationReceiptSelect = { id: true, assetId: true, evidenceId: true, evidenceVersion: true, amendmentId: true,
  sourceRevision: true, decommissionedAt: true, appliedAt: true, appliedById: true } satisfies Prisma.ImportRetirementApplicationSelect;

type RetirementPlan = ReturnType<typeof buildHistoricalRetirementPlan>;
type Receipt = Prisma.ImportRetirementApplicationGetPayload<{ select: typeof reconciliationReceiptSelect }>;

export function buildRetirementReconciliation(plan: RetirementPlan, receipts: Receipt[], now = new Date()) {
  const asset = plan.assetBefore;
  const assetReceipt = receipts.find((receipt) => receipt.assetId === asset.id) ?? null;
  const evidenceReceipt = receipts.find((receipt) => receipt.evidenceId === plan.source.evidenceId) ?? null;
  // These are diagnostics, not a relaxed version of the V13 application validator.
  const diagnostics = plan.blockers.filter((issue) => issue.code !== 'WARNINGS_NOT_ACKNOWLEDGED');
  const has = (code: string) => diagnostics.some((issue) => issue.code === code);
  const sourceNeedsReview = diagnostics.some((issue) => issue.code.startsWith('SOURCE_') ||
    ['RETIREMENT_EVIDENCE_KIND_REQUIRED', 'EVIDENCE_ASSET_LINK_REQUIRED', 'EVIDENCE_ASSET_MISMATCH', 'EVIDENCE_IDENTITY_UNRESOLVED',
      'EVIDENCE_RULES_CHANGED', 'EVIDENCE_SOURCE_REVISED', 'CURRENT_ASSET_IDENTITY_CONFLICT', 'PRODUCT_NOT_ASSET'].includes(issue.code));
  const terminal = asset.status === 'DECOMMISSIONED' && !asset.isActive;
  const invalidDate = asset.decommissionedAt !== null && (!Number.isFinite(asset.decommissionedAt.getTime()) ||
    asset.decommissionedAt < new Date('1900-01-01T00:00:00Z') || asset.decommissionedAt > now);
  if (invalidDate) diagnostics.push({ code: 'CURRENT_RETIREMENT_DATE_UNCONFIRMED' });
  const inconsistentState = has('CURRENT_ASSIGNMENT_STATE_INCONSISTENT') || has('OPERATIONAL_ASSIGNMENT_PERIOD_INVALID') || invalidDate ||
    (!terminal && (!asset.isActive || asset.decommissionedAt !== null)) || (asset.status === 'DECOMMISSIONED' && asset.isActive);
  const custodyConflict = has('ACTIVE_ASSIGNMENT_REQUIRES_RETURN');
  const receiptStateMismatch = assetReceipt !== null && (!terminal || asset.decommissionedAt?.getTime() !== assetReceipt.decommissionedAt.getTime());
  if (receiptStateMismatch) diagnostics.push({ code: 'IMPORTED_RETIREMENT_STATE_CONFLICT', relatedId: assetReceipt.id });
  const currentState = inconsistentState || receiptStateMismatch ? 'INCONSISTENT' : custodyConflict ? 'ACTIVE_CUSTODY' :
    terminal ? (asset.decommissionedAt === null ? 'TERMINAL_UNDATED' : 'TERMINAL_DATED') : 'NONTERMINAL';
  const evidenceState = evidenceReceipt ? (evidenceReceipt.assetId === asset.id ? 'USED_FOR_THIS_RETIREMENT' : 'USED_FOR_OTHER_RETIREMENT') :
    has('EVIDENCE_ALREADY_APPLIED') ? 'USED_BY_ASSIGNMENT' : sourceNeedsReview ? 'REVIEW_REQUIRED' : 'ARCHIVED_ONLY';
  const classification = currentState === 'INCONSISTENT' ? 'CURRENT_STATE_REVIEW_REQUIRED' :
    evidenceState === 'USED_FOR_OTHER_RETIREMENT' || evidenceState === 'USED_BY_ASSIGNMENT' ? 'EVIDENCE_ALREADY_USED' :
    assetReceipt ? (assetReceipt.evidenceId === plan.source.evidenceId ? 'ALREADY_IMPORTED_RETIREMENT' : 'EXISTING_IMPORTED_RETIREMENT') :
    sourceNeedsReview ? 'EVIDENCE_REVIEW_REQUIRED' : currentState === 'ACTIVE_CUSTODY' ? 'CURRENT_CUSTODY_CONFLICT' :
    terminal ? (asset.decommissionedAt === null ? 'EXISTING_UNDATED_RETIREMENT' : 'EXISTING_DATED_RETIREMENT') : 'RETIREMENT_DATE_UNCONFIRMED';
  const nextSteps: string[] = [];
  if (sourceNeedsReview) nextSteps.push('REVIEW_EVIDENCE_LINK_AND_SOURCE');
  if (inconsistentState || receiptStateMismatch) nextSteps.push('REVIEW_CURRENT_STATE');
  if (custodyConflict) nextSteps.push('REVIEW_CURRENT_CUSTODY');
  if (evidenceState === 'USED_FOR_OTHER_RETIREMENT' || evidenceState === 'USED_BY_ASSIGNMENT') nextSteps.push('REVIEW_EVIDENCE_CONSUMPTION');
  if (assetReceipt) nextSteps.push('CONSULT_EXISTING_RETIREMENT_RECEIPT');
  else if (terminal) nextSteps.push('RECONCILE_EXISTING_RETIREMENT_SEPARATELY');
  else if (classification === 'RETIREMENT_DATE_UNCONFIRMED') nextSteps.push('PROVIDE_VERIFIED_DATE_AND_REQUEST_V13_PLAN');
  nextSteps.push('KEEP_UNDATED_SOURCE_EVIDENCE');
  const content = { rulesVersion: retirementReconciliationRulesVersion, scope: 'HISTORICAL_RETIREMENT_RECONCILIATION' as const,
    checkedAsOf: plan.checkedAsOf, retirementPlanDigest: plan.planId, classification, currentState, evidenceState,
    assetBefore: asset, source: plan.source,
    sourceRetirement: plan.source.kind === 'RETIREMENT_OBSERVATION' ? { effectiveAt: null, datePrecision: 'UNKNOWN' as const, historicalActorId: null } : null,
    existingRetirement: terminal ? { effectiveAt: asset.decommissionedAt, datePrecision: asset.decommissionedAt === null ? 'UNKNOWN' : 'INSTANT',
      dateOrigin: assetReceipt && !receiptStateMismatch ? 'VERIFIED_IMPORT_RECEIPT' : 'CURRENT_ASSET', confirmsSourceDate: false } : null,
    existingApplication: assetReceipt, evidenceApplication: evidenceReceipt,
    warnings: plan.warnings, diagnostics, nextSteps,
    links: { verifiedPlan: classification === 'RETIREMENT_DATE_UNCONFIRMED' ? `/assets/${asset.id}/imported-retirement-plan` : null,
      existingApplication: assetReceipt ? `/assets/${asset.id}/imported-retirement-applications/${assetReceipt.id}` : null } };
  return { ...content, assessmentId: importPlanDigest(content), mode: 'READ_ONLY_RECONCILIATION', canApply: false, persisted: false,
    affectsCurrentState: false, operationalResolutionImplemented: false };
}
