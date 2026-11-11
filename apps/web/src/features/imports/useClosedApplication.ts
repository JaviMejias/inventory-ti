import { useEffect, useRef, useState } from 'react';
import { useRequestError, useToast } from '../../ui';
import { closedApplicationNeedsRecovery, saveClosedApplication } from './closed-application-api';
import { createClosedApplicationIntent, type ClosedApplication, type ClosedApplicationIntent } from './closed-application-model';
import type { ClosedPlan } from './closed-assignment-model';

export function useClosedApplication(assetId: string, actorId: string) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsPlan, setNeedsPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ClosedApplication | null>(null);
  const intent = useRef<ClosedApplicationIntent | null>(null);
  const outcome = useRef<'ready' | 'review' | 'saved'>('ready');
  const pending = useRef(false); const active = useRef(true);
  const reportError = useRequestError(); const { showToast } = useToast();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function reviewed() { if (!pending.current && !intent.current && outcome.current !== 'saved') { outcome.current = 'ready'; setNeedsPlan(false); setError(null); } }
  async function save(plan?: ClosedPlan) {
    if (!active.current || pending.current || outcome.current === 'saved' || (intent.current === null && (!plan?.planValidationComplete || outcome.current !== 'ready'))) return;
    if (!intent.current && plan) intent.current = createClosedApplicationIntent(plan, globalThis.crypto.randomUUID());
    if (!intent.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const receipt = await saveClosedApplication(assetId, intent.current, actorId);
      if (!active.current) return;
      outcome.current = 'saved'; setSaved(receipt); setUncertain(false); intent.current = null;
      showToast({ tone: 'success', title: 'Periodo histórico aplicado', description: 'Se guardó historia cerrada; el estado actual y el stock no cambiaron.' });
      return receipt;
    } catch (caught) {
      if (!active.current) return;
      setError(reportError(caught, 'No se pudo confirmar la aplicación histórica.'));
      const unknown = closedApplicationNeedsRecovery(caught); setUncertain(unknown);
      if (!unknown) { outcome.current = 'review'; intent.current = null; setNeedsPlan(true); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return { save, reviewed, busy, uncertain, needsPlan, error, saved, requestId: intent.current?.requestId ?? null, locked: busy || uncertain || Boolean(saved), submitting: () => pending.current, blocked: () => pending.current || intent.current !== null || outcome.current === 'saved' };
}
