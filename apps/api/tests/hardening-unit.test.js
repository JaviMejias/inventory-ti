import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAttemptLimiter } from '../src/auth/rate-limit.js';
import { parseEnvironment } from '../src/config/env.js';
import { isFixtureIdentity } from '../src/lib/test-user-quarantine.js';
import { assertTestDatabase } from './test-database.js';

test('integration safety rejects development databases even with NODE_ENV=test', () => {
  assert.throws(() => assertTestDatabase({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/inventory_ti', INVENTORY_TEST_DATABASE: 'inventory_ti' }));
  const name = `inventory_ti_test_${'a'.repeat(32)}`;
  assert.throws(() => assertTestDatabase({ NODE_ENV: 'test', DATABASE_URL: `postgresql://localhost/${name}` }));
  assert.throws(() => assertTestDatabase({ NODE_ENV: 'development', DATABASE_URL: `postgresql://localhost/${name}`, INVENTORY_TEST_DATABASE: name }));
  assert.doesNotThrow(() => assertTestDatabase({ NODE_ENV: 'test', DATABASE_URL: `postgresql://localhost/${name}`, INVENTORY_TEST_DATABASE: name }));
});

test('rate limiter reserves parallel attempts and completes them only once', () => {
  const begin = createAttemptLimiter(2, 100, 'Too many attempts', () => 0);
  const first = begin('source');
  const second = begin('source');
  assert.throws(() => begin('source'), { statusCode: 429 });
  first('failure');
  first('success');
  second('cancel');
  const final = begin('source');
  final('failure');
  assert.throws(() => begin('source'), { statusCode: 429 });
});

test('success resets failures without releasing other in-flight reservations', () => {
  const begin = createAttemptLimiter(2, 100, 'Too many attempts', () => 0);
  begin('source')('failure');
  const pending = begin('source');
  pending('success');
  const first = begin('source');
  const second = begin('source');
  first('success');
  const third = begin('source');
  assert.throws(() => begin('source'), { statusCode: 429 });
  second('failure');
  third('failure');
  assert.throws(() => begin('source'), { statusCode: 429 });
});

test('expired attempts cannot change a new rate-limit window', () => {
  let now = 0;
  const begin = createAttemptLimiter(1, 100, 'Too many attempts', () => now);
  const old = begin('source');
  now = 101;
  begin('source')('failure');
  old('success');
  assert.throws(() => begin('source'), { statusCode: 429 });
  now = 202;
  assert.doesNotThrow(() => begin('source')('cancel'));
});

test('proxy configuration accepts specific trusted networks and rejects blanket trust', () => {
  assert.deepEqual(parseEnvironment({ TRUST_PROXY: 'loopback,10.0.0.0/8,::1/128' }).TRUST_PROXY, ['loopback', '10.0.0.0/8', '::1/128']);
  assert.equal(parseEnvironment({ TRUST_PROXY: 'false' }).TRUST_PROXY, false);
  for (const value of ['true', '*', '', '0.0.0.0/0', '::/0', '10.0.0.1/33', '::1/129', 'localhost', 'loopback,', '127.0.0.1/-1']) {
    assert.throws(() => parseEnvironment({ TRUST_PROXY: value }));
  }
});

test('fixture detection requires exact username, email, display name and role', () => {
  const fixture = { username: 'correction-jefe-2-abcdef12', email: 'correction-jefe-2-abcdef12@example.com', displayName: 'Second correction jefe', role: 'JEFE' };
  assert.equal(isFixtureIdentity(fixture), true);
  for (const change of [{ username: 'correction-jefe' }, { email: 'real@example.com' }, { displayName: 'Actual administrator' }, { role: 'SOPORTE' }]) {
    assert.equal(isFixtureIdentity({ ...fixture, ...change }), false);
  }
});
