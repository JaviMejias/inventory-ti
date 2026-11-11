import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';

import { ToastContext, type ToastInput, type ToastTone } from './toast-context';

const DEFAULT_DURATION = 5000;
const DEDUPLICATION_WINDOW = 2000;
const MAX_VISIBLE_TOASTS = 4;
const EXIT_DURATION = 180;

let toastSequence = 0;

type ToastRecord = Required<Pick<ToastInput, 'title' | 'tone'>> & {
  id: string;
  description?: string;
  duration: number | null;
  signature: string;
  updatedAt: number;
  version: number;
};

function getToastHost() {
  const dialogs = Array.from(document.querySelectorAll<globalThis.HTMLDialogElement>('dialog[open]'));
  return dialogs.at(-1) ?? document.body;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [portalHost, setPortalHost] = useState<globalThis.HTMLElement | null>(null);
  const viewportRef = useRef<globalThis.HTMLElement>(null);

  useLayoutEffect(() => {
    const syncHost = () => setPortalHost(getToastHost());
    syncHost();
    const observer = new globalThis.MutationObserver(syncHost);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const nextHost = getToastHost();
    // A successful mutation can remove the dialog before its observer runs.
    if (portalHost !== nextHost) {
      setPortalHost(nextHost);
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport?.isConnected || typeof viewport.showPopover !== 'function') return;
    // Native modal dialogs outrank body portals; the popover must join their top layer.
    if (viewport.matches(':popover-open')) viewport.hidePopover();
    if (toasts.length > 0) viewport.showPopover();
    return () => {
      if (viewport.isConnected && viewport.matches(':popover-open')) viewport.hidePopover();
    };
  }, [portalHost, toasts]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((input: ToastInput) => {
    const now = Date.now();
    const tone = input.tone ?? 'info';
    const duration = input.duration === undefined ? (tone === 'error' ? null : DEFAULT_DURATION) : input.duration;
    const signature = [tone, input.title.trim(), input.description?.trim() ?? ''].join('|');
    const nextToast: ToastRecord = {
      id: 'toast-' + now + '-' + ++toastSequence,
      title: input.title,
      description: input.description,
      tone,
      duration,
      signature,
      updatedAt: now,
      version: 0
    };

    setToasts((current) => {
      const duplicate = current.find((toast) => toast.signature === signature && now - toast.updatedAt < DEDUPLICATION_WINDOW);

      if (duplicate) {
        const refreshed = { ...duplicate, duration, updatedAt: now, version: duplicate.version + 1 };
        return [refreshed, ...current.filter((toast) => toast.id !== duplicate.id)];
      }

      return [nextToast, ...current].slice(0, MAX_VISIBLE_TOASTS);
    });
  }, []);

  const value = useMemo(() => ({ showToast, dismissToast }), [dismissToast, showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {portalHost && createPortal(
        <section ref={viewportRef} popover="manual" className="ui-toast-viewport" aria-label="Notificaciones">
          {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} dismiss={() => dismissToast(toast.id)} />)}
        </section>,
        portalHost
      )}
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, dismiss }: { toast: ToastRecord; dismiss: () => void }) {
  const [closing, setClosing] = useState(false);
  const [paused, setPaused] = useState(false);
  const remainingTime = useRef(toast.duration ?? 0);
  const startedAt = useRef(0);
  const exitTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  const beginClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    exitTimer.current = globalThis.setTimeout(dismiss, EXIT_DURATION);
  }, [closing, dismiss]);

  useEffect(() => {
    if (exitTimer.current !== null) {
      globalThis.clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    remainingTime.current = toast.duration ?? 0;
    setClosing(false);
    setPaused(false);
  }, [toast.duration, toast.version]);

  useEffect(() => {
    if (toast.duration === null || paused || closing) return;

    startedAt.current = Date.now();
    const timer = globalThis.setTimeout(beginClose, remainingTime.current);

    return () => {
      globalThis.clearTimeout(timer);
      remainingTime.current = Math.max(0, remainingTime.current - (Date.now() - startedAt.current));
    };
  }, [beginClose, closing, paused, toast.duration, toast.version]);

  useEffect(() => () => {
    if (exitTimer.current !== null) globalThis.clearTimeout(exitTimer.current);
  }, []);

  function handleBlur(event: FocusEvent<globalThis.HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
  }

  const progressStyle = toast.duration === null
    ? undefined
    : ({ '--ui-toast-duration': String(toast.duration) + 'ms' } as CSSProperties);

  return (
    <article
      className={'ui-toast ui-toast-' + toast.tone}
      data-paused={paused || undefined}
      data-state={closing ? 'closing' : 'open'}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={handleBlur}
    >
      <span className="ui-toast-signal" aria-hidden="true" />
      <span className="ui-toast-icon" aria-hidden="true"><ToastIcon tone={toast.tone} /></span>
      <span className="ui-toast-copy">
        <strong>{toast.title}</strong>
        {toast.description && <span>{toast.description}</span>}
      </span>
      <button className="ui-toast-close" type="button" onClick={beginClose} aria-label="Cerrar notificación">
        <CloseIcon />
      </button>
      {toast.duration !== null && <span key={toast.version} className="ui-toast-progress" style={progressStyle} aria-hidden="true" />}
    </article>
  );
}

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === 'success') return <svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>;
  if (tone === 'warning') return <svg viewBox="0 0 24 24"><path d="m12 4 9 16H3L12 4Z" /><path d="M12 9v5M12 17h.01" /></svg>;
  if (tone === 'error') return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>;
  return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>;
}
