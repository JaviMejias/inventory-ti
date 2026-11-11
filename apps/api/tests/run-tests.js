import { spawn } from 'node:child_process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { PrismaClient } from '@prisma/client';

const apiDirectory = fileURLToPath(new URL('..', import.meta.url));
const sourceUrl = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/inventory_ti');
if (!['postgres:', 'postgresql:'].includes(sourceUrl.protocol)) throw new Error('Tests require a PostgreSQL connection');
const databaseName = `inventory_ti_test_${randomUUID().replaceAll('-', '')}`;
const maintenanceUrl = new URL(sourceUrl);
maintenanceUrl.pathname = '/postgres';
maintenanceUrl.searchParams.set('schema', 'public');
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
testUrl.searchParams.set('schema', 'public');
const database = new PrismaClient({ datasources: { db: { url: maintenanceUrl.href } } });
const childEnvironment = { ...process.env, NODE_ENV: 'test', DATABASE_URL: testUrl.href, INVENTORY_TEST_DATABASE: databaseName };
let created = false;
let activeChild;
let interrupted = false;

function interrupt() {
  interrupted = true;
  activeChild?.kill('SIGTERM');
}

function run(arguments_) {
  if (interrupted) return Promise.resolve(130);
  return new Promise((resolve, reject) => {
    activeChild = spawn(process.execPath, arguments_, { cwd: apiDirectory, env: childEnvironment, stdio: 'inherit' });
    activeChild.once('error', reject);
    activeChild.once('exit', (code) => {
      activeChild = undefined;
      resolve(interrupted ? 130 : code ?? 1);
    });
  });
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  await database.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  created = true;
  console.log(`Running tests in disposable database ${databaseName}`);
  const migrated = await run(['./node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', '../../prisma/schema.prisma']);
  if (migrated !== 0) process.exitCode = migrated;
  else {
    const files = readdirSync(new URL('.', import.meta.url)).filter((file) => file.endsWith('.test.js')).sort().map((file) => `tests/${file}`);
    // Files share a database and intentionally hold catalog-wide locks.
    // Serialize files, while keeping concurrent-request tests within each file.
    process.exitCode = await run(['--import', 'tsx/esm', '--import', './tests/require-test-database.js', '--test', '--test-concurrency=1', ...process.argv.slice(2), ...files]);
  }
} catch (error) {
  console.error('Isolated test run failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
} finally {
  try {
    if (created) {
      await database.$executeRawUnsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      console.log(`Removed disposable database ${databaseName}`);
    }
  } finally {
    await database.$disconnect();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
