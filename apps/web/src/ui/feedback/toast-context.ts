import { createContext, useContext } from 'react';

export type ToastTone = 'success' | 'info' | 'warning' | 'error';

export type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  duration?: number | null;
};

export type ToastContextValue = {
  showToast: (toast: ToastInput) => void;
  dismissToast: (id: string) => void;
};

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }

  return context;
}
