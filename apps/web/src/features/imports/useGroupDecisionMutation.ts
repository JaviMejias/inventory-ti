import { useCallback, useEffect, useRef, useState } from 'react';
import { useRequestError, useToast } from '../../ui';
import { captureGroupDecisionIntent, groupDecisionNeedsRecovery, writeGroupDecision } from './identity-group-decision-api';
import { groupDecisionInput, type GroupDecisionContext, type GroupDecisionDraft, type GroupDecisionIntent, type GroupDecisionSaved } from './identity-group-decision-model';
import type { IdentityGroupReview } from './identity-group-review-model';

export function useGroupDecisionMutation(review: IdentityGroupReview, actorId: string) {
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false); const [needsContext, setNeedsContext] = useState(false);
  const [error, setError] = useState<string | null>(null); const [saved, setSaved] = useState<GroupDecisionSaved | null>(null);
  const intent = useRef<GroupDecisionIntent | null>(null); const pending = useRef(false); const active = useRef(true); const state = useRef<'ready' | 'review' | 'saved'>('ready');
  const report = useRequestError(); const { showToast } = useToast();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const reviewed = useCallback(() => { if (!pending.current && !intent.current && state.current !== 'saved') { state.current = 'ready'; setNeedsContext(false); setError(null); } }, []);
  async function save(context?: GroupDecisionContext, groupKey?: string, draft?: GroupDecisionDraft) {
    if (!active.current || pending.current || state.current === 'saved' || !intent.current && (state.current !== 'ready' || !context || !groupKey || !draft)) return;
    try { if (!intent.current && context && groupKey && draft) intent.current = captureGroupDecisionIntent({ review, actorId, projection: context.projection, input: groupDecisionInput(context, groupKey, draft, globalThis.crypto.randomUUID()) }); }
    catch (caught) { setError(report(caught, 'Revisa la decisión y su evidencia')); return; }
    if (!intent.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const receipt = await writeGroupDecision(intent.current);
      if (!active.current) return;
      state.current = 'saved'; intent.current = null; setSaved(receipt); setUncertain(false);
      showToast({ tone: 'success', title: receipt.reused ? 'Decisión recuperada' : 'Decisión guardada', description: 'Se conservó una decisión administrativa. El inventario y los vínculos de evidencia no cambiaron.' });
      return receipt;
    } catch (caught) {
      if (!active.current) return;
      setError(report(caught, 'No se pudo confirmar la decisión del grupo'));
      const unknown = groupDecisionNeedsRecovery(caught); setUncertain(unknown);
      if (!unknown) { intent.current = null; state.current = 'review'; setNeedsContext(true); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return { busy, uncertain, needsContext, error, saved, save, reviewed, requestId: intent.current?.input.requestId ?? null,
    locked: busy || uncertain || Boolean(saved), submitting: () => pending.current, blocked: () => pending.current || intent.current !== null || state.current === 'saved' };
}
