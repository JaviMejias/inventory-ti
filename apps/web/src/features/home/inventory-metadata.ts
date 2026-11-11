import type { AssetStatus } from './asset-status';

export type ProductMetadata = { equipmentType?: string | null; brand?: string | null; model?: string | null };
export type AssetMetadata = {
  technicalCondition?: string | null; usagePurpose?: string | null; location?: string | null; sector?: string | null;
  ipAddress?: string | null; hostname?: string | null; loanCode?: string | null; notes?: string | null;
};
export type AssetMetadataForm = Record<keyof AssetMetadata, string>;
export const assetMetadataFields = [
  { key: 'technicalCondition', label: 'Condición técnica', max: 100, placeholder: 'Ej. Bueno, teclado dañado' },
  { key: 'usagePurpose', label: 'Finalidad', max: 100, placeholder: 'Ej. Contingencia, reposición' },
  { key: 'location', label: 'Ubicación descriptiva', max: 160, placeholder: 'Ej. Sala TI' },
  { key: 'sector', label: 'Sector', max: 100, placeholder: 'Ej. Estante A1' },
  { key: 'ipAddress', label: 'Dirección IP', max: 45, placeholder: 'Ej. 192.168.1.20' },
  { key: 'hostname', label: 'Nombre de equipo', max: 160, placeholder: 'Ej. TRANSITO01NTB' },
  { key: 'loanCode', label: 'Código de préstamo', max: 100, placeholder: 'Ej. MDA-17' },
  { key: 'notes', label: 'Observaciones', max: 10000, placeholder: 'Información adicional del equipo' }
] as const;

export function assetMetadataForm(asset: AssetMetadata = {}): AssetMetadataForm {
  return Object.fromEntries(assetMetadataFields.map(({ key }) => [key, asset[key] ?? ''])) as AssetMetadataForm;
}

export function assetMetadataPayload(form: AssetMetadataForm, original?: AssetMetadata) {
  return Object.fromEntries(assetMetadataFields
    .filter(({ key }) => original ? form[key].trim() !== (original[key] ?? '') : Boolean(form[key].trim()))
    .map(({ key }) => [key, form[key].trim() || null]));
}

export function productMetadataLabel(product: ProductMetadata): string {
  return [product.equipmentType, product.brand, product.model].filter(Boolean).join(' · ');
}

export type AssetAvailability = {
  product: { id: string; name: string; sku: string | null; lowStockThreshold: number } & ProductMetadata;
  activeCount: number; availableCount: number; statusCounts: Record<AssetStatus, number>; lowStock: boolean;
};
export type AvailabilityPage = { products: AssetAvailability[]; total: number; limit: number; offset: number; hasMore: boolean };
