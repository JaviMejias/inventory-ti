import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { assignmentCreateSchema, assignmentReturnSchema } from '../src/routes/assignments-schemas.js';

test('assignment destinations preserve legacy requests and reject mixed recipients', () => {
  const legacy = assignmentCreateSchema.parse({ personName: 'Daniela González' });
  assert.equal(legacy.recipientType, 'PERSON');
  assert.equal(legacy.assignmentType, 'STANDARD');
  assert.equal(assignmentCreateSchema.safeParse({ personId: randomUUID() }).success, true);
  const office = assignmentCreateSchema.parse({ recipientType: 'OFFICE', officeName: '  Pucon  ', ticketReference: ' ' });
  assert.equal(office.officeName, 'Pucon');
  assert.equal(office.ticketReference, null);
  for (const input of [
    {}, { recipientType: 'OFFICE' }, { recipientType: 'OFFICE', officeName: '' },
    { recipientType: 'OFFICE', officeName: 'CE', personName: 'Daniela González' },
    { recipientType: 'OFFICE', officeName: 'CE', personId: randomUUID() },
    { personName: 'Daniela González', officeName: 'CE' }, { personName: 'Daniela González', unknown: 'ignored?' }
  ]) assert.equal(assignmentCreateSchema.safeParse(input).success, false);
});

test('assignment destinations require explicit zoned timestamps and bound references', () => {
  const loan = assignmentCreateSchema.parse({ recipientType: 'OFFICE', officeName: 'CE', assignmentType: 'LOAN', effectiveAt: '2026-01-01T10:00:00-03:00', expectedReturnAt: '2026-02-01T13:00:00Z' });
  assert.equal(loan.effectiveAt.toISOString(), '2026-01-01T13:00:00.000Z');
  for (const input of [
    { expectedReturnAt: '2026-02-01T13:00:00Z' }, { effectiveAt: '2026-01-01' },
    { effectiveAt: '2026-01-01T10:00:00' }, { effectiveAt: 123 }, { effectiveAt: true },
    { ticketReference: 'x'.repeat(161) }, { notes: 'x'.repeat(10_001) }
  ]) assert.equal(assignmentCreateSchema.safeParse({ personName: 'Daniela González', ...input }).success, false);
});

test('assignment returns preserve bodyless defaults and restrict destination states', () => {
  assert.deepEqual(assignmentReturnSchema.parse({}), { returnStatus: 'AVAILABLE' });
  for (const returnStatus of ['AVAILABLE', 'UNDER_REVIEW', 'IN_REPAIR']) assert.equal(assignmentReturnSchema.safeParse({ returnStatus }).success, true);
  for (const input of [{ returnStatus: 'ASSIGNED' }, { returnStatus: 'DECOMMISSIONED' }, { returnStatus: 'LOST' }, { officeName: 'Other office' }]) assert.equal(assignmentReturnSchema.safeParse(input).success, false);
});
