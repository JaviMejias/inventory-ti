import { useEffect, useRef, useState } from 'react';
import { useRequestError } from '../../ui';
import { readRetirementReconciliation } from './retirement-reconciliation-api';
import type { RetirementReconciliation } from './retirement-reconciliation-model';

export function useRetirementReconciliation(assetId: string) {
  const [assessment, setAssessment] = useState<RetirementReconciliation | null>(null);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<globalThis.AbortController | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const reportError = useRequestError();
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; controller.current?.abort(); };
  }, [assetId]);
  function invalidate() {
    controller.current?.abort(); pending.current = false;
    setFresh(false); setBusy(false); setError(null);
  }
  async function consult(evidenceId: string) {
    if (!active.current || pending.current) return;
    const current = new globalThis.AbortController();
    controller.current = current; pending.current = true; setBusy(true); setFresh(false); setError(null);
    try {
      const result = await readRetirementReconciliation(assetId, evidenceId, current.signal);
      if (active.current && !current.signal.aborted) { setAssessment(result); setFresh(true); return result; }
    } catch (caught) {
      if (active.current && !current.signal.aborted) setError(reportError(caught, 'No se pudo consultar la conciliación. Se conserva la selección y el resultado anterior sin confirmar su vigencia.'));
    } finally {
      if (active.current && !current.signal.aborted) { pending.current = false; setBusy(false); }
    }
  }
  return { assessment, fresh, busy, error, consult, invalidate };
}
