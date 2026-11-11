import { sheetDictionary } from './dictionary.js';
import { importPlanDigest, type PlanDecision } from './plan.js';
import { identifierKey, type buildWorkbookPreview, type PreviewIssue } from './preview.js';
import type { SourceContext } from './source.js';
import type { HistoricalKind, HistoryCaptureInput } from './history-schemas.js';

export const historyRulesVersion = 'mda-history-evidence-1';
type Preview = ReturnType<typeof buildWorkbookPreview>;
type Record = Preview['records'][number];
export type HistoryAppliedItem = { id: string; candidateId: string; assetId: string };

function hasField(record: Record, field: string) {
  const column = Object.entries(sheetDictionary[record.sheet].columns).find(([, mapping]) => mapping.field === field)?.[0];
  const cell = column ? record.originalCells[column] : undefined;
  return Boolean(cell && (['formula', 'error'].includes(cell.type) || identifierKey(String(cell.value)) !== null));
}

function observationDate(record: Record, kind: HistoricalKind, asOf: string) {
  const field = kind === 'RECEIPT_OBSERVATION' ? 'receivedDate' : kind === 'USAGE_OBSERVATION' ? 'usedDate' : kind === 'LOAN_OBSERVATION' ? 'loanDate' : null;
  const value = field ? record.fields[field] ?? null : null;
  const day = value?.slice(0, 10) ?? null;
  const parsed = value && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.test(value) ? new Date(day + 'T00:00:00Z') : null;
  const valid = parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day && day! >= '1900-01-01' && day! <= asOf;
  // Fecha on retirement sheets is reception evidence, not a verified retirement timestamp.
  return { effectiveDay: valid ? day : null, datePrecision: valid ? 'DAY' as const : 'UNKNOWN' as const,
    dateField: field, sourceDateText: value, dateUncertainty: valid ? null : field === null ? 'RETIREMENT_DATE_NOT_MAPPED' : hasField(record, field) ? 'DATE_UNCONFIRMED' : 'DATE_NOT_REPORTED' };
}

export function historyRequestDigest(input: HistoryCaptureInput) {
  return importPlanDigest({ ...input, records: [...input.records].sort((a, b) => (a.recordId + a.kind).localeCompare(b.recordId + b.kind)) });
}

export function buildHistoricalObservations(original: Preview, effective: Preview, sourceContext: SourceContext) {
  const originalRecords = new Map(original.records.map((record) => [record.id, record]));
  const candidates = new Map(effective.candidates.flatMap((candidate) => candidate.recordIds.map((id) => [id, candidate] as const)));
  const candidateIssues = new Map<string, PreviewIssue[]>();
  const rowIssues = new Map<string, PreviewIssue[]>();
  const sheetIssues = new Map<string, PreviewIssue[]>();
  for (const issue of effective.issues) {
    const index = issue.candidateId !== null ? candidateIssues : issue.row !== null ? rowIssues : sheetIssues;
    const key = issue.candidateId ?? (issue.row !== null ? issue.sheet + ':' + issue.row : issue.sheet ?? '');
    const bucket = index.get(key);
    if (bucket) bucket.push(issue);
    else index.set(key, [issue]);
  }
  const blockedCandidates = new Set<string>();
  for (const record of effective.records) {
    const candidate = candidates.get(record.id);
    if (!candidate) continue;
    const issues = [...(candidateIssues.get(candidate.id) ?? []), ...(rowIssues.get(record.sheet + ':' + record.row) ?? []), ...(sheetIssues.get(record.sheet) ?? [])];
    const identityFormula = Object.entries(sheetDictionary[record.sheet].columns).some(([column, mapping]) =>
      ['serialNumber', 'assetTag'].includes(mapping.field) && ['formula', 'error'].includes(record.originalCells[column]?.type));
    if (identityFormula || issues.some((issue) => identityBlockers.has(issue.code))) blockedCandidates.add(candidate.id);
  }
  return effective.records.flatMap((record) => {
    const candidate = candidates.get(record.id);
    if (!candidate) return [];
    const kinds: HistoricalKind[] = [];
    if (['receivedDate', 'incomingTicket', 'incomingOt', 'purchaseOrder'].some((field) => hasField(record, field))) kinds.push('RECEIPT_OBSERVATION');
    if (['usedDate', 'outgoingTicket', 'outgoingOt', 'recipientText', 'officeText', 'details'].some((field) => hasField(record, field))) kinds.push('USAGE_OBSERVATION');
    if (record.sheet === 'NB Prestamo' || ['loanDate', 'loanCode'].some((field) => hasField(record, field))) kinds.push('LOAN_OBSERVATION');
    if (record.kind === 'RETIREMENT_HISTORY' || record.statusEvidence === 'DECOMMISSIONED') kinds.push('RETIREMENT_OBSERVATION');
    const issues = [...(candidateIssues.get(candidate.id) ?? []), ...(rowIssues.get(record.sheet + ':' + record.row) ?? []), ...(sheetIssues.get(record.sheet) ?? [])];
    const identityLinkBlocked = blockedCandidates.has(candidate.id);
    return kinds.map((kind) => ({ recordId: record.id, candidateId: candidate.id, kind, ...observationDate(record, kind, effective.asOf),
      original: originalRecords.get(record.id)!, effective: record, issues,
      sourceCorrections: sourceContext.corrections.filter((entry) => entry.recordId === record.id),
      suggestedAssets: candidate.existingAssets, identityLinkBlocked, historicalActorId: null, affectsCurrentState: false }));
  }).sort((a, b) => (a.recordId + a.kind).localeCompare(b.recordId + b.kind));
}
export type HistoricalObservation = ReturnType<typeof buildHistoricalObservations>[number];

const identityBlockers = new Set(['MISSING_ASSET_IDENTITY', 'NUMERIC_SERIAL_REQUIRES_REVIEW', 'NUMERIC_TAG_PRECISION_RISK',
  'NUMERIC_TAG_FORMAT_REQUIRES_REVIEW', 'IDENTIFIER_TYPE_REQUIRES_REVIEW', 'SERIAL_HAS_MULTIPLE_TAGS', 'TAG_HAS_MULTIPLE_SERIALS',
  'AMBIGUOUS_EXISTING_ASSET', 'EXISTING_SERIAL_CONFLICT', 'EXISTING_TAG_CONFLICT']);

export function historicalLinkBasis(observation: HistoricalObservation, assetId: string | null, decisions: PlanDecision[], applied: HistoryAppliedItem[], sourceContext: SourceContext) {
  if (assetId === null) return null;
  const receipt = applied.find((item) => item.candidateId === observation.candidateId);
  if (receipt) return receipt.assetId === assetId ? { type: 'PILOT_RECEIPT' as const, id: receipt.id } : undefined;
  const decision = decisions.find((entry) => entry.targetType === 'CANDIDATE' && entry.targetId === observation.candidateId);
  const revision = sourceContext.identityRevisions?.find((entry) => entry.candidateId === observation.candidateId)?.revision ?? 0;
  const mapping = sheetDictionary[observation.effective.sheet];
  const unsafeFormula = observation.issues.some((issue) => ['FORMULA_REQUIRES_REVIEW', 'EXCEL_CELL_ERROR'].includes(issue.code) && issue.cell &&
    ['serialNumber', 'assetTag'].includes(mapping.columns[issue.cell.replace(/\d+$/, '')]?.field));
  if (observation.identityLinkBlocked || unsafeFormula || observation.issues.some((issue) => identityBlockers.has(issue.code)) || observation.suggestedAssets.length !== 1 ||
    observation.suggestedAssets[0].id !== assetId || decision?.action !== 'LINK_EXISTING' || decision.linkedAssetId !== assetId || (decision.sourceRevision ?? 0) < revision) return undefined;
  return { type: 'REVIEW_DECISION' as const, id: decision.id };
}
