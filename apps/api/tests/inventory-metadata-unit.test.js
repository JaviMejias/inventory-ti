import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { productCreateSchema, productUpdateSchema } from '../src/catalog/schemas.js';
import { assetAvailabilityQuerySchema, assetCreateSchema, assetUpdateSchema } from '../src/routes/assets-schemas.js';

test('inventory metadata accepts legacy requests and distinguishes omission, empty and null', () => {
  const product = productCreateSchema.parse({ name: 'Legacy', trackingMode: 'ASSET' });
  assert.equal(product.brand, undefined);
  assert.equal(product.lowStockThreshold, 0);
  assert.equal(productUpdateSchema.parse({ brand: '  HP  ' }).brand, 'HP');
  assert.equal(productUpdateSchema.parse({ model: ' ' }).model, null);
  assert.equal(productUpdateSchema.parse({ equipmentType: null }).equipmentType, null);
  assert.equal(assetCreateSchema.parse({ productId: randomUUID() }).notes, undefined);
  assert.deepEqual(assetUpdateSchema.parse({ location: '  Bodega 2  ', notes: '', ipAddress: null }), { location: 'Bodega 2', notes: null, ipAddress: null });
  assert.equal(assetUpdateSchema.safeParse({}).success, false);
  assert.equal(assetUpdateSchema.safeParse({ notes: undefined }).success, false);
});

test('inventory metadata validates limits, IP addresses and rejects operational fields in metadata edits', () => {
  for (const ipAddress of ['10.72.40.254', '2001:db8::1', '', null]) {
    assert.equal(assetUpdateSchema.safeParse({ ipAddress }).success, true);
  }
  for (const ipAddress of ['10.72.40', '10.72.40.999', 'host.example', 123]) {
    assert.equal(assetUpdateSchema.safeParse({ ipAddress }).success, false);
  }
  for (const input of [{ brand: 'x'.repeat(101) }, { equipmentType: 3 }, { model: 'x'.repeat(161) }]) {
    assert.equal(productUpdateSchema.safeParse(input).success, false);
  }
  for (const input of [{ notes: 'x'.repeat(10_001) }, { status: 'ASSIGNED' }, { isActive: false }, { productId: randomUUID() }, { unknown: 'ignored?' }]) {
    assert.equal(assetUpdateSchema.safeParse(input).success, false);
  }
  assert.equal(assetCreateSchema.safeParse({ productId: randomUUID(), status: 'DECOMMISSIONED' }).success, false);
});

test('asset availability validates bounded product pagination', () => {
  assert.deepEqual(assetAvailabilityQuerySchema.parse({}), { limit: 25, offset: 0 });
  assert.deepEqual(assetAvailabilityQuerySchema.parse({ limit: '100', offset: '25', brand: ' HP ' }), { limit: 100, offset: 25, brand: 'HP' });
  for (const input of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { offset: 2_147_483_648 }, { productId: 'not-a-uuid' }, { status: 'ASSIGNED' }]) {
    assert.equal(assetAvailabilityQuerySchema.safeParse(input).success, false);
  }
});
