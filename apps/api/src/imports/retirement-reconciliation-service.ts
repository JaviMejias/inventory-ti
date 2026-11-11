import { Prisma, type PrismaClient } from '@prisma/client';

import { readHistoricalRetirementPlan } from './retirement-plan-service.js';
import type { RetirementReconciliationInput } from './retirement-reconciliation-schemas.js';
import { buildRetirementReconciliation, reconciliationReceiptSelect } from './retirement-reconciliation.js';

export async function reconcileHistoricalRetirement(database: PrismaClient, assetId: string, input: RetirementReconciliationInput) {
  return database.$transaction(async (transaction) => {
    const plan = await readHistoricalRetirementPlan(transaction, assetId, { evidenceId: input.evidenceId,
      confirmation: 'VERIFIED_HISTORICAL_RETIREMENT', confirmedAt: null, dateEvidenceReference: null,
      note: 'Read-only reconciliation; no retirement confirmation', evidenceReference: 'Archived source only; no external date proof',
      acknowledgedWarnings: [] });
    // Both keys are unique: at most two receipts, never a silently truncated history.
    const receipts = await transaction.importRetirementApplication.findMany({ where: { OR: [{ assetId }, { evidenceId: input.evidenceId }] },
      select: reconciliationReceiptSelect, orderBy: { id: 'asc' } });
    return buildRetirementReconciliation(plan, receipts);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}
