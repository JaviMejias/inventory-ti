type LoadingStateProps = {
  label?: string;
  className?: string;
};

export function LoadingState({ label = 'Cargando…', className = '' }: LoadingStateProps) {
  return <div className={`ui-loading-state ${className}`} role="status" aria-live="polite"><span className="ui-loading-spinner" aria-hidden="true" /><span>{label}</span></div>;
}
