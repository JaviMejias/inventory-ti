import { isIP } from 'node:net';
import { z } from 'zod';

const trustedProxySchema = z.string().default('loopback').transform((value, context): false | string[] => {
  if (value === 'false') return false;
  const proxies = value.split(',').map((proxy) => proxy.trim());
  const valid = proxies.every((proxy) => {
    if (proxy === 'loopback') return true;
    const [address, prefix, extra] = proxy.split('/');
    const version = isIP(address ?? '');
    return version !== 0 && extra === undefined && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (version === 4 ? 32 : 128)));
  });
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, message: 'TRUST_PROXY must be false, loopback, or a comma-separated list of trusted IP addresses/CIDRs' });
  return proxies;
});

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  TRUST_PROXY: trustedProxySchema,
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),
  COOKIE_SECURE: z.preprocess((value) => value === 'true' || value === true, z.boolean()).default(false),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax')
}).superRefine((values, context) => {
  if (values.NODE_ENV === 'production' && !values.COOKIE_SECURE) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be true in production' });
  }
  if (values.COOKIE_SAME_SITE === 'none' && !values.COOKIE_SECURE) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SAME_SITE'], message: 'COOKIE_SAME_SITE=none requires COOKIE_SECURE=true' });
  }
});

export function parseEnvironment(source: typeof process.env = process.env) {
  const sessionSecret = source.SESSION_SECRET ?? (source.NODE_ENV === 'production' ? undefined : 'local-development-session-secret-change-me');

  return environmentSchema.parse({
    DATABASE_URL: source.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/inventory_ti',
    NODE_ENV: source.NODE_ENV,
    API_HOST: source.API_HOST,
    API_PORT: source.API_PORT,
    WEB_ORIGIN: source.WEB_ORIGIN,
    TRUST_PROXY: source.TRUST_PROXY,
    SESSION_SECRET: sessionSecret,
    SESSION_TTL_HOURS: source.SESSION_TTL_HOURS,
    COOKIE_SECURE: source.COOKIE_SECURE,
    COOKIE_SAME_SITE: source.COOKIE_SAME_SITE
  });
}

export const environment = parseEnvironment();
