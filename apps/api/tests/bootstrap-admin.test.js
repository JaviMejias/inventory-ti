import './require-test-database.js';

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { after, before, beforeEach, test } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { verifyPassword } from '../src/lib/password.js';

const apiDirectory = fileURLToPath(new URL('..', import.meta.url));
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', `bootstrap_${randomUUID().replaceAll('-', '')}`);
const childEnvironment = { ...process.env, DATABASE_URL: url.href };
const database = new PrismaClient({ datasources: { db: { url: url.href } } });
const password = 'Bootstrap-password-123';
const profile = ['bootstrap-jefe', 'Bootstrap administrator', '+56 9 1234 5678', 'bootstrap@example.com'];
const scriptAvailable = process.platform !== 'win32' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;

function runPiped(lines) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', 'src/scripts/bootstrap-admin.ts'], {
    cwd: apiDirectory,
    env: childEnvironment,
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
    timeout: 15_000
  });
}

function runTerminal(steps) {
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['--quiet', '--return', '--command', `${process.execPath} --import tsx/esm src/scripts/bootstrap-admin.ts`, '/dev/null'], {
      cwd: apiDirectory,
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let transcript = '';
    let pending = '';
    let index = 0;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Bootstrap terminal timed out at prompt ${index + 1}`));
    }, 15_000);
    child.stdout.on('data', (chunk) => {
      const output = chunk.toString();
      transcript += output;
      pending += output;
      const step = steps[index];
      if (step && pending.includes(step.question)) {
        pending = pending.slice(pending.indexOf(step.question) + step.question.length);
        index += 1;
        child.stdin.write(step.cancel ? '\u0003' : `${step.value}\n`);
      }
    });
    child.stderr.on('data', (chunk) => { transcript += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timeout);
      child.stdin.end();
      resolve({ status, transcript, promptsAnswered: index });
    });
  });
}

before(() => {
  execFileSync(process.execPath, ['./node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', '../../prisma/schema.prisma'], {
    cwd: apiDirectory,
    env: childEnvironment,
    stdio: 'pipe'
  });
});

beforeEach(async () => {
  await database.auditLog.deleteMany();
  await database.user.deleteMany();
});

after(async () => { await database.$disconnect(); });

test('piped bootstrap failures do not create a user or audit and never echo passwords', async () => {
  for (const lines of [
    [...profile, 'short1', 'short1'],
    [...profile, password, 'Wrong-confirmation-123'],
    profile.slice(0, 2)
  ]) {
    const result = runPiped(lines);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /No se pudo crear el administrador/);
    assert.equal(await database.user.count(), 0);
    assert.equal(await database.auditLog.count(), 0);
    for (const secret of ['short1', password, 'Wrong-confirmation-123']) assert.ok(!result.stdout.includes(secret));
  }
});

test('piped bootstrap creates one active JEFE with hashed credentials and preserves password whitespace', async () => {
  const suppliedPassword = ` ${password} `;
  const result = runPiped([...profile, suppliedPassword, suppliedPassword]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Administrador creado correctamente/);
  assert.ok(!result.stdout.includes(password));
  const user = await database.user.findUniqueOrThrow({ where: { username: profile[0] } });
  assert.equal(user.role, 'JEFE');
  assert.equal(user.isActive, true);
  assert.notEqual(user.passwordHash, suppliedPassword);
  assert.equal(verifyPassword(suppliedPassword, user.passwordHash), true);
  assert.equal(verifyPassword(password, user.passwordHash), false);
  assert.equal(await database.auditLog.count({ where: { action: 'USER_BOOTSTRAP_JEFE', entityId: user.id } }), 1);
  const repeated = runPiped([...profile, password, password]);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stdout, /solo crea el primer JEFE/);
  assert.equal(await database.user.count(), 1);
  assert.equal(await database.auditLog.count(), 1);
});

test('terminal bootstrap retries a short password and mismatched confirmation without restarting', { skip: !scriptAvailable }, async () => {
  const steps = [
    { question: 'Nombre de usuario:', value: profile[0] },
    { question: 'Nombre visible:', value: profile[1] },
    { question: 'Teléfono:', value: profile[2] },
    { question: 'Email:', value: profile[3] },
    { question: 'Contraseña:', value: 'short1' },
    { question: 'Contraseña:', value: password },
    { question: 'Confirma la contraseña:', value: 'Wrong-confirmation-123' },
    { question: 'Confirma la contraseña:', value: password }
  ];
  const result = await runTerminal(steps);
  assert.equal(result.status, 0);
  assert.equal(result.promptsAnswered, steps.length);
  assert.match(result.transcript, /12 y 128 caracteres/);
  assert.match(result.transcript, /Las contraseñas no coinciden/);
  assert.match(result.transcript, /Administrador creado correctamente/);
  assert.equal(result.transcript.split('Nombre de usuario:').length - 1, 1);
  const secrets = ['short1', password, 'Wrong-confirmation-123'];
  const sanitizedTranscript = secrets.reduce((transcript, secret) => transcript.replaceAll(secret, '[redacted test password]'), result.transcript);
  for (const secret of secrets) assert.ok(!result.transcript.includes(secret), `A test password was echoed in terminal output:\n${sanitizedTranscript}`);
  assert.equal(await database.user.count(), 1);
  assert.equal(await database.auditLog.count(), 1);
});

test('terminal bootstrap cancellation during password entry creates no account', { skip: !scriptAvailable }, async () => {
  const result = await runTerminal([
    { question: 'Nombre de usuario:', value: profile[0] },
    { question: 'Nombre visible:', value: profile[1] },
    { question: 'Teléfono:', value: profile[2] },
    { question: 'Email:', value: profile[3] },
    { question: 'Contraseña:', cancel: true }
  ]);
  assert.equal(result.status, 1);
  assert.match(result.transcript, /Operación cancelada/);
  assert.equal(await database.user.count(), 0);
  assert.equal(await database.auditLog.count(), 0);
});
