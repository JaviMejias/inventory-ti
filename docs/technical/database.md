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
Notifications (where required)
```

> `Office` is future extensibility, not an MVP entity schema. Repair management is future scope.

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
- **Correction** stores an explicit signed, non-zero `delta`; it is applied only when the request is approved.

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

  - `Asset.product_id → Product.id`
  - `Assignment.asset_id → Asset.id`
  - `InventoryMovement.product_id → Product.id`
  - `InventoryMovement.asset_id → Asset.id` (nullable, asset-related movements)
  - `InventoryMovement.user_id → User.id`
  - `Correction.original_movement_id → InventoryMovement.id`
  - `Correction.compensating_movement_id → InventoryMovement.id` (nullable, set on approval)
- **ActivationCode.userId → User.id** (cascade on user removal; application policy still uses inactivation for historical users).
  - `AuditLog.user_id → User.id` (nullable for system events)

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
- Product tracking-mode and asset state-transition rules are application invariants centralized in the asset service.
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

Clustered default ordering by `createdAt`/timestamp for history lists is recommended. The exact index set is finalised during implementation (see TBDs).

## 6. Monetary/quantity values

- **Never use floating point** for monetary values; use integer-based representation (e.g., cents) or an exact decimal type.
- Quantities are integers for discrete units; consumables use exact quantities (int).

## 7. Notifications

Notifications required by the product (e.g., low-stock alerts, correction activity) are persisted where appropriate (see [structure.md](structure.md) modules and [workflows.md](../product/workflows.md)). Notification state is server-side.

## 8. Sensitive data

- Password hashes only (see [security.md](security.md) §3).
- No secrets/tokens in plaintext tables.

### Correction integrity

The original `InventoryMovement` row is locked with `SELECT ... FOR UPDATE` before checking and creating requests. A partial unique index added in `0011_correction_final_quantity` permits only one PENDING request per original, while preserving multiple processed corrections. That migration also backfills and requires the final signed `correctedQuantity`; the previous effective quantity is `correctedQuantity - delta`.

The `CorrectionRequest.delta` column was added in migration `0005_correction_delta`. Existing approved rows can be backfilled from their compensating movement; the migration fails safely if any existing request has no recoverable delta instead of inventing historical data.

Correction review locks the original movement first, then the request and affected stock row in one PostgreSQL transaction. The compensating `ADJUSTMENT`, stock update, correction status/reviewer fields, and audit records commit or roll back together. Direct JEFE creation/application is also atomic. Corrected running history is a derived repeatable-read view, not rewritten movement records.
