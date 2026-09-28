import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from '../utils';

type PageToolbarProps = HTMLAttributes<globalThis.HTMLDivElement> & {
  children: ReactNode;
  actions?: ReactNode;
};

export function PageToolbar({ children, actions, className, ...props }: PageToolbarProps) {
  return (
    <div {...props} className={cx('app-toolbar', 'ui-page-toolbar', className)}>
      <div className="ui-page-toolbar-content">{children}</div>
      {actions && <div className="ui-page-toolbar-actions">{actions}</div>}
    </div>
  );
}
