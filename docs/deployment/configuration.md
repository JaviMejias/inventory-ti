# Configuration

This document describes all environment variables used by Inventory TI.

## Application variables

| Variable | Default (dev) | Required | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/inventory_ti` | Yes | PostgreSQL connection string. |
| `NODE_ENV` | `development` | No | `development`, `test`, or `production`. |
| `API_HOST` | `0.0.0.0` | No | API listen address. |
| `API_PORT` | `3000` | No | API listen port. |
| `WEB_ORIGIN` | `http://localhost:5173` | No | CORS origin and cookie scope (must match the web app URL). |

## Authentication

| Variable | Default (dev) | Required | Description |
| --- | --- | --- | --- |
| `SESSION_SECRET` | dev fallback (development only) | **Yes in production** | Minimum 32 characters. Used to derive CSRF tokens from session tokens via HMAC-SHA256. Generate a random value before deploying. |
| `SESSION_TTL_HOURS` | `8` | No | Absolute session lifetime in hours; activity does not extend expiration. |

## Cookies

| Variable | Default (dev) | Required | Description |
| --- | --- | --- | --- |
| `COOKIE_SECURE` | `false` | No | Must be `true` in production (HTTPS). The API refuses to start with `COOKIE_SECURE=false` when `NODE_ENV=production`. |
| `COOKIE_SAME_SITE` | `lax` | No | Cookie policy. Use `none` together with `COOKIE_SECURE=true` when the web app and API use different HTTPS origins, such as separate ngrok URLs. |

## Frontend (Vite)

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_API_URL` | `/api` | Base URL of the API as seen from the browser. In Vite development, `/api` is proxied to `http://localhost:3000`; set a public API URL only for deployments without a reverse proxy. |

## Secrets policy

- **Never** commit `.env` files to Git (`.gitignore` covers `.env` and `.env.*` except `.env.example`).
- **Never** put real secrets in `.env.example`, documentation, Docker Compose defaults, seed scripts, or migration files.
- **Generate** `SESSION_SECRET` independently before deploying. Do not reuse values from examples.
- The bootstrap administrator is created interactively; credentials are never stored in source code or images.
