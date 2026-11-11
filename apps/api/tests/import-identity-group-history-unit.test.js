import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { validateGroupApplicationProof } from '../src/imports/identity-group-application-proof.js';
import { buildGroupHistoryPlan } from '../src/imports/identity-group-history-plan.js';
import { identityGroupHistoryParamsSchema, identityGroupHistoryPlanSchema } from '../src/imports/identity-group-history-schemas.js';
import { groupHistoryFixture } from './fixtures/group-history-plan.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function build(f, input = f.input) { return buildGroupHistoryPlan(f.application, f.item.id, f.asset, f.evidence, f.revisions, input, '2026-10-20'); }
function acknowledged(f) {
  const result = build(f); return { ...f.input, operations: f.input.operations.map((operation) => ({ ...operation,
    acknowledgedWarnings: result.operations.find((entry) => entry.evidenceId === operation.evidenceId).warnings.map((warning) => warning.id) })) };
}
const has = (result, code) => result.operations.some((operation) => operation.blockers.includes(code));

test('group history DTO selects exact evidence and receipt without client-supplied target, dates or authority', () => {
  const f = groupHistoryFixture(); assert.equal(identityGroupHistoryPlanSchema.safeParse(f.input).success, true);
  for (const change of [{ force: true }, { assetId: f.asset.id }, { expectedApplicationPlanId: 'bad' }, { operations: [] },
    { operations: [f.input.operations[0], f.input.operations[0]] }, { operations: Array(26).fill(f.input.operations[0]) },
    { operations: [{ ...f.input.operations[0], expectedEvidenceVersion: -1 }] }, { operations: [{ ...f.input.operations[0], expectedEvidenceVersion: 1001 }] },
    { operations: [{ ...f.input.operations[0], action: 'APPLY' }] }, { operations: [{ ...f.input.operations[0], confirmedAt: '2001-01-01' }] },
    { operations: [{ ...f.input.operations[0], acknowledgedWarnings: ['0'.repeat(64), '0'.repeat(64)] }] }]) assert.equal(identityGroupHistoryPlanSchema.safeParse({ ...f.input, ...change }).success, false);
  const params = { id: randomUUID(), reviewId: randomUUID(), applicationId: f.application.id, itemId: f.item.id };
  assert.deepEqual(identityGroupHistoryParamsSchema.parse(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value.toUpperCase()]))), params);
});

test('group history validates complete immutable receipt and global row ownership before proposing a link', () => {
  const f = groupHistoryFixture(); const proofs = validateGroupApplicationProof(f.application); assert.equal(proofs[0].source.length, 2);
  for (const corrupt of [
    (copy) => { copy.requestDigest = 'e'.repeat(64); }, (copy) => { copy.plan.sourceHash = 'e'.repeat(64); },
    (copy) => { copy.items[0].rows.pop(); }, (copy) => { copy.items[0].rows[0].itemId = randomUUID(); },
    (copy) => { copy.items[0].rows[0].sourceHash = 'e'.repeat(64); }, (copy) => { copy.items[0].result.id = randomUUID(); },
    (copy) => { copy.items[0].result.serialNumber = 'FORGED-RESULT'; },
    (copy) => { copy.items[0].decisionId = randomUUID(); }, (copy) => { copy.items[0].operation.source[0].row = 999; },
    (copy) => { copy.items[0].rows[0].originalCandidateId = 'e'.repeat(64); }
  ]) { const copy = clone(f.application); corrupt(copy); assert.throws(() => validateGroupApplicationProof(copy), (error) => error.code === 'INVALID_IDENTITY_GROUP_APPLICATION'); }
});

test('group history preserves captured null, current evidence and unknown actor while proposing explicit group identity projection', () => {
  const f = groupHistoryFixture(); const before = clone(f); const first = build(f);
  assert.equal(has(first, 'WARNINGS_NOT_ACKNOWLEDGED'), true);
  const result = build(f, acknowledged(f)); assert.equal(result.planValidationComplete, true);
  for (const key of ['persisted', 'canApply', 'affectsCurrentState', 'evidenceRelinked', 'historyLinkApplicationImplemented']) assert.equal(result[key], false);
  assert.equal(result.operations[0].capturedAssetId, null); assert.equal(result.operations[0].currentAssetId, null); assert.equal(result.operations[0].historicalActorId, null);
  assert.equal(result.operations[0].proposedAssetId, f.asset.id); assert.equal(result.operations[0].requiresIdentityProjection, true);
  assert.equal(result.operations[0].currentSnapshot.effective.serialKey, 'ORIGINAL-SERIAL'); assert.equal(result.operations[0].proposedIdentity.serialNumber, f.asset.serialNumber);
  assert.equal(result.summary.omittedEvidenceCount, 1); assert.deepEqual(clone(f), before);
});

test('group history fingerprints current context and is independent of selection and warning order', () => {
  const f = groupHistoryFixture(); f.input.operations = f.evidence.map((entry) => ({ ...f.input.operations[0], evidenceId: entry.id }));
  const input = acknowledged(f); const result = build(f, input);
  assert.equal(build(f, { ...input, operations: [...input.operations].reverse() }).historyLinkPlanId, result.historyLinkPlanId);
  f.asset.updatedAt = new Date('2026-10-20T11:00:00Z'); assert.notEqual(build(f, input).historyLinkPlanId, result.historyLinkPlanId);
  const now = build(f, input).historyLinkPlanId; f.input.operations[0].note = 'Different independent proof'; assert.notEqual(build(f).historyLinkPlanId, now);
});

test('group history accepts metadata-only group receipts with unchanged physical identity and current assigned state', () => {
  const f = groupHistoryFixture({ metadata: true }); assert.equal(f.item.operation.type, 'UPDATE_METADATA');
  f.asset.status = 'ASSIGNED'; const result = build(f, acknowledged(f)); assert.equal(result.planValidationComplete, true);
  assert.equal(result.asset.status, 'ASSIGNED'); assert.equal(result.operations[0].proposedAssetId, f.item.assetId); assert.equal(result.affectsCurrentState, false);
});

test('group history cannot use another group, receipt or source as evidence ownership', () => {
  const f = groupHistoryFixture({ split: true });
  assert.throws(() => buildGroupHistoryPlan(f.application, randomUUID(), f.asset, f.evidence, [], f.input), (error) => error.statusCode === 404);
  assert.throws(() => build(f, { ...f.input, expectedApplicationPlanId: 'e'.repeat(64) }), (error) => error.code === 'IDENTITY_GROUP_APPLICATION_CHANGED');
  assert.throws(() => build(f, { ...f.input, operations: [{ ...f.input.operations[0], evidenceId: randomUUID() }] }), (error) => error.statusCode === 404);
  const other = f.application.items.find((item) => item.id !== f.item.id); f.evidence[0].recordId = other.rows[0].recordId;
  assert.throws(() => build(f), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
});

test('group history requires current evidence version and preserves a latest explicit null amendment', () => {
  const f = groupHistoryFixture(); const evidence = f.evidence[0]; evidence.assetId = randomUUID(); evidence.snapshot.assetId = evidence.assetId;
  evidence.amendments = [{ id: randomUUID(), evidenceId: evidence.id, version: 1, assetId: null, effectiveDay: evidence.effectiveDay, snapshot: { ...clone(evidence.snapshot), assetId: null }, sourceRevision: 0, amendedAt: new Date('2026-10-20') }];
  assert.throws(() => build(f), (error) => error.code === 'EVIDENCE_VERSION_CONFLICT');
  f.input.operations[0].expectedEvidenceVersion = 1; const result = build(f, acknowledged(f)); assert.equal(result.planValidationComplete, true);
  assert.equal(result.operations[0].capturedAssetId, evidence.assetId); assert.equal(result.operations[0].currentAssetId, null); assert.equal(result.operations[0].amendmentId, evidence.amendments[0].id);
});

test('group history refuses already-applied evidence, incompatible rules, target swaps and implicit cross-asset transfer', () => {
  for (const [change, code] of [
    [(f) => { f.evidence[0].assignmentUse = { itemId: randomUUID(), endpoint: 'END' }; }, 'EVIDENCE_ALREADY_APPLIED'],
    [(f) => { f.evidence[0].retirementUse = { id: randomUUID(), assetId: f.asset.id }; }, 'EVIDENCE_ALREADY_APPLIED'],
    [(f) => { f.evidence[0].capture.rulesVersion = 'other'; }, 'EVIDENCE_RULES_CHANGED'],
    [(f) => { f.evidence[0].assetId = randomUUID(); }, 'EVIDENCE_LINKED_TO_ANOTHER_ASSET'],
    [(f) => { f.asset.serialNumber = 'ANOTHER-ASSET'; }, 'GROUP_ASSET_IDENTITY_CHANGED'],
    [(f) => { f.asset = null; }, 'GROUP_ASSET_NOT_FOUND'],
    [(f) => { f.asset.product.trackingMode = 'QUANTITY'; }, 'PRODUCT_NOT_ASSET']
  ]) { const f = groupHistoryFixture(); change(f); assert.equal(has(build(f), code), true, code); }
});

test('group history retains unknown dates without proposing operational dates, retirement or actor defaults', () => {
  const f = groupHistoryFixture(); const evidence = f.evidence[0]; evidence.effectiveDay = null; evidence.snapshot.effectiveDay = null;
  evidence.snapshot.datePrecision = 'UNKNOWN'; evidence.snapshot.dateUncertainty = 'DATE_NOT_REPORTED';
  f.asset.status = 'DECOMMISSIONED'; f.asset.isActive = false; const result = build(f, acknowledged(f));
  assert.equal(result.planValidationComplete, true); assert.equal(result.operations[0].effectiveDay, null); assert.equal(result.operations[0].datePrecision, 'UNKNOWN');
  assert.equal(result.operations[0].historicalActorId, null); assert.equal(result.operations[0].confirmedAt, undefined); assert.equal(result.affectsCurrentState, false);
});

test('group history source revisions invalidate only affected captured candidates without automatic refresh', () => {
  const f = groupHistoryFixture(); f.revisions = [{ batchId: f.evidence[0].capture.batchId, revision: 1, changes: [{ candidateId: f.evidence[0].candidateId }] }];
  assert.equal(has(build(f), 'EVIDENCE_SOURCE_REVISED'), true);
  f.revisions[0].changes[0].candidateId = 'e'.repeat(64); assert.equal(has(build(f), 'EVIDENCE_SOURCE_REVISED'), false);
  f.revisions[0].changes = []; assert.throws(() => build(f), (error) => error.code === 'INVALID_SOURCE_REVISION');
});

test('group history fails closed for malformed snapshots, moved original rows and amendment ownership corruption', () => {
  for (const change of [
    (f) => { f.evidence[0].snapshot = {}; },
    (f) => { f.evidence[0].snapshot.historicalActorId = randomUUID(); },
    (f) => { f.evidence[0].snapshot.original.row = 999; },
    (f) => { f.evidence[0].snapshot.effectiveDay = '2002-01-01'; },
    (f) => { f.evidence[0].capture.sourceHash = 'e'.repeat(64); },
    (f) => { f.evidence[0].amendments = [{ evidenceId: randomUUID(), version: 1 }]; }
  ]) { const f = groupHistoryFixture(); change(f); assert.throws(() => build(f), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE'); }
});

test('group history warning acknowledgement cannot waive blockers or manufacture extra approval', () => {
  const f = groupHistoryFixture(); f.evidence[0].assignmentUse = { itemId: randomUUID(), endpoint: 'END' };
  assert.equal(has(build(f, acknowledged(f)), 'EVIDENCE_ALREADY_APPLIED'), true);
  const input = acknowledged(f); input.operations[0].acknowledgedWarnings.push('e'.repeat(64)); assert.equal(has(build(f, input), 'UNKNOWN_WARNING_ACKNOWLEDGEMENT'), true);
});

test('group history rejects a no-op link but can plan missing identity projection without overwriting current evidence', () => {
  const f = groupHistoryFixture(); const evidence = f.evidence[0]; evidence.assetId = f.asset.id; evidence.snapshot.assetId = f.asset.id;
  assert.equal(build(f, acknowledged(f)).planValidationComplete, true);
  evidence.snapshot.effective.serialKey = f.asset.serialNumber;
  const result = build(f); assert.equal(has(result, 'NO_HISTORY_LINK_CHANGE'), true); assert.equal(result.operations[0].requiresIdentityProjection, false);
});

test('group history cannot replace original source cells through an otherwise valid latest evidence amendment', () => {
  const f = groupHistoryFixture(); const evidence = f.evidence[0]; const snapshot = clone(evidence.snapshot);
  snapshot.original.originalCells = { A: { type: 'text', value: 'Forged source cell' } };
  evidence.amendments = [{ id: randomUUID(), evidenceId: evidence.id, version: 1, assetId: null, effectiveDay: evidence.effectiveDay, snapshot, sourceRevision: 0, amendedAt: new Date('2026-10-20') }];
  f.input.operations[0].expectedEvidenceVersion = 1; assert.throws(() => build(f), (error) => error.code === 'INVALID_HISTORICAL_EVIDENCE');
});

test('group history bounds evidence and revision context and never returns a silently truncated valid plan', () => {
  const f = groupHistoryFixture(); f.evidence = Array(101).fill(f.evidence[0]); assert.throws(() => build(f), (error) => error.code === 'GROUP_HISTORY_PLAN_LIMIT');
  f.evidence = [f.evidence[0]]; f.revisions = Array(1001).fill({}); assert.throws(() => build(f), (error) => error.code === 'GROUP_HISTORY_PLAN_LIMIT');
});
