import type { Prisma } from '@prisma/client';

export const retirementImportSelect = { id: true, evidenceId: true, evidenceVersion: true, amendmentId: true, sourceRevision: true,
  decommissionedAt: true, appliedById: true, appliedAt: true } satisfies Prisma.ImportRetirementApplicationSelect;

type Retirement = Prisma.ImportRetirementApplicationGetPayload<{ select: typeof retirementImportSelect }>;
export const groupRetirementImportSelect = { ...retirementImportSelect, batchId: true, reviewId: true, groupKey: true, groupId: true } satisfies Prisma.ImportGroupRetirementApplicationSelect;
type GroupRetirement = Prisma.ImportGroupRetirementApplicationGetPayload<{ select: typeof groupRetirementImportSelect }>;

export function retirementHistoryEvents(retirement: Retirement | null, group: GroupRetirement | null = null) {
  return [...(retirement ? [{ id: 'import-retirement-' + retirement.id, kind: 'status', action: 'ASSET_DECOMMISSIONED', source: 'IMPORTED_HISTORY',
    effectiveAt: retirement.decommissionedAt, recordedAt: retirement.appliedAt, actor: null, recordedById: retirement.appliedById,
    importApplicationId: retirement.id, evidenceId: retirement.evidenceId, evidenceVersion: retirement.evidenceVersion }] : []),
  ...(group ? [{ id: 'import-group-retirement-' + group.id, kind: 'status', action: 'ASSET_DECOMMISSIONED', source: 'IMPORTED_HISTORY', importScope: 'GROUP_HISTORICAL_RETIREMENT',
    effectiveAt: group.decommissionedAt, recordedAt: group.appliedAt, actor: null, recordedById: group.appliedById,
    importApplicationId: group.id, groupRetirementApplicationId: group.id, batchId: group.batchId, reviewId: group.reviewId, groupKey: group.groupKey,
    evidenceId: group.evidenceId, evidenceVersion: group.evidenceVersion }] : [])];
}
