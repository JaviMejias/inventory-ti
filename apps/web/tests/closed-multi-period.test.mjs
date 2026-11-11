import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';
import { assetId } from './fixtures/import-pilot.mjs';
import { closedAssignmentFixture } from './fixtures/closed-assignment.mjs';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const errorUrl = moduleUrl('../src/lib/api.ts', { '../config/environment': 'data:text/javascript,export const environment={apiUrl:"https://fixture.invalid"};' });
const historyModelUrl = moduleUrl('../src/features/imports/history-evidence-model.ts');
const historyApiUrl = moduleUrl('../src/features/imports/history-evidence-api.ts', {
  '../../lib/api': errorUrl, './import-review-api': 'data:text/javascript,export const importReviewPath="/inventory/imports/batches";', './history-evidence-model': historyModelUrl
});
const modelUrl = moduleUrl('../src/features/imports/closed-assignment-model.ts');
const { closedPlanInput, emptyClosedPeriod, validateClosedPeriods } = await import(modelUrl);
const { validateClosedPlan, readClosedAssignmentPlan } = await import(moduleUrl('../src/features/imports/closed-assignment-api.ts', {
  '../../lib/api': errorUrl, './history-evidence-api': historyApiUrl, './history-evidence-model': historyModelUrl, './closed-assignment-model': modelUrl
}));

const uuid = (index) => 'abcdef00-abcd-4abc-8abc-' + index.toString(16).padStart(12, '0');
const hash = (index) => index.toString(16).padStart(64, '0');
function draftsFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    ...emptyClosedPeriod(uuid(index * 3 + 1)), startId: uuid(index * 3 + 2), endId: uuid(index * 3 + 3),
    startAt: new Date(Date.UTC(2020, 0, index * 3 + 1, 23, 30)).toISOString().replace('.000Z', '-03:00'),
    endAt: new Date(Date.UTC(2020, 0, index * 3 + 2, 18)).toISOString().replace('.000Z', '-03:00'),
    startProof: ' Acta de entrega ' + index + ' ', endProof: ' Acta de retorno ' + index + ' ',
    recipientType: index % 2 ? 'OFFICE' : 'PERSON', recipientName: index % 2 ? ' Oficina ' + index + ' ' : ' Persona Prueba ' + index + ' ',
    assignmentType: index % 2 ? 'LOAN' : 'STANDARD', returnStatus: index % 2 ? 'AVAILABLE' : 'UNDER_REVIEW',
    note: ' Verificación del periodo ' + index + ' ', reference: ' Respaldo ' + index + ' ', confirmed: true,
    acknowledgedWarnings: [hash(index * 2 + 102), hash(index * 2 + 101)]
  }));
}

// Build contract-shaped responses only; chronology and eligibility remain backend rules.
function planFor(input, blockedIndices = []) {
  const single = closedAssignmentFixture();
  const base = single.planFor(closedPlanInput(single.draftFor()));
  const template = base.periods[0];
  const periods = input.periods.map((period, index) => ({
    ...globalThis.structuredClone(period), acknowledgedWarnings: [...period.acknowledgedWarnings].sort(),
    sources: ['start', 'end'].map((endpoint, side) => ({
      ...globalThis.structuredClone(template.sources[side]), endpoint, evidenceId: period[endpoint].evidenceId,
      captureId: uuid(index + 1000), recordId: hash(index * 2 + side + 2000),
      effectiveDay: period[endpoint].confirmedAt?.slice(0, 10) ?? null,
      datePrecision: period[endpoint].confirmedAt ? 'DAY' : 'UNKNOWN'
    })),
    proposedAssignment: {
      ...template.proposedAssignment, recipientType: period.recipient?.type ?? null,
      personName: period.recipient?.type === 'PERSON' ? period.recipient.name : null,
      officeName: period.recipient?.type === 'OFFICE' ? period.recipient.name : null,
      assignmentType: period.assignmentType, returnStatus: period.returnStatus,
      startedAt: period.start.confirmedAt ? new Date(period.start.confirmedAt).toISOString() : null,
      endedAt: period.end.confirmedAt ? new Date(period.end.confirmedAt).toISOString() : null
    },
    warnings: ['start', 'end'].map((endpoint, side) => ({
      ...globalThis.structuredClone(single.warning), id: hash(index * 2 + side + 101), evidenceId: period[endpoint].evidenceId
    })),
    blockers: blockedIndices.includes(index) ? [{ code: 'EXACT_DATE_REQUIRED', endpoint: 'start' }, { code: 'CONFIRMED_RECIPIENT_REQUIRED' }] : [],
    valid: !blockedIndices.includes(index)
  }));
  return {
    ...base, periods, planValidationComplete: blockedIndices.length === 0,
    summary: { periodCount: periods.length, validCount: periods.length - blockedIndices.length, blockingCount: blockedIndices.length * 2, warningCount: periods.length * 2 }
  };
}

test('closed plan input accepts 1 through 25 periods and retains the single-draft calling contract', () => {
  for (let count = 1; count <= 25; count++) {
    const drafts = draftsFor(count);
    assert.deepEqual(validateClosedPeriods(drafts), {}, String(count));
    const input = closedPlanInput(drafts);
    assert.equal(input.periods.length, count);
    assert.deepEqual(input.periods.map((period) => period.periodId), drafts.map((draft) => draft.periodId));
  }
  const [draft] = draftsFor(1);
  assert.deepEqual(closedPlanInput(draft), closedPlanInput([draft]));
  assert.throws(() => closedPlanInput([]), /Invalid closed period draft/);
  assert.throws(() => closedPlanInput(draftsFor(26)), /Invalid closed period draft/);
});

test('validation retains errors from different periods, including the 25th, instead of inspecting only the first', () => {
  const drafts = draftsFor(25);
  drafts[0].confirmed = false; drafts[12].reference = ''; drafts[24].assignmentType = '';
  const errors = validateClosedPeriods(drafts);
  assert.deepEqual(Object.keys(errors), [drafts[0].periodId, drafts[12].periodId, drafts[24].periodId]);
  assert.ok(errors[drafts[0].periodId].confirmed);
  assert.ok(errors[drafts[12].periodId].reference);
  assert.ok(errors[drafts[24].periodId].assignmentType);
  assert.throws(() => closedPlanInput(drafts), /Invalid closed period draft/);
});

test('period identifiers must be valid UUIDs and unique regardless of letter case', () => {
  for (const duplicate of [uuid(1), uuid(1).toUpperCase()]) {
    const drafts = draftsFor(2); drafts[1].periodId = duplicate;
    assert.ok(validateClosedPeriods(drafts)[duplicate].periodId);
    assert.throws(() => closedPlanInput(drafts), /Invalid closed period draft/);
  }
  const drafts = draftsFor(2); drafts[1].periodId = 'not-a-period-uuid';
  assert.ok(validateClosedPeriods(drafts)[drafts[1].periodId].periodId);
});

test('global evidence ownership rejects every start/end reuse combination and marks both affected endpoints', () => {
  for (const first of ['startId', 'endId']) for (const second of ['startId', 'endId']) {
    for (const mixedCase of [false, true]) {
      const drafts = draftsFor(25);
      drafts[24][second] = mixedCase ? drafts[0][first].toUpperCase() : drafts[0][first];
      const errors = validateClosedPeriods(drafts);
      assert.ok(errors[drafts[0].periodId][first], first + '/' + second);
      assert.ok(errors[drafts[24].periodId][second], first + '/' + second);
      assert.equal(errors[drafts[12].periodId], undefined);
      assert.throws(() => closedPlanInput(drafts), /Invalid closed period draft/);
    }
  }
});

test('a period cannot reuse its own evidence with another case, and invalid endpoint UUIDs stay period-local', () => {
  const drafts = draftsFor(2); drafts[1].endId = drafts[1].startId.toUpperCase();
  const errors = validateClosedPeriods(drafts);
  assert.ok(errors[drafts[1].periodId].startId); assert.ok(errors[drafts[1].periodId].endId);
  assert.equal(errors[drafts[0].periodId], undefined);
  for (const field of ['startId', 'endId']) {
    const invalid = draftsFor(2); invalid[1][field] = 'not-an-evidence-uuid';
    assert.ok(validateClosedPeriods(invalid)[invalid[1].periodId][field]);
    assert.throws(() => closedPlanInput(invalid), /Invalid closed period draft/);
  }
});

test('acknowledgements are bounded, exact lowercase hashes and unique within each period', () => {
  const drafts = draftsFor(2);
  drafts[1].acknowledgedWarnings = Array.from({ length: 1000 }, (_, index) => hash(index + 1));
  assert.deepEqual(validateClosedPeriods(drafts), {});
  assert.equal(closedPlanInput(drafts).periods[1].acknowledgedWarnings.length, 1000);
  for (const warnings of [[hash(1), hash(1)], ['a'.repeat(64).toUpperCase()], ['a'.repeat(63)], ['g'.repeat(64)], [...drafts[1].acknowledgedWarnings, hash(1001)]]) {
    const invalid = draftsFor(2); invalid[1].acknowledgedWarnings = warnings;
    const errors = validateClosedPeriods(invalid);
    assert.ok(errors[invalid[1].periodId].acknowledgedWarnings);
    assert.equal(errors[invalid[0].periodId], undefined);
    assert.throws(() => closedPlanInput(invalid), /Invalid closed period draft/);
  }
});

test('warning lists are serialized independently per period without a global union or deduplication', () => {
  const drafts = draftsFor(3);
  drafts[0].acknowledgedWarnings = [hash(2), hash(1)]; drafts[1].acknowledgedWarnings = [hash(1)]; drafts[2].acknowledgedWarnings = [];
  assert.deepEqual(validateClosedPeriods(drafts), {});
  assert.deepEqual(closedPlanInput(drafts).periods.map((period) => period.acknowledgedWarnings), [[hash(2), hash(1)], [hash(1)], []]);
});

test('multiple periods preserve explicit unknowns, local days and offsets without adding historical facts', () => {
  const drafts = draftsFor(3);
  drafts[0].periodId = drafts[0].periodId.toUpperCase(); drafts[0].startId = drafts[0].startId.toUpperCase(); drafts[0].endId = drafts[0].endId.toUpperCase();
  Object.assign(drafts[1], { startAt: ' ', endAt: '', startProof: '', endProof: ' ', recipientType: '', recipientName: '', returnStatus: '' });
  drafts[2].startAt = ' 2021-06-15T23:45:00.123+05:30 ';
  const input = closedPlanInput(drafts);
  assert.deepEqual(Object.keys(input), ['periods']);
  assert.equal(input.periods[0].periodId, drafts[0].periodId.toLowerCase());
  assert.equal(input.periods[0].start.evidenceId, drafts[0].startId.toLowerCase());
  assert.equal(input.periods[0].end.evidenceId, drafts[0].endId.toLowerCase());
  assert.equal(input.periods[0].start.confirmedAt, drafts[0].startAt);
  assert.notEqual(new Date(input.periods[0].start.confirmedAt).toISOString().slice(0, 10), drafts[0].startAt.slice(0, 10));
  assert.equal(input.periods[2].start.confirmedAt, '2021-06-15T23:45:00.123+05:30');
  assert.deepEqual(input.periods[1].start, { evidenceId: drafts[1].startId, confirmedAt: null, dateEvidenceReference: null });
  assert.deepEqual(input.periods[1].end, { evidenceId: drafts[1].endId, confirmedAt: null, dateEvidenceReference: null });
  assert.equal(input.periods[1].recipient, null); assert.equal(input.periods[1].returnStatus, null);
  assert.deepEqual(input.periods.map((period) => period.note), drafts.map((draft) => draft.note.trim()));
  assert.deepEqual(input.periods.map((period) => period.evidenceReference), drafts.map((draft) => draft.reference.trim()));
  assert.deepEqual(input.periods[0].recipient, { type: 'PERSON', name: 'Persona Prueba 0' });
});

test('captured multi-period input and draft edits cannot mutate each other or share warning arrays', () => {
  const drafts = draftsFor(3); const original = globalThis.structuredClone(drafts);
  const input = closedPlanInput(drafts); const captured = globalThis.structuredClone(input);
  assert.deepEqual(drafts, original);
  drafts[0].startId = uuid(9000); drafts[1].recipientName = 'Otra oficina'; drafts[2].acknowledgedWarnings.push(hash(9000)); drafts.reverse();
  assert.deepEqual(input, captured);
  input.periods[0].start.confirmedAt = null; input.periods[1].recipient.name = 'Edición del payload'; input.periods[2].acknowledgedWarnings.push(hash(9001));
  assert.equal(drafts[1].recipientName, 'Otra oficina');
  assert.equal(drafts[2].startAt, original[0].startAt);
  assert.equal(drafts[0].acknowledgedWarnings.includes(hash(9001)), false);
  assert.equal(input.periods[0].acknowledgedWarnings.includes(hash(9001)), false);
});

test('plan validator accepts all 25 periods in server order while matching their identities and period-specific acknowledgements', () => {
  const input = closedPlanInput(draftsFor(25)); const before = globalThis.structuredClone(input);
  const response = planFor(input); response.periods.reverse();
  const result = validateClosedPlan(response, input, assetId);
  assert.equal(result.periods.length, 25); assert.equal(result.planValidationComplete, true);
  assert.deepEqual(result.summary, { periodCount: 25, validCount: 25, blockingCount: 0, warningCount: 50 });
  for (const period of result.periods) {
    const expected = input.periods.find((entry) => entry.periodId === period.periodId);
    assert.deepEqual(period.acknowledgedWarnings, [...expected.acknowledgedWarnings].sort());
    assert.equal(period.sources.find((source) => source.endpoint === 'start').evidenceId, expected.start.evidenceId);
    assert.equal(period.proposedAssignment.startedAt, new Date(expected.start.confirmedAt).toISOString());
  }
  assert.deepEqual(input, before);
});

test('one blocked final period keeps the whole plan incomplete with accurate aggregate counts and explicit nulls', () => {
  const drafts = draftsFor(25);
  Object.assign(drafts[24], { startAt: '', startProof: '', recipientType: '', recipientName: '', returnStatus: '' });
  const input = closedPlanInput(drafts); const response = planFor(input, [24]);
  const result = validateClosedPlan(response, input, assetId);
  assert.equal(result.periods[0].valid, true); assert.equal(result.periods[24].valid, false);
  assert.equal(result.planValidationComplete, false);
  assert.deepEqual(result.summary, { periodCount: 25, validCount: 24, blockingCount: 2, warningCount: 50 });
  assert.equal(result.periods[24].proposedAssignment.startedAt, null);
  assert.equal(result.periods[24].proposedAssignment.recipientType, null);
  assert.equal(result.periods[24].proposedAssignment.returnStatus, null);
  assert.equal(result.canApply, false); assert.equal(result.persisted, false); assert.equal(result.affectsCurrentState, false);
});

test('plan validator rejects dropped, extra, duplicate or foreign periods even when the first period is intact', () => {
  const input = closedPlanInput(draftsFor(25));
  for (const mutate of [
    (response) => response.periods.pop(),
    (response) => response.periods.splice(12, 1),
    (response) => response.periods.push(globalThis.structuredClone(response.periods[0])),
    (response) => { response.periods[24] = globalThis.structuredClone(response.periods[0]); },
    (response) => { response.periods[24].periodId = uuid(9999); }
  ]) {
    const response = planFor(input); mutate(response);
    assert.throws(() => validateClosedPlan(response, input, assetId), { code: 'INVALID_RESPONSE' });
  }
});

test('plan validator checks intent, endpoints, proposed actors and acknowledgements in first, middle and last periods', () => {
  const input = closedPlanInput(draftsFor(25));
  for (const index of [0, 12, 24]) for (const mutate of [
    (period) => { period.note = 'Motivo de otro periodo'; },
    (period) => { period.recipient.name = 'Otro destinatario'; },
    (period) => { period.sources[1].evidenceId = input.periods[(index + 1) % 25].end.evidenceId; },
    (period) => { period.proposedAssignment.returnedById = uuid(9000); },
    (period) => { period.proposedAssignment.startedAt = null; },
    (period) => { period.acknowledgedWarnings = [...input.periods[(index + 1) % 25].acknowledgedWarnings].sort(); },
    (period) => { period.warnings[0].evidenceId = input.periods[(index + 1) % 25].start.evidenceId; }
  ]) {
    const response = planFor(input); mutate(response.periods[index]);
    assert.throws(() => validateClosedPlan(response, input, assetId), { code: 'INVALID_RESPONSE' }, 'period ' + index);
  }
});

test('completion and all summary counters describe the full set rather than the selected or first period', () => {
  const input = closedPlanInput(draftsFor(25));
  for (const [field, incorrect] of [['periodCount', 1], ['validCount', 1], ['blockingCount', 1], ['warningCount', 2]]) {
    const response = planFor(input); response.summary[field] = incorrect;
    assert.throws(() => validateClosedPlan(response, input, assetId), { code: 'INVALID_RESPONSE' }, field);
  }
  const blocked = planFor(input, [24]); blocked.planValidationComplete = true;
  assert.throws(() => validateClosedPlan(blocked, input, assetId), { code: 'INVALID_RESPONSE' });
  const complete = planFor(input); complete.periods[24].valid = false;
  assert.throws(() => validateClosedPlan(complete, input, assetId), { code: 'INVALID_RESPONSE' });
});

test('the read-only planner sends the complete 25-period body with independent warning lists and receives every period', async () => {
  const input = closedPlanInput(draftsFor(25)); const response = planFor(input);
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); options.signal.throwIfAborted();
    return new globalThis.Response(JSON.stringify(url.endsWith('/auth/csrf') ? { csrfToken: 'multi-period-csrf' } : response));
  };
  try {
    const result = await readClosedAssignmentPlan(assetId, input, new globalThis.AbortController().signal);
    assert.equal(result.periods.length, 25); assert.equal(result.persisted, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://fixture.invalid/assets/' + assetId + '/imported-assignment-plan');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(new globalThis.Headers(calls[1].options.headers).get('X-CSRF-Token'), 'multi-period-csrf');
    assert.deepEqual(JSON.parse(calls[1].options.body), input);
  } finally { globalThis.fetch = originalFetch; }
});
