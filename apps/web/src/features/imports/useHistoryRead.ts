import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiErrorMessage } from '../../lib/api';

export function useHistoryRead<T>(read: (signal: globalThis.AbortSignal) => Promise<T>, fallback: string) {
  const [data, setData] = useState<T | null>(null);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<globalThis.AbortController | null>(null);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current && !controller.current?.signal.aborted) return;
    const current = new globalThis.AbortController();
    controller.current = current; pending.current = true;
    setReading(true); setError(null);
    try {
      const result = await read(current.signal);
      if (!current.signal.aborted) setData(result);
    } catch (caught) { if (!current.signal.aborted) setError(getApiErrorMessage(caught, fallback)); }
    finally { if (!current.signal.aborted) { pending.current = false; setReading(false); } }
  }, [read, fallback]);
  useEffect(() => { void refresh(); return () => controller.current?.abort(); }, [refresh]);
  return { data, reading, error, refresh };
}
