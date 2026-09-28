# Production Deployment

> **Status:** A Docker-based production stack is **planned but not yet provided**. The instructions below describe the deployment architecture the project is designed for, and the pieces that are currently implemented and runnable. No production container images or compose files exist in the repository yet.

## Target architecture

```text
Production server
        ↓
Reverse proxy / HTTPS (e.g. Nginx/Caddy/Traefik)
        ↓
API (Node.js + Fastify, Prisma)
        ↓
PostgreSQL
        ↓
Web app (built static assets, served by the reverse proxy or a static server)
```

## What is currently implemented

- The API is a single Node.js process started with `node dist/server.js` (built with `pnpm build`).
- The web app builds to static assets with Vite (`pnpm build` → `apps/web/dist`).
- PostgreSQL migrations are applied declaratively with `prisma migrate deploy` (see [database.md](database.md)).
- The initial administrator is created with `pnpm bootstrap:admin` (see [development.md](development.md) and [bootstrap-administrator](#bootstrap-administrator)).

## Production environment

Required configuration (see [configuration.md](configuration.md)):

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `COOKIE_SECURE` | `true` (the API refuses to start otherwise) |
| `SESSION_SECRET` | A newly generated random value ≥ 32 characters |
| `DATABASE_URL` | Production PostgreSQL connection string |
| `WEB_ORIGIN` | The https origin serving the web app |

`SESSION_SECRET` must be generated fresh per deployment and never committed:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## First deployment

1. Install Node.js (>= 24) and pnpm, install dependencies, configure environment, point `DATABASE_URL` at the production database.
2. Apply migrations (back up the database first on an existing installation):

   ```bash
   pnpm db:migrate
   ```

3. Build the applications:

   ```bash
   pnpm build
   ```

4. Create the initial administrator (only on an empty database):

   ```
   pnpm --filter @inventory-ti/api start   # in the background / process manager
   pnpm bootstrap:admin                    # interactive; creates the first JEFE
   ```

   > `bootstrap:admin` requires environment variables (at minimum `DATABASE_URL`) in the shell it runs in.

5. Start the API from the built output:

   ```bash
   node apps/api/dist/server.js
   ```

6. Serve the built web assets from `apps/web/dist` behind the reverse proxy, proxying `/api`-equivalent routes (the API is at `http://localhost:3000`) and forwarding `WebSocket` upgrades when realtime is added.

## Bootstrap administrator

`pnpm bootstrap:admin` is the only supported way to create the first administrator. Behavior:

- prompts for a username, display name, and password (hidden input; no default credentials);
- rejects execution if **any** users already exist in the database;
- hashes the password with the same scrypt mechanism used by the application;
- writes an audit `USER_BOOTSTRAP_JEFE` entry;
- is safe against accidental re-execution and against running on an already-populated database;
- never prints the password and never stores it in plain text.

There is **no** automatic `admin/admin`, no seeded default user, and no automatic administrator creation on startup.

## Update procedure

1. Pull the new version.
2. Back up the database (see [backups.md](backups.md)).
3. Apply migrations:

   ```bash
   pnpm db:migrate
   ```

4. Build the applications:

   ```bash
   pnpm build
   ```

5. Restart the API process (the process manager restarts it).
6. Run a health check (`GET /health` returns `200 {"service":"api","status":"ok"}`).
7. Verify the application.

### If something fails during an update

| Failure | Behavior |
| --- | --- |
| Migration fails | Database is unchanged (migrations are atomic per migration). Do not restart the API pointing at a mismatched schema until the migration issue is resolved. Investigate the failing migration and fix forward (never edit applied migrations retroactively). |
| API does not start | The process exits with a logged error. The process manager does not mark it healthy. Check logs; the most common causes are a missing/invalid `SESSION_SECRET`, `COOKIE_SECURE=false` in production, or an unreachable database. |
| Database unavailable | The API starts but requests fail. Check PostgreSQL connectivity and restore from backup if data is lost. |
| Frontend build fails | The new assets are not published; the previous version continues to be served by the reverse proxy until the build succeeds and is deployed. |
| Container crashes | If a containerized deployment is used, ensure `restart` policies and health checks are defined (planned for the future Docker setup). |

## Session cookie security

Production sessions require `COOKIE_SECURE=true` (enforced by the API when `NODE_ENV=production`), serving the app over HTTPS, and a strong `SESSION_SECRET`. The cookie is `HttpOnly`, `SameSite=Lax`, and scoped by default to the API origin.

## CORS

`WEB_ORIGIN` must be exactly the origin the browser uses for the web app. In production this is the https origin. `@fastify/cors` allows only that single origin with credentials.

## Rollback considerations

- Database migrations are applied forward-only. Downgrading generally requires manual SQL and is not automated.
- To roll back a bad application release, redeploy the previous build (migrations already applied remain applied) and restore the database if the release mutated data incorrectly.

## Not yet implemented

- Container images / Docker Compose for production (see [docker.md](docker.md)).
- Automated backups (see [backups.md](backups.md)).
- CI/CD pipeline.
- Realtime/WebSocket infrastructure (see [technical/realtime.md](../technical/realtime.md)) and PWA service worker (see [technical/pwa.md](../technical/pwa.md)).