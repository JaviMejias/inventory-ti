import type { Prisma } from '@prisma/client';

export async function readConsumedGroupRows(transaction: Prisma.TransactionClient, sourceHash: string, recordIds: string[]) {
  const where = { sourceHash, recordId: { in: recordIds } };
  const rows = await transaction.importIdentityGroupRowUse.findMany({ where, select: { recordId: true } });
  const retirements = await transaction.importGroupRetirementRowUse.findMany({ where, select: { recordId: true } });
  return [...rows, ...retirements];
}
