# Deployment Documentation

This section covers how to install, run, configure, update, and back up Inventory TI.

| Document | Purpose |
| --- | --- |
| [Configuration](configuration.md) | Environment variables and secrets. |
| [Development](development.md) | Local development setup (no Docker). |
| [Docker](docker.md) | Docker development and production (planned, not yet provided). |
| [Production](production.md) | Deploying to a production server. |
| [Database](database.md) | Migrations, schema management, database operations. |
| [Backups](backups.md) | Backup strategy and restore procedures. |
| [Troubleshooting](troubleshooting.md) | Common issues and solutions. |

## Quick answers

### What do I install?

- **Node.js** >= 24.0.0 < 25.0.0
- **pnpm** >= 11.0.0 (the repository pins `pnpm@11.19.0` via `packageManager`)
- **PostgreSQL** (any recent version, 14+ recommended)

### How do I run locally?

```bash
pnpm install
cp .env.example .env        # edit with your database credentials
DATABASE_URL=... pnpm db:migrate
pnpm bootstrap:admin         # first time only — creates the initial JEFE
pnpm dev                     # starts API + web together
```

See [development.md](development.md) for full details.

### How do I deploy to production?

See [production.md](production.md).

### How do I back up the database?

See [backups.md](backups.md).

## Implemented vs. planned

- **Implemented:** local development workflow, bootstrap admin command, migration tooling.
- **Planned (not yet provided):** Docker development stack, Docker production deployment, automated backups, CI/CD pipeline.

See [docker.md](docker.md) for the planned Docker approach.
