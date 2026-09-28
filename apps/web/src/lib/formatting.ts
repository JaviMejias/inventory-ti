export function formatDateTime(value: string | Date, locale = 'es-CL'): string {
  return new Date(value).toLocaleString(locale);
}

export function formatNumber(value: number, locale = 'es-CL'): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatChilePhone(value: string | null | undefined): string {
  if (!value?.trim()) return 'No informado';
  const digits = value.replace(/\D/g, '');
  const national = digits.startsWith('56') ? digits.slice(2) : digits;
  if (national.length === 9 && national.startsWith('9')) {
    return '+56 9 ' + national.slice(1, 5) + ' ' + national.slice(5);
  }
  if (national.length === 9 && national.startsWith('2')) {
    return '+56 2 ' + national.slice(1, 5) + ' ' + national.slice(5);
  }
  return value.trim();
}

export function normalizeChilePhone(value: string): string {
  return value.replace(/\D/g, '');
}
