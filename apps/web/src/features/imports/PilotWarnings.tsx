import { useState } from 'react';
import { Button, Field, Select } from '../../ui';
import type { PilotOperation, PlannedOperation } from './pilot-model';
import { pilotIssueLabel } from './pilot-issue-labels';

export function PilotWarnings({ planned, operations, disabled = false, update }: {
  planned: Pick<PlannedOperation, 'candidateId' | 'warnings'>[]; operations: PilotOperation[]; disabled?: boolean; update?: (operations: PilotOperation[]) => void;
}) {
  const [page, setPage] = useState(0);
  const recognizedMap = new Map(operations.map((operation) => [operation.candidateId, new Set(operation.acknowledgedWarnings)]));
  const warnings = planned.flatMap((operation) => operation.warnings.map((warning) => ({ operation, warning })));
  if (!warnings.length) return null;
  const current = Math.min(page, Math.ceil(warnings.length / 25) - 1);
  const start = current * 25;
  return <section className="space-y-3" aria-label={update ? 'Reconocer advertencias' : 'Advertencias del plan'}>
    <h3 className="font-semibold">Advertencias de la selección</h3>
    {warnings.slice(start, start + 25).map(({ operation, warning }) => {
      const recognized = recognizedMap.get(operation.candidateId)?.has(warning.id) ?? false;
      const source = warning.sheet ? warning.sheet + (warning.row !== null ? ' · fila ' + warning.row : '') : 'Análisis general';
      return update ? <Field key={operation.candidateId + warning.id} label={pilotIssueLabel(warning.code)} hint={source} disabled={disabled}>
        <Select value={recognized ? 'yes' : ''} onChange={(value) => update(operations.map((entry) => entry.candidateId === operation.candidateId ? { ...entry, acknowledgedWarnings: value === 'yes' ? [...new Set([...entry.acknowledgedWarnings, warning.id])] : entry.acknowledgedWarnings.filter((id) => id !== warning.id) } : entry))} options={[{ value: '', label: 'Pendiente de revisar' }, { value: 'yes', label: 'Revisada y reconocida para este equipo' }]} />
      </Field> : <div key={operation.candidateId + warning.id} className="inventory-metadata-section">
        <p>{pilotIssueLabel(warning.code)} · {recognized ? 'Reconocida en esta intención' : 'Sin reconocer'}</p>
        <p className="inventory-metadata-hint break-words">{source} · {warning.code} · {warning.id}</p>
      </div>;
    })}
    <div className="flex flex-wrap items-center gap-3">
      <p role="status">{start + 1}–{Math.min(start + 25, warnings.length)} de {warnings.length} advertencias</p>
      <Button size="sm" variant="secondary" disabled={current === 0 || disabled} onClick={() => setPage(current - 1)}>Anteriores</Button>
      <Button size="sm" variant="secondary" disabled={start + 25 >= warnings.length || disabled} onClick={() => setPage(current + 1)}>Siguientes</Button>
    </div>
    {update && <p className="inventory-metadata-hint">Reconocer exige volver a generar el plan. No elimina una incidencia bloqueante.</p>}
  </section>;
}
