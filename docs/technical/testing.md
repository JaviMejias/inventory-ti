# Testing

This document defines the testing strategy and required coverage. Tests prioritize **business rules** over implementation trivia.

Related documents:

- [workflows.md](../product/workflows.md) — operation and correction rules.
- [inventory.md](../product/inventory.md) — physical vs. available inventory.
- [assets.md](../product/assets.md) — status availability invariants.
- [security.md](security.md) — authorization.
- [realtime.md](realtime.md) — publish-after-commit.
- [decisions.md](decisions.md) — ADR-3 (atomicity without event sourcing).

## 1. Principles

- Test **business rules** first; implementation details are secondary.
- Test the invariants documented in the product docs.
- **Do not create tests for out-of-MVP features** (no physical locations, repairs module, offices module, or offline mutations).

## 2. Required coverage

### 2.1 Stock

- 10 notebooks with 1 in repair → **9 available**.
- **Physical asset count remains 10**.
- Consumable quantity updates follow the movement pipeline.

### 2.2 Assignments

- Assigning an asset **does not reduce the physical asset count**.
- Assigned asset becomes `ASSIGNED`.
- Returning an asset updates assignment/status correctly (e.g., back to `AVAILABLE`).
- **Assignment history is preserved** (who had it, when).

### 2.3 Asset statuses

- `IN_REPAIR` is unavailable.
- `IN_WARRANTY` is unavailable.
- `LOST` is unavailable.
- `DECOMMISSIONED` is not active inventory.
- `AVAILABLE` can be assigned when allowed.
- `ASSIGNED` is not available.

### 2.4 Corrections

- COORDINADOR/SOPORTE requests are `PENDING`; JEFE requests apply immediately with audit.
- Final signed quantities are persisted; the backend computes non-zero differences from the currently corrected effect. Legacy delta input remains supported.
- A movement can have only one pending correction request; rejected/approved history permits subsequent requests.
- `SOPORTE` cannot approve.
- `SOPORTE` sees only own correction requests.
- `JEFE` can approve.
- `COORDINADOR` cannot approve or reject.
- Explicit self-review of pending requests is forbidden; direct JEFE application is audited.
- Approved correction creates a **compensating movement**.
- Approved correction applies the delta against current locked stock.
- Original movement **remains unchanged** (immutable).
- Correction remains traceable (references original and compensating movements).
- Approval and rejection are idempotent state transitions; processed requests cannot be processed again.
- Approval rollback leaves no stock, movement, status, or audit partial state.
- Direct JEFE application rolls back request, movement, stock and audit together on failure.
- Correcting movement six from -3 to -2 changes final stock from 4 to 5 and increases subsequent balances by 1 without rewriting movement amounts or double-counting compensation.
- Filtered running history retains opening balances, signed adjustments and repeated corrections; a snapshot exposes historical negatives or materialized-stock divergence.
- Concurrent corrections to the same or different movements serialize without applying identical final quantities twice or overspending current stock.
- Migration backfill handles positive/legacy-negative EXIT quantities and signed adjustments, preserves recorded deltas, and fails for orphaned correction data.

### 2.5 Authorization

- Unauthorized operation returns **403**.
- Frontend restrictions do not replace backend authorization (test backend authorization independently).

### 2.6 Transactions

- Movement + stock update are **atomic**.
- Failed transaction leaves **no partial state**.
- Failed transaction produces **no WebSocket success event**.

## 3. Suggested test layers

- **Domain/service tests**: the business invariants above, directly on services.
- **API/integration tests**: routes → validation → auth → service → repository against a real test database; includes 403 cases and transaction failure cases.
- **Realtime tests**: assert no event is published when a transaction fails; events are published only after commit.
- **Frontend tests**: component/UX behavior (inputs, i18n, themes, PWA update flow) as needed; role-aware UI rendering (but never treated as a security boundary).

## 4. Non-goals

- No tests for out-of-MVP features.
- No excessive focus on implementation trivia that duplicates what business-rule tests already prove.
## Phase 6 assets and assignments

Asset integration tests cover product tracking-mode separation, active product validation, identifier uniqueness and normalization, status rules, terminal decommissioning, backend role enforcement, CSRF rejection without side effects, filtering/detail reads, audit creation, transaction rollback when audit creation fails, and concurrent decommission attempts on one locked asset row.

The existing Phase 5 inventory suite remains the regression boundary proving that asset functionality does not change quantitative stock or movement behavior. Assignment integration tests cover safe authenticated reads, active-user selection, all three operator roles, invalid/inactive users and assets, tracking-mode separation, one-assignment concurrency, valid return/history, duplicate and cross-asset returns, CSRF, audit rollback, status/decommission races, PostgreSQL history protection, deferred Asset/Assignment consistency, and the invariant that stock and movements remain unchanged.
