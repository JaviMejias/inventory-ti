# Production Deployment

This manual Linux recipe covers the **backend**: one Node process, PostgreSQL, systemd and an HTTPS reverse proxy. It is a configuration template, not an automated installer or evidence of a production deployment. Docker, CI/CD and automated backups are not provided. Web asset deployment is outside this guide.

## Prerequisites and layout

- Node **24.x** and pnpm **11.19.0**, matching `package.json`; do not use an arbitrary newer Node major.
- Accessible PostgreSQL; 14+ is the documented baseline, while current backend verification used PostgreSQL 18.6. Verify the chosen server version in staging.
- A dedicated unprivileged Linux service account/group named `inventory-ti`, a checkout at `/opt/inventory-ti`, and an operator able to install the systemd unit and configure HTTPS.
- PostgreSQL ownership/DDL privileges for migrations. Runtime credentials need application table/sequence access, not `CREATEDB` or superuser privileges. Tests use separate credentials and disposable databases.
- An existing HTTPS virtual host, for example `https://inventory.example.com`. The proxy below assumes one local, directly internet-facing Nginx instance.

Adapt account, paths, domain, grants and executable locations to the server. Have the DBA create the application database before migrating. Do not run the service as root. The service account must read the checkout and dependencies; restrict who can modify deployed code and configuration.

## Configuration

Keep the canonical environment file at `/opt/inventory-ti/.env`. Use simple `KEY=value` entries, no `export`, shell substitutions or multiline values, so it works with both Node scripts and systemd. Protect it (for example owner `root`, group `inventory-ti`, mode `0640`); never commit it or include it in public artifacts.

Replace these placeholders securely in an editor:

```dotenv
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=3000
WEB_ORIGIN=https://inventory.example.com
TRUST_PROXY=loopback
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
SESSION_TTL_HOURS=8
DATABASE_URL=postgresql://REPLACE_WITH_DATABASE_CREDENTIALS/inventory_ti
SESSION_SECRET=REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS
```

Generate the session secret once per installation, store it securely and preserve it across routine releases. Rotate deliberately, coordinating client CSRF-token refresh; do not generate a new secret on every restart. Generate locally with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Do not paste the generated value into logs or tickets. See [configuration.md](configuration.md) for all variables and cookie/site limitations.

## Prepare a release

From the checkout, with supported Node and pnpm on `PATH`:

```bash
cd /opt/inventory-ti
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm prisma:validate
pnpm db:generate
pnpm --filter @inventory-ti/api typecheck
pnpm --filter @inventory-ti/api build
```

Keep full dependencies for these commands: Prisma CLI and `tsx` are development dependencies used by migration/bootstrap tools. Do not install only production dependencies and expect those tools to work. On updates, prepare/build in a separate release checkout before replacing files used by the running service, or stop it before changing an in-place checkout. Keep the previous release available.

API development, Prisma, bootstrap and test scripts load the root `.env`; explicitly exported variables take precedence. Confirm operator CLI and service use the intended database. Production `start` does **not** explicitly load this file: the unit below injects it.

## First installation

1. Review migration SQL and permissions; for an existing database, follow the update procedure instead.
2. Run `pnpm db:migrate` from the root.
3. Run `pnpm bootstrap:admin` from the same root **before opening access**. The API need not be running. Provide username, display name, phone, email, password and confirmation in that order. It refuses if any users already exist. See [users.md](users.md).
4. Install the process manager and HTTPS proxy below.
5. Perform startup checks and verify authenticated reads before normal use.

There are no seeded credentials or automatic administrators on startup.

## API process manager

Save as `/etc/systemd/system/inventory-ti-api.service`. Verify `/usr/bin/node` is **Node 24.x**; replace the absolute executable path if necessary. The service does not inherit the interactive shell's Node version manager.

```ini
[Unit]
Description=Inventory TI API
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=inventory-ti
Group=inventory-ti
WorkingDirectory=/opt/inventory-ti
EnvironmentFile=/opt/inventory-ti/.env
ExecStart=/usr/bin/node /opt/inventory-ti/apps/api/dist/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

See the [systemd execution reference](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) for environment-file, identity and working-directory settings. This unit does not wait for database readiness.

Validate and start **on the deployment host**:

```bash
sudo systemd-analyze verify /etc/systemd/system/inventory-ti-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now inventory-ti-api
sudo systemctl status inventory-ti-api --no-pager
sudo journalctl -u inventory-ti-api -n 100 --no-pager
```

Do not start a second API with `pnpm start` while the unit owns port 3000.

## HTTPS reverse proxy

Add this **inside the existing HTTPS `server` block**. TLS certificates, HTTP-to-HTTPS redirection and web hosting must already be configured by the owner; this fragment is not a complete Nginx configuration.

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_cache off;
}
```

The trailing slash in `proxy_pass` strips `/api/`: `/api/auth/me` reaches `/auth/me`, the actual API route. See [Nginx proxy_pass documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

For this single-proxy topology, replace client-supplied forwarding headers with the direct client address. With an upstream load balancer/CDN, review its trusted real-IP chain and explicit trusted IPs/CIDRs instead of copying this assumption. Never set blanket proxy trust. Keep port 3000 private; the browser uses HTTPS and the same public origin for `/api`. Current backend traffic is REST only; WebSocket upgrades are not needed.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Check syntax on the actual host before reloading. Do not override `Access-Control-Allow-Origin` in the proxy; the API uses `WEB_ORIGIN`.

## Startup and readiness checks

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/health
curl --fail --silent --show-error https://inventory.example.com/api/health
node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma
```

`GET /health` only returns `200 {"service":"api","status":"ok"}`. It does **not** query PostgreSQL, validate migrations or authenticate a user. Migration status verifies connectivity and migration state, but not runtime credentials if the operator uses a separate migration role. Verify database access with the runtime role, then log in, fetch `/auth/me` and a protected read such as `/products` through HTTPS. Check cookies/CSRF and permissions using [users.md](users.md). A green `/health` alone is not readiness.

The API closes HTTP and disconnects Prisma on termination. Use normal process-manager stop/restart, not forced termination except when necessary.

## Updating an existing installation

1. Prepare/validate the new release and retain the old release/lockfile. Review every pending migration and [preflight checks](database.md#preflight-for-an-existing-database).
2. Schedule maintenance and stop **all API writers**, including replicas/operator jobs. `sudo systemctl stop inventory-ti-api` stops this single-instance example. Keep public requests in maintenance until checks succeed.
3. Take a protected backup and verify restoration into a **new disposable database** using [backups.md](backups.md). Record backup path, old release and migration status. Category/location removal is destructive; lost detail cannot be recovered from the new schema alone.
4. From the new checkout run `pnpm db:migrate`. A nonzero exit is a deployment failure: do not restart.
5. Point the service at the prepared release (adapt unit/layout), then `sudo systemctl restart inventory-ti-api`. Run `daemon-reload` first if the unit changed.
6. Check logs, migration status, runtime database access and authenticated HTTPS reads. Only then end maintenance. Do not rerun bootstrap on an existing installation.

## Failure and rollback

- **Migration failure:** earlier migrations in the batch may already have committed; a failing SQL file is not automatically guaranteed atomic. Inspect `_prisma_migrations` and actual schema. `0010`, `0011` and `0012` contain explicit transactions; this does not make the whole deployment transactional. Follow [database recovery](database.md#failed-migrations); never blindly mark a failure applied or edit an applied file.
- **Startup failure:** inspect logs, Node path, file permissions and environment validation. Prisma may connect lazily; the process can start even when database-backed requests fail.
- **Database unavailable:** restore connectivity first. Restore a backup only through an approved recovery plan when data/schema recovery requires it, not automatically for a connection error.
- **Application rollback:** use the previous build only after confirming compatibility with deployed schema. There is no automatic down-migration. If restoring data/schema is required, restore into a new database, verify it, then perform a controlled cutover; writes after the backup may be lost.

## Operational responsibilities outside the repository

Provisioning/TLS, backup scheduling/retention, off-host copies, monitoring/alerts, restore drills, multi-instance distributed rate limiting and CI/CD are operator work, not installed capabilities. Docker, realtime and file storage remain planned. This guide does not install or modify a production service/database.
