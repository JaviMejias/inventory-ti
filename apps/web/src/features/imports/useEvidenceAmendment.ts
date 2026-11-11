import { useEffect, useRef, useState } from 'react';
import { useRequestError, useToast } from '../../ui';
import { amendmentNeedsRecovery, readAmendmentPlan, saveAmendment } from './evidence-amendment-api';
import { createAmendmentIntent, type AmendmentDraft, type AmendmentIntent, type AmendmentPlan, type EvidenceAmendment, type EvidenceOwner } from './evidence-amendment-model';

export function useEvidenceAmendment(owner: EvidenceOwner, actorId: string) {
  const [plan, setPlan] = useState<AmendmentPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<EvidenceAmendment | null>(null);
  const controller = useRef<globalThis.AbortController | null>(null);
  const reviewed = useRef<AmendmentPlan | null>(null);
  const intent = useRef<{ body: AmendmentIntent; plan: AmendmentPlan } | null>(null);
  const pending = useRef(false); const active = useRef(true); const done = useRef(false);
  const reportError = useRequestError(); const { showToast } = useToast();
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  function blocked() { return pending.current || intent.current !== null || done.current; }
  function invalidate() {
    if (blocked()) return;
    controller.current?.abort(); controller.current = null; reviewed.current = null; setPlanning(false); setPlan(null); setError(null);
  }
  async function generate(assetId: string | null) {
    if (blocked() || controller.current) return;
    const request = new globalThis.AbortController(); controller.current = request; reviewed.current = null; setPlanning(true); setPlan(null); setError(null);
    try {
      const result = await readAmendmentPlan(owner, assetId, request.signal);
      if (!active.current || request.signal.aborted || controller.current !== request) return;
      reviewed.current = result; setPlan(result); return result;
    } catch (caught) {
      if (active.current && !request.signal.aborted) setError(reportError(caught, 'No se pudo preparar la enmienda documental.'));
    } finally { if (controller.current === request) { controller.current = null; if (active.current) setPlanning(false); } }
  }
  async function save(reviewedPlan?: AmendmentPlan, draft?: AmendmentDraft) {
    if (pending.current || done.current || controller.current) return;
    if (!intent.current) {
      if (!reviewedPlan || !draft || reviewedPlan !== reviewed.current || !reviewedPlan.valid) return;
      intent.current = { body: createAmendmentIntent(reviewedPlan, draft, globalThis.crypto.randomUUID()), plan: globalThis.structuredClone(reviewedPlan) };
    }
    const frozen = intent.current;
    pending.current = true; setSaving(true); setError(null);
    try {
      const result = await saveAmendment(frozen.plan, frozen.body, actorId);
      if (!active.current) return;
      done.current = true; intent.current = null; setUncertain(false); setSaved(result);
      showToast({ tone: 'success', title: 'Versión documental guardada', description: 'La captura original y el inventario actual no se modificaron.' });
      return result;
    } catch (caught) {
      if (!active.current) return;
      setError(reportError(caught, 'No se pudo confirmar la nueva versión documental.'));
      const unknown = amendmentNeedsRecovery(caught); setUncertain(unknown);
      if (!unknown) { intent.current = null; reviewed.current = null; setPlan(null); }
    } finally { pending.current = false; if (active.current) setSaving(false); }
  }
  return { plan, planning, saving, uncertain, error, saved, generate, invalidate, save, blocked, submitting: () => pending.current, requestId: intent.current?.body.requestId ?? null };
}
