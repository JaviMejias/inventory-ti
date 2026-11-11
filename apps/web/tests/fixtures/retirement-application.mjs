import { assetId, receiptId } from './import-pilot.mjs';
import { retirementFixture } from './retirement-plan.mjs';

export const retirementActorId = '00000000-0000-4000-8000-000000000009';
export function retirementApplicationFixture() {
  const review = retirementFixture(); const draft = review.draftFor();
  const input = { evidenceId: draft.evidenceId, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: draft.confirmedAt,
    dateEvidenceReference: draft.dateEvidenceReference, note: draft.note, evidenceReference: draft.reference, acknowledgedWarnings: [review.warning.id] };
  const plan = review.planFor(input);
  const intent = { requestId: receiptId, planId: plan.planId, confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT', plan: globalThis.structuredClone(input) };
  function receiptFor(reused = false, selectedPlan = plan) {
    const stored = globalThis.structuredClone(selectedPlan); const appliedAt = '2026-10-05T14:00:00.000Z';
    const before = stored.assetBefore; const source = stored.source;
    return { scope: 'VERIFIED_HISTORICAL_RETIREMENT', mode: 'APPLIED', persisted: true, affectsCurrentState: true, reused, application: {
      id: '00000000-0000-4000-8000-000000000006', assetId, evidenceId: source.evidenceId, evidenceVersion: source.evidenceVersion,
      amendmentId: source.amendmentId, sourceRevision: source.sourceRevision, decommissionedAt: stored.proposedRetirement.decommissionedAt,
      requestId: intent.requestId, requestDigest: 'b'.repeat(64), planId: stored.planId, rulesVersion: stored.planRulesVersion,
      appliedById: retirementActorId, appliedAt, plan: stored,
      result: { id: assetId, productId: before.productId, serialNumber: before.serialNumber, assetTag: before.assetTag,
        status: 'DECOMMISSIONED', isActive: false, decommissionedAt: stored.proposedRetirement.decommissionedAt, updatedAt: appliedAt }
    } };
  }
  const receipt = receiptFor();
  const metadata = Object.fromEntries(Object.entries(receipt.application).filter(([key]) => !['requestDigest', 'plan', 'result'].includes(key)));
  function pageFor(offset = 0) {
    return { scope: 'VERIFIED_HISTORICAL_RETIREMENT', affectsCurrentState: true, applications: offset === 0 ? [globalThis.structuredClone(metadata)] : [],
      total: 1, limit: 25, offset, hasMore: false };
  }
  return { review, input, plan, intent, receipt, receiptFor, metadata, pageFor };
}
