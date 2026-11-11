import { z } from 'zod';

export function nullableText(maximum: number) {
  return z.string().trim().max(maximum).nullable().optional().transform((value) => value === '' ? null : value);
}
