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

`pnpm db:migrate` runs `prisma migrate deploy`, which applies pending migrations without modifying the schema. This is the command used in both development and production.

It does **not** create new migrations or reset the database. It only applies existing migration files that have not yet been applied.

### Creating new migrations

When the schema changes during development, use the Prisma CLI directly:

```bash
pnpm --filter @inventory-ti/api exec prisma migrate dev --schema ../../prisma/schema.prisma --name <migration_name>
```

This creates a new migration directory under `prisma/migrations/` and applies it to the development database.

**Never use `migrate dev` in production.** Use `migrate deploy` only.

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

Before deploying `0010_remove_locations` to a database with operational data, take and verify a database backup. The migration drops location-level distinctions after summing each product's stock; that location detail cannot be recovered from the new schema.

## Bootstrap administrator

The initial `JEFE` user must be created explicitly:

```bash
pnpm bootstrap:admin
```

This command:
- prompts for a username, display name, and password (hidden input);
- creates a `JEFE` user with a scrypt-hashed password;
- writes an audit log entry (`USER_BOOTSTRAP_JEFE`);
- refuses to run if any users already exist (safe against accidental re-execution);
- uses a PostgreSQL advisory lock for concurrent safety.

See [development.md](development.md) for local setup or [production.md](production.md) for production deployment.

## Schema invariants enforced by PostgreSQL

- `InventoryMovement` records are append-only (trigger prevents UPDATE/DELETE).
- `InventoryStock.quantity` cannot go below zero (CHECK constraint).
- `Product.lowStockThreshold` cannot be negative (CHECK constraint).
- `Assignment.endedAt` must be after `startedAt` when set (CHECK constraint).
- `Assignment` has a partial unique index allowing at most one active assignment per asset (where `endedAt IS NULL`).
- `Asset(productId, serialNumber)` is unique when serial number is present.
- `Asset.assetTag` is globally unique when present.
- `InventoryStock(productId)` is unique; stock is consolidated per product.
