import type { ReactNode } from 'react';

import { PageHeader } from './PageHeader';

type ModuleHeaderProps = {
  title: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function ModuleHeader({ title, description, eyebrow, action, className }: ModuleHeaderProps) {
  return <PageHeader title={title} description={description} eyebrow={eyebrow} action={action} className={['ui-module-header', className].filter(Boolean).join(' ')} />;
}
