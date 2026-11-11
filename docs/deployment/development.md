# Development Setup

## Prerequisites

- **Node.js** >= 24.0.0 < 25.0.0
- **pnpm** >= 11.0.0 (the repository pins `pnpm@11.19.0` via `packageManager` in `package.json`)
- **PostgreSQL** (14+ recommended, must be running and accessible)

Check your versions:

```bash
node --version
pnpm --version
```

## Clean-machine setup

```bash
# 1. Clone the repository
git clone "$INVENTORY_REPOSITORY_URL" inventory-ti
cd inventory-ti

# 2. Install dependencies
pnpm install --frozen-lockfile

# 3. Configure environment
cp .env.example .env
# Edit .env — set DATABASE_URL to match your PostgreSQL instance.
# SESSION_SECRET is optional in development (a dev fallback is provided).

# 4. Create and migrate the database (PostgreSQL must be running)
# Option A — manual
psql -U postgres -c "CREATE DATABASE inventory_ti;"
pnpm db:migrate

# 5. Create the initial administrator (first time only)
pnpm bootstrap:admin

# 6. Start both API and web in development mode
pnpm dev
```

Set `INVENTORY_REPOSITORY_URL` to the project's clone URL before the example. The API scripts load `.env` from the repository root, not `apps/api/.env`. Bootstrap requests username, display name, phone, email, password and confirmation; see [users.md](users.md).

## Services

| Service | URL | Notes |
| --- | --- | --- |
| API | http://localhost:3000 | Health check: `GET /health` |
| Web | http://localhost:5173 | Vite dev server with HMR |

## Useful scripts

| Script | Description |
| --- | --- |
| `pnpm dev` | Start API + web in parallel. |
| `pnpm dev:api` | Start API only. |
| `pnpm dev:web` | Start web only. |
| `pnpm lint` | Run ESLint across the monorepo. |
| `pnpm typecheck` | TypeScript type checking. |
| `pnpm build` | Build all packages. |
| `pnpm test` | Run API tests (requires a running PostgreSQL). |
| `pnpm prisma:validate` | Validate the Prisma schema. |
| `pnpm db:generate` | Generate Prisma client. |
| `pnpm db:migrate` | Generate client + deploy migrations. |
| `pnpm bootstrap:admin` | Create the initial JEFE administrator. |

## Database URL

The default `DATABASE_URL` is:

```
postgresql://postgres:postgres@localhost:5432/inventory_ti
```

Adjust the username, password, host, and port to match your PostgreSQL installation.

## Running tests

Tests use the Node built-in runner and a **new disposable PostgreSQL database** per launch. The role must connect to the server's `postgres` maintenance database and have `CREATEDB`. The launcher migrates and runs fixtures only inside the generated `inventory_ti_test_<uuid>` database, then drops that database; it never uses the supplied application database as the fixture target.

```bash
pnpm test
```

The launcher loads the root `.env`. `TEST_DATABASE_URL` optionally supplies separate test-server credentials, otherwise it uses those in `DATABASE_URL`; exported values take precedence. Do not grant the production runtime role `CREATEDB` just to run tests. Direct integration-file invocation without the isolation marker fails. SIGKILL may leave a uniquely named temporary database for operator inspection; see [testing.md](../technical/testing.md#database-isolation).

## First login

1. Run `pnpm bootstrap:admin` to create the initial `JEFE` user.
2. Open http://localhost:5173 in your browser.
3. Log in with the credentials you provided during bootstrap.
4. Use the application to create products and additional users.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md).
