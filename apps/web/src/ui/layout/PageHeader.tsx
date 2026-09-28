import type { ReactNode } from 'react';

import { cx } from '../utils';

type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
  className?: string;
};

export function PageHeader({ title, description, eyebrow, action, meta, className }: PageHeaderProps) {
  return (
    <header className={cx('app-page-heading', className)}>
      <div>
        {eyebrow && <p className="app-page-kicker">{eyebrow}</p>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {(action || meta) && <div className="ui-page-header-side">{meta}{action}</div>}
    </header>
  );
}
