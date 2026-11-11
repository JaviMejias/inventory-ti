import { inventoryDateTimeToUtc } from '../../lib/date-range';
import type { AssetStatus } from './asset-status';

export type MovementType = 'INITIAL' | 'ENTRY' | 'EXIT' | 'RETURN' | 'ADJUSTMENT';
export type MovementForm = {
  type: MovementType;
  productId: string;
  quantity: string;
  reason: string;
  reference: string;
  effectiveAt: string;
  effectiveTime: string;
};
export type MovementErrors = Partial<Record<keyof MovementForm, string>>;
export type AssetScope = 'active' | 'decommissioned' | 'all';

export function assetListPath(scope: AssetScope): string {
  return scope === 'active' ? '/assets?isActive=true'
    : scope === 'decommissioned' ? '/assets?isActive=false&status=DECOMMISSIONED' : '/assets';
}

export function isOperationalAsset(asset: { status: AssetStatus; isActive?: boolean }): boolean {
  return asset.isActive !== false && asset.status !== 'DECOMMISSIONED';
}

export function assetMatchesScope(asset: { status: AssetStatus; isActive?: boolean }, scope: AssetScope): boolean {
  return scope === 'all' || (scope === 'active' ? isOperationalAsset(asset) : asset.status === 'DECOMMISSIONED' && asset.isActive === false);
}

export function validateMovement(form: MovementForm): MovementErrors {
  const errors: MovementErrors = {};
  if (!form.productId) errors.productId = 'Selecciona un producto.';
  const quantity = Number(form.quantity);
  const minimum = form.type === 'ADJUSTMENT' ? -2147483648 : 1;
  if (!form.quantity.trim() || !Number.isInteger(quantity) || quantity < minimum || quantity > 2147483647 || quantity === 0) {
    errors.quantity = form.type === 'ADJUSTMENT' ? 'Ingresa un ajuste entero distinto de cero dentro del rango permitido.' : 'Ingresa una cantidad entera entre 1 y 2.147.483.647.';
  }
  if (form.type === 'ADJUSTMENT' && !form.reason.trim()) errors.reason = 'Escribe el motivo del ajuste.';
  if (form.reason.trim().length > 10000) errors.reason = 'El motivo no puede superar los 10.000 caracteres.';
  if (form.reference.trim().length > 160) errors.reference = 'La referencia no puede superar los 160 caracteres.';
  if (form.effectiveAt || form.effectiveTime) {
    if (!form.effectiveAt) errors.effectiveAt = 'Selecciona la fecha efectiva.';
    if (!form.effectiveTime) errors.effectiveTime = 'Ingresa la hora efectiva en Chile.';
    if (form.effectiveAt && form.effectiveTime) {
      try { inventoryDateTimeToUtc(form.effectiveAt, form.effectiveTime); }
      catch { errors.effectiveTime = 'La fecha u hora no es válida o coincide con un cambio de hora en Chile. Selecciona otra hora.'; }
    }
  }
  return errors;
}

export function movementPayload(form: MovementForm) {
  return {
    productId: form.productId, quantity: Number(form.quantity),
    reason: form.reason.trim() || null, reference: form.reference.trim() || null,
    ...(form.effectiveAt ? { effectiveAt: inventoryDateTimeToUtc(form.effectiveAt, form.effectiveTime) } : {})
  };
}
