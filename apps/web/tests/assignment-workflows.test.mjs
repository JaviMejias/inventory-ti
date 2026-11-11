import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';

function moduleUrl(path, imports = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
}
const dateUrl = moduleUrl('../src/lib/date-range.ts');
const { emptyAssignmentForm, validateAssignment, assignmentPayload, assignmentReturnPayload, assignmentRecipient, canSetAssignmentDate } = await import(moduleUrl('../src/features/home/assignment-model.ts', { '../../lib/date-range': dateUrl }));
const form = { ...emptyAssignmentForm(), personName: ' Daniela González ' };
const now = new Date('2026-10-05T18:00:00.000Z');
const options = { v2: true, role: 'JEFE', now };
const returning = { id: 'assignment', personName: 'Daniela González', startedAt: '2026-10-01T12:00:00.000Z', endedAt: null };

test('legacy clients omit every V2 field and keep the body-less return', () => {
  const draft = { ...form, recipientType: 'OFFICE', officeName: 'Pucón', assignmentType: 'LOAN', effectiveDate: '2026-10-01', effectiveTime: '09:00', ticketReference: 'ticket' };
  assert.deepEqual(assignmentPayload(draft, false, 'JEFE'), { personName: 'Daniela González' });
  assert.equal(assignmentReturnPayload(draft, false, 'JEFE'), undefined);
});

test('recipient payloads are exclusive and office names need not be person names', () => {
  const office = { ...form, recipientType: 'OFFICE', officeName: ' Pucón ' };
  assert.deepEqual(validateAssignment(office, options), {});
  assert.deepEqual(assignmentPayload(office, true, 'JEFE'), { recipientType: 'OFFICE', officeName: 'Pucón', assignmentType: 'STANDARD' });
  assert.equal('officeName' in assignmentPayload(form, true, 'JEFE'), false);
  assert.ok(validateAssignment({ ...office, officeName: ' ' }, options).officeName);
  assert.ok(validateAssignment({ ...office, officeName: 'x'.repeat(161) }, options).officeName);
});

test('person names follow the existing API name-and-surname contract', () => {
  for (const personName of ['', 'Ana', ' Ana ', 'x'.repeat(151) + ' Pérez']) assert.ok(validateAssignment({ ...form, personName }, options).personName);
  assert.deepEqual(validateAssignment({ ...form, personName: ' Ana Pérez ' }, options), {});
});

test('references are trimmed and empty values omitted', () => {
  const payload = assignmentPayload({ ...form, ticketReference: ' TK-1 ', otReference: ' ', notes: ' Nota ' }, true);
  assert.equal(payload.ticketReference, 'TK-1');
  assert.equal(payload.notes, 'Nota');
  assert.equal('otReference' in payload, false);
  for (const key of ['ticketReference', 'otReference']) assert.ok(validateAssignment({ ...form, [key]: 'x'.repeat(161) }, options)[key]);
  assert.ok(validateAssignment({ ...form, notes: 'x'.repeat(10001) }, options).notes);
});

test('manual effective dates are role-restricted in both validation and serialization', () => {
  const draft = { ...form, effectiveDate: '2026-10-01', effectiveTime: '09:00' };
  for (const role of ['JEFE', 'COORDINADOR']) {
    assert.equal(canSetAssignmentDate(role), true);
    assert.deepEqual(validateAssignment(draft, { ...options, role }), {});
    assert.equal(assignmentPayload(draft, true, role).effectiveAt, '2026-10-01T12:00:00.000Z');
  }
  for (const role of ['SOPORTE', undefined]) {
    assert.equal(canSetAssignmentDate(role), false);
    assert.ok(validateAssignment(draft, { ...options, role }).effectiveDate);
    assert.equal('effectiveAt' in assignmentPayload(draft, true, role), false);
    assert.equal('effectiveAt' in assignmentReturnPayload(draft, true, role), false);
  }
  assert.equal('effectiveAt' in assignmentPayload(form, true, 'JEFE'), false);
});

test('effective date-time pairs reject future and invalid Chile civil times', () => {
  assert.ok(validateAssignment({ ...form, effectiveDate: '2026-10-01' }, options).effectiveTime);
  assert.ok(validateAssignment({ ...form, effectiveTime: '09:30' }, options).effectiveDate);
  for (const [effectiveDate, effectiveTime] of [['2026-10-06', '09:30'], ['2026-02-30', '09:30'], ['2026-09-06', '00:30'], ['2026-04-04', '23:30']]) assert.ok(validateAssignment({ ...form, effectiveDate, effectiveTime }, options).effectiveDate);
});

test('a loan can have a future expected date even for support, or no date at all', () => {
  const draft = { ...form, assignmentType: 'LOAN', expectedDate: '2027-01-15', expectedTime: '18:00' };
  assert.deepEqual(validateAssignment(draft, { ...options, role: 'SOPORTE' }), {});
  assert.equal(assignmentPayload(draft, true, 'SOPORTE').expectedReturnAt, '2027-01-15T21:00:00.000Z');
  assert.deepEqual(validateAssignment({ ...form, assignmentType: 'LOAN' }, options), {});
  assert.equal('expectedReturnAt' in assignmentPayload({ ...draft, assignmentType: 'STANDARD' }, true), false);
});

test('expected returns require a complete time and must follow the effective delivery', () => {
  const draft = { ...form, assignmentType: 'LOAN', effectiveDate: '2026-10-01', effectiveTime: '09:00', expectedDate: '2026-10-01', expectedTime: '09:00' };
  assert.ok(validateAssignment(draft, options).expectedDate);
  assert.ok(validateAssignment({ ...draft, expectedTime: '' }, options).expectedTime);
  assert.deepEqual(validateAssignment({ ...draft, expectedTime: '09:01' }, options), {});
  assert.ok(validateAssignment({ ...draft, effectiveDate: '', effectiveTime: '' }, options).expectedDate);
});

test('return payloads preserve their own notes and allow only the three return statuses', () => {
  for (const returnStatus of ['AVAILABLE', 'UNDER_REVIEW', 'IN_REPAIR']) {
    const draft = { ...emptyAssignmentForm(), returnStatus, ticketReference: ' Entrada ', notes: 'Revisar' };
    assert.deepEqual(validateAssignment(draft, { ...options, returning }), {});
    assert.deepEqual(assignmentReturnPayload(draft, true, 'JEFE'), { returnStatus, ticketReference: 'Entrada', notes: 'Revisar' });
  }
  for (const returnStatus of ['ASSIGNED', 'DECOMMISSIONED', 'RESERVED', 'LOST', 'IN_WARRANTY']) assert.ok(validateAssignment({ ...form, returnStatus }, { ...options, returning }).returnStatus);
});

test('manual return must be strictly after delivery; omitted effective dates stay server-owned', () => {
  const draft = { ...emptyAssignmentForm(), effectiveDate: '2026-10-01', effectiveTime: '09:00' };
  assert.ok(validateAssignment(draft, { ...options, returning }).effectiveDate);
  assert.deepEqual(validateAssignment({ ...draft, effectiveTime: '09:01' }, { ...options, returning }), {});
  assert.deepEqual(assignmentReturnPayload(emptyAssignmentForm(), true, 'JEFE'), { returnStatus: 'AVAILABLE' });
});

test('office and old nullable recipients render without inventing people', () => {
  assert.equal(assignmentRecipient({ ...returning, recipientType: 'OFFICE', officeName: 'Pucón', personName: null }), 'Pucón');
  assert.equal(assignmentRecipient({ ...returning, personName: null }), 'Destinatario no registrado');
});
