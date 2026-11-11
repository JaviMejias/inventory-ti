import { batchId, productId, receiptId } from './import-pilot.mjs';

const uuid = (index) => 'abcdef00-abcd-4abc-8abc-' + index.toString(16).padStart(12, '0');
const hash = (index) => index.toString(16).padStart(64, '0');

// V5/V6 snapshot shape, before source revisions existed. No V7 defaults are added.
export function legacyPilotFixture(count = 2) {
  const product = { id: productId, name: 'Notebook histórico QA', trackingMode: 'ASSET', isActive: true, equipmentType: 'Notebook', brand: 'QA', model: 'Modelo original', updatedAt: '2026-10-01T12:00:00.000Z' };
  const assets = [];
  const operations = Array.from({ length: count }, (_, index) => {
    const create = index % 2 === 0; const assetId = uuid(index + 1);
    const before = create ? null : { id: assetId, productId, serialNumber: 'LEGACY-' + index, assetTag: 'AF-' + index, isActive: true, status: 'ASSIGNED', notes: 'Nota anterior', sector: 'A1' };
    const values = create ? { productId, serialNumber: 'LEGACY-' + index, assetTag: null, notes: 'Alta original' } : { notes: 'Nota revisada', sector: null };
    const warning = { id: hash(index + 3000), code: 'MULTIPLE_SOURCE_OBSERVATIONS', severity: 'WARNING', sheet: 'Recepción', row: index + 4, cell: null, candidateId: hash(index + 100) };
    assets.push({ ...before, ...values, id: assetId, productId, product, isActive: true, status: create ? 'AVAILABLE' : 'ASSIGNED', updatedAt: '2026-10-02T12:00:00.000Z' });
    return {
      type: create ? 'CREATE_ASSET' : 'UPDATE_METADATA', candidateId: hash(index + 100), note: 'Verificación original ' + index,
      ...(create ? { confirmation: 'AVAILABLE_UNASSIGNED' } : { assetId }), values, acknowledgedWarnings: [warning.id],
      decisionId: uuid(index + 1000), product, before, resultingStatus: create ? 'AVAILABLE' : 'ASSIGNED',
      changes: Object.entries(values).filter(([field]) => field !== 'productId').map(([field, after]) => ({ field, before: before?.[field] ?? null, after })),
      source: [{ recordId: hash(index + 2000), sheet: 'Recepción', row: index + 4 }], warnings: [warning], blockers: [], valid: true
    };
  });
  const planId = hash(5000); const sourceHash = hash(6000);
  const plan = {
    mode: 'PILOT_PLAN', scope: 'ASSET_PILOT', planRulesVersion: 'mda-pilot-1', persisted: false, canApply: false,
    batchId, batchVersion: 2, planId, stagedPreviewId: hash(7000), currentPreviewId: hash(7001), checkedAsOf: '2026-10-02',
    omittedTargetCount: 7, planValidationComplete: true,
    freshness: { stale: false, rulesChanged: false, databaseChanged: false, reviewDateChanged: true },
    summary: { operationCount: count, validCount: count, blockedCount: 0, createCount: Math.ceil(count / 2), updateCount: Math.floor(count / 2) }, operations
  };
  const receipt = {
    id: receiptId, batchId, batchVersion: 2, requestId: uuid(8000), requestDigest: hash(8001), planId, sourceHash,
    appliedById: uuid(8002), createdAt: '2026-10-02T12:00:00.000Z', plan,
    items: operations.map((operation, index) => ({ id: uuid(index + 9000), applicationId: receiptId, sourceHash, candidateId: operation.candidateId,
      decisionId: operation.decisionId, assetId: assets[index].id, operation: globalThis.structuredClone(operation), result: assets[index] }))
  };
  return { receipt, response: { mode: 'APPLIED', persisted: true, application: receipt }, batchId, receiptId, product };
}
