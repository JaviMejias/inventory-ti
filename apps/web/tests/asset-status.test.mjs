import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import ts from 'typescript';

const source = readFileSync(new URL('../src/features/home/asset-status.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { getAssetStatusOptions, assetStatusLabels, assetStatusDescriptions } = await import('data:text/javascript;base64,' + globalThis.Buffer.from(compiled).toString('base64'));
const values = (role, status = 'AVAILABLE', isActive = true) => getAssetStatusOptions(role, status, isActive).map((option) => option.value);

test('jefe and coordinador can select all other operational statuses', () => {
  for (const role of ['JEFE', 'COORDINADOR']) {
    assert.deepEqual(values(role), ['RESERVED', 'UNDER_REVIEW', 'IN_REPAIR', 'IN_WARRANTY', 'LOST']);
    assert.ok(values(role, 'IN_REPAIR').includes('AVAILABLE'));
  }
});

test('support can send an asset to repair and make it available again without elevated options', () => {
  assert.deepEqual(values('SOPORTE'), ['RESERVED', 'UNDER_REVIEW', 'IN_REPAIR']);
  assert.deepEqual(values('SOPORTE', 'IN_REPAIR'), ['AVAILABLE', 'RESERVED', 'UNDER_REVIEW']);
  assert.deepEqual(values('SOPORTE', 'IN_WARRANTY'), ['AVAILABLE', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR']);
});

test('active assignments and terminal or inactive assets cannot change operational status', () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    assert.deepEqual(values(role, 'ASSIGNED'), []);
    assert.deepEqual(values(role, 'DECOMMISSIONED'), []);
    assert.deepEqual(values(role, 'AVAILABLE', false), []);
  }
});

test('the current state, assignment and decommission are never destinations', () => {
  for (const role of ['JEFE', 'COORDINADOR', 'SOPORTE']) {
    for (const status of Object.keys(assetStatusLabels)) {
      const options = values(role, status);
      assert.equal(options.includes(status), false);
      assert.equal(options.includes('ASSIGNED'), false);
      assert.equal(options.includes('DECOMMISSIONED'), false);
    }
  }
});

test('unauthenticated or unexpected roles have no operational options', () => {
  assert.deepEqual(values(undefined), []);
  assert.deepEqual(values('ADMIN'), []);
});

test('every permitted option has Spanish labels and consequence text', () => {
  for (const option of getAssetStatusOptions('JEFE', 'IN_REPAIR')) {
    assert.equal(option.label, assetStatusLabels[option.value]);
    assert.match(assetStatusDescriptions[option.value], /activo/);
  }
});
