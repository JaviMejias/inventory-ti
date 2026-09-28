import type { ReactNode } from 'react';

import { cx } from '../utils';

export type BadgeVariant = 'default' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';

type BadgeProps = {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
};

export function Badge({ children, variant = 'default', className }: BadgeProps) {
  return <span className={cx('ui-badge', `ui-badge-${variant}`, className)}>{children}</span>;
}
