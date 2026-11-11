import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { dateCell, receptionRow, textCell, workbook } from './workbook-preview.js';

export async function groupClosedAssignmentFixture({ database, product, post, get, knownDay = true, periodCount = 1, extraEvidence = false, sourceCorrection = false }) {
  const serial = ('GROUP-CLOSED-ORIGINAL-' + randomUUID()).toUpperCase();
  const asset = await database.asset.create({ data: { productId: product.id, serialNumber: ('GROUP-CLOSED-VERIFIED-' + randomUUID()).toUpperCase() } });
  const rows = Array.from({ length: periodCount }, (_, index) => {
    const year = 2001 + index * 2;
    return [receptionRow(4 + index * 2, serial, { ...(knownDay ? { M: dateCell(`${year}-01-01`) } : {}),
      ...(sourceCorrection && index === 0 ? { E: textCell('Incorrect source model') } : {}), N: textCell(`OUT-${year}`), O: textCell(`OT-OUT-${year}`) }),
      receptionRow(5 + index * 2, serial, { ...(knownDay ? { A: dateCell(`${year + 1}-01-01`) } : {}), H: textCell(`IN-${year + 1}`), B: textCell(`OT-IN-${year + 1}`) })];
  }).flat();
  if (extraEvidence) {
    rows.push(receptionRow(4 + periodCount * 2, serial, { A: dateCell('2007-01-01'), H: textCell('UNSELECTED-RECEIPT') }),
      receptionRow(5 + periodCount * 2, serial, { A: dateCell('2008-01-01'), H: textCell('UNLINKED-RECEIPT') }));
  }
  const source = workbook('Recepción', rows); source.source.sha256 = randomBytes(32).toString('hex');
  const previewed = await post('/inventory/imports/preview', source); assert.equal(previewed.statusCode, 200, previewed.body);
  const preview = previewed.json();
  const staged = await post('/inventory/imports/batches', { workbook: source, previewId: preview.previewId }); assert.equal(staged.statusCode, 201, staged.body);
  const batch = staged.json().batch; const base = '/inventory/imports/batches/' + batch.id;
  const sourceRevision = sourceCorrection ? 1 : 0;
  if (sourceCorrection) {
    const corrected = await post(base + '/source-revisions', { requestId: randomUUID(), expectedRevision: 0, expectedBatchVersion: 1,
      note: 'Verified source model before archival', evidenceReference: 'Physical manufacturer label',
      changes: [{ recordId: preview.records.find((record) => record.row === 4).id, field: 'model', action: 'REPLACE', value: 'Model G9' }] });
    assert.equal(corrected.statusCode, 201, corrected.body);
  }
  const history = await get(base + '/history-preview'); assert.equal(history.statusCode, 200, history.body);
  const captured = await post(base + '/history-captures', { requestId: randomUUID(), expectedVersion: 1, expectedSourceRevision: sourceRevision,
    historyPreviewId: history.json().historyPreviewId, confirmation: 'STORE_HISTORICAL_EVIDENCE_ONLY', note: 'Archive separate dispatch and receipt rows',
    evidenceReference: 'Signed historical documents', records: history.json().observations.map(({ recordId, kind }) => ({ recordId, kind, assetId: null })) });
  assert.equal(captured.statusCode, 201, captured.body); const capture = captured.json().capture;
  assert.equal(capture.items.length, rows.length); assert.ok(capture.items.every((entry) => entry.assetId === null));
  const proposal = { expectedVersion: 1, expectedSourceRevision: sourceRevision, confirmation: 'REVIEW_PHYSICAL_IDENTITY_GROUPS',
    candidateIds: preview.candidates.map((entry) => entry.id), note: 'Verify one physical asset across archival rows',
    groups: [{ groupId: randomUUID(), recordIds: preview.records.map((entry) => entry.id), serialNumber: asset.serialNumber, assetTag: null, evidenceReference: 'Verified physical label' }] };
  const grouped = await post(base + '/identity-group-plan', proposal); assert.equal(grouped.statusCode, 200, grouped.body);
  assert.equal(grouped.json().proposalValidationComplete, true, grouped.body);
  const reserved = await post(base + '/identity-group-reviews', { requestId: randomUUID(), planId: grouped.json().planId,
    confirmation: 'RESERVE_IDENTITY_GROUP_REVIEW_ONLY', plan: proposal }); assert.equal(reserved.statusCode, 201, reserved.body);
  const review = reserved.json().review; const reviewUrl = base + '/identity-group-reviews/' + review.id;
  const effective = await get(reviewUrl + '/effective-preview'); assert.equal(effective.statusCode, 200, effective.body);
  const projection = effective.json(); assert.equal(projection.groups.length, 1); const group = projection.groups[0];
  const decided = await post(reviewUrl + '/decisions', { requestId: randomUUID(), confirmation: 'RECORD_IDENTITY_GROUP_DECISION_ONLY',
    expectedDecisionVersion: 0, expectedBatchVersion: 1, expectedSourceRevision: sourceRevision, projectionId: projection.projectionId,
    groupKey: group.groupKey, action: 'LINK_EXISTING', linkedAssetId: asset.id, note: 'Verified existing asset identity', evidenceReference: 'Physical label and archive',
    evidenceReviews: group.evidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: entry.evidenceVersion,
      disposition: 'EXCLUDE_FROM_GROUP_PILOT', note: 'Historical custody requires separate review', evidenceReference: 'Separate historical documents' })) });
  assert.equal(decided.statusCode, 201, decided.body);
  let pilotInput = { expectedBatchVersion: 1, expectedSourceRevision: sourceRevision, expectedDecisionVersion: 1, projectionId: projection.projectionId,
    operations: [{ type: 'UPDATE_METADATA', groupKey: group.groupKey, decisionId: decided.json().decision.id, assetId: asset.id,
      note: 'Review metadata without importing historical custody', values: { location: 'Verified group archive' }, acknowledgedWarnings: [] }] };
  const firstPilot = await post(reviewUrl + '/pilot-plan', pilotInput); assert.equal(firstPilot.statusCode, 200, firstPilot.body);
  pilotInput = { ...pilotInput, operations: pilotInput.operations.map((operation) => ({ ...operation,
    acknowledgedWarnings: firstPilot.json().operations.find((entry) => entry.groupKey === operation.groupKey).warnings.map((warning) => warning.id) })) };
  const pilot = await post(reviewUrl + '/pilot-plan', pilotInput); assert.equal(pilot.statusCode, 200, pilot.body);
  assert.equal(pilot.json().planValidationComplete, true, pilot.body);
  const applied = await post(reviewUrl + '/pilot-plan/apply', { requestId: randomUUID(), planId: pilot.json().planId,
    confirmation: 'APPLY_IDENTITY_GROUP_ASSET_PILOT', plan: pilotInput }); assert.equal(applied.statusCode, 201, applied.body);
  const application = applied.json().application; const item = application.items[0];
  const itemUrl = reviewUrl + '/applications/' + application.id + '/items/' + item.id;
  const evidenceAt = (row) => capture.items.find((entry) => entry.snapshot.original.row === row);
  const periods = Array.from({ length: periodCount }, (_, index) => {
    const year = 2001 + index * 2; const start = evidenceAt(4 + index * 2); const end = evidenceAt(5 + index * 2);
    assert.equal(start.kind, 'USAGE_OBSERVATION'); assert.equal(end.kind, 'RECEIPT_OBSERVATION'); assert.notEqual(start.recordId, end.recordId);
    return { periodId: randomUUID(), confirmation: 'VERIFIED_CLOSED_ASSIGNMENT',
      start: { evidenceId: start.id, confirmedAt: `${year}-01-01T09:00:00-03:00`, dateEvidenceReference: 'Signed dispatch timestamp' },
      end: { evidenceId: end.id, confirmedAt: `${year + 1}-01-01T10:00:00-03:00`, dateEvidenceReference: 'Signed return timestamp' },
      recipient: { type: 'OFFICE', name: 'Historical office' }, assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW',
      note: 'Historical closed custody verified independently', evidenceReference: 'Dispatch and return documents', acknowledgedWarnings: [] };
  });
  const endpointIds = periods.flatMap((period) => [period.start.evidenceId, period.end.evidenceId]);
  const selectedEvidence = capture.items.filter((entry) => endpointIds.includes(entry.id) || (extraEvidence && entry.id === evidenceAt(4 + periodCount * 2).id));
  let historyInput = { expectedApplicationPlanId: application.planId, operations: selectedEvidence.map((entry) => ({ evidenceId: entry.id, expectedEvidenceVersion: 0,
    action: 'LINK_TO_APPLIED_GROUP', note: 'Verify historical group membership', evidenceReference: 'Physical label and original document', acknowledgedWarnings: [] })) };
  const firstHistory = await post(itemUrl + '/history-link-plan', historyInput); assert.equal(firstHistory.statusCode, 200, firstHistory.body);
  historyInput = { ...historyInput, operations: historyInput.operations.map((operation) => ({ ...operation,
    acknowledgedWarnings: firstHistory.json().operations.find((entry) => entry.evidenceId === operation.evidenceId).warnings.map((warning) => warning.id) })) };
  const historyPlan = await post(itemUrl + '/history-link-plan', historyInput); assert.equal(historyPlan.statusCode, 200, historyPlan.body);
  assert.equal(historyPlan.json().planValidationComplete, true, historyPlan.body);
  const saved = await post(itemUrl + '/history-link-plan/apply', { requestId: randomUUID(), historyLinkPlanId: historyPlan.json().historyLinkPlanId,
    confirmation: 'SAVE_GROUP_HISTORY_LINKS_ONLY', plan: historyInput }); assert.equal(saved.statusCode, 201, saved.body);
  const historyApplication = saved.json().application;
  const input = { expectedApplicationPlanId: application.planId, links: historyApplication.links.filter((link) => endpointIds.includes(link.evidenceId))
    .map((link) => ({ evidenceId: link.evidenceId, linkId: link.id, expectedLinkVersion: link.version, expectedEvidenceVersion: link.evidenceVersion })), plan: { periods } };
  return { asset, source, preview, batch, base, capture, review, reviewUrl, application, item, itemUrl, historyApplication,
    evidence: capture.items, input, url: itemUrl + '/closed-assignment-plan' };
}
