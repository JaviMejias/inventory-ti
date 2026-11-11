import { useCallback, useEffect, useRef, useState } from 'react';
import { useRequestError } from '../../ui';
import { readGroupDecisionContext } from './identity-group-decision-api';
import type { GroupDecisionContext } from './identity-group-decision-model';
import type { IdentityGroupProjection } from './identity-group-projection-model';
import type { IdentityGroupReview } from './identity-group-review-model';

export function useGroupDecisionContext(review: IdentityGroupReview, initial: IdentityGroupProjection, open: boolean) {
  const [data, setData] = useState<GroupDecisionContext | null>(null); const [reading, setReading] = useState(false); const [fresh, setFresh] = useState(false); const [error, setError] = useState<string | null>(null);
  const controller = useRef<globalThis.AbortController | null>(null); const active = useRef(true); const enabled = useRef(open); const pending = useRef(false);
  const report = useRequestError();
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  const refresh = useCallback(async (first = false) => {
    if (!active.current || !enabled.current || !open || pending.current && !controller.current?.signal.aborted) return;
    const current = new globalThis.AbortController(); controller.current = current; pending.current = true;
    setReading(true); setFresh(false); setError(null);
    try {
      const context = await readGroupDecisionContext(review, current.signal, first ? initial : undefined);
      if (active.current && !current.signal.aborted) { setData(context); setFresh(true); return context; }
    } catch (caught) { if (active.current && !current.signal.aborted) setError(report(caught, 'No se pudo confirmar el contexto de decisiones')); }
    finally { if (active.current && !current.signal.aborted) { pending.current = false; setReading(false); } }
  }, [review, initial, open, report]);
  useEffect(() => { enabled.current = open; if (open) void refresh(true); else { controller.current?.abort(); pending.current = false; setReading(false); setFresh(false); } return () => { enabled.current = false; controller.current?.abort(); }; }, [open, refresh]);
  return { data, reading, fresh, error, refresh };
}
