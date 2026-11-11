import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { closedAssignmentPlanSchema } from '../src/imports/assignment-plan-schemas.js';
import { buildClosedAssignmentPlan } from '../src/imports/assignment-plan.js';
import { buildHistoricalObservations } from '../src/imports/history.js';
import { buildWorkbookPreview } from '../src/imports/preview.js';
import { dateCell, receptionRow, textCell, workbook } from './fixtures/workbook-preview.js';

function fixture() {
  const now = new Date('2026-10-05T12:00:00Z');
  const asset = { id: randomUUID(), productId: randomUUID(), serialNumber: 'PERIOD-001', assetTag: null, status: 'AVAILABLE', isActive: true,
    decommissionedAt: null, updatedAt: now, product: { id: randomUUID(), trackingMode: 'ASSET', isActive: true, updatedAt: now } };
  const source = workbook('Recepción', [receptionRow(4, asset.serialNumber, { M: dateCell('2001-01-01'), N: textCell('OUT-TK'), O: textCell('OUT-OT') }),
    receptionRow(5, asset.serialNumber, { A: dateCell('2002-01-01'), H: textCell('IN-TK'), B: textCell('IN-OT') })]);
  const preview = buildWorkbookPreview(source, [], '2026-10-05');
  const evidence = buildHistoricalObservations(preview, preview, { revision: 0, corrections: [] }).map((snapshot) => ({
    id: randomUUID(), captureId: randomUUID(), sourceHash: source.source.sha256, recordId: snapshot.recordId, candidateId: snapshot.candidateId,
    kind: snapshot.kind, effectiveDay: snapshot.effectiveDay, assetId: asset.id, snapshot, capturedAt: now,
    capture: { batchId: randomUUID(), sourceRevision: 0, rulesVersion: 'mda-history-evidence-1' }
  }));
  const start = evidence.find((entry) => entry.kind === 'USAGE_OBSERVATION'); const end = evidence.find((entry) => entry.kind === 'RECEIPT_OBSERVATION');
  const input = closedAssignmentPlanSchema.parse({ periods: [{ periodId: randomUUID(), confirmation: 'VERIFIED_CLOSED_ASSIGNMENT',
    start: { evidenceId: start.id, confirmedAt: '2001-01-01T09:00:00-03:00', dateEvidenceReference: 'Signed delivery timestamp' },
    end: { evidenceId: end.id, confirmedAt: '2002-01-01T10:00:00-03:00', dateEvidenceReference: 'Signed return timestamp' },
    recipient: { type: 'OFFICE', name: 'Central office' }, assignmentType: 'STANDARD', returnStatus: 'UNDER_REVIEW',
    note: 'Closed custody period reviewed', evidenceReference: 'Delivery and return documents' }] });
  const build = (change = {}) => buildClosedAssignmentPlan(change.asset ?? asset, change.evidence ?? evidence, change.assignments ?? [], change.revisions ?? [], change.input ?? input, now);
  return { asset, evidence, start, end, input, build };
}
const codes = (result) => result.periods.flatMap((period) => period.blockers.map((entry) => entry.code));

test('closed history DTO requires explicit confirmation and bounds dates, recipients, selections and warning acknowledgements', () => {
  const { input } = fixture(); const period = input.periods[0];
  for (const invalid of [{ periods: [] }, { periods: Array(26).fill(period) }, { periods: [period, period] }, { ...input, canApply: true },
    { periods: [{ ...period, confirmation: 'APPLY_ASSIGNMENT' }] }, { periods: [{ ...period, createdById: randomUUID() }] },
    { periods: [{ ...period, returnStatus: 'DECOMMISSIONED' }] }, { periods: [{ ...period, start: { ...period.start, confirmedAt: '2001-01-01' } }] },
    { periods: [{ ...period, end: { ...period.end, confirmedAt: '1899-01-01T00:00:00Z' } }] },
    { periods: [{ ...period, start: { ...period.start, confirmedAt: '2001-01-01T09:00:00.000001Z' } }] },
    { periods: [{ ...period, recipient: { type: 'PERSON', name: 'OneName' } }] },
    { periods: [{ ...period, recipient: { type: 'OFFICE', name: 'Office', personId: randomUUID() } }] },
    { periods: [{ ...period, acknowledgedWarnings: ['a'.repeat(64), 'a'.repeat(64)] }] }]) {
    assert.equal(closedAssignmentPlanSchema.safeParse(invalid).success, false);
  }
});

test('closed history plan is deterministic, preserves current state and never attributes historical actors to the capturer', () => {
  const { build } = fixture(); const result = build(); const proposal = result.periods[0].proposedAssignment;
  assert.equal(result.planValidationComplete, true); assert.equal(result.canApply, false); assert.equal(result.persisted, false); assert.equal(result.affectsCurrentState, false);
  assert.equal(proposal.startedAt, '2001-01-01T12:00:00.000Z'); assert.equal(proposal.endedAt, '2002-01-01T13:00:00.000Z');
  assert.equal(proposal.assignedById, null); assert.equal(proposal.returnedById, null); assert.equal(proposal.personId, null);
  assert.equal(proposal.ticketReference, 'OUT-TK'); assert.equal(proposal.otReference, 'OUT-OT');
  assert.equal(proposal.returnTicketReference, 'IN-TK'); assert.equal(proposal.returnOtReference, 'IN-OT');
  assert.equal(build().planId, result.planId); assert.equal(result.assetBefore.status, 'AVAILABLE');
});

test('missing exact instants, proof, recipient and return condition remain explicit blockers without invented defaults', () => {
  const { build, input } = fixture(); const period = input.periods[0];
  const partial = closedAssignmentPlanSchema.parse({ periods: [{ ...period, start: { evidenceId: period.start.evidenceId },
    end: { evidenceId: period.end.evidenceId }, recipient: null, returnStatus: null }] });
  const result = build({ input: partial });
  for (const code of ['EXACT_DATE_REQUIRED', 'EXACT_DATE_PROOF_REQUIRED', 'CONFIRMED_RECIPIENT_REQUIRED', 'CONFIRMED_RETURN_STATUS_REQUIRED']) assert.ok(codes(result).includes(code));
  assert.equal(result.periods[0].proposedAssignment.startedAt, null); assert.equal(result.periods[0].proposedAssignment.endedAt, null);
});

test('source calendar days compare against the supplied offset, while future, reversed and mismatching dates block', () => {
  const { build, input } = fixture(); const period = input.periods[0];
  assert.equal(build({ input: { periods: [{ ...period, start: { ...period.start, confirmedAt: '2001-01-01T23:00:00-03:00' } }] } }).planValidationComplete, true);
  for (const [change, code] of [
    [{ start: { ...period.start, confirmedAt: '2001-01-02T00:00:00Z' } }, 'SOURCE_DAY_MISMATCH'],
    [{ end: { ...period.end, confirmedAt: '2055-01-01T00:00:00Z' } }, 'HISTORICAL_DATE_IN_FUTURE'],
    [{ end: { ...period.end, confirmedAt: period.start.confirmedAt } }, 'HISTORICAL_PERIOD_ORDER_INVALID']
  ]) assert.ok(codes(build({ input: { periods: [{ ...period, ...change }] } })).includes(code));
});

test('operational periods block overlap but permit touching boundaries and history before an active assignment', () => {
  const { asset, build, input } = fixture(); const period = input.periods[0];
  const closed = { id: randomUUID(), startedAt: new Date('2000-01-01'), endedAt: new Date(period.start.confirmedAt), recipientType: 'OFFICE', officeName: 'Office', personName: null, assignmentType: 'STANDARD', returnStatus: 'AVAILABLE' };
  assert.equal(build({ assignments: [closed] }).planValidationComplete, true);
  assert.ok(codes(build({ assignments: [{ ...closed, endedAt: new Date('2001-01-02') }] })).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
  const active = { ...closed, startedAt: new Date('2005-01-01'), endedAt: null };
  assert.equal(build({ asset: { ...asset, status: 'ASSIGNED' }, assignments: [active] }).planValidationComplete, true);
  assert.ok(codes(build({ asset: { ...asset, status: 'ASSIGNED' }, assignments: [{ ...active, startedAt: new Date('2001-01-01') }] })).includes('OPERATIONAL_ASSIGNMENT_OVERLAP'));
  assert.ok(codes(build({ asset: { ...asset, status: 'ASSIGNED' } })).includes('CURRENT_ASSIGNMENT_STATE_INCONSISTENT'));
});

test('planned periods detect each other independently of order, with all endpoint observations distinct', () => {
  const { build, input, evidence, start, end } = fixture();
  const copies = evidence.map((entry) => ({ ...entry, id: randomUUID() }));
  const second = { ...input.periods[0], periodId: randomUUID(), start: { ...input.periods[0].start, evidenceId: copies.find((entry) => entry.kind === start.kind).id },
    end: { ...input.periods[0].end, evidenceId: copies.find((entry) => entry.kind === end.kind).id } };
  const periods = [...input.periods, second]; const result = build({ evidence: [...evidence, ...copies], input: { periods } });
  assert.equal(result.periods.every((period) => period.blockers.some((entry) => entry.code === 'PROPOSED_PERIOD_OVERLAP')), true);
  assert.equal(result.planId, build({ evidence: [...copies, ...evidence], input: { periods: periods.toReversed() } }).planId);
});

test('physical endpoint provenance and confirmed links are mandatory, not guessed from matching names', () => {
  const { asset, build, evidence, input, start } = fixture();
  for (const [change, code] of [[{ assetId: null }, 'EVIDENCE_ASSET_LINK_REQUIRED'], [{ assetId: randomUUID() }, 'EVIDENCE_ASSET_MISMATCH'],
    [{ snapshot: { ...start.snapshot, identityLinkBlocked: true } }, 'EVIDENCE_IDENTITY_UNRESOLVED']]) {
    assert.ok(codes(build({ evidence: evidence.map((entry) => entry.id === start.id ? { ...entry, ...change } : entry) })).includes(code));
  }
  assert.ok(codes(build({ asset: { ...asset, serialNumber: 'OTHER' } })).includes('CURRENT_ASSET_IDENTITY_CONFLICT'));
  assert.throws(() => build({ evidence: [] }), (error) => error.code === 'NOT_FOUND');
  assert.throws(() => build({ evidence: [{ ...evidence[0], snapshot: {} }, ...evidence.slice(1)] }), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
  assert.equal(input.periods.length, 1);
});

test('loan type, recipient text and endpoint kinds cannot be silently reinterpreted', () => {
  const { build, input, start, evidence, end } = fixture();
  const replace = (change) => evidence.map((entry) => entry.id === start.id ? { ...entry, ...change } : entry);
  assert.ok(codes(build({ evidence: replace({ kind: 'LOAN_OBSERVATION', snapshot: { ...start.snapshot, kind: 'LOAN_OBSERVATION' } }) })).includes('SOURCE_LOAN_TYPE_MISMATCH'));
  assert.ok(codes(build({ evidence: replace({ kind: 'RECEIPT_OBSERVATION', snapshot: { ...start.snapshot, kind: 'RECEIPT_OBSERVATION' } }) })).includes('EVIDENCE_ENDPOINT_KIND_INVALID'));
  const reported = { ...start.snapshot, effective: { ...start.snapshot.effective, fields: { ...start.snapshot.effective.fields, officeText: 'Other office' } } };
  assert.ok(codes(build({ evidence: replace({ snapshot: reported }) })).includes('SOURCE_RECIPIENT_MISMATCH'));
  const placeholder = { ...start.snapshot, effective: { ...start.snapshot.effective, fields: { ...start.snapshot.effective.fields,
    officeText: 'N/A', recipientText: 'Another Recipient', loanCode: 'NB-01' } } };
  const guarded = build({ evidence: replace({ snapshot: placeholder }) });
  assert.ok(codes(guarded).includes('SOURCE_RECIPIENT_MISMATCH')); assert.ok(codes(guarded).includes('SOURCE_LOAN_TYPE_MISMATCH'));
  const sameRecord = { ...end, recordId: start.recordId, snapshot: { ...end.snapshot, recordId: start.recordId, original: start.snapshot.original,
    effective: { ...end.snapshot.effective, id: start.recordId, sheet: start.snapshot.original.sheet, row: start.snapshot.original.row } } };
  assert.ok(codes(build({ evidence: [start, sameRecord], input })).includes('DISTINCT_ENDPOINT_RECORDS_REQUIRED'));
});

test('later source corrections invalidate only affected candidates, including restoration and rules drift', () => {
  const { build, start, evidence } = fixture();
  assert.ok(codes(build({ revisions: [{ batchId: start.capture.batchId, revision: 1, changes: [{ candidateId: start.candidateId }] }] })).includes('EVIDENCE_SOURCE_REVISED'));
  assert.equal(build({ revisions: [{ batchId: start.capture.batchId, revision: 1, changes: [{ candidateId: 'f'.repeat(64) }] }] }).planValidationComplete, true);
  assert.ok(codes(build({ evidence: evidence.map((entry) => ({ ...entry, capture: { ...entry.capture, rulesVersion: 'old-rules' } })) })).includes('EVIDENCE_RULES_CHANGED'));
  assert.throws(() => build({ revisions: [{ batchId: start.capture.batchId, revision: 1, changes: [{}] }] }), (error) => error.code === 'INVALID_SOURCE_REVISION');
});

test('warnings require exact acknowledgements; source blockers cannot be bypassed, even with external date proof', () => {
  const { build, input, start, evidence } = fixture();
  const issue = { code: 'RETIREMENT_DATE_UNCONFIRMED', severity: 'WARNING', sheet: start.snapshot.original.sheet, row: start.snapshot.original.row, cell: null, candidateId: null };
  const changed = evidence.map((entry) => entry.id === start.id ? { ...entry, snapshot: { ...entry.snapshot, issues: [issue] } } : entry);
  const first = build({ evidence: changed }); const warningId = first.periods[0].warnings[0].id;
  const acknowledged = { periods: [{ ...input.periods[0], acknowledgedWarnings: [warningId] }] };
  assert.ok(codes(first).includes('WARNINGS_NOT_ACKNOWLEDGED')); assert.equal(build({ evidence: changed, input: acknowledged }).planValidationComplete, true);
  assert.ok(codes(build({ input: acknowledged })).includes('UNKNOWN_WARNING_ACKNOWLEDGEMENT'));
  const damaged = changed.map((entry) => entry.id === start.id ? { ...entry, snapshot: { ...entry.snapshot, issues: [{ ...issue, code: 'FUTURE_SOURCE_DATE', severity: 'BLOCKING' }] } } : entry);
  assert.ok(codes(build({ evidence: damaged })).includes('SOURCE_FUTURE_SOURCE_DATE'));
});

test('historical state conflicts are acknowledged context, but periods after decommission cannot become valid', () => {
  const { asset, build, input, start, evidence } = fixture();
  const retired = { ...asset, isActive: false, status: 'DECOMMISSIONED', decommissionedAt: new Date('2005-01-01') };
  assert.equal(build({ asset: retired }).planValidationComplete, true);
  assert.ok(codes(build({ asset: { ...retired, decommissionedAt: new Date('2001-12-31') } })).includes('HISTORICAL_PERIOD_AFTER_DECOMMISSION'));
  assert.ok(codes(build({ asset: { ...retired, decommissionedAt: null } })).includes('DECOMMISSION_DATE_UNCONFIRMED'));
  const issue = { code: 'EXISTING_TERMINAL_STATE_CONFLICT', severity: 'BLOCKING', sheet: null, row: null, cell: null, candidateId: start.candidateId };
  const changed = evidence.map((entry) => entry.id === start.id ? { ...entry, snapshot: { ...entry.snapshot, issues: [issue] } } : entry);
  const first = build({ asset: retired, evidence: changed });
  assert.equal(first.periods[0].warnings[0].contextualOnly, true);
  assert.equal(build({ asset: retired, evidence: changed, input: { periods: [{ ...input.periods[0], acknowledgedWarnings: first.periods[0].warnings.map((warning) => warning.id) }] } }).planValidationComplete, true);
});

test('source references are never truncated and plan fingerprints bind proof, source, asset and assignment changes', () => {
  const { asset, build, input, start, evidence } = fixture();
  const changed = evidence.map((entry) => entry.id === start.id ? { ...entry, snapshot: { ...entry.snapshot, effective: { ...entry.snapshot.effective,
    fields: { ...entry.snapshot.effective.fields, outgoingTicket: 'X'.repeat(161) } } } } : entry);
  const result = build({ evidence: changed }); assert.ok(codes(result).includes('SOURCE_REFERENCE_TOO_LONG')); assert.equal(result.periods[0].proposedAssignment.ticketReference, null);
  const usageReturn = evidence.map((entry) => entry.kind === 'RECEIPT_OBSERVATION' ? { ...entry, kind: 'USAGE_OBSERVATION', snapshot: { ...entry.snapshot,
    kind: 'USAGE_OBSERVATION', effective: { ...entry.snapshot.effective, fields: { ...entry.snapshot.effective.fields, outgoingTicket: 'NEXT-DISPATCH-TK', outgoingOt: 'NEXT-DISPATCH-OT' } } } } : entry);
  const returnPlan = build({ evidence: usageReturn });
  assert.equal(returnPlan.planValidationComplete, true);
  assert.equal(returnPlan.periods[0].proposedAssignment.returnTicketReference, null);
  assert.equal(returnPlan.periods[0].proposedAssignment.returnOtReference, null);
  assert.equal(returnPlan.periods[0].sources[1].fields.outgoingTicket, 'NEXT-DISPATCH-TK');
  const baseline = build().planId;
  assert.notEqual(build({ asset: { ...asset, updatedAt: new Date('2026-10-04') } }).planId, baseline);
  assert.notEqual(build({ input: { periods: [{ ...input.periods[0], evidenceReference: 'Other proof' }] } }).planId, baseline);
  assert.notEqual(result.planId, baseline);
});
