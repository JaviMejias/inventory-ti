import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { buildHistoricalObservations } from '../src/imports/history.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { historicalRetirementPlanSchema } from '../src/imports/retirement-plan-schemas.js';
import { buildHistoricalRetirementPlan } from '../src/imports/retirement-plan.js';
import { dateCell, retirementRow, workbook } from './fixtures/workbook-preview.js';

function fixture(sheet = 'Baja 2026') {
  const now = new Date('2026-10-05T12:00:00Z');
  const asset = { id: randomUUID(), productId: randomUUID(), serialNumber: 'RETIRE-001', assetTag: null, status: 'AVAILABLE', isActive: true,
    decommissionedAt: null, updatedAt: now, product: { id: randomUUID(), trackingMode: 'ASSET', isActive: true, updatedAt: now } };
  const source = workbook(sheet, [retirementRow(sheet, 5, asset.serialNumber, { A: dateCell('2001-01-01') })]);
  const preview = buildWorkbookPreview(source, [], '2026-10-05');
  const snapshot = buildHistoricalObservations(preview, preview, { revision: 0, corrections: [] }).find((entry) => entry.kind === 'RETIREMENT_OBSERVATION');
  const evidence = { id: randomUUID(), captureId: randomUUID(), sourceHash: source.source.sha256, recordId: snapshot.recordId,
    candidateId: snapshot.candidateId, kind: snapshot.kind, effectiveDay: snapshot.effectiveDay, assetId: asset.id, snapshot, capturedAt: now,
    capture: { batchId: randomUUID(), sourceRevision: 0, rulesVersion: 'mda-history-evidence-1' } };
  const input = historicalRetirementPlanSchema.parse({ evidenceId: evidence.id, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT',
    confirmedAt: '2005-01-01T09:00:00-03:00', dateEvidenceReference: 'Signed disposal timestamp',
    note: 'Physical retirement independently verified', evidenceReference: 'Signed disposal certificate' });
  input.acknowledgedWarnings = buildHistoricalRetirementPlan(asset, evidence, [], [], input, now).warnings.map((warning) => warning.id);
  const build = (change = {}) => buildHistoricalRetirementPlan(change.asset ?? asset, change.evidence ?? evidence, change.assignments ?? [],
    change.revisions ?? [], change.input ?? input, change.now ?? now, change.usedEvidence ?? []);
  return { now, asset, evidence, input, build };
}
const codes = (plan) => plan.blockers.map((entry) => entry.code);
const assignment = (change = {}) => ({ id: randomUUID(), startedAt: new Date('2002-01-01'), endedAt: new Date('2003-01-01'),
  recipientType: 'OFFICE', officeName: 'Office', personName: null, assignmentType: 'STANDARD', returnStatus: 'AVAILABLE', ...change });

test('retirement DTO is strict and requires human confirmation, bounded proof and valid zoned instants', () => {
  const { input } = fixture();
  for (const change of [{ evidenceId: 'a'.repeat(64) }, { confirmation: 'APPLY_RETIREMENT' }, { canApply: true }, { force: true },
    { historicalActorId: randomUUID() }, { confirmedAt: '2005-01-01' }, { confirmedAt: '1899-01-01T00:00:00Z' },
    { confirmedAt: '2005-01-01T00:00:00.000001Z' }, { confirmedAt: '2005-02-30T00:00:00Z' }, { confirmedAt: '2005-01-01T00:00:00+99:00' },
    { note: ' ' }, { evidenceReference: 'x'.repeat(501) }, { dateEvidenceReference: '' },
    { acknowledgedWarnings: ['a'.repeat(64), 'a'.repeat(64)] }]) assert.equal(historicalRetirementPlanSchema.safeParse({ ...input, ...change }).success, false);
  assert.equal(historicalRetirementPlanSchema.parse({ ...input, evidenceId: input.evidenceId.toUpperCase() }).evidenceId, input.evidenceId);
});

test('all three retirement sheets preserve unknown source retirement date and actor, never reception date or sheet year as defaults', () => {
  for (const sheet of ['Baja 2024', 'Baja 2025', 'Baja 2026']) {
    const { asset, evidence, input, build } = fixture(sheet);
    const incomplete = build({ input: { ...input, confirmedAt: null, dateEvidenceReference: null } });
    assert.equal(incomplete.source.effectiveDay, null); assert.equal(incomplete.source.datePrecision, 'UNKNOWN');
    assert.equal(incomplete.source.sourceReceivedDay, '2001-01-01'); assert.equal(incomplete.proposedRetirement.decommissionedAt, null);
    assert.equal(incomplete.proposedRetirement.historicalActorId, null);
    assert.ok(codes(incomplete).includes('EXACT_RETIREMENT_DATE_REQUIRED')); assert.ok(codes(incomplete).includes('EXACT_RETIREMENT_DATE_PROOF_REQUIRED'));
    assert.equal(asset.status, 'AVAILABLE'); assert.equal(evidence.effectiveDay, null);
  }
});

test('verified retirement plan stays read-only and fingerprints proof, asset, history and evidence versions', () => {
  const { asset, evidence, input, build } = fixture(); const result = build();
  assert.equal(result.planValidationComplete, true); assert.equal(result.canApply, false); assert.equal(result.persisted, false); assert.equal(result.affectsCurrentState, false);
  assert.equal(result.proposedRetirement.decommissionedAt, '2005-01-01T12:00:00.000Z'); assert.equal(result.assetBefore.status, 'AVAILABLE');
  assert.equal(build().planId, result.planId);
  for (const change of [{ input: { ...input, evidenceReference: 'Other document' } }, { asset: { ...asset, updatedAt: new Date('2026-10-04') } },
    { assignments: [assignment()] }, { evidence: { ...evidence, evidenceVersion: 1, amendmentId: randomUUID() } }]) assert.notEqual(build(change).planId, result.planId);
});

test('future retirement, earlier local receipt day and damaged source receipt dates cannot become valid', () => {
  const { evidence, input, build } = fixture();
  assert.ok(codes(build({ input: { ...input, confirmedAt: '2055-01-01T00:00:00Z' } })).includes('HISTORICAL_DATE_IN_FUTURE'));
  assert.ok(codes(build({ input: { ...input, confirmedAt: '2000-12-31T23:30:00-03:00' } })).includes('RETIREMENT_BEFORE_RECEIPT_DAY'));
  assert.equal(build({ input: { ...input, confirmedAt: '2001-01-01T00:30:00+03:00' } }).planValidationComplete, true);
  const corrupted = { ...evidence, snapshot: { ...evidence.snapshot, effective: { ...evidence.snapshot.effective,
    fields: { ...evidence.snapshot.effective.fields, receivedDate: '2001-02-30' } } } };
  assert.ok(codes(build({ evidence: corrupted })).includes('SOURCE_RECEIPT_DATE_UNCONFIRMED'));
});

test('retirement does not close current assignments, even if they start later than the proposed date', () => {
  const { asset, build } = fixture(); const active = assignment({ startedAt: new Date('2010-01-01'), endedAt: null });
  assert.ok(codes(build({ asset: { ...asset, status: 'ASSIGNED' }, assignments: [active] })).includes('ACTIVE_ASSIGNMENT_REQUIRES_RETURN'));
  assert.ok(codes(build({ assignments: [active] })).includes('CURRENT_ASSIGNMENT_STATE_INCONSISTENT'));
  assert.ok(codes(build({ asset: { ...asset, status: 'ASSIGNED' } })).includes('CURRENT_ASSIGNMENT_STATE_INCONSISTENT'));
  const late = assignment({ endedAt: new Date('2006-01-01') });
  const result = build({ assignments: [late] }); assert.ok(codes(result).includes('ASSIGNMENT_AFTER_RETIREMENT'));
  assert.equal(result.blockers.find((entry) => entry.code === 'ASSIGNMENT_AFTER_RETIREMENT').relatedId, late.id);
  assert.equal(build({ assignments: [assignment({ endedAt: new Date('2005-01-01T12:00:00Z') })] }).planValidationComplete, true);
  assert.ok(codes(build({ assignments: [assignment({ endedAt: new Date('2001-01-01') })] })).includes('OPERATIONAL_ASSIGNMENT_PERIOD_INVALID'));
});

test('existing terminal state is reconciliation, never a date replacement or reactivation, while inactive catalogs can be retired', () => {
  const { asset, build } = fixture();
  for (const change of [{ isActive: false }, { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: null },
    { decommissionedAt: new Date('2005-01-01') }]) assert.ok(codes(build({ asset: { ...asset, ...change } })).includes('EXISTING_RETIREMENT_REQUIRES_RECONCILIATION'));
  assert.equal(build({ asset: { ...asset, product: { ...asset.product, isActive: false } } }).planValidationComplete, true);
  assert.ok(codes(build({ asset: { ...asset, product: { ...asset.product, trackingMode: 'QUANTITY' } } })).includes('PRODUCT_NOT_ASSET'));
});

test('retirement evidence must be linked, match current identity, use compatible rules and remain unconsumed', () => {
  const { asset, evidence, build } = fixture();
  for (const [change, code] of [[{ assetId: null }, 'EVIDENCE_ASSET_LINK_REQUIRED'], [{ assetId: randomUUID() }, 'EVIDENCE_ASSET_MISMATCH'],
    [{ snapshot: { ...evidence.snapshot, identityLinkBlocked: true } }, 'EVIDENCE_IDENTITY_UNRESOLVED'],
    [{ capture: { ...evidence.capture, rulesVersion: 'old' } }, 'EVIDENCE_RULES_CHANGED'],
    [{ kind: 'RECEIPT_OBSERVATION', snapshot: { ...evidence.snapshot, kind: 'RECEIPT_OBSERVATION' } }, 'RETIREMENT_EVIDENCE_KIND_REQUIRED']]) {
    assert.ok(codes(build({ evidence: { ...evidence, ...change } })).includes(code));
  }
  assert.ok(codes(build({ asset: { ...asset, serialNumber: 'OTHER' } })).includes('CURRENT_ASSET_IDENTITY_CONFLICT'));
  assert.ok(codes(build({ usedEvidence: [{ evidenceId: evidence.id, itemId: randomUUID() }] })).includes('EVIDENCE_ALREADY_APPLIED'));
});

test('later source revisions require refreshed V12 evidence and retain captured vs effective source versions', () => {
  const { evidence, build } = fixture(); const revisions = [{ batchId: evidence.capture.batchId, revision: 1, changes: [{ candidateId: evidence.candidateId }] }];
  assert.ok(codes(build({ revisions })).includes('EVIDENCE_SOURCE_REVISED'));
  const refreshed = build({ revisions, evidence: { ...evidence, evidenceVersion: 1, amendmentId: randomUUID(), effectiveSourceRevision: 1 } });
  assert.equal(refreshed.planValidationComplete, true); assert.equal(refreshed.source.sourceRevision, 1); assert.equal(refreshed.source.capturedSourceRevision, 0);
  assert.equal(build({ revisions: [{ ...revisions[0], changes: [{ candidateId: 'f'.repeat(64) }] }] }).planValidationComplete, true);
  assert.throws(() => build({ revisions: [{ ...revisions[0], changes: [{}] }] }), (error) => error.code === 'INVALID_SOURCE_REVISION');
});

test('warning acknowledgement cannot waive current-state conflicts or any source blocker for retirement', () => {
  const { evidence, input, build } = fixture(); const first = build({ input: { ...input, acknowledgedWarnings: [] } });
  assert.ok(codes(first).includes('WARNINGS_NOT_ACKNOWLEDGED'));
  assert.ok(codes(build({ input: { ...input, acknowledgedWarnings: ['f'.repeat(64)] } })).includes('UNKNOWN_WARNING_ACKNOWLEDGEMENT'));
  for (const code of ['CROSS_SHEET_STATE_CONFLICT', 'EXISTING_TERMINAL_STATE_CONFLICT', 'AVAILABILITY_ASSIGNMENT_CONFLICT', 'MODEL_CONFLICT']) {
    const changed = { ...evidence, snapshot: { ...evidence.snapshot, issues: [...evidence.snapshot.issues,
      { code, severity: 'BLOCKING', sheet: null, row: null, cell: null, candidateId: evidence.candidateId }] } };
    assert.ok(codes(build({ evidence: changed })).includes('SOURCE_' + code));
  }
});

test('malformed archive provenance and manufactured retirement day fail closed instead of returning a plan', () => {
  const { evidence, build } = fixture();
  for (const change of [{ snapshot: {} }, { recordId: 'f'.repeat(64) }, { snapshot: { ...evidence.snapshot, historicalActorId: randomUUID() } },
    { effectiveDay: '2001-01-01', snapshot: { ...evidence.snapshot, effectiveDay: '2001-01-01', datePrecision: 'DAY' } },
    { snapshot: { ...evidence.snapshot, effective: { ...evidence.snapshot.effective, row: 9 } } }]) {
    assert.throws(() => build({ evidence: { ...evidence, ...change } }), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
  }
});
