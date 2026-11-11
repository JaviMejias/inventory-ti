import { useEffect, useRef, useState } from 'react';
import { useRequestError, useToast } from '../../ui';
import { getRetirementApplicationErrorMessage, retirementApplicationNeedsRecovery, saveRetirementApplication } from './retirement-application-api';
import { createRetirementApplicationIntent, type RetirementApplication, type RetirementApplicationIntent } from './retirement-application-model';
import type { RetirementPlan } from './retirement-plan-model';

export function useRetirementApplication(assetId: string, actorId: string) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsPlan, setNeedsPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<RetirementApplication | null>(null);
  const intent = useRef<RetirementApplicationIntent | null>(null);
  const outcome = useRef<'ready' | 'review' | 'saved'>('ready');
  const pending = useRef(false);
  const active = useRef(true);
  const reportError = useRequestError();
  const { showToast } = useToast();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function reviewed() {
    if (pending.current || intent.current || outcome.current === 'saved') return;
    outcome.current = 'ready'; setNeedsPlan(false); setError(null);
  }
  async function save(plan?: RetirementPlan) {
    if (!active.current || pending.current || outcome.current === 'saved' || (!intent.current && (!plan?.planValidationComplete || outcome.current !== 'ready'))) return;
    if (!intent.current && plan) intent.current = createRetirementApplicationIntent(plan, globalThis.crypto.randomUUID());
    if (!intent.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const receipt = await saveRetirementApplication(assetId, intent.current, actorId);
      if (!active.current) return;
      outcome.current = 'saved'; intent.current = null;
      setSaved(receipt); setUncertain(false);
      showToast({ tone: 'success', title: 'Baja histórica aplicada', description: 'El activo quedó dado de baja definitivamente. Se conserva el comprobante y el stock por cantidad no cambió.' });
      return receipt;
    } catch (caught) {
      if (!active.current) return;
      setError(reportError(caught, getRetirementApplicationErrorMessage(caught)));
      const unknown = retirementApplicationNeedsRecovery(caught); setUncertain(unknown);
      if (!unknown) { outcome.current = 'review'; intent.current = null; setNeedsPlan(true); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return { save, reviewed, busy, uncertain, needsPlan, error, saved, requestId: intent.current?.requestId ?? null,
    locked: busy || uncertain || Boolean(saved), submitting: () => pending.current,
    blocked: () => pending.current || intent.current !== null || outcome.current === 'saved' };
}
