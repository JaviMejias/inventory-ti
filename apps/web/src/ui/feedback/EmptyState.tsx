import type { ReactNode } from 'react';

import { cx } from '../utils';

type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty-state ui-empty-state-animated', className)}>
      {icon && <span className="ui-empty-state-icon">{icon}</span>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="ui-empty-state-action">{action}</div>}
    </div>
  );
}
