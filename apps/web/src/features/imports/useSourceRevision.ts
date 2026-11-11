import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, getApiErrorMessage } from '../../lib/api';
import { useRequestError, useToast } from '../../ui';
import { readResolvedReviewSource, saveSourceRevision } from './source-review-api';
import type { ResolvedReviewSource, RevisionIntent, SourceEvent } from './source-review-model';

export function useSourceRevision(batchId: string, changed: () => void) {
  const [source, setSource] = useState<ResolvedReviewSource | null>(null);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [saved, setSaved] = useState<SourceEvent | null>(null);
  const intent = useRef<RevisionIntent | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const controller = useRef<globalThis.AbortController | null>(null);
  const reportError = useRequestError();
  const { showToast } = useToast();
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new globalThis.AbortController();
    controller.current = current;
    setReading(true); setReadError(null);
    try {
      const value = await readResolvedReviewSource(batchId, current.signal);
      if (!current.signal.aborted) { setSource(value); setNeedsRefresh(false); }
    } catch (error) {
      if (!current.signal.aborted) setReadError(getApiErrorMessage(error, 'No se pudo consultar la interpretación vigente.'));
    } finally { if (!current.signal.aborted) setReading(false); }
  }, [batchId]);
  useEffect(() => {
    active.current = true; void refresh();
    return () => { active.current = false; controller.current?.abort(); };
  }, [refresh]);
  async function save(next?: RevisionIntent): Promise<boolean> {
    if (pending.current || (!uncertain && (!next || !source || reading || readError || needsRefresh))) return false;
    if (!uncertain && next) intent.current = globalThis.structuredClone(next);
    if (!intent.current) return false;
    pending.current = true; setBusy(true); setWriteError(null);
    try {
      const result = await saveSourceRevision(batchId, intent.current);
      if (!active.current) return false;
      setSaved(result); setUncertain(false); intent.current = null;
      showToast({ tone: 'success', title: 'Revisión de origen guardada', description: 'Se conservó la evidencia original. No se modificó el inventario.' });
      changed();
      // An idempotent recovery may return an older event. Never replace the current head with that revision.
      await refresh();
      return true;
    } catch (error) {
      if (!active.current) return false;
      setWriteError(reportError(error, 'No se pudo guardar la revisión del origen'));
      const unknown = !(error instanceof ApiRequestError) || ['NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code ?? '') || error.status >= 500;
      setUncertain(unknown);
      if (!unknown) { intent.current = null; setNeedsRefresh(error instanceof ApiRequestError && ['SOURCE_REVISION_CONFLICT', 'REVIEW_VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'SOURCE_TARGET_ALREADY_APPLIED'].includes(error.code ?? '')); }
      return false;
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return { source, reading, readError, writeError, busy, uncertain, needsRefresh, saved, refresh, save,
    locked: busy || uncertain || reading || Boolean(readError) || needsRefresh || !source };
}
