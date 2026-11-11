import type { HTMLAttributes, ReactNode } from 'react';

import { PageToolbar } from './PageToolbar';

type ModuleFiltersProps = Omit<HTMLAttributes<globalThis.HTMLDivElement>, 'children'> & {
  children: ReactNode;
  actions?: ReactNode;
  ariaLabel?: string;
};

export function ModuleFilters({ children, actions, ariaLabel = 'Filtros', className, ...props }: ModuleFiltersProps) {
  return <PageToolbar {...props} className={['ui-module-filters', className].filter(Boolean).join(' ')} role="region" aria-label={ariaLabel} actions={actions}>{children}</PageToolbar>;
}
