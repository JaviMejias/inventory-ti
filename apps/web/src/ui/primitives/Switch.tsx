import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cx } from '../utils';

type SwitchProps = Omit<ButtonHTMLAttributes<globalThis.HTMLButtonElement>, 'children' | 'onChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
};

export function Switch({ checked, onCheckedChange, label, className, disabled, type = 'button', ...props }: SwitchProps) {
  return (
    <span className={cx('ui-switch', disabled && 'ui-switch-disabled', className)}>
      {label && <span className="ui-switch-label">{label}</span>}
      <button
        {...props}
        type={type}
        className="ui-switch-control"
        role="switch"
        aria-checked={checked}
        data-state={checked ? 'checked' : 'unchecked'}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
      >
        <span className="ui-switch-track" aria-hidden="true">
          <span className="ui-switch-glyph ui-switch-glyph-off">−</span>
          <span className="ui-switch-glyph ui-switch-glyph-on">✓</span>
          <span className="ui-switch-thumb" />
        </span>
      </button>
    </span>
  );
}
