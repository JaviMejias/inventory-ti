import type { AppRole } from '../../lib/permissions';

export type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'RESERVED' | 'UNDER_REVIEW' | 'IN_REPAIR' | 'IN_WARRANTY' | 'LOST' | 'DECOMMISSIONED';
export type OperationalAssetStatus = Exclude<AssetStatus, 'ASSIGNED' | 'DECOMMISSIONED'>;

export const assetStatusLabels: Record<AssetStatus, string> = {
  AVAILABLE: 'Disponible',
  ASSIGNED: 'Asignado',
  RESERVED: 'Reservado',
  UNDER_REVIEW: 'En revisión',
  IN_REPAIR: 'En reparación',
  IN_WARRANTY: 'En garantía',
  LOST: 'Extraviado',
  DECOMMISSIONED: 'Dado de baja'
};

export const assetStatusDescriptions: Record<OperationalAssetStatus, string> = {
  AVAILABLE: 'El activo quedará disponible para asignación.',
  RESERVED: 'El activo quedará reservado, fuera de las unidades disponibles para asignación.',
  UNDER_REVIEW: 'El activo quedará en revisión y no podrá asignarse.',
  IN_REPAIR: 'El activo quedará en reparación y no podrá asignarse hasta volver a estar disponible.',
  IN_WARRANTY: 'El activo quedará en garantía y no podrá asignarse.',
  LOST: 'El activo quedará registrado como extraviado y no podrá asignarse.'
};

const operationalStatuses: OperationalAssetStatus[] = ['AVAILABLE', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR', 'IN_WARRANTY', 'LOST'];
const supportStatuses: OperationalAssetStatus[] = ['AVAILABLE', 'RESERVED', 'UNDER_REVIEW', 'IN_REPAIR'];

export function getAssetStatusOptions(role: AppRole | undefined, currentStatus: AssetStatus, isActive = true) {
  if (!isActive || currentStatus === 'ASSIGNED' || currentStatus === 'DECOMMISSIONED') return [];
  if (role !== 'JEFE' && role !== 'COORDINADOR' && role !== 'SOPORTE') return [];
  const statuses = role === 'SOPORTE' ? supportStatuses : operationalStatuses;
  return statuses.filter((status) => status !== currentStatus).map((status) => ({ value: status, label: assetStatusLabels[status] }));
}
