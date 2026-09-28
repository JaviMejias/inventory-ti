import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from '../utils';

type PageContainerProps = HTMLAttributes<globalThis.HTMLElement> & {
  children: ReactNode;
  fluid?: boolean;
};

export function PageContainer({ children, className, fluid = false, ...props }: PageContainerProps) {
  return <section {...props} className={cx('app-page', fluid && 'app-page-fluid', className)}>{children}</section>;
}
