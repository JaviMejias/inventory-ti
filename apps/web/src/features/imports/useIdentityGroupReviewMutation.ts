import { useCallback, useEffect, useRef, useState } from 'react';
import { useRequestError, useToast } from '../../ui';
import type { ImportPreview } from './import-review-model';
import { identityGroupReviewNeedsRecovery, writeIdentityGroupReview } from './identity-group-review-api';
import { releaseIdentityGroupIntent, reserveIdentityGroupIntent, type IdentityGroupReview, type IdentityGroupReviewIntent } from './identity-group-review-model';
import type { IdentityGroupPlan } from './identity-group-model';

export function useIdentityGroupReviewMutation(batchId: string, actorId: string, original: ImportPreview) {
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false);
  const [needsReview, setNeedsReview] = useState(false); const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<IdentityGroupReview | null>(null);
  const intent = useRef<IdentityGroupReviewIntent | null>(null); const state = useRef<'ready' | 'review' | 'saved'>('ready');
  const pending = useRef(false); const active = useRef(true);
  const reportError = useRequestError(); const { showToast } = useToast();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const reviewed = useCallback(() => { if (!pending.current && !intent.current && state.current !== 'saved') { state.current = 'ready'; setNeedsReview(false); setError(null); } }, []);
  async function run(makeIntent?: () => IdentityGroupReviewIntent) {
    if (!active.current || pending.current || state.current === 'saved' || !intent.current && (state.current !== 'ready' || !makeIntent)) return;
    try { if (!intent.current && makeIntent) intent.current = makeIntent(); }
    catch (caught) { setError(reportError(caught, 'Revisa la propuesta de agrupación')); return; }
    if (!intent.current) return;
    pending.current = true; setBusy(true); setError(null);
    const operation = intent.current.kind;
    try {
      const receipt = await writeIdentityGroupReview(intent.current, original);
      if (!active.current) return;
      state.current = 'saved'; intent.current = null; setSaved(receipt); setUncertain(false);
      showToast({ tone: 'success', title: receipt.release ? 'Revisión cancelada' : 'Revisión reservada', description: receipt.release ? 'El comprobante se conserva y sus filas quedaron liberadas. El inventario no cambió.' : 'Las filas quedaron reservadas para esta revisión. No se crearon ni modificaron activos.' });
      return receipt;
    } catch (caught) {
      if (!active.current) return;
      setError(reportError(caught, operation === 'reserve' ? 'No se pudo confirmar la reserva' : 'No se pudo confirmar la cancelación'));
      const unknown = identityGroupReviewNeedsRecovery(caught); setUncertain(unknown);
      if (!unknown) { state.current = 'review'; intent.current = null; setNeedsReview(true); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return { busy, uncertain, needsReview, error, saved, reviewed, recover: () => run(),
    reserve: (plan: IdentityGroupPlan) => run(() => reserveIdentityGroupIntent(batchId, actorId, plan, original, globalThis.crypto.randomUUID())),
    release: (review: IdentityGroupReview, note: string) => run(() => releaseIdentityGroupIntent(batchId, actorId, review, note, globalThis.crypto.randomUUID())),
    requestId: intent.current?.input.requestId ?? null, locked: busy || uncertain || Boolean(saved), submitting: () => pending.current,
    blocked: () => pending.current || intent.current !== null || state.current === 'saved'
  };
}
