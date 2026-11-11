import { importIssueLabels } from './import-issue-labels';
const blockerLabels: Record<string, string> = {
  BATCH_SNAPSHOT_STALE: 'Cambió el inventario o las reglas; requiere un lote vigente.',
  WARNINGS_NOT_ACKNOWLEDGED: 'Hay advertencias pendientes de reconocer.',
  UNKNOWN_WARNING_ACKNOWLEDGEMENT: 'Las advertencias reconocidas ya no corresponden a este plan.',
  PRODUCT_NOT_FOUND: 'El producto no existe.', PRODUCT_INACTIVE: 'El producto está inactivo.', PRODUCT_NOT_ASSET: 'El producto no admite activos.',
  SELECTED_PRODUCT_EQUIPMENTTYPE_CONFLICT: 'El tipo del producto contradice el origen.',
  SELECTED_PRODUCT_BRAND_CONFLICT: 'La marca del producto contradice el origen.', SELECTED_PRODUCT_MODEL_CONFLICT: 'El modelo del producto contradice el origen.',
  RETIREMENT_REQUIRES_SEPARATE_WORKFLOW: 'La baja requiere su propio circuito.',
  NEW_ASSET_REVIEW_REQUIRED: 'Requiere una decisión vigente de proponer nuevo.', EXISTING_ASSET_MATCH: 'La identidad coincide con un activo existente.',
  SOURCE_AVAILABILITY_UNCONFIRMED: 'El origen no acredita disponibilidad.', SOURCE_HISTORY_REQUIRES_SEPARATE_WORKFLOW: 'La historia o entrega requiere otro circuito.',
  MISSING_ASSET_IDENTITY: 'Falta identidad.', IDENTITY_PLACEHOLDER_NOT_ALLOWED: 'La identidad contiene un marcador sin verificar.',
  SOURCE_IDENTITY_MISMATCH: 'La identidad no coincide con el origen.', CROSS_CANDIDATE_IDENTITY_CONFLICT: 'La identidad coincide con otro candidato.',
  EXISTING_ASSET_REVIEW_REQUIRED: 'Requiere una decisión vigente de vincular este activo.', ASSET_NOT_FOUND: 'El activo no existe.',
  ASSET_DECOMMISSIONED: 'El activo está inactivo o dado de baja.', NO_METADATA_CHANGE: 'No hay diferencias en los metadatos.',
  IDENTITY_REVIEW_DECISION_REQUIRED: 'La identidad corregida necesita una nueva decisión de revisión.'
};
export function pilotIssueLabel(code: string): string { return blockerLabels[code] ?? importIssueLabels[code] ?? 'Incidencia pendiente de revisión'; }
