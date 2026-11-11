import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { dateCell, receptionRow, textCell, workbook } from './workbook-preview.js';

export async function appliedGroupHistoryFixture({ post, get, database, product, split = false, count = 2, originalLink = false, knownDay = true }) {
  const serial = ('GROUP-HISTORY-ORIGINAL-' + randomUUID()).toUpperCase();
  const originalAsset = originalLink ? await database.asset.create({ data: { productId: product.id, serialNumber: serial } }) : null;
  const source = workbook('Recepción', Array.from({ length: count }, (_, index) => receptionRow(index + 4, serial,
    { ...(knownDay ? { A: dateCell('2001-01-01') } : {}), H: textCell('IN-' + index), K: textCell('Disponible') })));
  source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body); const preview = previewed.json();
  const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch; const base = '/inventory/imports/batches/' + batch.id;
  let version = 1;
  if (originalAsset) {
    const decision = await post(base + '/decisions', { requestId: randomUUID(), expectedVersion: version, expectedSourceRevision: 0,
      targetType: 'CANDIDATE', targetId: preview.candidates[0].id, action: 'LINK_EXISTING', linkedAssetId: originalAsset.id, note: 'Original archival identity reviewed before regrouping' });
    assert.equal(decision.statusCode, 201, decision.body); version++;
  }
  const history = await get(base + '/history-preview'); assert.equal(history.statusCode, 200, history.body);
  const captured = await post(base + '/history-captures', { requestId: randomUUID(), expectedVersion: version, expectedSourceRevision: 0,
    historyPreviewId: history.json().historyPreviewId, confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Archive receipt history', evidenceReference: 'Receiving records',
    records: history.json().observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: null })) }); assert.equal(captured.statusCode, 201, captured.body);
  const capture = captured.json().capture; const recordIds = preview.records.filter((entry) => entry.kind === 'ASSET_OBSERVATION').map((entry) => entry.id);
  const group = { groupId: randomUUID(), recordIds, serialNumber: ('GROUP-HISTORY-VERIFIED-' + randomUUID()).toUpperCase(), assetTag: null, evidenceReference: 'Physical label' };
  const request = { expectedVersion: version, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS', candidateIds: preview.candidates.map((entry) => entry.id),
    note: 'Verified physical group', groups: split ? recordIds.map((recordId) => ({ ...group, groupId: randomUUID(), recordIds: [recordId], serialNumber: ('GROUP-' + randomUUID()).toUpperCase() })) : [group] };
  const planned = await post(base + '/identity-group-plan', request); assert.equal(planned.statusCode, 200, planned.body);
  const reserved = await post(base + '/identity-group-reviews', { requestId: randomUUID(), planId: planned.json().planId, confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: request }); assert.equal(reserved.statusCode, 201, reserved.body);
  const review = reserved.json().review; const reviewUrl = base + '/identity-group-reviews/' + review.id;
  const effective = await get(reviewUrl + '/effective-preview'); assert.equal(effective.statusCode, 200, effective.body); const projection = effective.json();
  const decisions = [];
  for (const entry of projection.groups) {
    const decision = await post(reviewUrl + '/decisions', { requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
      expectedDecisionVersion: decisions.length, expectedBatchVersion: version, expectedSourceRevision: 0, projectionId: projection.projectionId,
      groupKey: entry.groupKey, action: 'PROPOSE_NEW', note: 'Independent group target', evidenceReference: 'Physical identity proof',
      evidenceReviews: entry.evidence.map((evidence) => ({ evidenceId: evidence.id, expectedEvidenceVersion: evidence.evidenceVersion,
        disposition: 'EXCLUDE_FROM_GROUP_PILOT', note: 'No historical effect in asset pilot', evidenceReference: 'Separate history review' })) });
    assert.equal(decision.statusCode, 201, decision.body); decisions.push(decision.json().decision);
  }
  const planRequest = { expectedBatchVersion: version, expectedSourceRevision: 0, expectedDecisionVersion: decisions.length, projectionId: projection.projectionId,
    operations: projection.groups.map((entry) => ({ type: 'CREATE_ASSET', groupKey: entry.groupKey, decisionId: decisions.find((decision) => decision.groupKey === entry.groupKey).id,
      note: 'Available verified group', confirmation: 'AVAILABLE_UNASSIGNED', values: { productId: product.id, serialNumber: entry.serialNumber, assetTag: entry.assetTag } })) };
  const plan = await post(reviewUrl + '/pilot-plan', planRequest); assert.equal(plan.statusCode, 200, plan.body); assert.equal(plan.json().planValidationComplete, true, plan.body);
  const applied = await post(reviewUrl + '/pilot-plan/apply', { requestId: randomUUID(), planId: plan.json().planId, confirmation: 'APPLY_IDENTITY_GROUP_ASSET_PILOT', plan: planRequest }); assert.equal(applied.statusCode, 201, applied.body);
  const application = applied.json().application; const item = application.items[0];
  const evidence = capture.items.filter((entry) => item.rows.some((row) => row.recordId === entry.recordId));
  const url = reviewUrl + '/applications/' + application.id + '/items/' + item.id + '/history-link-plan';
  const input = { expectedApplicationPlanId: application.planId, operations: [evidence[0]].map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: 0,
    action: 'LINK_TO_APPLIED_GROUP', note: 'Explicit history membership review', evidenceReference: 'Independent archived documents', acknowledgedWarnings: [] })) };
  return { source, preview, batch, base, review, reviewUrl, application, item, evidence, capture, url, input, originalAsset };
}
