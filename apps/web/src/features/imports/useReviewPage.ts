import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiErrorMessage } from '../../lib/api';
import { readReviewPage } from './import-review-api';
import { appendServerPage, type ServerPage } from './import-review-model';

const emptyPage = { items: [], total: 0, hasMore: false, nextOffset: 0 };
export function useReviewPage<Row extends { id: string }>(path: string, kind: 'batches' | 'decisions' | 'applications') {
  const [page, setPage] = useState<ServerPage<Row>>(emptyPage);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryOffset, setRetryOffset] = useState(0);
  const controller = useRef<globalThis.AbortController | null>(null);
  const pending = useRef(false);
  const load = useCallback(async (offset = 0) => {
    controller.current?.abort();
    const current = new globalThis.AbortController();
    controller.current = current;
    pending.current = true;
    setLoading(true);
    setError(null);
    setRetryOffset(offset);
    try {
      const result = await readReviewPage<Row>(`${path}${path.includes('?') ? '&' : '?'}limit=25&offset=${offset}`, kind, current.signal);
      if (!current.signal.aborted) setPage((previous) => appendServerPage(previous, result.rows, result.total, result.hasMore, offset));
    } catch (caughtError) {
      if (!current.signal.aborted) setError(getApiErrorMessage(caughtError, 'No se pudo cargar la revisión.'));
    } finally {
      if (!current.signal.aborted) { pending.current = false; setLoading(false); }
    }
  }, [path, kind]);
  useEffect(() => {
    setPage(emptyPage);
    void load();
    return () => controller.current?.abort();
  }, [load]);
  return { page, loading, error, reload: () => load(0), retry: () => load(retryOffset), more: () => { if (!pending.current && page.hasMore && !error) void load(page.nextOffset); } };
}
