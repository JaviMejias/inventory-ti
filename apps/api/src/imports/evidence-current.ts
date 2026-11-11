import type { ImportEvidenceAmendment, ImportHistoricalEvidence } from '@prisma/client';

export const latestAmendmentInclude = { amendments: { orderBy: { version: 'desc' as const }, take: 1 } };

export function currentHistoricalEvidence<T extends ImportHistoricalEvidence & { capture: { sourceRevision: number }; amendments: ImportEvidenceAmendment[] }>(evidence: T) {
  const { amendments, ...original } = evidence;
  const latest = amendments[0];
  return { ...original, assetId: latest ? latest.assetId : original.assetId, effectiveDay: latest ? latest.effectiveDay : original.effectiveDay,
    snapshot: latest ? latest.snapshot : original.snapshot, effectiveSourceRevision: latest?.sourceRevision ?? original.capture.sourceRevision,
    evidenceVersion: latest?.version ?? 0, amendmentId: latest?.id ?? null, amendedAt: latest?.amendedAt ?? null,
    capturedAssetId: original.assetId, capturedEffectiveDay: original.effectiveDay, capturedSourceRevision: original.capture.sourceRevision };
}
