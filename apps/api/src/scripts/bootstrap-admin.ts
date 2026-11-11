import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Buffer } from 'node:buffer';

import { Role } from '@prisma/client';

import { prisma } from '../config/database.js';
import { hashPassword } from '../lib/password.js';
import { collectBootstrapInput } from './bootstrap-input.js';

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
      // Readline's terminal listener must not echo password input.
      readline!.close();
      return promptHiddenTty(question);
    }
    return readline!.question(`${question} `).then((answer) => answer.trim());
  }

  if (!pipedReady) {
    throw new Error('No se pudo leer la entrada del comando. No se creó ningún administrador.');
  }
  if (pipedIndex >= pipedLines.length) {
    return Promise.reject(new Error('Faltan datos en la entrada del comando. Envía los seis campos en el orden indicado. No se creó ningún administrador.'));
  }

  const value = pipedLines[pipedIndex];
  pipedIndex += 1;
  if (hidden) {
    output.write(`${question} [oculta]\n`);
  } else {
    output.write(`${question} ${value}\n`);
  }
  return Promise.resolve(hidden ? value : value.trim());
}

function promptHiddenTty(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    input.setRawMode(true);
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
          reject(new Error('Operación cancelada. No se creó ningún administrador.'));
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
    input.resume();
    output.write(`${question} `);
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
    throw new Error(`Ya existen ${existingUsers} usuario(s). Este comando solo crea el primer JEFE en una base sin usuarios. Administra las cuentas desde la aplicación.`);
  }

  output.write('\nCreación del administrador inicial (JEFE).\n');
  const data = await collectBootstrapInput({
    interactive: isTty,
    read: nextLine,
    write: (message) => { output.write(message); }
  });

  const user = await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${bootstrapLockKey})`);
    const currentCount = await transaction.user.count();
    if (currentCount > 0) {
      throw new Error('Se creó otro usuario mientras ingresabas los datos. No se creó este administrador. Administra las cuentas desde la aplicación.');
    }

    const created = await transaction.user.create({
      data: {
        username: data.username,
        email: data.email,
        displayName: data.displayName,
        phone: data.phone,
        passwordHash: hashPassword(data.password),
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

  output.write('\nAdministrador creado correctamente.\n');
  output.write(`Se creó el usuario JEFE "${user.username}" (${user.displayName}).\n`);
  output.write('Ya puedes iniciar sesión en la aplicación. La contraseña no se guardó en texto plano.\n');
}

bootstrap()
  .catch((error: unknown) => {
    output.write(`\nNo se pudo crear el administrador: ${error instanceof Error ? error.message : 'Error inesperado.'}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    readline?.close();
    await prisma.$disconnect();
  });
