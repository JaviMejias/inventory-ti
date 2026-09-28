import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

import { cx } from '../utils';

type ControlProps = {
  id?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
};

type FieldProps = {
  label: string;
  children: ReactElement<ControlProps>;
  id?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
};

export function Field({ label, children, id, hint, error, required, disabled, className }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? `field-${generatedId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement<ControlProps>(children)
    ? cloneElement(children, {
        id: controlId,
        className: cx('ui-field-control', children.props.className),
        disabled: disabled || children.props.disabled,
        required: required || children.props.required,
        'aria-describedby': describedBy,
        'aria-invalid': Boolean(error)
      })
    : children;

  return (
    <div className={cx('ui-field', disabled && 'ui-field-disabled', className)}>
      <label className="ui-field-label" htmlFor={controlId}>
        <span>{label}</span>
        {required && <span className="ui-field-required">Obligatorio</span>}
      </label>
      {control}
      {hint && <p className="ui-field-hint" id={hintId}>{hint}</p>}
      {error && <p className="ui-field-error" id={errorId} role="alert">{error}</p>}
    </div>
  );
}
