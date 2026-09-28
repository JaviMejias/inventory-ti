# Backups

> **Status:** No automated backup tooling exists in the repository. Backup is an **operational responsibility** of the deployment owner. This page documents what is needed and how to perform PostgreSQL backups manually.

## What needs to be backed up

- **PostgreSQL database** — this is the only durable application state. It contains users, sessions, catalog, stock, movements, assets, assignments, corrections, and audit logs.
- There is **no file storage** in operation today (storage is planned), so no file/object store must be backed up yet. If/when file storage is added, see [technical/storage.md](../technical/storage.md).

## Where persistent data lives

- Local/development: inside the PostgreSQL instance addressed by `DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5432/inventory_ti`).
- Docker (when implemented): a named volume for the `db` service. Database dumps must be taken through `pg_dump` (a volume copy is **not** a safe backup while the server is running).

## Performing a backup

Use `pg_dump` (logical backup), which is safe on a running server:

```bash
pg_dump "postgresql://USER:PASSWORD@HOST:5432/inventory_ti" \
  -Fc -f inventory_ti_$(date +%Y%m%d_%H%M%S).dump
```

## Restoring

```bash
pg_restore --clean --if-exists \
  -d "postgresql://USER:PASSWORD@HOST:5432/inventory_ti" \
  inventory_ti_20260101_000000.dump
```

Restore into an empty (or confirmed disposable) target database. Migrations must be in sync with the dump; after restoring, run `pnpm db:migrate` only if the dump predates migrations already applied to the new database — otherwise let the schema come from the dump and do not re-run migrations.

## When to run backups

- Before **any** `migrate deploy` against an existing database (see [database.md](database.md) and [production.md](production.md)).
- Before major version upgrades.
- On a regular cadence (e.g., daily) for production, with a retention policy (e.g., keep N days/weekly/monthly).
- After configuring automated backups, test restores periodically — an untested backup is not a backup.

## What is not currently implemented

- Scheduled automated backups.
- Offsite/object-storage backup targets.
- Point-in-time recovery tooling.
- Restore drills in CI.

These are future work and documented here so they are not assumed to exist.