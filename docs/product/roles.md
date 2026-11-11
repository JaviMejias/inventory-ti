# Roles

This document defines the three system roles, their permissions, and the authorization model.

Related documents:

- [requirements.md](requirements.md) — overall WHAT/WHY.
- [inventory.md](inventory.md) — inventory operations, movements, corrections.
- [assets.md](assets.md) — asset handling and statuses.
- [workflows.md](workflows.md) — end-to-end workflows.
- [reports.md](reports.md) — report access.
- [technical/security.md](../technical/security.md) — backend-authoritative authorization.

## 1. Roles overview

| Role | Purpose |
| --- | --- |
| `JEFE` | Full administrative authority over the system. |
| `COORDINADOR` | Operational management: runs operations and requests corrections. |
| `SOPORTE` | Operational support: executes day-to-day operational actions. |

## 2. Permission matrix

| Capability | JEFE | COORDINADOR | SOPORTE |
| --- | :-: | :-: | :-: |
| Manage users | ✅ | ❌ | ❌ |
| Manage roles | ✅ | ❌ | ❌ |
| Manage products | ✅ | ❌ | ❌ |
| View dashboard | ✅ | ✅ | ❌ |
| View inventory | ✅ | ✅ | Relevant inventory |
| Perform authorized inventory operations | ✅ | ✅ | Operational actions |
| Manage assets | ✅ | Business-rule-bound | Operational asset handling |
| Manage assignments | ✅ | ✅ | ✅ |
| Request corrections | ✅ | ✅ | ✅ |
| Approve corrections | ✅ | ❌ | ❌ |
| Access audit information | ✅ | ❌ | ❌ |
| Access reports | ✅ | ✅ | ❌ |

Legend: ✅ = full access · ❌ = not allowed · Text cells (e.g., "Relevant inventory", "Operational actions", "Where authorized") = constrained access described in the detailed notes below.

### Detailed notes for `COORDINADOR`

- Can perform normal operational administration.
- Can view the dashboard, inventory, manage/operate assets per business rules, manage assignments, request corrections, and access reports; cannot review corrections.
- Cannot perform unrestricted, system-wide user/role administration unless explicitly granted later by future granular permissions.
- In the MVP, catalog management (products) remains a `JEFE`-level capability.

### Detailed notes for `SOPORTE`

- Can view relevant inventory and perform normal operational inventory actions.
- Can receive, issue, and return equipment or consumables **according to business rules**.
- Can register operational actions.
- Can manage operational asset handling and assignments.
- **Cannot** directly edit stock quantities.
- **Cannot** bypass inventory movement rules.
- **Cannot** approve corrections (including their own).
- Can view only correction requests created by that user.
- Has **no dashboard or report access** in the MVP (see [reports.md](reports.md)).

## 3. JEFE — full administrative authority

`JEFE` can, subject to the safeguards below:

- Manage users and roles.
- Manage products.
- View the dashboard and inventory.
- Perform authorized inventory operations.
- Manage assets and assignments.
- Apply corrections directly with audit, and approve or reject pending requests from other users (see [workflows.md](workflows.md)).
- Access audit information and reports.

## 4. Cross-cutting rules

1. **Backend authorization is authoritative.** All permission checks, including role checks, are enforced server-side. Frontend role restrictions are UX only.
2. **Explicit self-review of pending corrections is forbidden.** Newly created JEFE corrections are applied directly with audited self-review. See [workflows.md](workflows.md) and [inventory.md](inventory.md).
3. **`SOPORTE` cannot approve corrections** under any circumstance.
4. **Inventory operations** are always recorded as `InventoryMovement` records; nobody, including `JEFE`, performs arbitrary direct stock edits. See [inventory.md](inventory.md).
5. Permissions above describe the MVP. A future *granular permissions* mechanism may expand or refine them. `COORDINADOR` user/role administration remains restricted until such a mechanism grants it explicitly.
6. **At least one usable JEFE must remain.** User deactivation, role changes, and administrative access resets cannot remove the last active JEFE with a configured password. Inactive and pending-activation accounts do not satisfy this requirement. These mutations and test-account quarantine share a PostgreSQL transaction advisory lock, so concurrent requests from different API processes cannot bypass the safeguard. User-management permissions are rechecked inside the serialized transaction.

## 5. Future: granular permissions

- The MVP ships with the three fixed roles and the fixed matrix above.
- Future **granular permissions** are anticipated: specific capabilities could be granted on top of or instead of the fixed roles (e.g., granting a `COORDINADOR` limited user-management).
- This is future work, not an MVP feature. Until implemented, the fixed role matrix applies.

## 6. Asset and assignment permissions

| Asset operation | JEFE | COORDINADOR | SOPORTE |
| --- | :-: | :-: | :-: |
| View assets and details | ✅ | ✅ | ✅ |
| Create assets | ✅ | ✅ | ❌ |
| Edit asset metadata | ✅ | ✅ | ❌ |
| Move an operational asset | ✅ | ✅ | ✅ |
| Set normal operational status | ✅ | ✅ | Limited |
| Decommission an asset | ✅ | ❌ | ❌ |

`SOPORTE` may set `AVAILABLE`, `RESERVED`, `UNDER_REVIEW`, and `IN_REPAIR`. `SOPORTE` may not set `LOST`, `IN_WARRANTY`, `DECOMMISSIONED`, or `ASSIGNED` through the general status endpoint. All three roles may view, assign, and return assets through the dedicated assignment workflow; the backend remains authoritative.

| Assignment operation | JEFE | COORDINADOR | SOPORTE |
| --- | :-: | :-: | :-: |
| View current assignment and history | ✅ | ✅ | ✅ |
| Assign an available asset | ✅ | ✅ | ✅ |
| Return an assigned asset | ✅ | ✅ | ✅ |
