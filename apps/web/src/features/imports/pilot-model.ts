import { assetMetadataFields } from '../home/inventory-metadata';
import type { ImportPreview, ReviewDecision, SourceCell } from './import-review-model';

export type PilotValues = Record<string, string | null>;
export type PilotOperation = {
  type: 'CREATE_ASSET' | 'UPDATE_METADATA'; candidateId: string; note: string;
  acknowledgedWarnings: string[]; values: PilotValues; confirmation?: 'AVAILABLE_UNASSIGNED'; assetId?: string;
};
export type PilotRequest = { expectedVersion: number; expectedSourceRevision: number; operations: PilotOperation[] };
export type SourceCorrection = {
  candidateId: string; recordId: string; sheet: string; row: number; column: string; field: string;
  revision: number; reviewedById: string; note: string; evidenceReference: string;
  originalCell: SourceCell | null; afterCell: SourceCell | null;
};
export type ResolvedSource = {
  batchId: string; batchVersion: number; canApply: false; preview: ImportPreview;
  sourceContext: { revision: number; corrections: SourceCorrection[] };
};
export type PilotProduct = { id: string; name: string; trackingMode: string; isActive: boolean; equipmentType?: string | null; brand?: string | null; model?: string | null };
export type PilotCatalogProduct = Omit<PilotProduct, 'isActive'> & { active: boolean };
export type PilotContext = { source: ResolvedSource; decisions: ReviewDecision[]; products: PilotProduct[] };
export type PlannedOperation = PilotOperation & {
  valid: boolean; decisionId: string | null; identityRevision?: number; decisionSourceRevision?: number; product: PilotProduct | null;
  before: Record<string, unknown> | null; resultingStatus: string | null;
  changes: { field: string; before: unknown; after: unknown }[];
  source: { recordId: string; sheet: string; row: number }[];
  sourceCorrections: SourceCorrection[];
  warnings: { id: string; code: string; sheet: string | null; row: number | null }[];
  blockers: { code: string; issueId?: string }[];
};
export type PilotPlan = {
  planRulesVersion?: 'mda-pilot-2' | 'mda-pilot-3';
  mode: 'PILOT_PLAN'; scope: 'ASSET_PILOT'; persisted: false; canApply: false;
  batchId: string; batchVersion: number; sourceRevision: number; planId: string; checkedAsOf: string;
  omittedTargetCount: number; planValidationComplete: boolean;
  freshness: { stale: boolean };
  summary: { operationCount: number; validCount: number; blockedCount: number; createCount: number; updateCount: number };
  operations: PlannedOperation[];
};
export type ApplicationMetadata = {
  id: string; batchId: string; batchVersion: number; requestId: string; planId: string;
  sourceHash: string; appliedById: string; createdAt: string;
};
export type ApplicationReceipt = ApplicationMetadata & {
  plan: PilotPlan;
  items: { id: string; candidateId: string; assetId: string; operation: PlannedOperation; result: Record<string, unknown> }[];
};
export type LegacyPilotOperation = Omit<PlannedOperation, 'sourceCorrections' | 'identityRevision' | 'decisionSourceRevision'>;
export type LegacyPilotPlan = Omit<PilotPlan, 'planRulesVersion' | 'sourceRevision' | 'operations'> & {
  planRulesVersion: 'mda-pilot-1'; stagedPreviewId: string; currentPreviewId: string;
  operations: LegacyPilotOperation[];
};
export type LegacyPilotReceipt = ApplicationMetadata & {
  requestDigest: string; plan: LegacyPilotPlan;
  items: { id: string; applicationId: string; sourceHash: string; decisionId: string; candidateId: string; assetId: string; operation: LegacyPilotOperation; result: Record<string, unknown> }[];
};
export type PilotReadReceipt = ApplicationReceipt | LegacyPilotReceipt;
export function isLegacyPilotReceipt(receipt: PilotReadReceipt): receipt is LegacyPilotReceipt {
  return receipt.plan.planRulesVersion === 'mda-pilot-1';
}
export type ApplyIntent = { requestId: string; planId: string; confirmation: 'APPLY_ASSET_PILOT'; plan: PilotRequest };
export type EvaluatedPilot = { request: PilotRequest; plan: PilotPlan };

export const pilotFieldLabels: Record<string, string> = {
  productId: 'Producto', serialNumber: 'Serie', assetTag: 'Activo fijo',
  ...Object.fromEntries(assetMetadataFields.map((field) => [field.key, field.label]))
};
const metadataLimits = new Map(assetMetadataFields.map((field) => [field.key as string, field.max]));
export function operationType(decision?: ReviewDecision): PilotOperation['type'] | null {
  return decision?.action === 'PROPOSE_NEW' ? 'CREATE_ASSET' : decision?.action === 'LINK_EXISTING' && decision.linkedAssetId ? 'UPDATE_METADATA' : null;
}
export function validatePilotOperation(operation: PilotOperation, verified: boolean, products: PilotProduct[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!operation.note.trim() || operation.note.trim().length > 2000) errors.note = 'Escribe un motivo de entre 1 y 2.000 caracteres.';
  if (operation.type === 'CREATE_ASSET') {
    if (!products.some((product) => product.id === operation.values.productId && product.isActive && product.trackingMode === 'ASSET')) errors.productId = 'Selecciona un producto activo con seguimiento por activo.';
    if (!operation.values.serialNumber?.trim() && !operation.values.assetTag?.trim()) errors.serialNumber = 'Revisa la identidad del equipo; debe tener serie o activo fijo.';
    if (!verified) errors.confirmation = 'Confirma la disponibilidad física y que el equipo no tiene una entrega vigente.';
  } else {
    if (!operation.assetId) errors.assetId = 'Falta el activo vinculado; actualiza el contexto.';
    if (!Object.keys(operation.values).length) errors.values = 'Indica al menos un campo para establecer o borrar.';
  }
  for (const [key, value] of Object.entries(operation.values)) {
    if (!metadataLimits.has(key) && !(operation.type === 'CREATE_ASSET' && ['productId', 'serialNumber', 'assetTag'].includes(key))) errors.values = 'Esta operación no admite cambiar identidad, producto, estado ni entregas.';
    const max = key === 'serialNumber' ? 160 : key === 'assetTag' ? 100 : metadataLimits.get(key);
    if (value !== null && max && value.length > max) errors[key] = 'El valor supera el límite permitido.';
  }
  return errors;
}
export function requestForPilot(context: PilotContext, operations: PilotOperation[]): PilotRequest {
  return { expectedVersion: context.source.batchVersion, expectedSourceRevision: context.source.sourceContext.revision, operations: globalThis.structuredClone(operations) };
}
export function canConfirmPilot(evaluated: EvaluatedPilot | null, enabled: boolean): boolean {
  return Boolean(enabled && evaluated && (!evaluated.plan.planRulesVersion || ['mda-pilot-2', 'mda-pilot-3'].includes(evaluated.plan.planRulesVersion)) && evaluated.plan.planValidationComplete && !evaluated.plan.freshness.stale &&
    evaluated.plan.operations.length > 0 && evaluated.plan.operations.length <= 25 && evaluated.plan.operations.every((operation) => operation.valid && operation.blockers.length === 0) &&
    evaluated.plan.batchVersion === evaluated.request.expectedVersion && evaluated.plan.sourceRevision === evaluated.request.expectedSourceRevision);
}
export function captureApplyIntent(evaluated: EvaluatedPilot, requestId: string): ApplyIntent {
  if (!canConfirmPilot(evaluated, true)) throw new Error('Only a complete current pilot plan can create a write intent');
  return { requestId, planId: evaluated.plan.planId, confirmation: 'APPLY_ASSET_PILOT', plan: globalThis.structuredClone(evaluated.request) };
}
