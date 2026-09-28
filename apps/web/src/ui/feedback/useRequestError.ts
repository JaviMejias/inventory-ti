import { useCallback } from 'react';

import { getApiErrorMessage } from '../../lib/api';
import { useToast } from './toast-context';

export function useRequestError() {
  const { showToast } = useToast();

  return useCallback((error: unknown, title: string) => {
    const message = getApiErrorMessage(error, title + '.');
    showToast({ tone: 'error', title, description: message });
    return message;
  }, [showToast]);
}
