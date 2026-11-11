import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, getApiErrorMessage } from '../../lib/api';
import { environment } from '../../config/environment';
import { useRequestError, useToast } from '../../ui';
import { applyPilot, generatePilotPlan, readPilotContext } from './pilot-api';
import { readPilotApplication } from './pilot-receipt-api';
import { canConfirmPilot, captureApplyIntent, requestForPilot, type ApplicationReceipt, type ApplyIntent, type EvaluatedPilot, type PilotContext, type PilotOperation, type PilotReadReceipt, type PlannedOperation } from './pilot-model';

export function usePilotWorkflow(batchId: string, changed: () => void) {
  const [context, setContext] = useState<PilotContext | null>(null);
  const [operations, setOperations] = useState<PilotOperation[]>([]);
  const [evaluated, setEvaluated] = useState<EvaluatedPilot | null>(null);
  const [warningOperations, setWarningOperations] = useState<PlannedOperation[]>([]);
  const [receipt, setReceipt] = useState<ApplicationReceipt | null>(null);
  const [originalReceipt, setOriginalReceipt] = useState<PilotReadReceipt | null>(null);
  const [originalReference, setOriginalReference] = useState<{ batchId: string; applicationId: string } | null>(null);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [dirty, setDirty] = useState(false);
  const controller = useRef<globalThis.AbortController | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const intent = useRef<ApplyIntent | null>(null);
  const reportError = useRequestError();
  const { showToast } = useToast();
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new globalThis.AbortController();
    controller.current = current;
    setReading(true); setReadError(null); setEvaluated(null); setWarningOperations([]);
    try {
      const source = await readPilotContext(batchId, current.signal);
      if (current.signal.aborted) return;
      setContext(source); setNeedsRefresh(false);
      setOperations((previous) => previous.map((operation) => ({ ...operation, acknowledgedWarnings: [] })));
    } catch (caughtError) {
      if (!current.signal.aborted) setReadError(getApiErrorMessage(caughtError, 'No se pudo cargar el contexto del piloto.'));
    } finally { if (!current.signal.aborted) setReading(false); }
  }, [batchId]);
  useEffect(() => {
    active.current = true; void refresh();
    return () => { active.current = false; controller.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    if (!dirty && !recovery) return undefined;
    const warn = (event: globalThis.BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, recovery]);
  function invalidate() { setEvaluated(null); setDirty(true); }
  function updateOperations(next: PilotOperation[]) { setOperations(next); invalidate(); }
  async function generate() {
    if (pending.current || !context || reading || readError || needsRefresh || recovery || !operations.length) return;
    pending.current = true; setBusy(true); setError(null); setEvaluated(null);
    const request = requestForPilot(context, operations);
    try {
      const plan = await generatePilotPlan(batchId, request);
      if (active.current) { setEvaluated({ request, plan }); setWarningOperations(plan.operations); }
    } catch (caughtError) {
      if (active.current) {
        setError(reportError(caughtError, 'No se pudo generar el plan.'));
        setNeedsRefresh(caughtError instanceof ApiRequestError && ['REVIEW_VERSION_CONFLICT', 'SOURCE_REVISION_CONFLICT'].includes(caughtError.code ?? ''));
      }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function apply() {
    if (!environment.inventoryImportApplyV6 || pending.current || (!intent.current && !canConfirmPilot(evaluated, true))) return;
    if (!intent.current && evaluated) intent.current = captureApplyIntent(evaluated, globalThis.crypto.randomUUID());
    pending.current = true; setBusy(true); setError(null);
    try {
      const applied = await applyPilot(batchId, intent.current!);
      if (!active.current) return;
      setReceipt(applied); setRecovery(false); setDirty(false); intent.current = null;
      showToast({ tone: 'success', title: 'Piloto aplicado', description: 'El servidor confirmó los cambios y guardó el comprobante.' });
      changed();
    } catch (caughtError) {
      if (!active.current) return;
      setError(reportError(caughtError, 'No se pudo confirmar la aplicación.'));
      if (caughtError instanceof ApiRequestError && caughtError.code === 'IMPORT_TARGET_ALREADY_APPLIED') {
        const details = caughtError.details;
        if (typeof details === 'object' && details !== null && 'batchId' in details && 'applicationId' in details &&
          typeof details.batchId === 'string' && typeof details.applicationId === 'string' &&
          [details.batchId, details.applicationId].every((id) => /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) {
          setOriginalReference({ batchId: details.batchId, applicationId: details.applicationId });
        }
      }
      const retrySame = !(caughtError instanceof ApiRequestError) || ['NETWORK_ERROR', 'INVALID_RESPONSE', 'IMPORT_APPLY_BUSY'].includes(caughtError.code ?? '') || caughtError.status >= 500;
      setRecovery(retrySame);
      if (!retrySame) { intent.current = null; setEvaluated(null); setNeedsRefresh(true); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function consultOriginal() {
    if (!originalReference || pending.current) return;
    pending.current = true; setBusy(true);
    const current = new globalThis.AbortController();
    controller.current = current;
    try {
      const proof = await readPilotApplication(originalReference.batchId, originalReference.applicationId, current.signal);
      if (active.current) setOriginalReceipt(proof);
    } catch (caughtError) {
      if (active.current && !current.signal.aborted) setError(reportError(caughtError, 'No se pudo consultar el comprobante original.'));
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return { context, operations, evaluated, warningOperations, receipt, originalReceipt, originalReference, reading, readError, error, busy, recovery, needsRefresh, dirty, requestId: intent.current?.requestId, refresh, generate, apply, consultOriginal, closeOriginal: () => setOriginalReceipt(null), invalidate, updateOperations };
}
