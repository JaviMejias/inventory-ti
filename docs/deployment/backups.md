# Backups and Restore Verification

Backup scheduling, retention, off-host storage and recovery are **operator responsibilities**; the repository does not install backup automation or point-in-time recovery.

## Scope and credentials

PostgreSQL is the only durable application state currently implemented: users, sessions, activation-code hashes, catalog, stock, movements, assets, assignments, corrections and audits. File storage is planned, not operating today.

Dumps contain sensitive personal data and credential hashes. Restrict access, encrypt retained/off-host copies, and keep dumps outside Git and public web directories. Preserve deployment configuration/secrets separately in an approved secret store. Never put database passwords in CLI arguments, tickets or logs.

Use PostgreSQL client tools compatible with the server; `pg_dump` cannot dump a server from a newer major than itself. Match the server major for this recipe (current project verification: PostgreSQL 18.6). See [pg_dump documentation](https://www.postgresql.org/docs/18/app-pgdump.html).

Configure libpq `PGHOST`, `PGPORT`, `PGUSER` for the selected server and a protected `PGPASSFILE` (Unix mode `0600`), or equivalent approved authentication. These variables are **not** populated automatically from the application's `DATABASE_URL`. Confirm the selected source explicitly:

```bash
psql --dbname=inventory_ti --command='SELECT current_database(), current_user, version();'
```

The account needs access to all objects being dumped. Database roles/grants and server configuration are not provisioned by this single-database backup.

## Take a logical backup

Have the operator provision a protected directory such as `/var/backups/inventory-ti`, writable only by the backup operator. Replace the source database name if different, then:

```bash
umask 077
BACKUP_FILE="/var/backups/inventory-ti/inventory_ti_$(date -u +%Y%m%d_%H%M%S).dump"
pg_dump --dbname=inventory_ti --format=custom --file="$BACKUP_FILE" && \
  pg_restore --list "$BACKUP_FILE"
```

Stop on any dump error; an existing/incomplete file is not evidence of success. Archive listing checks readability, **not restorability**. For an update, stop all API writers before the final backup and keep maintenance until the release is verified; this gives a defined rollback point. Record the source/server, timestamp, release, migration status and backup checksum in protected operational records.

## Verify restoration into a new disposable database

Never test restore over `inventory_ti` or any live database. Use a separate staging server where possible. Configure target-server libpq credentials independently, including permission to create the verification database. Confirm the target server before continuing.

Choose a name reserved for this drill, here `inventory_ti_restore_check`. **Do not reuse a populated database.** Creation must succeed; if it already exists, stop and have the operator choose another explicitly disposable target. Do not add `--clean`, drop a database, or force an overwrite to make the example work.

Use the exact protected backup path produced above; if opening another shell, set `BACKUP_FILE` to that verified existing file.

```bash
createdb --template=template0 inventory_ti_restore_check && \
  pg_restore --dbname=inventory_ti_restore_check \
    --single-transaction --exit-on-error --no-owner --no-privileges \
    "$BACKUP_FILE"
```

The `&&` gate prevents restoration if target creation failed (including an existing target). Continue with verification **only if that command succeeded**:

```bash
psql --dbname=inventory_ti_restore_check --set=ON_ERROR_STOP=1 \
  --command='SELECT current_database(), current_user;'
psql --dbname=inventory_ti_restore_check --set=ON_ERROR_STOP=1 \
  --command='SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at;'
psql --dbname=inventory_ti_restore_check --set=ON_ERROR_STOP=1 \
  --command='SELECT (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM "Product") AS products, (SELECT count(*) FROM "InventoryMovement") AS movements, (SELECT count(*) FROM "CorrectionRequest") AS corrections;'
```

Check each exit code; do not continue verification after a failure. `--single-transaction` makes this restore atomic; `--no-owner --no-privileges` avoids requiring original owners/grants for a portable **verification** restore. These options are described in [pg_restore documentation](https://www.postgresql.org/docs/18/app-pgrestore.html). A real recovery must recreate and validate the intended runtime ownership/grants separately.

Check counts against the backup source's recorded counts, migration records, expected indexes/triggers/constraints and representative stock/history queries. For an application drill, point an **isolated, nonpublic API process** and its configuration at the restored database; verify login and protected reads with an authorized account. A restored database still contains real personal data and valid credential/session hashes: apply the same protection as production, never expose it publicly or use it for fixtures.

A dump carries its own schema and `_prisma_migrations`. Compare restored state with the selected application release using `migrate status`; apply only genuinely pending forward migrations through the reviewed deployment procedure. Never run migrations against a different database just because a dump has been restored.

## Recovery and retention

For actual recovery, agree on downtime, acceptable data loss and the target release, restore into a **new database**, verify schema/data/grants/application, then perform an explicit configuration cutover. Preserve the old database until the operator approves cleanup. Writes since the backup may be lost; there is no automatic down-migration or cutover.

Schedule backups to match the required recovery-point objective; take one before migrations/major upgrades, retain protected off-host copies and regularly perform restore drills. Record successful checks and failures. The owner must also arrange cleanup of verified disposable restore databases; no destructive cleanup command is included here.
