import type { ReactNode } from 'react';

import { cx } from '../utils';

export type AlertVariant = 'info' | 'success' | 'warning' | 'danger';

type AlertProps = {
  variant?: AlertVariant;
  title?: ReactNode;
  children: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: 'alert' | 'status';
};

const variantClasses: Record<AlertVariant, string> = {
  info: 'ui-alert-info', success: 'ui-alert-success', warning: 'ui-alert-warning', danger: 'ui-alert-danger'
};

export function Alert({ variant = 'info', title, children, icon, action, className, role = variant === 'danger' ? 'alert' : 'status' }: AlertProps) {
  return (
    <div className={cx('ui-alert', variantClasses[variant], className)} role={role}>
      {icon && <span className="ui-alert-icon">{icon}</span>}
      <div className="ui-alert-content">
        {title && <strong>{title}</strong>}
        <span>{children}</span>
      </div>
      {action && <div className="ui-alert-action">{action}</div>}
    </div>
  );
}
