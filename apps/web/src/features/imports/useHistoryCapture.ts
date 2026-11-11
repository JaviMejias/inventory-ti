import { useCallback, useEffect, useRef, useState } from 'react';
import { useRequestError, useToast } from '../../ui';
import { historyNeedsRecovery, readHistoryPreview, saveHistoryCapture } from './history-evidence-api';
import type { HistoryCapture, HistoryIntent } from './history-evidence-model';
import { useHistoryRead } from './useHistoryRead';

export function useHistoryCapture(batchId: string, offset: number, changed: () => void) {
  const read = useCallback((signal: globalThis.AbortSignal) => readHistoryPreview(batchId, offset, signal), [batchId, offset]);
  const preview = useHistoryRead(read, 'No se pudo consultar la evidencia histórica vigente.');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [saved, setSaved] = useState<HistoryCapture | null>(null);
  const intent = useRef<HistoryIntent | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const reportError = useRequestError();
  const { showToast } = useToast();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function refresh() {
    if (pending.current || uncertain || saved) return;
    await preview.refresh(); setNeedsRefresh(false);
  }
  async function save(next?: HistoryIntent) {
    if (pending.current || saved || (!uncertain && (!next || !preview.data || preview.reading || preview.error || needsRefresh))) return;
    if (!uncertain && next) intent.current = globalThis.structuredClone(next);
    if (!intent.current) return;
    pending.current = true; setBusy(true); setWriteError(null);
    try {
      const result = await saveHistoryCapture(batchId, intent.current);
      if (!active.current) return;
      setSaved(result); setUncertain(false); intent.current = null;
      showToast({ tone: 'success', title: 'Evidencia histórica guardada', description: 'No cambió el stock ni el estado de los activos.' });
      changed();
    } catch (error) {
      if (!active.current) return;
      setWriteError(reportError(error, 'No se pudo confirmar la captura histórica.'));
      const unknown = historyNeedsRecovery(error);
      setUncertain(unknown);
      if (!unknown) { intent.current = null; setNeedsRefresh(true); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return { preview: preview.data, reading: preview.reading, readError: preview.error, refresh, save, busy, uncertain, needsRefresh, writeError, saved, requestId: intent.current?.requestId ?? null,
    locked: busy || uncertain || Boolean(saved) || preview.reading || Boolean(preview.error) || needsRefresh || !preview.data };
}
