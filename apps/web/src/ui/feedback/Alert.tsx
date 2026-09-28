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

export function Alert({ variant = 'info', title, children, icon, action, className, role = variant === 'danger' ? 'alert' : 'status' }: AlertProps) {
  return (
    <div className={cx('ui-alert', `ui-alert-${variant}`, className)} role={role}>
      {icon && <span className="ui-alert-icon">{icon}</span>}
      <div className="ui-alert-content">
        {title && <strong>{title}</strong>}
        <span>{children}</span>
      </div>
      {action && <div className="ui-alert-action">{action}</div>}
    </div>
  );
}
