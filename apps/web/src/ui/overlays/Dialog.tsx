import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { cx } from '../utils';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
  className?: string;
  closeOnBackdrop?: boolean;
  onExited?: () => void;
  initialFocus?: () => globalThis.HTMLElement | null;
};

const EXIT_DURATION = 180;

export function Dialog({ open, onClose, title, description, children, actions, busy = false, className, closeOnBackdrop = true, onExited, initialFocus }: DialogProps) {
  const dialogRef = useRef<globalThis.HTMLDialogElement>(null);
  const previouslyFocused = useRef<globalThis.HTMLElement | null>(null);
  const previousPageScroll = useRef<{ left: number; top: number } | null>(null);
  const onExitedRef = useRef(onExited);
  const initialFocusRef = useRef(initialFocus);
  const titleId = useId();
  const descriptionId = useId();
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);

  const restoreContext = useCallback(() => {
    if (previouslyFocused.current?.isConnected) previouslyFocused.current.focus({ preventScroll: true });
    previouslyFocused.current = null;
    if (previousPageScroll.current) globalThis.scrollTo({ ...previousPageScroll.current, behavior: 'instant' });
    previousPageScroll.current = null;
  }, []);

  useEffect(() => { onExitedRef.current = onExited; }, [onExited]);
  useEffect(() => { initialFocusRef.current = initialFocus; }, [initialFocus]);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      return undefined;
    }
    if (!rendered) return undefined;
    setClosing(true);
    const timeout = globalThis.setTimeout(() => {
      const dialog = dialogRef.current;
      if (dialog?.open) dialog.close();
      restoreContext();
      setRendered(false);
      onExitedRef.current?.();
    }, EXIT_DURATION);
    return () => globalThis.clearTimeout(timeout);
  }, [open, rendered, restoreContext]);

  useLayoutEffect(() => {
    if (!rendered) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (!dialog.open) {
      previouslyFocused.current = globalThis.document.activeElement instanceof globalThis.HTMLElement ? globalThis.document.activeElement : null;
      previousPageScroll.current = { left: globalThis.scrollX, top: globalThis.scrollY };
      dialog.showModal();
      globalThis.scrollTo({ ...previousPageScroll.current, behavior: 'instant' });
    }
    const frame = globalThis.requestAnimationFrame(() => {
      const target = initialFocusRef.current?.();
      (target?.isConnected && dialog.contains(target) ? target : dialog).focus({ preventScroll: true });
    });
    return () => {
      globalThis.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      restoreContext();
    };
  }, [rendered, restoreContext]);

  if (!rendered) return null;

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      className={cx('ui-dialog', className)}
      data-state={closing ? 'closing' : 'open'}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => { if (closeOnBackdrop && event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="ui-dialog-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button className="ui-dialog-close" type="button" onClick={onClose} disabled={busy} aria-label="Cerrar diálogo">×</button>
      </div>
      <div className="ui-dialog-body">{children}</div>
      {actions && <div className="ui-dialog-actions">{actions}</div>}
    </dialog>
  );
}
