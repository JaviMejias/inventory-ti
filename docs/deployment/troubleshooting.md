# Troubleshooting

Common issues when setting up or running Inventory TI, and how to resolve them.

## `PrismaClientInitializationError: Environment variable not found: DATABASE_URL`

All commands that touch the database (tests, migrations, bootstrap, `prisma:*` scripts) need `DATABASE_URL` in the environment or in the repository-root `.env` file.

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/inventory_ti" pnpm test
```

Prisma also reads `.env` automatically if a `.env` file exists. To use it:

```bash
cp .env.example .env   # then edit DATABASE_URL
```

> Note: the API `dev`, `test`, and `bootstrap:admin` scripts load the repository-root `.env` automatically using Node's built-in env-file support. Production `start` does not load a local file; production should inject environment variables through its process manager or deployment platform. Prisma CLI also reads `.env` according to its normal configuration lookup.

## The API starts but `/health` fails

`GET /health` returns `{"service":"api","status":"ok"}`. If it is not reachable:

- Confirm the API is listening (`API_HOST`/`API_PORT`, default `0.0.0.0:3000`).
- Confirm `WEB_ORIGIN` matches the origin you connect from (CORS is single-origin).
- If the port is occupied, change `API_PORT`.

## `COOKIE_SECURE` error on startup

The API refuses to start with `NODE_ENV=production` and `COOKIE_SECURE=false`. Set `COOKIE_SECURE=true` and serve the app over HTTPS.

## Login fails with "Invalid username/email or password"

- Confirm the user is active (`isActive = true`).
- Confirm the password meets the policy: at least 12 characters, including a letter and a number.
- Confirm `DATABASE_URL` points at the database that contains the user.

## `Bootstrap refused: ... user(s) already exist`

The bootstrap administrator can only be created on an **empty** user table. To add more users, log in as `JEFE` and use the user-management endpoints/UI. Do not reset the database just to re-run bootstrap.

## Tests fail with connection errors

The tests connect to PostgreSQL via `DATABASE_URL`. Ensure PostgreSQL is running and the database exists:

```bash
psql "postgresql://postgres:postgres@localhost:5432/inventory_ti" -c "SELECT 1"
```

## Prisma client is out of date after a schema change

```bash
pnpm db:generate
```

## The web app cannot reach the API (CORS issues)

In the browser devtools, if API calls are blocked by CORS, verify:

- The API is running with `WEB_ORIGIN` set to the web origin (e.g., `http://localhost:5173`).
- The browser is using the same origin as `WEB_ORIGIN`.
- `VITE_API_URL` in `apps/web/.env` points at the API as seen by the browser.

## `Unsupported engine` warnings from pnpm

The repository declares Node `>=24.0.0 <25.0.0` and pnpm `>=11.0.0 <12.0.0` (pinned `11.19.0`). Warnings appear when the local Node/pnpm fall outside that range. Use a Node 24 LTS and the pinned pnpm for best results.

## What to include in a bug report

- Node/pnpm versions (`node --version`, `pnpm --version`)
- `NODE_ENV` and whether `COOKIE_SECURE` is set
- The `WEB_ORIGIN`/`VITE_API_URL` used
- The exact command and error output (secrets redacted)
- Whether PostgreSQL is local or remote and its version
