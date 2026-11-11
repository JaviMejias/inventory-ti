import { useEffect, useRef, useState } from 'react';
import { useRequestError } from '../../ui';
import { readClosedAssignmentPlan } from './closed-assignment-api';
import type { ClosedPlan, ClosedPlanInput } from './closed-assignment-model';

export function useClosedAssignmentPlan(assetId: string) {
  const [plan, setPlan] = useState<ClosedPlan | null>(null);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<globalThis.AbortController | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const reportError = useRequestError();
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  function invalidate() {
    controller.current?.abort(); pending.current = false;
    setFresh(false); setBusy(false); setError(null);
  }
  async function generate(input: ClosedPlanInput) {
    if (!active.current || pending.current) return;
    const current = new globalThis.AbortController();
    controller.current = current; pending.current = true; setBusy(true); setFresh(false); setError(null);
    try {
      const result = await readClosedAssignmentPlan(assetId, globalThis.structuredClone(input), current.signal);
      if (!current.signal.aborted) { setPlan(result); setFresh(true); return result; }
    } catch (caught) { if (!current.signal.aborted) setError(reportError(caught, 'No se pudo preparar el periodo cerrado. El borrador se conserva.')); }
    finally { if (!current.signal.aborted) { pending.current = false; setBusy(false); } }
  }
  return { plan, fresh, busy, error, generate, invalidate };
}
