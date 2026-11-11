export type ReviewAction = 'HOLD' | 'EXCLUDE' | 'LINK_EXISTING' | 'PROPOSE_NEW';
export type TargetType = 'CANDIDATE' | 'RECORD';
export type SourceCell = { type: string; value: string | number | boolean; numberFormat?: string; rawValue?: string; cachedValue?: string | number | boolean | null; formulaAttributes?: Record<string, string> };
export type SourceRecord = {
  id: string; sheet: string; row: number; hidden: boolean; kind: string;
  fields: Record<string, string | null>; originalCells: Record<string, SourceCell>;
  serialKey: string | null; tagKey: string | null; statusEvidence: 'AVAILABLE' | 'DECOMMISSIONED' | null;
};
export type Candidate = {
  id: string; serials: string[]; tags: string[]; recordIds: string[]; proposal: string;
  existingAssets: Array<{ id: string; serialNumber: string | null; assetTag: string | null; status: string; isActive: boolean; product: { name: string } }>;
};
export type PreviewIssue = { code: string; severity: 'BLOCKING' | 'WARNING' | 'INFO'; sheet: string | null; row: number | null; cell: string | null; candidateId: string | null };
export type ImportPreview = {
  mode: 'PREVIEW'; canApply: false; persisted: false; comparisonMode: string; previewId: string; asOf: string;
  source: { fileName: string; sha256: string }; summary: Record<string, number>;
  sheets: Array<{ name: string; kind: string; headerValid: boolean; populatedRows: number; recordCount: number; excludedCount: number; hidden: boolean; filterRange: string | null }>;
  records: SourceRecord[]; candidates: Candidate[]; issues: PreviewIssue[];
  excluded: Array<{ sheet: string; row: number; reason: string; originalCells: Record<string, SourceCell> }>;
};
export type ImportBatch = {
  id: string; sourceFileName: string; sourceHash: string; previewId: string; asOf: string;
  version: number; targetCount: number; createdById: string; createdAt: string; updatedAt: string;
  mode: 'REVIEW'; persisted: true; canApply: false;
};
export type ReviewSummary = {
  targetCount: number; reviewedTargetCount: number; unreviewedCount: number; holdCount: number;
  excludedCount: number; linkedCount: number; newProposalCount: number; pendingTargetCount: number; decisionCoverageComplete: boolean;
};
export type BatchDetail = { batch: ImportBatch; reviewSummary: ReviewSummary };
export type Freshness = { batchId: string; stale: boolean; rulesChanged: boolean; databaseChanged: boolean; reviewDateChanged: boolean; checkedAsOf: string; currentPreviewId: string; canApply: false };
export type ReviewDecision = {
  id: string; batchId: string; batchVersion: number; requestId: string; targetType: TargetType; targetId: string;
  action: ReviewAction; linkedAssetId: string | null; note: string; reviewedById: string; createdAt: string; sourceRevision?: number;
};
export type ReviewIntent = {
  expectedVersion: number; requestId: string; targetType: TargetType; targetId: string;
  action: ReviewAction; note: string; linkedAssetId?: string; expectedSourceRevision?: number;
};
export type ReviewTarget = { id: string; type: TargetType; label: string; kind: string; records: SourceRecord[]; candidate?: Candidate; issues: PreviewIssue[] };
export type ServerPage<T> = { items: T[]; total: number; hasMore: boolean; nextOffset: number };

export const reviewActionLabels: Record<ReviewAction, string> = {
  HOLD: 'Dejar pendiente', EXCLUDE: 'Excluir de la propuesta', LINK_EXISTING: 'Vincular con activo existente', PROPOSE_NEW: 'Proponer activo nuevo'
};
export const recordKindLabels: Record<string, string> = {
  ASSET_OBSERVATION: 'Observación de equipo', RETIREMENT_HISTORY: 'Historia de baja', CONSUMABLE_REVIEW: 'Consumible por revisar',
  MANUAL_SUMMARY: 'Resumen manual', SOURCE_NOTE: 'Nota de origen', UNMAPPED: 'Sin interpretación'
};
export const proposalLabels: Record<string, string> = {
  REVIEW_EXISTING: 'Coincidencia existente', REVIEW_MATCH: 'Coincidencia ambigua', REVIEW_NEW: 'Sin coincidencias',
  REVIEW_IDENTITY: 'Identidad por revisar', REVIEW_SOURCE_ONLY: 'Sin comparación con inventario'
};

export function buildReviewTargets(preview: ImportPreview): ReviewTarget[] {
  const recordsById = new Map(preview.records.map((record) => [record.id, record]));
  const byCandidate = new Map<string, PreviewIssue[]>();
  const bySheet = new Map<string, PreviewIssue[]>();
  const byRow = new Map<string, PreviewIssue[]>();
  const general: PreviewIssue[] = [];
  function add(index: Map<string, PreviewIssue[]>, key: string, issue: PreviewIssue) {
    const items = index.get(key) ?? [];
    items.push(issue);
    index.set(key, items);
  }
  for (const issue of preview.issues) {
    if (issue.candidateId) add(byCandidate, issue.candidateId, issue);
    else if (issue.sheet === null) general.push(issue);
    else if (issue.row === null) add(bySheet, issue.sheet, issue);
    else add(byRow, `${issue.sheet}:${issue.row}`, issue);
  }
  const physical = preview.candidates.map((candidate): ReviewTarget => ({
    id: candidate.id, type: 'CANDIDATE', label: candidate.serials.join(' / ') || candidate.tags.join(' / ') || 'Equipo sin identidad confirmada',
    kind: candidate.proposal, candidate, records: candidate.recordIds.flatMap((id) => recordsById.has(id) ? [recordsById.get(id)!] : []), issues: []
  }));
  const independent = preview.records.filter((record) => !['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(record.kind)).map((record): ReviewTarget => ({
    id: record.id, type: 'RECORD', label: `${record.sheet} · fila ${record.row}`, kind: record.kind, records: [record], issues: []
  }));
  return [...physical, ...independent].map((target) => ({ ...target, issues: [...new Set([
    ...general, ...(byCandidate.get(target.id) ?? []),
    ...target.records.flatMap((record) => [...(bySheet.get(record.sheet) ?? []), ...(byRow.get(`${record.sheet}:${record.row}`) ?? [])])
  ])] }));
}

export function availableReviewActions(target: ReviewTarget, stale: boolean): ReviewAction[] {
  const actions: ReviewAction[] = ['HOLD', 'EXCLUDE'];
  if (target.type !== 'CANDIDATE' || stale || !target.candidate) return actions;
  if (target.candidate.existingAssets.length) actions.push('LINK_EXISTING');
  if (target.candidate.proposal === 'REVIEW_NEW' && (target.candidate.serials.length || target.candidate.tags.length) && !target.candidate.existingAssets.length) actions.push('PROPOSE_NEW');
  return actions;
}

export function validateReviewDraft(target: ReviewTarget, stale: boolean, action: ReviewAction, note: string, linkedAssetId: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!availableReviewActions(target, stale).includes(action)) errors.action = 'Actualiza la revisión y selecciona una acción disponible.';
  if (!note.trim() || note.trim().length > 2000) errors.note = 'Escribe un motivo de entre 1 y 2.000 caracteres.';
  if (action === 'LINK_EXISTING' && !target.candidate?.existingAssets.some((asset) => asset.id === linkedAssetId)) errors.linkedAssetId = 'Selecciona uno de los activos sugeridos por el análisis.';
  return errors;
}

export function createReviewIntent(target: ReviewTarget, version: number, action: ReviewAction, note: string, linkedAssetId: string, requestId: string): ReviewIntent {
  return { expectedVersion: version, requestId, targetType: target.type, targetId: target.id, action, note: note.trim(), ...(action === 'LINK_EXISTING' ? { linkedAssetId } : {}) };
}

export function appendServerPage<T extends { id: string }>(previous: ServerPage<T>, received: T[], total: number, hasMore: boolean, offset: number): ServerPage<T> {
  const items = offset === 0 ? [] : previous.items;
  return { items: [...new Map([...items, ...received].map((item) => [item.id, item])).values()], total, hasMore, nextOffset: offset + received.length };
}
