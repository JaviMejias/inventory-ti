import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from '../utils';

type CardProps = HTMLAttributes<globalThis.HTMLElement> & {
  children: ReactNode;
};

export function Card({ children, className, ...props }: CardProps) {
  return <section {...props} className={cx('ui-card', className)}>{children}</section>;
}
