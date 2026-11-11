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
- For browser access, confirm `WEB_ORIGIN` matches the browser origin (CORS is single-origin). CORS does not block a direct server-side health request.
- If the port is occupied, change `API_PORT`.

## `COOKIE_SECURE` error on startup

The API refuses to start with `NODE_ENV=production` and `COOKIE_SECURE=false`. Set `COOKIE_SECURE=true` and serve the app over HTTPS.

## Login fails with "Invalid username/email or password"

- Confirm the user is active (`isActive = true`).
- If the account is pending (`ACCOUNT_PENDING`), complete activation and log in again; administrative activation alone does not configure a password.
- Confirm the password meets the policy: at least 12 characters, including a letter and a number.
- Confirm `DATABASE_URL` points at the database that contains the user.

## Bootstrap refuses because users already exist

The command reports `Ya existen ... usuario(s)`. Bootstrap can only create the first administrator on an **empty** user table. To add more users, log in as `JEFE` and use the user-management endpoints/UI. Do not reset the database just to rerun bootstrap.

Invalid fields in interactive mode are requested again without restarting; password requirements are displayed before entry, and mismatched confirmation repeats only that confirmation. With piped input, invalid/incomplete fields terminate the command nonzero rather than consuming extra retry lines. See [users.md](users.md).

## Tests fail with connection errors

The launcher uses credentials from `TEST_DATABASE_URL` or `DATABASE_URL` to create a disposable database through the server's `postgres` database. Ensure server access and `CREATEDB`; the application database is not the fixture target. Never bypass the isolation guard or run individual integration files against live inventory.

```bash
psql --dbname=postgres --command='SELECT current_user, rolcreatedb FROM pg_roles WHERE rolname = current_user;'
```

Configure libpq host/user/password securely for this diagnostic; it does not load `DATABASE_URL` automatically.

## `/health` is green but database requests return 500

`/health` is process liveness only. Check PostgreSQL with the runtime credentials, migration status using [database.md](database.md), and API logs. An unapplied `0011_correction_final_quantity` can leave correction queries incompatible with the deployed client. Review backups and pending SQL before `pnpm db:migrate`; do not reset the database.

## `LAST_ADMIN_REQUIRED` or `SELF_ACCESS_RESET`

The API protects the last active JEFE with a configured password. A pending/inactive replacement does not count. Activate and verify a second JEFE before deactivation/demotion/reset; use `/auth/password` for your own password. See [users.md](users.md).

## Activation code lost or expired

Codes expire after 24 hours and cannot be read back. Another JEFE issues `/users/:id/reset-access`, revoking old password/sessions/codes. Administrative `/activate` only enables the account; password setup still requires `/auth/activate`, followed by separate login.

## Stock conflicts or blocked product tracking mode

`INSUFFICIENT_STOCK` uses locked current product stock, not an old list value. Refresh reads and verify the product ID and quantity in the request. `STOCK_LIMIT_EXCEEDED` rejects 32-bit stock overflow. `PRODUCT_TRACKING_MODE_LOCKED` protects products with any stock row, movement or asset; it is not an invitation to delete history. Corrections submit the final signed movement effect, not final product stock or an extra movement amount; see [corrections.md](../technical/corrections.md).

## A migration failed

Keep writers stopped and inspect actual schema and `_prisma_migrations`. Earlier migrations may already be applied. Follow [failed migration recovery](database.md#failed-migrations); never blindly mark it applied, edit an applied SQL file or use force-reset.

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
