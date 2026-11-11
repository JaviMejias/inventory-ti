import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { buildHistoricalObservations } from '../src/imports/history.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { buildHistoricalRetirementPlan } from '../src/imports/retirement-plan.js';
import { retirementReconciliationSchema } from '../src/imports/retirement-reconciliation-schemas.js';
import { buildRetirementReconciliation } from '../src/imports/retirement-reconciliation.js';
import { dateCell, retirementRow, workbook } from './fixtures/workbook-preview.js';

function fixture(sheet = 'Baja 2026') {
  const now = new Date('2026-10-05T12:00:00Z');
  const asset = { id: randomUUID(), productId: randomUUID(), serialNumber: 'RECON-001', assetTag: null, status: 'AVAILABLE', isActive: true,
    decommissionedAt: null, updatedAt: now, product: { id: randomUUID(), trackingMode: 'ASSET', isActive: true, updatedAt: now } };
  const source = workbook(sheet, [retirementRow(sheet, 5, asset.serialNumber, { A: dateCell('2001-01-01') })]);
  const preview = buildWorkbookPreview(source, [], '2026-10-05');
  const snapshot = buildHistoricalObservations(preview, preview, { revision: 0, corrections: [] }).find((entry) => entry.kind === 'RETIREMENT_OBSERVATION');
  const evidence = { id: randomUUID(), captureId: randomUUID(), sourceHash: source.source.sha256, recordId: snapshot.recordId,
    candidateId: snapshot.candidateId, kind: snapshot.kind, effectiveDay: snapshot.effectiveDay, assetId: asset.id, snapshot, capturedAt: now,
    capture: { batchId: randomUUID(), sourceRevision: 0, rulesVersion: 'mda-history-evidence-1' } };
  const input = { evidenceId: evidence.id, confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: null, dateEvidenceReference: null,
    note: 'Read-only assessment', evidenceReference: 'Original archived evidence', acknowledgedWarnings: [] };
  const build = (change = {}) => buildRetirementReconciliation(buildHistoricalRetirementPlan(change.asset ?? asset, change.evidence ?? evidence,
    change.assignments ?? [], change.revisions ?? [], input, now, change.usedEvidence ?? []), change.receipts ?? [], now);
  const receipt = { id: randomUUID(), assetId: asset.id, evidenceId: evidence.id, evidenceVersion: 0, amendmentId: null, sourceRevision: 0,
    decommissionedAt: new Date('2005-01-01T12:00:00Z'), appliedAt: now, appliedById: randomUUID() };
  return { asset, evidence, receipt, build, now };
}
const codes = (assessment) => assessment.diagnostics.map((issue) => issue.code);

test('retirement reconciliation DTO permits only an explicit evidence UUID and no operational/date overrides', () => {
  const evidenceId = randomUUID();
  assert.deepEqual(retirementReconciliationSchema.parse({ evidenceId: evidenceId.toUpperCase() }), { evidenceId });
  for (const input of [{}, { evidenceId: 'bad' }, ...['force', 'confirmedAt', 'status', 'acknowledgedWarnings', 'confirmation'].map((key) => ({ evidenceId, [key]: true }))]) {
    assert.equal(retirementReconciliationSchema.safeParse(input).success, false);
  }
});

test('retirement reconciliation keeps source date and actor unknown for all three sheets and never treats receipt/year as retirement', () => {
  for (const sheet of ['Baja 2024', 'Baja 2025', 'Baja 2026']) {
    const { build } = fixture(sheet); const result = build();
    assert.equal(result.classification, 'RETIREMENT_DATE_UNCONFIRMED'); assert.equal(result.currentState, 'NONTERMINAL');
    assert.equal(result.sourceRetirement.effectiveAt, null); assert.equal(result.sourceRetirement.historicalActorId, null);
    assert.equal(result.source.datePrecision, 'UNKNOWN'); assert.equal(result.canApply, false); assert.equal(result.persisted, false);
    assert.equal(result.affectsCurrentState, false); assert.equal(result.operationalResolutionImplemented, false);
    assert.ok(codes(result).includes('EXACT_RETIREMENT_DATE_REQUIRED')); assert.ok(codes(result).includes('EXACT_RETIREMENT_DATE_PROOF_REQUIRED'));
    assert.equal(result.nextSteps.includes('PROVIDE_VERIFIED_DATE_AND_REQUEST_V13_PLAN'), true);
    assert.equal(result.existingRetirement, null); assert.equal(result.proposedRetirement, undefined); assert.equal(result.planId, undefined);
  }
});

test('retirement reconciliation preserves dated/undated existing terminals without confirming the source date or proposing overwrite', () => {
  const { asset, build } = fixture();
  for (const date of [null, new Date('2005-01-01T12:00:00Z')]) {
    const result = build({ asset: { ...asset, status: 'DECOMMISSIONED', isActive: false, decommissionedAt: date } });
    assert.equal(result.classification, date ? 'EXISTING_DATED_RETIREMENT' : 'EXISTING_UNDATED_RETIREMENT');
    assert.equal(result.existingRetirement.effectiveAt, date); assert.equal(result.existingRetirement.confirmsSourceDate, false);
    assert.equal(result.existingRetirement.dateOrigin, 'CURRENT_ASSET'); assert.equal(result.links.verifiedPlan, null);
    assert.ok(result.nextSteps.includes('RECONCILE_EXISTING_RETIREMENT_SEPARATELY'));
  }
});

test('retirement reconciliation distinguishes active custody, inconsistent terminal flags and unconfirmed future dates', () => {
  const { asset, build, now } = fixture();
  const assignment = { id: randomUUID(), startedAt: new Date('2010-01-01'), endedAt: null };
  const active = build({ asset: { ...asset, status: 'ASSIGNED' }, assignments: [assignment] });
  assert.equal(active.classification, 'CURRENT_CUSTODY_CONFLICT'); assert.equal(active.links.verifiedPlan, null);
  for (const change of [{ status: 'ASSIGNED' }, { isActive: false }, { status: 'DECOMMISSIONED' },
    { decommissionedAt: new Date('2005-01-01') }, { status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date(now.getTime() + 1) }]) {
    assert.equal(build({ asset: { ...asset, ...change } }).classification, 'CURRENT_STATE_REVIEW_REQUIRED');
  }
});

test('retirement reconciliation source defects remain review-required and cannot be waived by assessment classification', () => {
  const { asset, evidence, build } = fixture();
  for (const change of [{ assetId: null }, { assetId: randomUUID() }, { capture: { ...evidence.capture, rulesVersion: 'old' } },
    { snapshot: { ...evidence.snapshot, issues: [...evidence.snapshot.issues, { code: 'MODEL_CONFLICT', severity: 'BLOCKING', sheet: null, row: null, cell: null, candidateId: evidence.candidateId }] } }]) {
    const result = build({ evidence: { ...evidence, ...change } }); assert.equal(result.classification, 'EVIDENCE_REVIEW_REQUIRED');
    assert.equal(result.links.verifiedPlan, null); assert.ok(result.nextSteps.includes('REVIEW_EVIDENCE_LINK_AND_SOURCE'));
  }
  const revised = build({ revisions: [{ batchId: evidence.capture.batchId, revision: 1, changes: [{ candidateId: evidence.candidateId }] }] });
  assert.ok(codes(revised).includes('EVIDENCE_SOURCE_REVISED'));
  assert.equal(build({ asset: { ...asset, serialNumber: 'OTHER' } }).classification, 'EVIDENCE_REVIEW_REQUIRED');
});

test('retirement reconciliation reports used evidence, imported receipt and different retirement source without consuming or attaching anything', () => {
  const { asset, evidence, receipt, build } = fixture(); const terminal = { ...asset, status: 'DECOMMISSIONED', isActive: false, decommissionedAt: receipt.decommissionedAt };
  const used = [{ evidenceId: evidence.id, itemId: receipt.id }];
  assert.equal(build({ usedEvidence: used }).evidenceState, 'USED_BY_ASSIGNMENT');
  const imported = build({ asset: terminal, usedEvidence: used, receipts: [receipt] });
  assert.equal(imported.classification, 'ALREADY_IMPORTED_RETIREMENT'); assert.equal(imported.evidenceState, 'USED_FOR_THIS_RETIREMENT');
  assert.equal(imported.existingRetirement.dateOrigin, 'VERIFIED_IMPORT_RECEIPT'); assert.equal(imported.existingApplication.id, receipt.id);
  assert.equal(imported.sourceRetirement.effectiveAt, null); assert.ok(codes(imported).includes('EVIDENCE_ALREADY_APPLIED'));
  const different = build({ asset: terminal, receipts: [{ ...receipt, evidenceId: randomUUID() }] });
  assert.equal(different.classification, 'EXISTING_IMPORTED_RETIREMENT'); assert.equal(different.evidenceApplication, null);
  const foreign = build({ usedEvidence: used, receipts: [{ ...receipt, assetId: randomUUID() }] });
  assert.equal(foreign.classification, 'EVIDENCE_ALREADY_USED'); assert.equal(foreign.existingApplication, null);
  assert.equal(foreign.links.existingApplication, null);
});

test('retirement reconciliation detects receipt/state corruption instead of presenting a healthy already-imported case', () => {
  const { asset, receipt, build } = fixture();
  for (const current of [asset, { ...asset, status: 'DECOMMISSIONED', isActive: false, decommissionedAt: new Date('2006-01-01') }]) {
    const result = build({ asset: current, receipts: [receipt] }); assert.equal(result.classification, 'CURRENT_STATE_REVIEW_REQUIRED');
    assert.ok(codes(result).includes('IMPORTED_RETIREMENT_STATE_CONFLICT')); assert.equal(result.canApply, false);
    if (result.existingRetirement) assert.equal(result.existingRetirement.dateOrigin, 'CURRENT_ASSET');
  }
});

test('retirement reconciliation fingerprint binds metadata, source versions, assignment history and recorded receipt independently of ordering', () => {
  const { asset, evidence, receipt, build } = fixture(); const baseline = build();
  assert.equal(build().assessmentId, baseline.assessmentId);
  for (const change of [{ asset: { ...asset, updatedAt: new Date('2026-10-04') } },
    { evidence: { ...evidence, evidenceVersion: 1, amendmentId: randomUUID() } },
    { assignments: [{ id: randomUUID(), startedAt: new Date('2002-01-01'), endedAt: new Date('2003-01-01') }] }, { receipts: [receipt] }]) {
    assert.notEqual(build(change).assessmentId, baseline.assessmentId);
  }
  assert.ok(baseline.warnings.length > 0); assert.equal(codes(baseline).includes('WARNINGS_NOT_ACKNOWLEDGED'), false);
  assert.equal(baseline.warnings[0].issue.severity, 'WARNING');
  const assignments = [{ id: randomUUID(), startedAt: new Date('2002-01-01'), endedAt: new Date('2003-01-01') },
    { id: randomUUID(), startedAt: new Date('2004-01-01'), endedAt: new Date('2005-01-01') }];
  const receipts = [receipt, { ...receipt, id: randomUUID(), assetId: randomUUID(), evidenceId: randomUUID() }];
  assert.equal(build({ assignments, receipts }).assessmentId, build({ assignments: [...assignments].reverse(), receipts: [...receipts].reverse() }).assessmentId);
});

test('retirement reconciliation does not relabel a receipt observation as retirement or hide source blockers on terminals', () => {
  const { asset, evidence, build } = fixture();
  const wrongKind = build({ evidence: { ...evidence, kind: 'RECEIPT_OBSERVATION', snapshot: { ...evidence.snapshot, kind: 'RECEIPT_OBSERVATION' } } });
  assert.equal(wrongKind.classification, 'EVIDENCE_REVIEW_REQUIRED'); assert.equal(wrongKind.sourceRetirement, null);
  const terminal = build({ asset: { ...asset, status: 'DECOMMISSIONED', isActive: false }, evidence: { ...evidence, assetId: null } });
  assert.equal(terminal.currentState, 'TERMINAL_UNDATED'); assert.equal(terminal.classification, 'EVIDENCE_REVIEW_REQUIRED');
  assert.ok(codes(terminal).includes('EVIDENCE_ASSET_LINK_REQUIRED')); assert.ok(terminal.nextSteps.includes('RECONCILE_EXISTING_RETIREMENT_SEPARATELY'));
});
