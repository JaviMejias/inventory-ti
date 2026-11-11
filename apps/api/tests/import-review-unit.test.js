import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma } from '@prisma/client';

import { batchCreateSchema, batchListSchema, decisionListSchema, reviewDecisionSchema } from '../src/imports/review-schemas.js';
import { withReviewStorage } from '../src/imports/review-routes.js';
import { workbook } from './fixtures/workbook-preview.js';

const decision = () => ({ expectedVersion: 1, requestId: randomUUID(), targetType: 'CANDIDATE', targetId: 'a'.repeat(64), action: 'HOLD', note: 'Pending review' });

test('review DTO requires an explicit version, idempotency key and nonblank rationale', () => {
  assert.equal(reviewDecisionSchema.parse({ ...decision(), note: '  Rationale  ' }).note, 'Rationale');
  for (const invalid of [
    { ...decision(), expectedVersion: '1' }, { ...decision(), expectedVersion: 2147483647 },
    { ...decision(), requestId: 'not-uuid' }, { ...decision(), note: '  ' },
    { ...decision(), note: 'x'.repeat(2001) }, { ...decision(), force: true }
  ]) assert.equal(reviewDecisionSchema.safeParse(invalid).success, false);
});

test('stand-alone records cannot propose assets and links require exactly one UUID', () => {
  const base = decision();
  assert.equal(reviewDecisionSchema.safeParse({ ...base, action: 'LINK_EXISTING', linkedAssetId: randomUUID() }).success, true);
  for (const invalid of [
    { ...base, action: 'LINK_EXISTING' }, { ...base, linkedAssetId: randomUUID() },
    { ...base, action: 'PROPOSE_NEW', linkedAssetId: randomUUID() },
    { ...base, targetType: 'RECORD', action: 'PROPOSE_NEW' },
    { ...base, targetType: 'RECORD', action: 'LINK_EXISTING', linkedAssetId: randomUUID() }
  ]) assert.equal(reviewDecisionSchema.safeParse(invalid).success, false);
});

test('batch and pagination schemas reject client approval flags and unbounded queries', () => {
  const valid = { workbook: workbook(), previewId: 'a'.repeat(64) };
  assert.equal(batchCreateSchema.safeParse(valid).success, true);
  assert.equal(batchCreateSchema.safeParse({ ...valid, canApply: true }).success, false);
  assert.deepEqual(batchListSchema.parse({}), { limit: 25, offset: 0 });
  assert.deepEqual(decisionListSchema.parse({ mode: 'history', limit: '10' }), { mode: 'history', limit: 10, offset: 0 });
  assert.equal(batchListSchema.safeParse({ limit: '101' }).success, false);
  assert.equal(decisionListSchema.safeParse({ targetId: 'a'.repeat(64) }).success, false);
});

test('missing review storage is a safe deployment error, not a disguised operational failure', async () => {
  const error = new Prisma.PrismaClientKnownRequestError('PRIVATE DATABASE DETAILS', { code: 'P2021', clientVersion: '6.19.3', meta: { modelName: 'ImportBatch' } });
  await assert.rejects(withReviewStorage(async () => { throw error; }), (failure) => failure.statusCode === 503 && failure.code === 'IMPORT_REVIEW_NOT_READY' && !failure.message.includes('PRIVATE'));
  const unrelated = new Prisma.PrismaClientKnownRequestError('Asset missing', { code: 'P2021', clientVersion: '6.19.3', meta: { modelName: 'Asset' } });
  await assert.rejects(withReviewStorage(async () => { throw unrelated; }), (failure) => failure === unrelated);
});
