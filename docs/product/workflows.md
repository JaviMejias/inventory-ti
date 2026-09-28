# Workflows

This document defines the end-to-end workflows of the system: inventory operations, corrections, and assignments, with their rules and atomicity requirements.

Related documents:

- [requirements.md](requirements.md), [roles.md](roles.md), [inventory.md](inventory.md), [assets.md](assets.md), [reports.md](reports.md).
- [technical/architecture.md](../technical/architecture.md), [technical/backend.md](../technical/backend.md), [technical/database.md](../technical/database.md).

## 1. General rules

1. Backend authorization is **authoritative**; frontend restrictions are UX only.
2. Every inventory operation runs through: **validate → authorize → transaction → commit → realtime event**.
3. Movement creation and materialized stock update are **atomic**.
4. Movements are **immutable** after creation.
5. Roles: `JEFE`, `COORDINADOR`, `SOPORTE` (see [roles.md](roles.md)).

## 2. Inventory operations

Movement types and their recorded fields are defined in [inventory.md](inventory.md) §4. Inventory operations use `INITIAL`, `ENTRY`, `EXIT`, `RETURN`, and `ADJUSTMENT`.

### 2.1 The atomic operation pipeline

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

Failure at any step before commit leaves **no partial state** and publishes **no success event**. See [technical/realtime.md](../technical/realtime.md).

### 2.2 Operations

**INITIAL** — initializes stock for a product. Only one initial movement is permitted per product.

- Authorized by: operational authorizations per role matrix (inventory operations).

**ENTRY (receive)** — stock is received/added.

**EXIT (issue)** — stock is issued/removed. Availability-based: for asset-based products the operation refers to specific assets; for consumables it decreases current quantity.

**RETURN** — stock is returned (received back).

**ADJUSTMENT** — a deliberate, reasoned signed delta of materialized stock. It requires a non-zero reasoned delta and cannot make stock negative.


### 2.3 Rules for normal operations

- No arbitrary direct stock edits; every change goes through the pipeline above.
- `SOPORTE` can receive/issue/return per business rules and register operational actions, but **cannot directly edit stock quantities** and **cannot bypass movement rules**.
- Stock quantities used by the pipeline must not go negative (validated per product quantity and availability invariants).
- Concurrent operations lock the affected materialized stock rows in PostgreSQL before checking and applying the result.

## 3. Corrections

### 3.1 Purpose

Fix a wrong InventoryMovement without rewriting history.

### 3.2 States

```text
PENDING
APPROVED
REJECTED
```

### 3.3 Workflow

1. User identifies an existing InventoryMovement.
2. User requests a Correction.
3. User provides a **reason** and the signed final **correctedQuantity**. The backend derives the delta from the currently effective movement quantity (including previous approved corrections).
4. The Correction **references the original movement**.
5. JEFE requests are applied immediately with audited self-review. Requests from other roles wait for an authorized JEFE reviewer.
6. Explicit approval/rejection of one's own pending request is forbidden, including legacy pending JEFE requests.
7. Only `JEFE` can approve or reject.
8. `COORDINADOR` and `SOPORTE` can request and view only their own corrections, but cannot review.
9. An **approved** correction creates one compensating `ADJUSTMENT` and applies the delta to current stock.
10. The original movement **remains immutable**.
11. A movement can have only one pending correction request; after rejection or approval it can be corrected again, retaining all history. Compensating adjustments cannot themselves be corrected.

Rejected corrections are recorded as rejected; no compensating movement is created.

### 3.4 Example

```text
Movement #100
Type: EXIT
Quantity: -5
```

Correction request:

```text
Correction #20
Status: APPROVED
Original movement: #100
Reason: Only 4 units were actually delivered
```

Compensating movement:

```text
Movement #101
Type: ADJUSTMENT
Quantity: +1
Corrects movement: #100
```

- Movement #100 is **never overwritten**.
- Compensation is fully traceable: Correction → Original movement → Compensating movement.
- The corrected running-history view applies the difference at the original movement and recalculates all later balances. Compensating records are returned separately to avoid double counting. Correcting -3 to -2 adds +1 to current stock and later balances, without changing later movement quantities.

## 4. Assignments

### 4.1 Assign a single asset

1. Select an active asset with status `AVAILABLE`.
2. Choose the person.
3. The assignment is recorded with the actor and server timestamp; the asset's status becomes `ASSIGNED`.
4. Physical inventory count is unchanged (see [inventory.md](inventory.md) §6).

### 4.2 Return an asset

1. Select an assigned asset.
2. Register the return.
3. The active assignment is closed with `endedAt` and `endedBy`; the asset is freed to `AVAILABLE`.

### 4.3 History

The system keeps the full assignment history and can answer who has it, who had it, and when. It is **not** a single `asset.assignedTo` field.

### 4.4 Authorization

- `JEFE`, `COORDINADOR`, and `SOPORTE`: view, assign, and return assets. All assignment mutations require authentication and CSRF.

See [roles.md](roles.md).

## 5. Assets and status changes (operational handling)

- Receiving an asset → status set to `AVAILABLE` (or as configured for intake).
- Depositing asset to repair/`IN_REPAIR` or warranty/`IN_WARRANTY` = an operational action that changes status; these statuses are **not available**.
- Reporting a loss → `LOST` (not available).
- Decommission → `DECOMMISSIONED` (no longer active inventory).
- General note: no full legal state machine; only the availability invariants in [assets.md](assets.md) §2 are enforced.

### 5.1 Phase 6A asset operations

- Asset creation and metadata changes are available to `JEFE` and `COORDINADOR`.
- `SOPORTE` may set `AVAILABLE`, `RESERVED`, `UNDER_REVIEW`, and `IN_REPAIR`, but may not set `LOST`, `IN_WARRANTY`, `DECOMMISSIONED`, or `ASSIGNED` directly.
- Only `JEFE` may decommission an asset.
- Status and decommission operations lock the asset row before validating and updating it.
- Every mutation and its `AuditLog` entry commit atomically.
- The general status operation cannot bypass an active assignment. Assignment and return are the only workflow operations that set `ASSIGNED` or close an active assignment.

## 6. Low-stock visibility

- Threshold is product-level.
- After any committed stock operation, the product's low-stock state (`current stock <= threshold`) is recomputed and surfaced on the dashboard / reporting / notifications where appropriate.

## 7. Realtime after commit

- Every committed operation publishes a WebSocket event; see [technical/realtime.md](../technical/realtime.md).
- The event is published **only after** the transaction commits.
- A client may miss events because of disconnection/process failure and **resyncs via REST** on reconnect.
