# Database Operations

## Prisma workflow

The project uses Prisma as the ORM and migration tool. The schema is at `prisma/schema.prisma`.

### Commands

| Command | Description |
| --- | --- |
| `pnpm prisma:validate` | Validate the Prisma schema without applying changes. |
| `pnpm db:generate` | Generate the Prisma client (required after schema changes or `pnpm install`). |
| `pnpm db:migrate` | Generate client + deploy pending migrations (`migrate deploy`). |

### Migration deploy

`pnpm db:migrate` generates the client and runs `prisma migrate deploy`, which **changes the database schema/data according to pending SQL files**. It does not generate migrations or rewrite `schema.prisma`. This command is used in both development and production.

It does **not** create new migrations or reset the database. It only applies existing migration files that have not yet been applied.

### Creating new migrations

When the schema changes during development, use the Prisma CLI directly:

```bash
node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate dev --schema prisma/schema.prisma --name descriptive_change_name
```

This creates a new migration directory under `prisma/migrations/` and applies it to the development database.

**Never use `migrate dev` in production.** Use `migrate deploy` only.

Run the example from the repository root against a development database only; it may require a shadow database and can request destructive actions. Review generated SQL before committing.

### Destructive commands (development only)

Commands such as:

```bash
prisma migrate reset
prisma db push --force-reset
```

are **development-only** and must never be run against a production database.

## Current migrations

The repository has the following migrations:

| Migration | Purpose |
| --- | --- |
| `0001_initial_database` | Core schema: Users, Categories, Products, InventoryStock, Assets, InventoryMovements, Assignments, CorrectionRequests, AuditLogs. Includes DB-level constraints and a trigger preventing movement updates/deletes. |
| `0002_auth_sessions` | Adds the `Session` table for server-side session management. |
| `0003_assignment_ended_by` | Adds the nullable `endedById` column to `Assignment` (Phase 6B preparation). |
| `0004_assignment_integrity` | Adds database-level assignment history integrity checks and protections. |
| `0005_correction_delta` | Adds the signed correction delta and validates existing correction data. |
| `0006_category_color` | Historical category presentation field; removed by the later category-removal migration. |
| `0007_assignment_person_name` | Adds the denormalized person name snapshot and allows historical assignments without a user row. |
| `0008_user_activation_lifecycle` | Adds nullable user phone/password state and one-time activation codes. |
| `0009_remove_categories` | Removes the Category table and Product category association; enforces globally unique product names. |
| `0010_remove_locations` | Consolidates stock by product, migrates historical transfers to a paired entry/exit, removes location fields and the Location table, and removes the transfer movement type. |
| `0011_correction_final_quantity` | Backfills final signed correction quantities, retains deltas and original records, and adds a partial unique index allowing one pending request per movement. |
| `0012_backend_integrity` | Rejects normalized duplicate SKUs, adds a case-insensitive trimmed SKU index and a trigger preventing tracking-mode changes after any stock, movement or asset exists. |

Before deploying `0010_remove_locations` to a database with operational data, take and verify a database backup. The migration drops location-level distinctions after summing each product's stock; that location detail cannot be recovered from the new schema.

## Preflight for an existing database

Read migration status from the repository root using the intended migration credentials:

```bash
node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma
```

Pending/failed migrations may produce a nonzero status; inspect the output rather than treating it as a successful deployment. Review **all** pending SQL, preserve the previous release and verify a [backup restore](backups.md) before migrating. Stop writers during the maintenance window, especially for category/location removal. Never resolve conflicts by silently deleting products/history.

Run these read-only checks on the existing database before the corresponding migrations (use a trusted SQL client; database credentials are not shown):

```sql
-- Before 0009: globally unique product names after removing categories.
SELECT lower(btrim("name")) AS normalized_name, count(*) AS occurrences
FROM "Product" GROUP BY lower(btrim("name")) HAVING count(*) > 1;

-- Before 0011: one pending correction per original movement.
SELECT "originalMovementId", count(*) AS occurrences
FROM "CorrectionRequest" WHERE "status" = 'PENDING'
GROUP BY "originalMovementId" HAVING count(*) > 1;

-- Before 0012: normalized nonblank SKU uniqueness.
SELECT lower(btrim("sku")) AS normalized_sku, count(*) AS occurrences
FROM "Product" WHERE "sku" IS NOT NULL AND btrim("sku") <> ''
GROUP BY lower(btrim("sku")) HAVING count(*) > 1;
```

These checks do not replace migration review: earlier correction backfills require recoverable historical deltas, final quantities and consolidated stock must fit PostgreSQL `INTEGER`, and corrupt references/data need a reviewed repair. `0010`, `0011` and `0012` have explicit transactions, but the full migration batch is not a single transaction.

## Failed migrations

Do not assume the database is unchanged. Prior migrations may be committed and older SQL files do not all wrap themselves in an explicit transaction. Keep the API stopped while code and schema disagree. Inspect migration status, `_prisma_migrations` (including `logs`, `finished_at`, `rolled_back_at`) and the actual affected tables/indexes/triggers.

Never edit an applied migration or blindly use `migrate resolve --applied`. An operator must determine whether to undo partially applied SQL and mark it rolled back, complete a reviewed repair and mark it applied, or restore/cut over from a verified backup. `migrate resolve` changes bookkeeping; it does not execute or undo SQL. Then redeploy pending migrations and repeat checks. Production database reset, fixture cleanup and force-reset are not recovery procedures.

## Bootstrap administrator

The initial `JEFE` user must be created explicitly:

```bash
pnpm bootstrap:admin
```

This command:

- prompts for username, display name, phone, email, password and confirmation, in that order (password inputs hidden);
- creates a `JEFE` user with a scrypt-hashed password;
- writes an audit log entry (`USER_BOOTSTRAP_JEFE`);
- refuses to run if any users already exist (safe against accidental re-execution);
- uses a PostgreSQL advisory lock for concurrent safety.

See [development.md](development.md) for local setup or [production.md](production.md) for production deployment.

See [users.md](users.md) for required fields, activation, reset, last-administrator protection and recovery limitations. Bootstrap needs no running API and cannot recover a populated user table.

## Schema invariants enforced by PostgreSQL

- `InventoryMovement` records are append-only (trigger prevents UPDATE/DELETE).
- `InventoryStock.quantity` cannot go below zero (CHECK constraint).
- `Product.lowStockThreshold` cannot be negative (CHECK constraint).
- `Assignment.endedAt` must be after `startedAt` when set (CHECK constraint).
- `Assignment` has a partial unique index allowing at most one active assignment per asset (where `endedAt IS NULL`).
- `Asset(productId, serialNumber)` is unique when serial number is present.
- `Asset.assetTag` is globally unique when present.
- `InventoryStock(productId)` is unique; stock is consolidated per product.
- Normalized product names and nonblank SKUs are unique case-insensitively.
- Product tracking mode cannot change after any stock row (even zero), movement or asset exists; both service locks and the `0012` trigger protect this rule.
- Quantities are signed 32-bit integers; service validation also rejects stock overflow and negative resulting stock.

The usable-JEFE floor is an **application transaction invariant**, not a database trigger. Direct operator SQL can bypass it; do not modify account state outside a reviewed procedure. Expression/partial indexes and triggers live in migration SQL and are not all represented by Prisma schema syntax.
