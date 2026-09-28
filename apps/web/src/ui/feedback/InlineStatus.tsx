import type { ReactNode } from 'react';

import { cx } from '../utils';
import type { AlertVariant } from './Alert';

type InlineStatusProps = {
  children: ReactNode;
  variant?: AlertVariant;
  className?: string;
};

export function InlineStatus({ children, variant = 'info', className }: InlineStatusProps) {
  return <span className={cx('ui-inline-status', `ui-inline-status-${variant}`, className)} role={variant === 'danger' ? 'alert' : 'status'}>{children}</span>;
}
