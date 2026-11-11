# Database

This document defines the data model, integrity rules, and indexing guidance implemented through Prisma and PostgreSQL.

Related documents:

- [inventory.md](../product/inventory.md) — inventory concepts.
- [assets.md](../product/assets.md) — assets and assignments.
- [workflows.md](../product/workflows.md) — operations, corrections, assignments.
- [decisions.md](decisions.md) — ADR-2, ADR-3, ADR-4, ADR-10.

## 1. Conceptual model

Entities:

```text
Users
Roles
Products
Assets
Assignments
Materialized inventory / current stock
InventoryMovements
Corrections
AuditLogs
Sessions and ActivationCodes
```

> Roles are a fixed enum, not a separate table. Notifications, `Office` and repair management are future scope, not current tables.

## 2. Relationships

```text
Product
  ├── quantity-based inventory   → materialized stock quantity
  └── asset-based inventory      → set of Assets

Asset
  └── belongs to Product

Asset
  └── has status

Asset
  └── has Assignment history

InventoryMovement
  └── records inventory changes (product/asset/qty/type/user/time/reason)

Correction
  └── references original movement
  └── produces compensating movement when approved
```

### Relationship highlights

- **User** has one **Role** (MVP: fixed roles; future granular permissions may extend this).
- **User** stores the labor phone, nullable for legacy rows, and uses nullable `passwordHash` to represent pending activation; **ActivationCode** stores only a hash, expiration, and one-use timestamp.
- **Product** can be quantity-based or asset-based (tracking mode, see ADR-4).
- **Conceptually**: products → materialized stock; assets → per-asset status rows.
- **Assignment** links **Asset** ↔ **Person** (a user/contact), with timestamps for begin/end, and full history rows.
- **InventoryMovement** records the immutable history (see [inventory.md](../product/inventory.md) §4).
- **Correction** references the original movement; when approved, produces a compensating movement (typically `ADJUSTMENT`).
- **Correction** stores signed final `correctedQuantity` and non-zero compensating `delta` derived from the effective movement quantity. Stock changes only on approval (immediate and audited for new JEFE requests).

## 3. Immutable movements + materialized stock (ADR-3)

Two distinct representations:

1. **InventoryMovements** — the immutable history of inventory-changing operations.
2. **Materialized stock** — the current-state representation used by reads.

Rules:

- Movements are **immutable**; never updated after creation.
- Materialized stock may change **only** as part of a valid transaction that also records the movement.
- The system must **not** recompute current stock from full movement history on every read (no event sourcing, no CQRS — see ADR-3).
- Inventory operations lock each product's `InventoryStock` row with PostgreSQL `FOR UPDATE`.
- `INITIAL` uniqueness is enforced transactionally per product. `ADJUSTMENT` uses a signed non-zero integer delta; other movement quantities are positive.

### Transactional invariant

```text
create immutable movement
        +
update materialized stock      ⇒  same transaction
```

## 4. Integrity rules

- **Immutability**: `InventoryMovement` records are append-only. No `UPDATE`/`DELETE` of movements.
- **Transactional stock updates**: movement creation + materialized stock update are atomic; failed transactions leave no partial state.
- **No direct stock edits**: there is no stock mutation endpoint; all changes originate in movement routes.
- **Appropriate foreign keys**:

  - `Asset.productId → Product.id`
  - `Assignment.assetId → Asset.id`
  - `Assignment.personId → User.id` (nullable; `personName` retains the name snapshot)
  - `Assignment.createdById / endedById → User.id`
  - `InventoryMovement.productId → Product.id`
  - `InventoryMovement.assetId → Asset.id` (nullable, retained schema relation; current asset operations do not create inventory movements)
  - `InventoryMovement.performedById → User.id` (nullable for retained/system history)
  - `CorrectionRequest.originalMovementId → InventoryMovement.id`
  - `CorrectionRequest.compensatingMovementId → InventoryMovement.id` (nullable, set on approval)
  - `CorrectionRequest.requestedById / reviewedById → User.id`
  - `Session.userId / ActivationCode.userId → User.id` (cascade on user removal; application policy uses inactivation instead)
  - `AuditLog.userId → User.id` (nullable for system events; `SET NULL` on user removal)

- **Unique constraints where appropriate**:

  - users: unique login identifier (username or email);
  - assets: unique serial/id per product (or as business rules dictate);
  - one active assignment per asset (partial unique where supported) — an asset has at most one **active** assignment;
  - movement/correction reference integrity preserved.

- **Soft deletion/inactivation** where historical references require it (e.g., users, products, assets that are referenced by movements/assignments are inactivated rather than hard-deleted).

### Asset and assignment persistence

- `Asset.assetTag` is globally unique when present.
- `Asset(productId, serialNumber)` is unique when a serial number is present.
- Asset rows reference `Product` with a restrictive foreign key.
- Product tracking-mode changes are blocked after any stock row, movement or asset exists, by service-level product locks and the `0012_backend_integrity` trigger. Asset state transitions are validated by the asset service.
- Asset mutations and corresponding audit entries are atomic.
- Asset state is the current-state representation for asset-tracked products; `InventoryStock` remains exclusive to quantity tracking.
- `Assignment.createdById` is required and `endedById` is required once an assignment is closed; historical user relations use restrictive foreign keys.
- A partial unique index permits at most one active Assignment per Asset. A PostgreSQL check constraint requires ended assignments to contain both `endedAt` and `endedById`.
- PostgreSQL triggers prevent Assignment deletion and mutation of historical identity/timestamp fields. Deferred consistency triggers enforce `Asset.status = ASSIGNED` exactly when one active Assignment exists at commit.
- Assignment/Asset/AuditLog changes are atomic and do not touch `InventoryStock` or `InventoryMovement`.

## 5. Indexes

Indexes for common inventory/movement queries:

- movements by product + time;
- movements by asset;
- movements by user;
- movements by type + time;
- corrections by original movement;
- assignments by asset, by person, active assignment lookup;
- materialized stock by product;
- assets by product and status.

Migration SQL also provides globally unique expression indexes on normalized names (`0009`) and nonblank SKUs (`0012`), plus a partial index for one pending correction per original (`0011`). Review migrations, not Prisma schema alone, for these protections.

The schema and migration SQL are the source of truth for indexes; PostgreSQL tables are not automatically clustered by timestamp. Movement reads order by `effectiveAt`, and corrected history uses deterministic `effectiveAt`, `createdAt`, `id` ordering.

## 6. Monetary/quantity values

- **Never use floating point** for monetary values; use integer-based representation (e.g., cents) or an exact decimal type.
- Quantities use PostgreSQL signed 32-bit `INTEGER` (`-2147483648` to `2147483647`). Stock/thresholds must be nonnegative; movement-specific signs also apply. Backend validation rejects out-of-range inputs, and mutations reject stock overflow with `409 STOCK_LIMIT_EXCEEDED` before committing.

## 7. Notifications (planned)

There is no Notification model/table or delivery worker today. Low-stock visibility uses stock/product thresholds; correction state and audits persist in their own tables. Future notification persistence must not be assumed from conceptual module descriptions.

## 8. Sensitive data

- Password hashes only (see [security.md](security.md) §3).
- No secrets/tokens in plaintext tables.

### Correction integrity

The original `InventoryMovement` row is locked with `SELECT ... FOR UPDATE` before checking and creating requests. A partial unique index added in `0011_correction_final_quantity` permits only one PENDING request per original, while preserving multiple processed corrections. That migration also backfills and requires the final signed `correctedQuantity`; the previous effective quantity is `correctedQuantity - delta`.

The `CorrectionRequest.delta` column was added in migration `0005_correction_delta`. Existing approved rows can be backfilled from their compensating movement; the migration fails safely if any existing request has no recoverable delta instead of inventing historical data.

Correction review locks the original movement first, then the request and affected stock row in one PostgreSQL transaction. The compensating `ADJUSTMENT`, stock update, correction status/reviewer fields, and audit records commit or roll back together. Direct JEFE creation/application is also atomic. Corrected running history is a derived repeatable-read view, not rewritten movement records.
