import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const prismaRequire = createRequire(realpathSync(fileURLToPath(import.meta.resolve('prisma/config'))));
const configRequire = createRequire(prismaRequire.resolve('@prisma/config'));
const { loadConfigFromFile } = prismaRequire('@prisma/config');
const { deepmerge } = configRequire('deepmerge-ts');

test('patched Prisma dependency merges plain configuration records without regressions', () => {
  assert.deepEqual(deepmerge({ migrations: { path: 'migrations' }, experimental: { views: true } }, { migrations: { seed: 'node seed.js' } }), {
    migrations: { path: 'migrations', seed: 'node seed.js' }, experimental: { views: true }
  });
});

test('Prisma configuration loading still works with the targeted security override', async () => {
  const configRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = await loadConfigFromFile({ configRoot, configFile: 'tests/fixtures/prisma-security.config.mjs' });
  assert.equal(result.error, undefined);
  assert.equal(result.config.schema, fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url)));
  assert.equal(result.config.migrations.path, fileURLToPath(new URL('../../../prisma/migrations', import.meta.url)));
});

test('Prisma configuration merger no longer overflows the stack on circular input', () => {
  const first = { value: 1 };
  const second = { value: 2 };
  first.self = first;
  second.self = second;
  const result = deepmerge(first, second);
  assert.equal(result.value, 2);
  assert.equal(result.self.value, 2);
});
