import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Buffer } from 'node:buffer';

import { Role } from '@prisma/client';

import { prisma } from '../config/database.js';
import { hashPassword } from '../lib/password.js';
import { bootstrapAdminSchema } from '../auth/schemas.js';

const bootstrapLockKey = 84821101;
const isTty = Boolean(input.isTTY);

const readline = isTty ? createInterface({ input, output, terminal: true }) : null;

const pipedLines: string[] = [];
let pipedIndex = 0;
let pipedReady = false;

async function readPipedInput(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

function nextLine(question: string, hidden: boolean): Promise<string> {
  if (isTty) {
    if (hidden) {
      return promptHiddenTty(question);
    }
    return readline!.question(`${question} `).then((answer) => answer.trim());
  }

  if (!pipedReady) {
    throw new Error(`Internal error: piped input was not loaded before prompt "${question}"`);
  }
  if (pipedIndex >= pipedLines.length) {
    return Promise.reject(new Error(`No more piped input available for prompt "${question}"; the bootstrap was cancelled without creating an administrator.`));
  }

  const value = pipedLines[pipedIndex];
  pipedIndex += 1;
  if (hidden) {
    output.write(`${question} [hidden]\n`);
  } else {
    output.write(`${question} ${value}\n`);
  }
  return Promise.resolve(value.trim());
}

function promptHiddenTty(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(`${question} `);

    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';

    const cleanup = (): void => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Aborted by user'));
          return;
        }
        if ((char === '\b' || char === '\u007f') && value.length > 0) {
          value = value.slice(0, -1);
          output.write('\b \b');
        } else if (char !== '\b' && char !== '\u007f') {
          value += char;
          output.write('*');
        }
      }
    };

    input.on('data', onData);
  });
}

async function bootstrap(): Promise<void> {
  if (!isTty) {
    pipedLines.push(...(await readPipedInput()));
    pipedReady = true;
    readline?.close();
  }

  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    throw new Error(`Bootstrap refused: ${existingUsers} user(s) already exist. The initial JEFE can only be created on an empty database. Manage users through the application instead.`);
  }

  const username = await nextLine('Username', false);
  const displayName = await nextLine('Display name', false);
  const phone = await nextLine('Phone', false);
  const rawEmail = await nextLine('Email', false);
  const password = await nextLine('Password', true);
  const passwordConfirmation = await nextLine('Confirm password', true);

  if (password !== passwordConfirmation) {
    throw new Error('Passwords do not match');
  }

  const parsed = bootstrapAdminSchema.safeParse({
    username,
    email: rawEmail,
    displayName,
    phone,
    password,
    role: 'JEFE'
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid input:\n- ${issues.join('\n- ')}`);
  }

  const user = await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${bootstrapLockKey})`);
    const currentCount = await transaction.user.count();
    if (currentCount > 0) {
      throw new Error('Bootstrap refused: users were created concurrently. No administrator was created.');
    }

    const created = await transaction.user.create({
      data: {
        username: parsed.data.username,
        email: parsed.data.email ?? null,
        displayName: parsed.data.displayName,
        phone: parsed.data.phone,
        passwordHash: hashPassword(parsed.data.password),
        role: Role.JEFE,
        isActive: true
      }
    });

    await transaction.auditLog.create({
      data: {
        userId: null,
        action: 'USER_BOOTSTRAP_JEFE',
        entityType: 'User',
        entityId: created.id,
        metadata: { role: Role.JEFE, username: created.username }
      }
    });

    return created;
  });

  output.write(`\nBootstrap complete.\n`);
  output.write(`Created JEFE user "${user.username}" (${user.displayName}).\n`);
  output.write(`Log in through the web application. The password was never stored in plain text.\n`);
}

bootstrap()
  .catch((error: unknown) => {
    output.write(`\nBootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    readline?.close();
    await prisma.$disconnect();
  });