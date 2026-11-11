import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { dateCell, retirementRow, workbook } from './workbook-preview.js';

export async function verifiedRetirementFixture({ database, product, actorId, post, get, active = false, retired = false, unlinked = false, unknownReceipt = false, existingAsset = null }) {
  const asset = existingAsset ?? await database.$transaction(async (transaction) => {
    const created = await transaction.asset.create({ data: { productId: product.id, serialNumber: `RETIRE-APPLY-${randomUUID()}`, location: 'Warehouse', notes: 'Original asset metadata',
      ...(active ? { status: 'ASSIGNED' } : {}), ...(retired ? { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2005-01-01') } : {}) } });
    if (active) await transaction.assignment.create({ data: { assetId: created.id, personName: 'Current recipient', createdById: actorId, startedAt: new Date('2010-01-01') } });
    return created;
  });
  const source = workbook('Baja 2026', [retirementRow('Baja 2026', 5, asset.serialNumber, unknownReceipt ? {} : { A: dateCell('2001-01-01') })]);
  source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body); const preview = previewed.json();
  const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch; const base = `/inventory/imports/batches/${batch.id}`;
  const reviewed = await post(base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: preview.candidates[0].id, action: 'LINK_EXISTING', linkedAssetId: asset.id, note: 'Physical retirement identity checked' }); assert.equal(reviewed.statusCode, 201, reviewed.body);
  const history = (await get(base + '/history-preview')).json();
  const captured = await post(base + '/history-captures', { expectedVersion: 2, expectedSourceRevision: 0, requestId: randomUUID(), historyPreviewId: history.historyPreviewId,
    confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Disposal source retained', evidenceReference: 'Original archived inventory',
    records: history.observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: unlinked ? null : asset.id })) }); assert.equal(captured.statusCode, 201, captured.body);
  const capture = captured.json().capture; const evidence = capture.items.find((item) => item.kind === 'RETIREMENT_OBSERVATION');
  const planUrl = `/assets/${asset.id}/imported-retirement-plan`;
  const planInput = { evidenceId: evidence.id, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: '2005-01-01T09:00:00-03:00',
    dateEvidenceReference: 'Signed disposal timestamp including timezone', note: 'Disposal confirmed independently of reception', evidenceReference: 'Verified disposal certificate', acknowledgedWarnings: [] };
  const first = await post(planUrl, planInput); assert.equal(first.statusCode, 200, first.body);
  planInput.acknowledgedWarnings = first.json().warnings.map((warning) => warning.id);
  const planned = await post(planUrl, planInput); assert.equal(planned.statusCode, 200, planned.body); const plan = planned.json();
  const input = { requestId: randomUUID(), planId: plan.planId, confirmation: 'APPLY_VERIFIED_HISTORICAL_RETIREMENT', plan: planInput };
  return { asset, batch, base, source, preview, capture, evidence, plan, input, planUrl, url: planUrl + '/apply', receiptUrl: `/assets/${asset.id}/imported-retirement-applications` };
}
