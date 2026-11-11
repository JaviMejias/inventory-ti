import './require-test-database.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, before, after } from 'node:test';

import { PrismaClient, AssetStatus, CorrectionStatus, MovementType, ProductTrackingMode, Role } from '@prisma/client';

const prisma = new PrismaClient();

class RollbackTest extends Error {}

async function withRollback(callback) {
  try {
    await prisma.$transaction(async (transaction) => {
      await callback(transaction);
      throw new RollbackTest();
    });
  } catch (error) {
    if (!(error instanceof RollbackTest)) {
      throw error;
    }
  }
}

function uniqueSuffix() {
  return randomUUID().slice(0, 8);
}

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
});

test('materialized stock and assignment history preserve their separate responsibilities', async () => {
  await withRollback(async (transaction) => {
    const suffix = uniqueSuffix();
    const product = await transaction.product.create({
      data: {
        name: `Test asset product ${suffix}`,
        trackingMode: ProductTrackingMode.ASSET
      }
    });
    const person = await transaction.user.create({
      data: { username: `person-${suffix}`, displayName: 'Test Person', role: Role.SOPORTE }
    });
    const asset = await transaction.asset.create({
      data: {
        productId: product.id,
        assetTag: `ASSET-${suffix}`,
        status: AssetStatus.AVAILABLE
      }
    });
    await transaction.inventoryStock.create({
      data: { productId: product.id, quantity: 10 }
    });
    await transaction.assignment.create({
      data: {
        assetId: asset.id,
        personId: person.id,
        personName: person.displayName,
        createdById: person.id,
        startedAt: new Date('2026-01-01T10:00:00Z'),
        endedAt: new Date('2026-02-01T10:00:00Z'),
        endedById: person.id
      }
    });
    await transaction.assignment.create({
      data: {
        assetId: asset.id,
        personId: person.id,
        personName: person.displayName,
        createdById: person.id,
        startedAt: new Date('2026-02-02T10:00:00Z')
      }
    });

    const assignments = await transaction.assignment.count({ where: { assetId: asset.id } });
    const stock = await transaction.inventoryStock.findUnique({
      where: { productId: product.id }
    });

    assert.equal(assignments, 2);
    assert.equal(stock?.quantity, 10);
  });
});

test('corrections reference an immutable original movement', async () => {
  await withRollback(async (transaction) => {
    const suffix = uniqueSuffix();
    const product = await transaction.product.create({
      data: {
        name: `Correction product ${suffix}`,
        trackingMode: ProductTrackingMode.QUANTITY
      }
    });
    const requester = await transaction.user.create({
      data: { username: `requester-${suffix}`, displayName: 'Requester', role: Role.SOPORTE }
    });
    const reviewer = await transaction.user.create({
      data: { username: `reviewer-${suffix}`, displayName: 'Reviewer', role: Role.COORDINADOR }
    });
    const original = await transaction.inventoryMovement.create({
      data: {
        productId: product.id,
        performedById: requester.id,
        movementType: MovementType.EXIT,
        quantity: -5,
        reason: 'Original movement'
      }
    });
    const compensating = await transaction.inventoryMovement.create({
      data: {
        productId: product.id,
        performedById: reviewer.id,
        movementType: MovementType.ADJUSTMENT,
        quantity: 1,
        reason: 'Compensating movement'
      }
    });
    const correction = await transaction.correctionRequest.create({
      data: {
        originalMovementId: original.id,
        compensatingMovementId: compensating.id,
        requestedById: requester.id,
        reviewedById: reviewer.id,
        status: CorrectionStatus.APPROVED,
        reason: 'Only four units were issued',
        delta: 1,
        correctedQuantity: -4,
        reviewedAt: new Date()
      }
    });

    const storedOriginal = await transaction.inventoryMovement.findUniqueOrThrow({ where: { id: original.id } });
    const storedCorrection = await transaction.correctionRequest.findUniqueOrThrow({ where: { id: correction.id } });

    assert.equal(storedOriginal.quantity, -5);
    assert.equal(storedOriginal.movementType, MovementType.EXIT);
    assert.equal(storedCorrection.originalMovementId, original.id);
    assert.equal(storedCorrection.compensatingMovementId, compensating.id);
  });
});

test('database constraints reject negative stock, multiple active assignments, and movement mutation', async () => {
  await withRollback(async (transaction) => {
    const suffix = uniqueSuffix();
    const product = await transaction.product.create({
      data: {
        name: `Constraint product ${suffix}`,
        trackingMode: ProductTrackingMode.ASSET
      }
    });
    await assert.rejects(
      transaction.inventoryStock.create({ data: { productId: product.id, quantity: -1 } })
    );
  });

  await withRollback(async (transaction) => {
    const suffix = uniqueSuffix();
    const product = await transaction.product.create({
      data: {
        name: `Assignment constraint product ${suffix}`,
        trackingMode: ProductTrackingMode.ASSET
      }
    });
    const person = await transaction.user.create({
      data: { username: `constraint-person-${suffix}`, displayName: 'Constraint Person', role: Role.SOPORTE }
    });
    const asset = await transaction.asset.create({
      data: { productId: product.id, assetTag: `CONS-ASSET-${suffix}` }
    });

    await transaction.assignment.create({ data: { assetId: asset.id, personId: person.id, personName: person.displayName, createdById: person.id, startedAt: new Date() } });
    await assert.rejects(
      transaction.assignment.create({ data: { assetId: asset.id, personId: person.id, personName: person.displayName, createdById: person.id, startedAt: new Date() } })
    );
  });

  await withRollback(async (transaction) => {
    const suffix = uniqueSuffix();
    const product = await transaction.product.create({
      data: {
        name: `Movement constraint product ${suffix}`,
        trackingMode: ProductTrackingMode.QUANTITY
      }
    });
    const movement = await transaction.inventoryMovement.create({
      data: {
        productId: product.id,
        movementType: MovementType.ENTRY,
        quantity: 1
      }
    });

    await assert.rejects(
      transaction.inventoryMovement.update({ where: { id: movement.id }, data: { reason: 'Mutation attempt' } })
    );
  });
});
