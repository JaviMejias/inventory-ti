import { retirementApplicationFixture } from './retirement-application.mjs';

// Synthetic responses exercise the UI boundary; they do not implement server classification rules.
export function retirementReconciliationFixture() {
  const base = retirementApplicationFixture();
  const evidenceId = base.plan.source.evidenceId; const assetId = base.plan.assetBefore.id;
  const metadata = Object.fromEntries(['id', 'assetId', 'evidenceId', 'evidenceVersion', 'amendmentId', 'sourceRevision', 'decommissionedAt', 'appliedAt', 'appliedById'].map((key) => [key, base.receipt.application[key]]));
  function assessmentFor(classification = 'RETIREMENT_DATE_UNCONFIRMED') {
    const result = { rulesVersion: 'mda-retirement-reconciliation-1', scope: 'HISTORICAL_RETIREMENT_RECONCILIATION', mode: 'READ_ONLY_RECONCILIATION',
      canApply: false, persisted: false, affectsCurrentState: false, operationalResolutionImplemented: false,
      checkedAsOf: '2026-10-25', assessmentId: '1'.repeat(64), retirementPlanDigest: '2'.repeat(64), classification,
      currentState: 'NONTERMINAL', evidenceState: 'ARCHIVED_ONLY', assetBefore: globalThis.structuredClone(base.plan.assetBefore), source: globalThis.structuredClone(base.plan.source),
      sourceRetirement: { effectiveAt: null, datePrecision: 'UNKNOWN', historicalActorId: null }, existingRetirement: null,
      existingApplication: null, evidenceApplication: null, warnings: globalThis.structuredClone(base.plan.warnings),
      diagnostics: [{ code: 'EXACT_RETIREMENT_DATE_REQUIRED' }, { code: 'EXACT_RETIREMENT_DATE_PROOF_REQUIRED' }],
      nextSteps: ['PROVIDE_VERIFIED_DATE_AND_REQUEST_V13_PLAN', 'KEEP_UNDATED_SOURCE_EVIDENCE'],
      links: { verifiedPlan: '/assets/' + assetId + '/imported-retirement-plan', existingApplication: null } };
    if (classification !== 'RETIREMENT_DATE_UNCONFIRMED') {
      result.links.verifiedPlan = null; result.nextSteps = ['KEEP_UNDATED_SOURCE_EVIDENCE'];
    }
    if (classification === 'CURRENT_CUSTODY_CONFLICT') {
      result.currentState = 'ACTIVE_CUSTODY'; result.assetBefore.status = 'ASSIGNED';
      result.diagnostics.unshift({ code: 'ACTIVE_ASSIGNMENT_REQUIRES_RETURN' }); result.nextSteps.unshift('REVIEW_CURRENT_CUSTODY');
    }
    if (classification === 'CURRENT_STATE_REVIEW_REQUIRED') {
      result.currentState = 'INCONSISTENT'; result.assetBefore.isActive = false;
      result.diagnostics.unshift({ code: 'CURRENT_ASSIGNMENT_STATE_INCONSISTENT' }); result.nextSteps.unshift('REVIEW_CURRENT_STATE');
    }
    if (classification === 'EVIDENCE_REVIEW_REQUIRED') {
      result.evidenceState = 'REVIEW_REQUIRED'; result.diagnostics.unshift({ code: 'SOURCE_FORMULA_REQUIRES_REVIEW' });
      result.nextSteps.unshift('REVIEW_EVIDENCE_LINK_AND_SOURCE');
    }
    if (classification === 'EVIDENCE_ALREADY_USED') {
      result.evidenceState = 'USED_FOR_OTHER_RETIREMENT'; result.evidenceApplication = { ...metadata, id: '00000000-0000-4000-8000-000000000098', assetId: '00000000-0000-4000-8000-000000000099' };
      result.diagnostics.unshift({ code: 'EVIDENCE_ALREADY_APPLIED', relatedId: metadata.id }); result.nextSteps.unshift('REVIEW_EVIDENCE_CONSUMPTION');
    }
    if (['EXISTING_UNDATED_RETIREMENT', 'EXISTING_DATED_RETIREMENT', 'ALREADY_IMPORTED_RETIREMENT', 'EXISTING_IMPORTED_RETIREMENT'].includes(classification)) {
      const dated = classification !== 'EXISTING_UNDATED_RETIREMENT'; result.assetBefore.status = 'DECOMMISSIONED'; result.assetBefore.isActive = false;
      result.assetBefore.decommissionedAt = dated ? metadata.decommissionedAt : null;
      result.currentState = dated ? 'TERMINAL_DATED' : 'TERMINAL_UNDATED';
      result.existingRetirement = { effectiveAt: result.assetBefore.decommissionedAt, datePrecision: dated ? 'INSTANT' : 'UNKNOWN', dateOrigin: 'CURRENT_ASSET', confirmsSourceDate: false };
      result.diagnostics.unshift({ code: 'EXISTING_RETIREMENT_REQUIRES_RECONCILIATION' }); result.nextSteps.unshift('RECONCILE_EXISTING_RETIREMENT_SEPARATELY');
    }
    if (classification === 'ALREADY_IMPORTED_RETIREMENT' || classification === 'EXISTING_IMPORTED_RETIREMENT') {
      result.existingApplication = { ...metadata, evidenceId: classification === 'EXISTING_IMPORTED_RETIREMENT' ? base.review.second.id : evidenceId };
      result.evidenceApplication = classification === 'ALREADY_IMPORTED_RETIREMENT' ? { ...metadata } : null;
      result.evidenceState = result.evidenceApplication ? 'USED_FOR_THIS_RETIREMENT' : 'ARCHIVED_ONLY';
      result.existingRetirement.dateOrigin = 'VERIFIED_IMPORT_RECEIPT'; result.nextSteps[0] = 'CONSULT_EXISTING_RETIREMENT_RECEIPT';
      result.links.existingApplication = '/assets/' + assetId + '/imported-retirement-applications/' + metadata.id;
    }
    return result;
  }
  return { base, evidenceId, assetId, metadata, assessmentFor };
}
