import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../../lib/api';
import { useRequestError } from '../../ui';
import type { ImportPreview } from './import-review-model';
import type { ResolvedReviewSource } from './source-review-model';
import { readIdentityGroupContext, readIdentityGroupPlan } from './identity-group-api';
import type { IdentityGroupInput, IdentityGroupPlan } from './identity-group-model';

export function useIdentityGroupPlan(batchId: string, original: ImportPreview) {
  const [context, setContext] = useState<ResolvedReviewSource | null>(null);
  const [contextFresh, setContextFresh] = useState(false);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [plan, setPlan] = useState<IdentityGroupPlan | null>(null);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readController = useRef<globalThis.AbortController | null>(null);
  const planController = useRef<globalThis.AbortController | null>(null);
  const readPending = useRef(false);
  const planPending = useRef(false);
  const active = useRef(true);
  const ready = useRef(false);
  const confirmedContext = useRef<ResolvedReviewSource | null>(null);
  const reportError = useRequestError();
  const refresh = useCallback(async () => {
    if (!active.current || readPending.current && !readController.current?.signal.aborted) return;
    planController.current?.abort(); planPending.current = false; setFresh(false); setBusy(false); setError(null);
    const current = new globalThis.AbortController(); readController.current = current; readPending.current = true;
    ready.current = false; setReading(true); setReadError(null); setContextFresh(false);
    try {
      const result = await readIdentityGroupContext(batchId, original, current.signal);
      if (active.current && !current.signal.aborted) { confirmedContext.current = result; ready.current = true; setContext(result); setContextFresh(true); }
    } catch (caught) {
      if (active.current && !current.signal.aborted) setReadError(reportError(caught, 'No se pudo confirmar el contexto de agrupación. Se conserva el borrador.'));
    } finally {
      if (active.current && !current.signal.aborted) { readPending.current = false; setReading(false); }
    }
  }, [batchId, original, reportError]);
  useEffect(() => {
    active.current = true; void refresh();
    return () => { active.current = false; readController.current?.abort(); planController.current?.abort(); };
  }, [refresh]);
  function invalidate() { planController.current?.abort(); planPending.current = false; setFresh(false); setBusy(false); setError(null); }
  function cancel() {
    invalidate();
    if (readPending.current) { readController.current?.abort(); readPending.current = false; ready.current = false; setReading(false); setContextFresh(false); }
  }
  async function generate(input: IdentityGroupInput) {
    if (!active.current || planPending.current || readPending.current || !ready.current || input.expectedVersion !== confirmedContext.current?.batchVersion || input.expectedSourceRevision !== confirmedContext.current?.sourceContext.revision) return;
    const current = new globalThis.AbortController(); planController.current = current; planPending.current = true;
    setBusy(true); setFresh(false); setError(null);
    try {
      const result = await readIdentityGroupPlan(batchId, globalThis.structuredClone(input), original, current.signal);
      if (active.current && !current.signal.aborted) { setPlan(result); setFresh(true); return result; }
    } catch (caught) {
      if (active.current && !current.signal.aborted) {
        setError(reportError(caught, 'No se pudo simular la agrupación'));
        if (caught instanceof ApiRequestError && ['REVIEW_VERSION_CONFLICT', 'SOURCE_REVISION_CONFLICT'].includes(caught.code ?? '')) { ready.current = false; setContextFresh(false); }
      }
    } finally {
      if (active.current && !current.signal.aborted) { planPending.current = false; setBusy(false); }
    }
  }
  return { context, contextFresh, reading, readError, plan, fresh, busy, error, refresh, generate, invalidate, cancel };
}
