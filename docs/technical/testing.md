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

### Database isolation

Run `pnpm --filter @inventory-ti/api test` (or root `pnpm test`). The launcher creates a uniquely named disposable PostgreSQL database, applies every migration, runs the suites with an isolation marker, and drops only that database in `finally`, including failed runs. Tests never run in the database named in `DATABASE_URL`; its credentials are used only to connect to PostgreSQL and create the temporary database. The connection role needs `CREATEDB`, or separate credentials can be supplied in `TEST_DATABASE_URL`. Direct integration-test execution without the generated database and matching marker fails before fixtures are written. Interrupted runs receive cleanup for SIGINT/SIGTERM; a process killed with SIGKILL may leave its uniquely named temporary database for manual inspection/removal.

Focused runs accept Node test options, for example `pnpm --filter @inventory-ti/api test --test-name-pattern="tracking mode"`.

Bootstrap input unit tests cover immediate per-field validation, retries preserving accepted inputs, hidden-password prompts, confirmation-only retries and fail-fast six-line stdin. CLI integration tests run in a private schema inside the disposable database: they verify hashed JEFE creation/audit, populated-table refusal, invalid/incomplete stdin without writes, exact password whitespace and real terminal retry/cancellation with no password echo. Terminal checks use the host's `script` utility and are explicitly skipped when it is unavailable; no extra dependency is installed. Run the focused group with `pnpm --filter @inventory-ti/api test --test-name-pattern=bootstrap`.

The last-administrator suite uses a private schema inside that disposable database. Other suites' JEFE fixtures must not mask the administrator floor. It covers pending/inactive replacements, failed-mutation rollback, concurrent removals and mutual access resets across app instances, and requests whose actor loses user-management permissions while waiting to commit.

### Dependency security regression

Fastify is at least 5.12.5. The workspace temporarily overrides only `@prisma/config@6.19.3>deepmerge-ts` to 8.0.0 for GHSA-ggr8-5vv4-36mx. Prisma 6 uses its `deepmerge` export to load configuration records; the application does not rely on the changed Map-merging, mutation, or renamed type APIs. Tests exercise actual Prisma config loading, nested configuration records and circular graphs. Remove/reassess this scoped override when Prisma itself is upgraded. CLI validation, generation, migration deployment and the database test runner must keep passing with it.

React Router is at least 7.18.2. The app keeps declarative `BrowserRouter` routing and the compatible `react-router-dom` exports; v6 future flags are no longer passed. Verify deep links, client-side navigation/history, account and unknown routes after upgrades, and run the production dependency audit. Domain conflicts such as `LAST_ADMIN_REQUIRED` must remain localized inside the open dialog and the shared toast without exposing raw server messages.

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
- If realtime is added, failed transactions must produce **no WebSocket success event**; no current publisher exists to test.

## 3. Suggested test layers

- **Domain/service tests**: the business invariants above, directly on services.
- **API/integration tests**: routes → validation → auth → service → repository against a real test database; includes 403 cases and transaction failure cases.
- **Realtime tests (future)**: once implemented, assert no event on failure and publish only after commit. Do not claim coverage for an absent publisher.
- **Frontend tests**: implemented input, theme, overlay, error, date and dataset behavior; role-aware rendering is never a security boundary. Complete i18n and PWA update-flow coverage belongs to future implementation, not current coverage. See the concrete suites below.

## 4. Non-goals

- No tests for out-of-MVP features.
- No excessive focus on implementation trivia that duplicates what business-rule tests already prove.
## Phase 6 assets and assignments

Asset integration tests cover product tracking-mode separation, active product validation, identifier uniqueness and normalization, status rules, terminal decommissioning, backend role enforcement, CSRF rejection without side effects, filtering/detail reads, audit creation, transaction rollback when audit creation fails, and concurrent decommission attempts on one locked asset row.

The existing Phase 5 inventory suite remains the regression boundary proving that asset functionality does not change quantitative stock or movement behavior. Assignment integration tests cover safe authenticated reads, active-user selection, all three operator roles, invalid/inactive users and assets, tracking-mode separation, one-assignment concurrency, valid return/history, duplicate and cross-asset returns, CSRF, audit rollback, status/decommission races, PostgreSQL history protection, deferred Asset/Assignment consistency, and the invariant that stock and movements remain unchanged.

## Frontend verification

Root `pnpm test` runs the API suite, **not** the frontend suite. Run web regressions separately; they do not require PostgreSQL or a running API:

```bash
pnpm --filter @inventory-ti/web test
pnpm --filter @inventory-ti/web typecheck
pnpm --filter @inventory-ti/web build
```

Focused scripts are `test:errors`, `test:corrections`, `test:toasts`, `test:asset-status` and `test:select`. For suites without a dedicated script, run from `apps/web`:

```bash
pnpm exec node --test tests/datepicker.test.mjs tests/dashboard-data.test.mjs
```

| Suite in `apps/web/tests/` | Covered behavior |
| --- | --- |
| `api-errors.test.mjs` | Safe Spanish errors, field mapping, unknown network outcomes, malformed responses, session expiry vs. invalid credentials, intentional aborts. |
| `corrections.test.mjs` | Final signed quantity, fixed directions vs. adjustment switch, zero cancellation, server-confirmed direct application vs. pending feedback. |
| `asset-status.test.mjs` | Role/state-dependent destinations, assignment/terminal restrictions and localized descriptions. |
| `dashboard-data.test.mjs` | Chile dates/DST, complete long-period movement buckets, full page aggregation, failed/empty page handling and deep-link record reconciliation. |
| `datepicker.test.mjs` | Empty/invalid dates, independent month/year navigation, inner-select interaction and Escape/focus behavior. |
| `select-position.test.mjs` | Popup remeasurement after dialog entry and page-popup lifecycle. |
| `toast-lifecycle.test.mjs` | Connected top-layer hosts, nested/removed dialogs, unsupported popover API, refreshed lifetime and exit-timer cleanup. |

Documentation verification on **2026-10-03**: all 51 frontend tests passed using the equivalent `node --test tests/*.test.mjs` command. This is a dated result, not a guarantee for later revisions. The local runtime was Node 26.7.0; the repository declares Node 24, so this run does not replace verification on the supported deployment runtime.

These are Node-based logic/source-harness regressions, not complete end-to-end browser tests. They do not establish full visual, accessibility or cross-browser coverage. Typecheck/build are relevant for frontend code changes; this documentation-only update does not claim a new production build or backend validation.

### Browser regression checklist

| Area | Manual/browser checks still required |
| --- | --- |
| All implemented routes | Light/dark/system, keyboard focus, reduced motion, loading/empty/error states, lazy-route retry and browser back/forward. |
| Responsive navigation and records | 375/768/1023 CSS-pixel card layouts; 1024/1280 desktop tables, including 1280×720; long names, touch actions and safe-area bottom clearance. |
| Selects and calendars | Anchoring inside short/scrolling/nested dialogs; month/year controls stay within calendar bounds; inner-select interaction leaves the calendar open. |
| Dashboard | Dates affect movement charts only; current KPIs stay snapshots; drill-downs search the target table and preserve it after closing detail. |
| Inventory | Both tabs reveal records, history restores focus/scroll, assignment/return/status errors remain visible above the modal. |
| Corrections | Final-quantity preview, role-specific submit/review, retained drafts after failure, drawer geometry and later-page loading without duplicates. |
| Users and Mi cuenta | JEFE-only route/create, activation/reset copy feedback, own-reset restriction, edit does not auto-submit, Cancel discards and Save confirms. |
| Authentication and errors | Theme header never overlaps, short-screen scrolling, pending activation, invalid credentials, expired session and unknown-result connection failure. |

Dashboard access for SOPORTE remains a [policy decision](frontend.md#unresolved-dashboard-access-policy), not an approved test expectation. Full-read/local-reveal datasets and the 50-record assignment modal are documented limitations, not proof of remote pagination at scale.
