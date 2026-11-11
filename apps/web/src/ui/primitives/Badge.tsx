import type { ReactNode } from 'react';

import { cx } from '../utils';

export type BadgeVariant = 'default' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';

type BadgeProps = {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
};

const variantClasses: Record<BadgeVariant, string> = {
  default: 'ui-badge-default', info: 'ui-badge-info', success: 'ui-badge-success', warning: 'ui-badge-warning', danger: 'ui-badge-danger', neutral: 'ui-badge-neutral'
};

export function Badge({ children, variant = 'default', className }: BadgeProps) {
  return <span className={cx('ui-badge', variantClasses[variant], className)}>{children}</span>;
}
