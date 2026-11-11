import { useEffect, useRef, useState } from 'react';
import { useRequestError, useToast } from '../../ui';
import { batchIntakeNeedsRecovery, createWorkbookBatch, previewWorkbook } from './workbook-intake-api';
import { captureBatchIntake, type BatchIntakeIntent, type DatabasePreview, type WorkbookInput } from './workbook-intake-model';
import type { ImportBatch } from './import-review-model';

export function useWorkbookIntake() {
  const [preview, setPreview] = useState<DatabasePreview | null>(null); const [reading, setReading] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null); const [uncertain, setUncertain] = useState(false); const [needsPreview, setNeedsPreview] = useState(false);
  const [saved, setSaved] = useState<ImportBatch | null>(null);
  const controller = useRef<globalThis.AbortController | null>(null); const readPending = useRef(false); const writePending = useRef(false); const active = useRef(true);
  const intent = useRef<{ request: BatchIntakeIntent; preview: DatabasePreview } | null>(null); const state = useRef<'ready' | 'review' | 'saved'>('ready'); const confirmedPreview = useRef<DatabasePreview | null>(null);
  const report = useRequestError(); const { showToast } = useToast();
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  function clear() { if (writePending.current || intent.current || state.current === 'saved') return; controller.current?.abort(); readPending.current = false; confirmedPreview.current = null; state.current = 'ready'; setPreview(null); setReading(false); setError(null); setNeedsPreview(false); }
  function cancelRead() { controller.current?.abort(); readPending.current = false; setReading(false); }
  async function generate(workbook: WorkbookInput) {
    if (!active.current || readPending.current || writePending.current || intent.current || state.current === 'saved') return;
    const current = new globalThis.AbortController(); controller.current = current; readPending.current = true; confirmedPreview.current = null; setReading(true); setError(null); setNeedsPreview(true);
    try {
      const result = await previewWorkbook(workbook, current.signal);
      if (!current.signal.aborted && active.current) { confirmedPreview.current = result; setPreview(result); setNeedsPreview(false); state.current = 'ready'; return result; }
    } catch (caught) { if (!current.signal.aborted && active.current) setError(report(caught, 'No se pudo generar la previsualización')); }
    finally { if (!current.signal.aborted && active.current) { readPending.current = false; setReading(false); } }
  }
  async function save(workbook?: WorkbookInput) {
    if (!active.current || readPending.current || writePending.current || state.current === 'saved' || !intent.current && (state.current !== 'ready' || !workbook || !confirmedPreview.current)) return;
    try { if (!intent.current && workbook && confirmedPreview.current) intent.current = { request: captureBatchIntake(workbook, confirmedPreview.current), preview: confirmedPreview.current }; }
    catch (caught) { setError(report(caught, 'Revisa el origen completo y sus límites antes de guardar')); return; }
    if (!intent.current) return;
    writePending.current = true; setBusy(true); setError(null);
    try {
      const receipt = await createWorkbookBatch(intent.current.request, intent.current.preview);
      if (!active.current) return;
      state.current = 'saved'; intent.current = null; setSaved(receipt.batch); setUncertain(false);
      showToast({ tone: 'success', title: receipt.reused ? 'Lote recuperado' : 'Lote de revisión guardado', description: 'El origen y su análisis quedaron guardados para revisión. No se crearon activos ni movimientos.' });
      return receipt.batch;
    } catch (caught) {
      if (!active.current) return;
      setError(report(caught, 'No se pudo confirmar el lote de revisión'));
      const unknown = batchIntakeNeedsRecovery(caught); setUncertain(unknown);
      if (!unknown) { state.current = 'review'; intent.current = null; confirmedPreview.current = null; setNeedsPreview(true); }
    } finally { writePending.current = false; if (active.current) setBusy(false); }
  }
  return { preview, reading, busy, error, uncertain, needsPreview, saved, generate, save, clear, cancelRead,
    locked: busy || uncertain || Boolean(saved), submitting: () => writePending.current,
    blocked: () => writePending.current || intent.current !== null || state.current === 'saved'
  };
}
