import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { dateCell, receptionRow, textCell, workbook } from './workbook-preview.js';

export async function closedAssignmentFixture({ database, product, actorId, post, get, count = 1, active = false, retired = false, priorUsage = false, unlinked = false, unknownEndDate = false }) {
  const asset = await database.$transaction(async (transaction) => {
    const created = await transaction.asset.create({ data: { productId: product.id, serialNumber: `CLOSED-${randomUUID()}`,
      ...(active ? { status: 'ASSIGNED' } : {}), ...(retired ? { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2005-01-01') } : {}) } });
    if (active) await transaction.assignment.create({ data: { assetId: created.id, personName: 'Current recipient', createdById: actorId, startedAt: new Date('2005-01-01') } });
    return created;
  });
  const rows = Array.from({ length: count }, (_, index) => {
    const year = 2001 + index * 2;
    return [receptionRow(4 + index * 2, asset.serialNumber, { M: dateCell(`${year}-01-01`), N: textCell(`OUT-${year}`), O: textCell(`OT-OUT-${year}`) }),
      receptionRow(5 + index * 2, asset.serialNumber, { ...(unknownEndDate ? {} : { A: dateCell(`${year + 1}-01-01`) }), H: textCell(`IN-${year + 1}`), B: textCell(`OT-IN-${year + 1}`) })];
  }).flat();
  if (priorUsage) rows.push(receptionRow(4 + count * 2, asset.serialNumber, { M: dateCell('2000-01-01'), N: textCell('EARLIER-OUT') }));
  const source = workbook('Recepción', rows); source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json(); const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId });
  assert.equal(staged.statusCode, 201, staged.body); const batch = staged.json().batch; const base = `/inventory/imports/batches/${batch.id}`;
  const reviewed = await post(base + '/decisions', { expectedVersion: 1, expectedSourceRevision: 0, requestId: randomUUID(), targetType: 'CANDIDATE',
    targetId: preview.candidates[0].id, action: 'LINK_EXISTING', linkedAssetId: asset.id, note: 'Physical source identity reviewed' });
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  const history = (await get(base + '/history-preview')).json();
  const captured = await post(base + '/history-captures', { expectedVersion: 2, expectedSourceRevision: 0, requestId: randomUUID(), historyPreviewId: history.historyPreviewId,
    confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Closed periods source retained', evidenceReference: 'Dispatch and receiving documents',
    records: history.observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: unlinked ? null : asset.id })) });
  assert.equal(captured.statusCode, 201, captured.body); const capture = captured.json().capture;
  const periods = Array.from({ length: count }, (_, index) => {
    const year = 2001 + index * 2;
    const start = capture.items.find((entry) => entry.kind === 'USAGE_OBSERVATION' && entry.effectiveDay === `${year}-01-01`);
    const end = capture.items.find((entry) => entry.kind === 'RECEIPT_OBSERVATION' && entry.snapshot.original.row === 5 + index * 2);
    return { periodId: randomUUID(), confirmation: 'VERIFIED_CLOSED_ASSIGNMENT', start: { evidenceId: start.id, confirmedAt: `${year}-01-01T09:00:00-03:00`, dateEvidenceReference: 'Signed delivery timestamp' },
      end: { evidenceId: end.id, confirmedAt: `${year + 1}-01-01T10:00:00-03:00`, dateEvidenceReference: 'Signed return timestamp' }, recipient: { type: 'OFFICE', name: 'Central office' },
      assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW', note: 'Confirmed closed period', evidenceReference: 'Recipient, delivery and return records', acknowledgedWarnings: [] };
  });
  const planInput = { periods }; const planUrl = `/assets/${asset.id}/imported-assignment-plan`;
  const planned = await post(planUrl, planInput); assert.equal(planned.statusCode, 200, planned.body); const plan = planned.json();
  assert.equal(plan.planValidationComplete, !unlinked, planned.body);
  const input = { requestId: randomUUID(), planId: plan.planId, confirmation: 'APPLY_CLOSED_ASSIGNMENT_HISTORY', plan: planInput };
  return { asset, source, batch, base, capture, plan, input, planUrl, url: planUrl + '/apply', receiptUrl: `/assets/${asset.id}/imported-assignment-applications` };
}
