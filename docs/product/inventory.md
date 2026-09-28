# Inventory

This document defines the inventory model: Products, the distinction between quantity-based and asset-based inventory, physical vs. available inventory, InventoryMovements, consolidated materialized stock, and low stock.

Related documents:

- [assets.md](assets.md) — assets, asset statuses, and assignments.
- [workflows.md](workflows.md) — end-to-end workflows for operations and corrections.
- [technical/database.md](../technical/database.md) — persistence model.
- [technical/decisions.md](../technical/decisions.md) — ADR-3 (immutable movements + materialized stock), ADR-4 (products vs. assets).

## 1. Core concepts

### 1.1 Product

A **Product** is a catalog item/type (e.g., Notebook, Mouse, Keyboard, Monitor). A product is tracked in **one of two ways**:

- **Quantity-based (consumable):** tracked by a current quantity. Example: *Keyboard — current stock 25*.
- **Asset-based:** tracked through its individual **Assets**. Example: *Dell Latitude — serial ABC123*.

A single product uses one tracking mode consistently. See [assets.md](assets.md) for the asset side and ADR-4.

### 1.2 Materialized Stock

**Materialized Stock** is the current-state representation of inventory:

- for consumable products: a current quantity;
- for asset-based products: the set of assets and their statuses (from which physical/available counts derive).

It changes only through validated, authorized operations applied in a transaction. See section 4 and [workflows.md](workflows.md).

## 2. Inventory vs. availability

This distinction is **mandatory**.

- **Physical inventory** is the total of all individual units tracked by the system.
- **Availability** is what can be assigned/used right now.

### 2.1 Example — asset-based product

10 notebooks physically exist:

```text
AVAILABLE    7
ASSIGNED     1
IN_REPAIR    1
LOST         1
----------------
PHYSICAL    10
AVAILABLE    7
```

- Physical inventory remains **10**.
- Availability is **7**.
- Assigning an asset does **not** make the physical asset disappear from inventory; it changes the asset's status from `AVAILABLE` to `ASSIGNED` (see [assets.md](assets.md) and [workflows.md](workflows.md)).

There is **no** simplistic `available_quantity` field replacing individual asset status and per-asset tracking.

### 2.2 Consumable products

For consumables, the current quantity **is** the operational availability measure.

```text
Keyboard — current stock: 25
```

## 4. Inventory movements

InventoryMovements are **immutable historical records** of inventory-changing operations.

### 4.1 Movement types

```text
INITIAL        Initial stock recorded when a product is first counted.
ENTRY          Stock received / added.
EXIT           Stock issued / removed.
RETURN         Stock returned (received back).
ADJUSTMENT     Correction of materialized stock for a reason (e.g., from an approved
               compensating correction).
```

### 4.2 Recorded information

A movement records, where applicable:

- product
- asset
- quantity
- movement type
- user
- timestamp
- reason
- related information (e.g., the corrected movement for a compensating ADJUSTMENT, reference document, etc.)

### 4.3 Rules

- Movement records are created at operation time and are **never edited after creation**.
- Normal inventory changes must **not** be performed through arbitrary direct stock edits.
- `quantity` is positive for `INITIAL`, `ENTRY`, `EXIT`, and `RETURN`; the movement type determines whether stock is added or removed. `ADJUSTMENT` stores a signed non-zero delta and requires a reason.
- Only one `INITIAL` is allowed per product. Later corrections use `ADJUSTMENT`.

## 5. Movement history vs. materialized stock

These are **two distinct things**:

- **InventoryMovements** = the immutable history of what happened.
- **Materialized Stock** = the current-state representation.

The system does **not** recalculate current stock from the entire movement history on every read. Instead, each inventory operation runs as:

```text
inventory operation
        ↓
validate
        ↓
authorize
        ↓
database transaction
        ↓
create immutable movement
        +
update materialized current stock
        ↓
commit
        ↓
publish realtime event
```

- Movement creation and materialized stock update are **atomic** (see [workflows.md](workflows.md) and [technical/database.md](../technical/database.md)).
- This is **not** event sourcing and **not** CQRS (see ADR-3).

## 6. Assignments are not inventory movements

An **Assignment** represents `Asset ↔ Person`. An **InventoryMovement** represents a change to inventory.

Example: 10 physical notebooks exist, 1 is assigned to a person.

```text
Physical assets = 10
Available assets = 9
Assigned assets = 1
```

- The assignment does **not** decrement physical inventory from 10 to 9.
- The assigned asset takes the status `ASSIGNED`; physical count stays 10.
- The system answers: who currently has the asset, who had it previously, when it was assigned, when returned, and the full assignment history.
- Assignment history is **not** replaced by a single `asset.assignedTo` field.

Assignment and return are transactional Asset operations. They update only `Asset` and `Assignment` (plus `AuditLog`); they never create `InventoryMovement` or change `InventoryStock`.

See [assets.md](assets.md) for details.

## 7. Low stock

- Each product carries a **low-stock threshold** configured at **product level** in the MVP.
- A product is low stock when:

```text
current stock <= low stock threshold
```

- Low stock is surfaced on the dashboard and in reporting/notifications where appropriate.
- The threshold is configured at product level.

## 8. Corrections (summary)

Corrections exist to compensate a wrong movement:

1. User identifies an existing InventoryMovement.
2. User requests a correction with a reason and the signed final quantity, referencing the original movement; the backend calculates the difference from its current corrected effect.
3. JEFE requests apply immediately; requests from other roles wait for review (states: `PENDING`, `APPROVED`, `REJECTED`).
4. Only `JEFE` can approve or reject; `COORDINADOR` and `SOPORTE` cannot review. Explicit self-review of pending requests is forbidden; direct JEFE application records audited self-review.
5. An approved correction creates a **compensating InventoryMovement** (typically `ADJUSTMENT`).
6. The original movement remains immutable.

Corrections are limited to `QUANTITY` movements. Approval validates the current materialized stock while holding its row lock; if applying the delta would make stock negative, approval fails and the request remains `PENDING`. The request, compensating `ADJUSTMENT`, stock update, and audit records are one transaction.

Full detail, rules, and examples in [workflows.md](workflows.md).

Processed corrections allow a new request against the same original movement. The corrected history recalculates later running balances without changing later movement amounts or counting compensating adjustments twice. See the [backend corrections contract](../technical/corrections.md).
