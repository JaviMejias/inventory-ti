import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cx } from '../utils';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

type ButtonProps = ButtonHTMLAttributes<globalThis.HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconOnly?: boolean;
  children: ReactNode;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'ui-button-primary',
  secondary: 'ui-button-secondary',
  danger: 'ui-button-danger',
  ghost: 'ui-button-ghost'
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'ui-button-sm',
  md: 'ui-button-md',
  lg: 'ui-button-lg'
};

export function Button({
  children,
  className,
  variant = 'primary',
  size = 'md',
  loading = false,
  iconOnly = false,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cx('ui-button', variantClasses[variant], sizeClasses[size], iconOnly && 'ui-button-icon-only', className)}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-icon-only={iconOnly || undefined}
    >
      {loading && <span className="ui-button-spinner" aria-hidden="true" />}
      <span className={cx('ui-button-content', loading && 'ui-button-content-hidden')}>{children}</span>
    </button>
  );
}
