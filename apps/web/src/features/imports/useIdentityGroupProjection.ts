import { useCallback, useEffect, useRef, useState } from 'react';
import { useRequestError } from '../../ui';
import { readIdentityGroupProjection } from './identity-group-projection-api';
import type { IdentityGroupProjection } from './identity-group-projection-model';
import type { IdentityGroupReview } from './identity-group-review-model';

export function useIdentityGroupProjection(review: IdentityGroupReview | null, open: boolean) {
  const [data, setData] = useState<IdentityGroupProjection | null>(null); const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null); const [fresh, setFresh] = useState(false);
  const controller = useRef<globalThis.AbortController | null>(null); const active = useRef(true); const pending = useRef(false);
  const enabled = useRef(open);
  const report = useRequestError();
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  const refresh = useCallback(async () => {
    if (!active.current || !enabled.current || !open || !review || pending.current && !controller.current?.signal.aborted) return;
    const current = new globalThis.AbortController(); controller.current = current; pending.current = true;
    setReading(true); setFresh(false); setError(null);
    try {
      const result = await readIdentityGroupProjection(review, current.signal);
      if (active.current && !current.signal.aborted) { setData(result); setFresh(true); }
    } catch (caught) {
      if (active.current && !current.signal.aborted) setError(report(caught, 'No se pudo consultar la situación actual de los grupos'));
    } finally { if (active.current && !current.signal.aborted) { pending.current = false; setReading(false); } }
  }, [review, open, report]);
  useEffect(() => {
    enabled.current = open;
    if (open) void refresh();
    else { controller.current?.abort(); pending.current = false; setReading(false); setFresh(false); }
    return () => { enabled.current = false; controller.current?.abort(); };
  }, [open, refresh]);
  return { data, reading, error, fresh, refresh };
}
