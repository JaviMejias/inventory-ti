import type { ReactNode } from 'react';

import { Button } from '../primitives/Button';
import { Alert } from '../feedback/Alert';
import { Dialog } from './Dialog';

type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  className?: string;
  loading?: boolean;
  onExited?: () => void;
  error?: string | null;
};

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = true, loading = false, onExited, className, error }: ConfirmDialogProps) {
  return (
    <Dialog
      className={className}
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      busy={loading}
      onExited={onExited}
      actions={<><Button variant="secondary" onClick={onClose} disabled={loading}>{cancelLabel}</Button><Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button></>}
    >
      <p className="ui-dialog-confirmation">Esta acción se aplicará inmediatamente.</p>
      {error && <Alert variant="danger">{error}</Alert>}
    </Dialog>
  );
}
