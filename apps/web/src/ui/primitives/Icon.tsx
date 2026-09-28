import type { ReactNode } from 'react';

import { cx } from '../utils';

type IconProps = {
  children: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
};

const sizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6'
} as const;

export function Icon({ children, className, size = 'md', label }: IconProps) {
  return (
    <svg
      className={cx(sizeClasses[size], className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
    >
      {children}
    </svg>
  );
}
