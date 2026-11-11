# Configuration

This document describes all environment variables used by Inventory TI.

The canonical API file is `.env` in the **repository root**, copied from the root `.env.example`. Development, Prisma, bootstrap, quarantine and test scripts load it explicitly; an exported variable takes precedence. `pnpm --filter @inventory-ti/api start` does not explicitly load it: production must inject the environment through its process manager, as in [production.md](production.md). An `apps/api/.env` is not a substitute for this root file.

## Application variables

| Variable | Default (dev) | Required | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/inventory_ti` | Yes | PostgreSQL connection string. |
| `NODE_ENV` | `development` | No | `development`, `test`, or `production`. |
| `API_HOST` | `0.0.0.0` | No | API listen address. |
| `API_PORT` | `3000` | No | API listen port. |
| `WEB_ORIGIN` | `http://localhost:5173` | No | Single allowed browser CORS origin, including scheme and port, without path/trailing slash. Does not set the cookie domain. |
| `TRUST_PROXY` | `loopback` | No | `false` without a proxy, `loopback` for a local proxy, or comma-separated trusted IPs/CIDRs. Blanket trust and `/0` networks are rejected. Affects client IP used by login/activation limits. |
| `TEST_DATABASE_URL` | unset | Tests only | Optional separate test-server credentials. Runner creates/drops its own database through the server's `postgres` maintenance database; role requires `CREATEDB`. Never points fixtures directly at the supplied database. |

## Authentication

| Variable | Default (dev) | Required | Description |
| --- | --- | --- | --- |
| `SESSION_SECRET` | dev fallback (development only) | **Yes in production** | Minimum 32 characters. Used to derive CSRF tokens from session tokens via HMAC-SHA256. Generate a random value before deploying. |
| `SESSION_TTL_HOURS` | `8` | No | Absolute session lifetime in hours; activity does not extend expiration. |

## Cookies

| Variable | Default (dev) | Required | Description |
| --- | --- | --- | --- |
| `COOKIE_SECURE` | `false` | No | Must be `true` in production (HTTPS). The API refuses to start with `COOKIE_SECURE=false` when `NODE_ENV=production`. |
| `COOKIE_SAME_SITE` | `lax` | No | `lax`, `strict` or `none`. For genuinely cross-site requests, `none` requires `COOKIE_SECURE=true`; API rejects `none` without Secure. Different origins are not necessarily different sites. |

The session cookie is `HttpOnly`, host-only (no `Domain` attribute), with path `/`. `WEB_ORIGIN` authorizes CORS; it does not move/share that cookie. Browser third-party-cookie restrictions may still prevent cross-site sessions even with `SameSite=None`. Prefer a single HTTPS origin with `/api` reverse-proxied to the backend. In local HTTP development use `COOKIE_SECURE=false`, `COOKIE_SAME_SITE=lax` and the matching local origin. Do not leave a public tunnel API URL in a local-only client configuration. Frontend configuration belongs to its separate guide.

## Frontend (Vite)

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:3000` (code fallback) | API base as seen from the browser. The supplied `apps/web/.env.example` explicitly sets `/api`; Vite development proxies that path to `http://localhost:3000`. |

Vite reads this value when starting development or building the frontend. An existing build does not pick up a later environment change automatically. The `/api` development proxy is not shipped in the production bundle: configure the same path in the production reverse proxy or build with an explicit public API URL. Do not place server secrets in any `VITE_*` variable; those values are browser-visible.

## Secrets policy

- **Never** commit `.env` files to Git (`.gitignore` covers `.env` and `.env.*` except `.env.example`).
- **Never** put real secrets in `.env.example`, documentation, Docker Compose defaults, seed scripts, or migration files.
- **Generate** `SESSION_SECRET` independently before deploying. Do not reuse values from examples.
- The bootstrap administrator is created interactively; credentials are never stored in source code or images.
