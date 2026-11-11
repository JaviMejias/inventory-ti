import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
  .replace("import { environment } from '../config/environment';", "const environment = { apiUrl: 'http://inventory.test' };");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { ApiRequestError, apiRequest, getApiErrorMessage, getApiFieldErrors, SESSION_EXPIRED_EVENT } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('domain errors provide Spanish recovery without displaying server messages', () => {
  for (const code of ['SELF_ACCESS_RESET', 'ASSET_IDENTIFIER_CONFLICT', 'ASSET_ALREADY_ASSIGNED', 'ASSIGNMENT_ALREADY_CLOSED', 'CORRECTION_ALREADY_EXISTS', 'CORRECTION_ALREADY_PROCESSED', 'CORRECTION_SELF_APPROVAL', 'CORRECTION_NO_CHANGE', 'CORRECTION_INVALID_QUANTITY', 'CORRECTION_STALE', 'STOCK_LIMIT_EXCEEDED', 'INVALID_CREDENTIALS', 'INVALID_CURRENT_PASSWORD', 'CSRF_INVALID']) {
    const message = getApiErrorMessage(new ApiRequestError('Internal database detail', 409, code), 'No se pudo guardar.');
    assert.notEqual(message, 'No se pudo guardar.');
    assert.doesNotMatch(message, /Internal database/);
  }
  assert.match(getApiErrorMessage(new ApiRequestError('Insufficient stock. Available: 6; requested: 10', 409, 'INSUFFICIENT_STOCK'), ''), /hay 6 unidades disponibles.*10/);
  assert.equal(getApiErrorMessage(new Error('Failed to fetch'), 'No se pudo cargar.'), 'No se pudo cargar.');
});

test('the last administrator conflict explains recovery without exposing server details', () => {
  const error = new ApiRequestError('At least one active JEFE with a configured password must remain', 409, 'LAST_ADMIN_REQUIRED');
  const message = getApiErrorMessage(error, 'No se pudo guardar.');
  assert.match(message, /al menos un Jefe activo.*contraseña configurada/);
  assert.match(message, /Activa otra cuenta de Jefe/);
  assert.doesNotMatch(message, /At least|JEFE/);
});

test('validation details map backend fields to form field errors', () => {
  const error = new ApiRequestError('Request validation failed', 400, 'VALIDATION_ERROR', [
    { path: ['email'], message: 'Invalid email' },
    { path: ['unknownField'], message: 'Unmapped issue' }
  ]);
  assert.deepEqual(getApiFieldErrors(error, { email: 'email', phone: 'phone' }), { email: 'Revisa este campo.' });
  assert.deepEqual(getApiFieldErrors(new ApiRequestError('Failure', 500, 'INTERNAL_ERROR'), { email: 'email' }), {});
});

function mockFetch(context, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  context.after(() => { globalThis.fetch = original; });
}

test('a network failure explains that the outcome could not be confirmed', async (context) => {
  mockFetch(context, async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(apiRequest('/assets', { method: 'POST' }), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.match(getApiErrorMessage(error, ''), /No se pudo confirmar la operación/);
    return true;
  });
});

test('server failures with an HTML response are localized safely', async (context) => {
  mockFetch(context, async () => new globalThis.Response('<html>Database unavailable</html>', { status: 503 }));
  await assert.rejects(apiRequest('/users'), (error) => {
    assert.equal(error.status, 503);
    assert.match(getApiErrorMessage(error, ''), /El servicio no pudo/);
    assert.doesNotMatch(getApiErrorMessage(error, ''), /Database/);
    return true;
  });
});

test('API validation details are preserved for inline field feedback', async (context) => {
  mockFetch(context, async () => new globalThis.Response(JSON.stringify({ code: 'VALIDATION_ERROR', message: 'Request validation failed', details: [{ path: ['phone'], message: 'Invalid phone' }] }), { status: 400 }));
  await assert.rejects(apiRequest('/users', { method: 'POST' }), (error) => {
    assert.deepEqual(error.details, [{ path: ['phone'], message: 'Invalid phone' }]);
    assert.deepEqual(getApiFieldErrors(error, { phone: 'phone' }), { phone: 'Revisa este campo.' });
    return true;
  });
});

test('invalid successful JSON is a visible unexpected-response failure', async (context) => {
  mockFetch(context, async () => new globalThis.Response('not json', { status: 200 }));
  await assert.rejects(apiRequest('/products'), (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.match(getApiErrorMessage(error, ''), /respuesta inesperada/);
    return true;
  });
});

test('an empty successful response is accepted', async (context) => {
  mockFetch(context, async () => new globalThis.Response(null, { status: 204 }));
  assert.equal(await apiRequest('/auth/logout', { method: 'POST' }), undefined);
});

test('session expiry is dispatched without treating an incorrect password as logout', async (context) => {
  const events = [];
  const original = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (event) => { events.push(event.type); return true; };
  context.after(() => { globalThis.dispatchEvent = original; });
  let code;
  mockFetch(context, async () => new globalThis.Response(JSON.stringify({ code, message: 'Authentication required' }), { status: 401 }));
  for (code of ['INVALID_CURRENT_PASSWORD', 'INVALID_CREDENTIALS', 'UNAUTHENTICATED']) {
    await assert.rejects(apiRequest('/auth/password'));
  }
  assert.deepEqual(events, [SESSION_EXPIRED_EVENT]);
});

test('an intentional abort is preserved rather than reported as a connection error', async (context) => {
  const controller = new globalThis.AbortController();
  controller.abort();
  const reason = new globalThis.DOMException('Aborted', 'AbortError');
  mockFetch(context, async () => { throw reason; });
  await assert.rejects(apiRequest('/products', { signal: controller.signal }), (error) => error === reason);
});
