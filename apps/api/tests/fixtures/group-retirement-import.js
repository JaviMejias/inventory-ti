import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { dateCell, retirementRow, workbook } from './workbook-preview.js';

export async function groupRetirementFixture({ database, product, post, get, ...options }) {
  async function decide(f) {
    f.projection = (await get(f.reviewUrl + '/effective-preview')).json(); const group = f.projection.groups.find((entry) => entry.groupId === f.targetGroupId);
    const previous = (await get(f.reviewUrl + '/decisions')).json();
    const response = await post(f.reviewUrl + '/decisions', { requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
      expectedDecisionVersion: previous.decisionVersion, expectedBatchVersion: f.projection.batchVersion, expectedSourceRevision: f.projection.sourceRevision,
      projectionId: f.projection.projectionId, groupKey: group.groupKey, action: 'LINK_EXISTING', linkedAssetId: f.asset.id,
      note: 'Reviewed unique physical identity for a separate disposal plan', evidenceReference: 'Physical label and archival verification',
      evidenceReviews: group.evidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion, disposition: 'EXCLUDE_FROM_GROUP_PILOT',
        note: 'Disposal cannot be imported through metadata pilot', evidenceReference: 'Independent disposal documents' })) });
    assert.equal(response.statusCode, 201, response.body); f.decision = response.json().decision;
    f.input = { expectedBatchVersion: f.projection.batchVersion, expectedSourceRevision: f.projection.sourceRevision, expectedDecisionVersion: response.json().decisionVersion,
      projectionId: f.projection.projectionId, groupKey: group.groupKey, decisionId: f.decision.id, expectedEvidenceVersion: 0, acknowledgedGroupWarnings: [],
      plan: { evidenceId: f.retirement.id, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: '2005-01-01T09:00:00-03:00',
        dateEvidenceReference: 'Signed disposal timestamp and timezone', note: 'Physical disposal independently verified', evidenceReference: 'Signed disposal certificate', acknowledgedWarnings: [] } };
  }
  async function prepare({ active = false, terminal = false, existingAsset = null, split = false } = {}) {
    const serial = ('GROUP-RETIRE-ORIGINAL-' + randomUUID()).toUpperCase();
    const asset = existingAsset ?? await database.asset.create({ data: { productId: product.id, serialNumber: ('GROUP-RETIRE-VERIFIED-' + randomUUID()).toUpperCase(),
      ...(terminal ? { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2004-01-01') } : {}) } });
    const partner = split ? await database.asset.create({ data: { productId: product.id, serialNumber: ('GROUP-RETIRE-SECOND-' + randomUUID()).toUpperCase() } }) : null;
    if (active) assert.equal((await post('/assets/' + asset.id + '/assignments', { personName: 'Current custodian', effectiveAt: '2001-01-01T00:00:00Z' })).statusCode, 201);
    const source = workbook('Baja 2026', [retirementRow('Baja 2026', 5, serial, { A: dateCell('2000-01-01') }), retirementRow('Baja 2026', 6, serial)]);
    source.source.sha256 = randomBytes(32).toString('hex');
    const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body); const preview = previewed.json();
    const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
    const batch = staged.json().batch; const base = '/inventory/imports/batches/' + batch.id;
    const history = (await get(base + '/history-preview')).json();
    const captured = await post(base + '/history-captures', { requestId: randomUUID(), expectedVersion: 1, expectedSourceRevision: 0, historyPreviewId: history.historyPreviewId,
      confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Retain separate original receipt and disposal observations', evidenceReference: 'Original inventory archive',
      records: history.observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: null })) }); assert.equal(captured.statusCode, 201, captured.body);
    const capture = captured.json().capture; const retirement = capture.items.find((entry) => entry.kind === 'RETIREMENT_OBSERVATION' && entry.snapshot.original.row === 5);
    const proposal = { expectedVersion: 1, expectedSourceRevision: 0, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS', candidateIds: preview.candidates.map((entry) => entry.id),
      note: 'Verify one physical asset across disposal source rows', groups: [{ groupId: randomUUID(), recordIds: preview.records.map((entry) => entry.id),
        serialNumber: asset.serialNumber, assetTag: null, evidenceReference: 'Physical label verification' }] };
    if (split) proposal.groups = preview.records.map((record, index) => ({ groupId: randomUUID(), recordIds: [record.id], serialNumber: index === 0 ? asset.serialNumber : partner.serialNumber,
      assetTag: null, evidenceReference: 'Distinct physical labels verified against each original row' }));
    const grouped = await post(base + '/identity-group-plan', proposal); assert.equal(grouped.statusCode, 200, grouped.body); assert.equal(grouped.json().proposalValidationComplete, true, grouped.body);
    const reserved = await post(base + '/identity-group-reviews', { requestId: randomUUID(), planId: grouped.json().planId, confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: proposal });
    assert.equal(reserved.statusCode, 201, reserved.body); const review = reserved.json().review; const reviewUrl = base + '/identity-group-reviews/' + review.id;
    const f = { source, asset, partner, proposal, targetGroupId: proposal.groups[0].groupId, batch, base, review, reviewUrl, capture, retirement, url: reviewUrl + '/retirement-plan' };
    await decide(f); f.refreshDecision = () => decide(f); return f;
  }
  return prepare(options);
}
