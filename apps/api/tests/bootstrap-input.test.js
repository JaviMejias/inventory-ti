import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectBootstrapInput } from '../src/scripts/bootstrap-input.js';

const password = 'Bootstrap-password-123';
const validLines = ['bootstrap-jefe', 'Bootstrap administrator', '+56 9 1234 5678', 'bootstrap@example.com', password, password];

function promptFor(lines, interactive = true) {
  const questions = [];
  const messages = [];
  let index = 0;
  return {
    questions,
    messages,
    prompt: {
      interactive,
      read: async (question, hidden) => {
        questions.push({ question, hidden });
        assert.ok(index < lines.length, 'Unexpected additional prompt');
        return lines[index++];
      },
      write: (message) => { messages.push(message); }
    }
  };
}

test('bootstrap validates each field immediately and retries only invalid profile input', async () => {
  const input = promptFor(['ab', validLines[0], '   ', validLines[1], 'phone', validLines[2], 'invalid-email', validLines[3], password, password]);
  const result = await collectBootstrapInput(input.prompt);
  assert.deepEqual(result, { username: validLines[0], displayName: validLines[1], phone: validLines[2], email: validLines[3], password, role: 'JEFE' });
  assert.deepEqual(input.questions.map(({ question }) => question), [
    'Nombre de usuario:', 'Nombre de usuario:', 'Nombre visible:', 'Nombre visible:',
    'Teléfono:', 'Teléfono:', 'Email:', 'Email:', 'Contraseña:', 'Confirma la contraseña:'
  ]);
  assert.equal(input.messages.filter((message) => message.startsWith('Error:')).length, 4);
});

test('bootstrap retries invalid passwords without asking for accepted profile fields again', async () => {
  const invalidPasswords = ['short1', 'letterswithoutdigits', '123456789012', 'a1'.repeat(65)];
  const input = promptFor([...validLines.slice(0, 4), ...invalidPasswords, password, password]);
  const result = await collectBootstrapInput(input.prompt);
  assert.equal(result.password, password);
  assert.equal(input.questions.filter(({ question }) => question === 'Nombre de usuario:').length, 1);
  assert.equal(input.questions.filter(({ question }) => question === 'Contraseña:').length, 5);
  assert.equal(input.questions.filter(({ question }) => question === 'Confirma la contraseña:').length, 1);
  assert.ok(input.questions.slice(4).every(({ hidden }) => hidden));
  assert.match(input.messages[0], /12 y 128 caracteres/);
  for (const secret of [...invalidPasswords, password]) assert.ok(!input.messages.join('').includes(secret));
});

test('bootstrap retries confirmation only and never prints either password', async () => {
  const wrongConfirmation = 'Wrong-confirmation-123';
  const input = promptFor([...validLines.slice(0, 5), wrongConfirmation, password]);
  const result = await collectBootstrapInput(input.prompt);
  assert.equal(result.password, password);
  assert.equal(input.questions.filter(({ question }) => question === 'Contraseña:').length, 1);
  assert.equal(input.questions.filter(({ question }) => question === 'Confirma la contraseña:').length, 2);
  assert.match(input.messages.join(''), /Las contraseñas no coinciden/);
  assert.ok(!input.messages.join('').includes(password));
  assert.ok(!input.messages.join('').includes(wrongConfirmation));
});

test('bootstrap preserves passwords exactly while normalizing profile whitespace', async () => {
  const spacedPassword = ` ${password} `;
  const input = promptFor([...validLines.slice(0, 4).map((value) => ` ${value} `), spacedPassword, spacedPassword]);
  const result = await collectBootstrapInput(input.prompt);
  assert.equal(result.username, validLines[0]);
  assert.equal(result.email, validLines[3]);
  assert.equal(result.password, spacedPassword);
});

for (const [field, index, invalid, message] of [
  ['username', 0, 'ab', /nombre de usuario/],
  ['displayName', 1, '', /nombre visible/],
  ['phone', 2, 'invalid', /teléfono/],
  ['email', 3, 'invalid', /email válido/],
  ['password', 4, 'short1', /12 y 128 caracteres/]
]) {
  test(`piped bootstrap rejects invalid ${field} without consuming the following positional fields`, async () => {
    const lines = [...validLines];
    lines[index] = invalid;
    const input = promptFor(lines, false);
    await assert.rejects(collectBootstrapInput(input.prompt), message);
    assert.equal(input.questions.length, index + 1);
  });
}

test('piped bootstrap rejects mismatched confirmation and accepts the documented six-field input', async () => {
  const invalid = promptFor([...validLines.slice(0, 5), 'Wrong-confirmation-123'], false);
  await assert.rejects(collectBootstrapInput(invalid.prompt), /Las contraseñas no coinciden/);
  assert.equal(invalid.questions.length, 6);
  const valid = promptFor(validLines, false);
  assert.equal((await collectBootstrapInput(valid.prompt)).role, 'JEFE');
  assert.equal(valid.questions.length, 6);
});

test('bootstrap cancellation propagates without returning partially accepted data', async () => {
  const input = promptFor(validLines);
  const read = input.prompt.read;
  input.prompt.read = (question, hidden) => {
    if (question === 'Contraseña:') return Promise.reject(new Error('Operación cancelada.'));
    return read(question, hidden);
  };
  await assert.rejects(collectBootstrapInput(input.prompt), /Operación cancelada/);
  assert.equal(input.questions.length, 4);
});
