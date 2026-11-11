import type { PlanProduct } from './plan.js';
import { identifierKey } from './preview.js';

export const assetPilotHistoryFields = ['recipientText', 'officeText', 'loanCode', 'loanDate', 'usedDate', 'outgoingTicket', 'outgoingOt', 'details'] as const;

export function assetPilotProductBlockers(product: PlanProduct | undefined, observations: { fields: Record<string, string | null> }[]) {
  if (!product) return ['PRODUCT_NOT_FOUND'];
  const blockers: string[] = [];
  if (!product.isActive) blockers.push('PRODUCT_INACTIVE');
  if (product.trackingMode !== 'ASSET') blockers.push('PRODUCT_NOT_ASSET');
  for (const field of ['equipmentType', 'brand', 'model'] as const) {
    const selected = identifierKey(product[field]);
    if (selected && observations.some((record) => {
      const source = identifierKey(record.fields[field] ?? null);
      return source && source !== selected;
    })) blockers.push('SELECTED_PRODUCT_' + field.toUpperCase() + '_CONFLICT');
  }
  return blockers;
}
