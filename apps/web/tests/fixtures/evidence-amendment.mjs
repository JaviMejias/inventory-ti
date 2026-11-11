import { historyFixture } from './import-history.mjs';
import { assetId, receiptId } from './import-pilot.mjs';

export const amendmentActorId = '00000000-0000-4000-8000-000000000009';
const idFor = (number) => '00000000-0000-4000-8000-' + String(number + 300).padStart(12, '0');
export function amendmentFixture() {
  const history = historyFixture();
  const capture = history.receiptFor({ expectedVersion: 2, expectedSourceRevision: 0, historyPreviewId: 'e'.repeat(64), requestId: receiptId, note: 'Captura original', evidenceReference: 'Archivo QA', records: [{ recordId: history.observations[1].recordId, kind: history.observations[1].kind, assetId }] });
  const original = { ...globalThis.structuredClone(capture.items[0]), capture };
  const owner = Object.fromEntries(['id', 'captureId', 'recordId', 'candidateId', 'kind'].map((key) => [key, original[key]]));
  const proposed = { ...globalThis.structuredClone(original.snapshot), assetId: null, linkBasis: null };
  const eventFor = (version) => ({ id: idFor(version), evidenceId: owner.id, version, previousAmendmentId: version === 1 ? null : idFor(version - 1), batchVersion: 3, sourceRevision: 1,
    requestId: idFor(version + 100), requestDigest: 'f'.repeat(64), amendmentPlanId: 'd'.repeat(64), rulesVersion: 'mda-history-amendment-1', assetId: null, effectiveDay: null, snapshot: globalThis.structuredClone(proposed),
    note: 'Revisión documental ' + version, evidenceReference: 'Respaldo QA', amendedById: amendmentActorId, amendedAt: '2026-10-05T17:00:00Z' });
  function pageFor(offset = 0, total = 27) {
    const latest = total ? eventFor(total) : null;
    const current = { ...globalThis.structuredClone(original), assetId: latest?.assetId ?? (total ? null : original.assetId), effectiveDay: latest?.effectiveDay ?? (total ? null : original.effectiveDay), snapshot: latest ? latest.snapshot : globalThis.structuredClone(original.snapshot),
      evidenceVersion: total, amendmentId: latest?.id ?? null, amendedAt: latest?.amendedAt ?? null, effectiveSourceRevision: total ? 1 : 0,
      capturedAssetId: original.assetId, capturedEffectiveDay: original.effectiveDay, capturedSourceRevision: 0 };
    return { ...history.scope, originalEvidence: globalThis.structuredClone(original), current, events: Array.from({ length: Math.min(25, Math.max(0, total - offset)) }, (_, index) => {
      const { requestDigest, snapshot, ...event } = eventFor(total - offset - index); void requestDigest; void snapshot; return event;
    }), total, limit: 25, offset, hasMore: offset + 25 < total };
  }
  const page = pageFor();
  const plan = { ...history.scope, mode: 'EVIDENCE_AMENDMENT_PLAN', persisted: false, rulesVersion: 'mda-history-amendment-1', evidenceId: owner.id,
    batchId: capture.batchId, batchVersion: 4, sourceRevision: 2, evidenceVersion: 27, previousAmendmentId: page.current.amendmentId, originalEvidence: original,
    current: page.current, proposed, used: null, historyPreviewId: 'e'.repeat(64), blockers: [], amendmentPlanId: 'd'.repeat(64), valid: true };
  const draft = { target: 'unlinked', assetId: '', note: '  Nueva revisión  ', reference: '  Respaldo QA  ', confirmed: true };
  const intent = { requestId: receiptId, amendmentPlanId: plan.amendmentPlanId, expectedEvidenceVersion: 27, expectedBatchVersion: 4, expectedSourceRevision: 2,
    confirmation: 'AMEND_HISTORICAL_EVIDENCE_ONLY', assetId: null, note: 'Nueva revisión', evidenceReference: 'Respaldo QA' };
  function receiptFor(body = intent, reused = false) { return { ...history.scope, persisted: true, reused, event: { ...eventFor(body.expectedEvidenceVersion + 1), batchVersion: body.expectedBatchVersion, sourceRevision: body.expectedSourceRevision, requestId: body.requestId, note: body.note, evidenceReference: body.evidenceReference, assetId: body.assetId, snapshot: { ...globalThis.structuredClone(proposed), assetId: body.assetId } } }; }
  return { history, capture, owner, original, proposed, pageFor, page, plan, draft, intent, eventFor, receiptFor };
}
