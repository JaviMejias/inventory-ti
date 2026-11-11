import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/features/home/correction-model.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { getCorrectedQuantity, getCorrectionFeedback } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('exit quantities represent the final negative effect, not an additional subtraction', () => {
  assert.equal(getCorrectedQuantity('EXIT', 2, 'add'), -2);
  assert.equal(getCorrectedQuantity('EXIT', 2, 'subtract'), -2);
});

test('initial, entry and return preserve their positive direction', () => {
  for (const type of ['INITIAL', 'ENTRY', 'RETURN']) {
    assert.equal(getCorrectedQuantity(type, 2, 'add'), 2);
    assert.equal(getCorrectedQuantity(type, 2, 'subtract'), 2);
  }
});

test('adjustments retain the explicitly chosen sign', () => {
  assert.equal(getCorrectedQuantity('ADJUSTMENT', 2, 'add'), 2);
  assert.equal(getCorrectedQuantity('ADJUSTMENT', 2, 'subtract'), -2);
});

test('zero cancels a movement effect without generating an additional quantity', () => {
  for (const type of ['INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'ADJUSTMENT']) {
    assert.equal(Math.abs(getCorrectedQuantity(type, 0, 'subtract')), 0);
  }
});

test('server-confirmed application and pending review produce different Spanish feedback', () => {
  const applied = getCorrectionFeedback('APPROVED');
  assert.equal(applied.title, 'Corrección aplicada');
  assert.match(applied.description, /stock.*saldos.*actualizaron/);
  assert.doesNotMatch(applied.description, /pendiente/);
  const pending = getCorrectionFeedback('PENDING');
  assert.equal(pending.title, 'Corrección solicitada');
  assert.match(pending.description, /pendiente.*JEFE/);
  assert.equal(getCorrectionFeedback('REJECTED').title, 'Corrección rechazada');
});
