# Assets

This document defines Assets, asset statuses, and how assets relate to Products and Assignments.

Related documents:

- [requirements.md](requirements.md) — overall WHAT/WHY.
- [inventory.md](inventory.md) — physical vs. available inventory, movement history.
- [workflows.md](workflows.md) — end-to-end workflows for asset handling and assignments.
- [technical/decisions.md](../technical/decisions.md) — ADR-4 (products vs. assets).

## 1. Product vs. Asset

| | Product | Asset |
| --- | --- | --- |
| Meaning | A catalog item/type. | An individually trackable physical unit. |
| Example | Notebook, Mouse, Keyboard, Monitor | Dell Latitude, serial ABC123 |
| Tracking | Quantity (consumable) or via assets (asset-based) | Individual identity, status, assignment history |
| Modeled as | Catalog/product record | Physical unit with `status` |

Assets are **not** modeled as anonymous quantities. To be useful, an asset is:

- created/registered under a Product,
- individually identifiable (serial number / internal id / barcode as appropriate),
- assigned its current status,
- linked to an assignment history.

## 2. Asset statuses

The statuses are exactly:

```text
AVAILABLE
ASSIGNED
RESERVED
UNDER_REVIEW
IN_REPAIR
IN_WARRANTY
LOST
DECOMMISSIONED
```

### 2.1 Intended meanings

| Status | Meaning | Available? |
| --- | --- | --- |
| `AVAILABLE` | In a usable state, not assigned; can be assigned when business rules allow it. | Yes |
| `ASSIGNED` | Currently assigned to a person; not available. | No |
| `RESERVED` | Reserved for a future purpose (e.g., pending assignment); not for general use. | No |
| `UNDER_REVIEW` | Held for review (e.g., discrepancy investigation); not for general use. | No |
| `IN_REPAIR` | Being repaired; out of use. **Not available.** | No |
| `IN_WARRANTY` | Held for warranty processing; out of use. **Not available.** | No |
| `LOST` | Reported lost. **Not available.** | No |
| `DECOMMISSIONED` | No longer active inventory. No longer part of active inventory counts. | No |

### 2.2 Constraints (must hold)

- `IN_REPAIR`, `IN_WARRANTY`, `LOST`, `DECOMMISSIONED`, and `ASSIGNED` are **not available** for assignment.
- `AVAILABLE` can be assigned when business rules allow it.
- `DECOMMISSIONED` is not active inventory.

### 2.3 No complex state machine

The MVP does **not** implement a full asset state machine (no rigid legal transition graph). It represents these statuses correctly and enforces the availability invariants above. A full **repair-management subsystem is out of scope**; `IN_REPAIR` and `IN_WARRANTY` are statuses, not modules. There is **no `repairs` MVP module**.

## 3. Physical inventory vs. availability (summary)

Every asset exists once in the physical inventory. Its status determines availability.

```text
AVAILABLE    7
ASSIGNED     1
IN_REPAIR    1
LOST         1
----------------
PHYSICAL    10
AVAILABLE    7
```

See [inventory.md](inventory.md) §2 for the full treatment.

## 4. Assignments

### 4.1 The relationship

An **Assignment** is the relationship:

```text
Asset ↔ Person
```

- Assigning an asset sets its status to `ASSIGNED`; physical inventory is unchanged.
- Returning an asset ends the active assignment, records who performed the return, and frees the asset to `AVAILABLE`.
- Assignments are **not** InventoryMovements (see [inventory.md](inventory.md) §6).

The Phase 6B workflow permits one active assignment per asset. The assigned user must exist and be active, and only an `AVAILABLE` asset may be assigned. `RESERVED`, `UNDER_REVIEW`, `IN_REPAIR`, `IN_WARRANTY`, `LOST`, and `DECOMMISSIONED` assets cannot be assigned. Assignment, asset-status change, and audit entry commit atomically; failures leave no partial state.

### 4.2 Assignment history

The system records and can answer:

- who currently has the asset;
- who previously had it;
- when it was assigned;
- when it was returned;
- the full assignment history.

Assignment history is **not** replaced by only `asset.assignedTo`.

## 5. Data the system keeps per asset

Conceptually, per asset:

- product linkage (which Product catalog entry it belongs to);
- individual identifier(s) (serial number / internal id);
- current status;
- active assignment (if any) and full assignment history;
- related inventory movements (where the asset was received/deposed/returned, etc.).

Persistence details are in [technical/database.md](../technical/database.md).

## 6. Implemented boundary

Phase 6A implements asset registration, metadata editing, operational status changes, filtering, detail views, and terminal decommissioning. New assets start as `AVAILABLE`; identifiers containing only whitespace are stored as `null`. Only active `ASSET` products can receive assets.

`DECOMMISSIONED` is terminal. Decommissioning sets `status = DECOMMISSIONED`, `isActive = false`, and `decommissionedAt`; decommissioned assets cannot be edited or returned to an operational status. The `ASSIGNED` status cannot be set through the Phase 6A status endpoint because it belongs to the transactional assignment workflow in Phase 6B.

Assets do not create or update `InventoryStock`. Phase 6B provides assignment and return endpoints plus the assignment panel in the Assets screen. Assignments preserve history and are never deleted; `InventoryStock` and `InventoryMovement` remain unchanged by assign/return.
