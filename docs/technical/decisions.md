# Technical Decisions (ADRs)

This document records the significant architectural decisions as Architecture Decision Records.

Status is **Accepted** unless noted. Each ADR links to the documents that elaborate it.

Related documents: [architecture.md](architecture.md), [database.md](database.md), [realtime.md](realtime.md), [pwa.md](pwa.md), [storage.md](storage.md), and the product docs.

---

## ADR-1: Modular monolith

**Status:** Accepted

### Context

The system is an internal, single-team inventory application with consolidated stock and no physical-location tracking. It must be easy to build, run, and maintain.

### Decision

Build a **modular monolith**:

- one backend application with clear domain modules;
- one web application;
- one PostgreSQL database;
- monorepo with `apps/web`, `apps/api`, and `packages/shared` (see [structure.md](structure.md)).

### Consequences

- Simple deployment, debugging, and transactions across modules.
- Module boundaries are **domain boundaries**, not services or separate databases.
- Explicitly rejected for now: microservices, Kubernetes, and message brokers.

---

## ADR-2: PostgreSQL as authoritative persistence

**Status:** Accepted

### Context

Inventory correctness is a hard requirement; there must be exactly one source of truth.

### Decision

**PostgreSQL** is the authoritative persistence and the authority for application state. WebSocket and cache layers are never sources of truth. The API enforces all invariants against PostgreSQL.

### Consequences

- All business invariants (movement immutability, atomic stock updates, availability) are guaranteed by database transactions and constraints.
- Simplicity wins: no Redis/Kafka/event bus layer is required (see ADR-1, ADR-7).

---

## ADR-3: Immutable movements + materialized current stock

**Status:** Accepted

### Context

Inventory history must be immutable and traceable, while reads must be cheap and current.

### Decision

Two distinct representations:

- **InventoryMovements**: append-only immutable history of inventory-changing operations.
- **Materialized stock**: a maintained current-state representation.

Every inventory operation runs in one transaction: **create the immutable movement and update the materialized stock atomically**. Current stock is **never recomputed** from the full movement history on every read.

**Rejected alternatives:**

- Event sourcing — unnecessary complexity for this scale.
- CQRS — no read/write scaling need (full CQRS is not introduced).

### Consequences

- O(1) current-stock reads; auditable append-only history.
- Movement and materialized stock must always be written in the same transaction (see [database.md](database.md) §3).

---

## ADR-4: Products vs. Assets

**Status:** Accepted

### Context

Some inventory is counted in quantities; some is individually tracked equipment. Users need both without conflating them.

### Decision

- **Product** = catalog item/type, tracked either **by quantity** (consumables) or **by assets** (asset-based).
- **Asset** = individually trackable physical unit with identity, status, and assignment history.
- **Assignment** = the `Asset ↔ Person` relationship with its own history.

Assignments are **not** inventory movements. Assigning an asset does **not** decrement physical inventory; it changes the asset's status to `ASSIGNED` (see [inventory.md](../product/inventory.md) §6, [assets.md](../product/assets.md)).

No simplistic `available_quantity` field replaces per-asset status.

### Consequences

- Physical count vs. available count are computed from asset statuses, not from decremented quantities.
- Full assignment history is maintained; not just `asset.assignedTo`.

---

## ADR-5: Backend-authoritative authorization

**Status:** Accepted

### Context

Role restrictions shown in the UI can be bypassed by any HTTP client.

### Decision

**Authorization is enforced in the backend** as part of every protected operation. Frontend role restrictions are UX-only.

- Unauthorized operations return **HTTP 403**.
- Roles: `JEFE`, `COORDINADOR`, `SOPORTE` (see [roles.md](../product/roles.md)).

### Consequences

- The UI may hide/disable actions, but the backend remains the security boundary.
- Authorization tests run against the API (see [testing.md](testing.md) §2.5).

---

## ADR-6: Online-first PWA

**Status:** Accepted

### Context

Users need quick access and installable behavior, but inventory correctness depends on authoritative server state.

### Decision

Deliver as an **online-first PWA**:

- cache the application shell/static assets;
- detect connectivity and reconnect;
- resync authoritative data from the API on reconnect;
- installable, with an update flow that preserves the session.

**Offline inventory mutations are out of MVP scope.** Private inventory API data is not cached indiscriminately.

### Consequences

- The app requires network for mutations; no offline write queue.
- Version updates never require uninstall/clearing data and preserve the session (see [pwa.md](pwa.md)).

---

## ADR-7: WebSocket events only after successful commit

**Status:** Accepted

### Context

Realtime updates must never be published for operations that did not actually succeed.

### Decision

Publish WebSocket events **only after** the database transaction commits:

```text
transaction → commit → publish WebSocket event
```

On any failure: no partial state, no success event. PostgreSQL/API state is authoritative; WebSocket is a delivery channel. It is acceptable for a client to miss an event (disconnection, process crash) and resync via REST.

**Rejected:** queues/event buses/Redis to strengthen delivery.

### Consequences

- Event ordering is post-commit ordering.
- Clients reconnect → authenticate → resync via REST (see [realtime.md](realtime.md) §4).
- Tests verify no event on failed transactions (see [testing.md](testing.md) §2.6).

---

## ADR-8: Shared report data layer

**Status:** Accepted

### Context

Reports must not drift from the on-screen inventory/movement views.

### Decision

Reports are produced from the **same filtered dataset** as the relevant inventory/movement views. One filtering/query layer serves views and report generators (PDF, XLSX); there is no independent filtering logic per format.

### Consequences

- Filters (date range, movement type, user, product, asset, status) are defined once.
- Formatting/rendering differs per format, but the data query does not (see [reports.md](../product/reports.md)).

---

## ADR-9: Storage abstraction

**Status:** Accepted

### Context

File handling (metadata vs bytes) must not couple the domain to a concrete store.

### Decision

- The **database stores file metadata**.
- **File bytes go through a storage abstraction.**
- MVP backend: **internal/local filesystem storage**.
- Future: object storage may be introduced without changing domain logic.

Uploads are validated (MIME type, size, dimensions where applicable); processing (compression, resizing, optimized versions, thumbnails, lazy loading) is supported — with no requirement to store originals unless a concrete MVP need exists.

### Consequences

- Domain logic is storage-agnostic; swapping backends is confined to the storage adapter (see [storage.md](storage.md)).

---

## ADR-10: Inventory is consolidated without physical locations

**Status:** Accepted

### Context

The system replaces spreadsheets for one IT support team. Physical storage locations are not needed for the operational workflows.

### Decision

Products have one consolidated stock quantity. Assets are tracked by product, identifiers, status, and assignment history, without a physical-location field. Location selection, location configuration, and transfers are not implemented.

Explicit statements:

- **No physical-location dimension in MVP** — stock is stored once per product and movement history has no location fields.
- **Office hierarchy is not part of the product** — `Office` is not modeled or implemented.

### Consequences

- Low-stock threshold is product-level.
- A migration consolidates previous per-location quantities by summing stock rows for each product.
- Historical transfers are retained as an exit and an entry, preserving their aggregate stock effect while removing location references.

---

## ADR-11: No Company or CompanyUser tables in the MVP schema

**Status:** Accepted

The current MVP describes one internal Chilexpress installation and does not define multi-tenant company membership. `Role` is therefore represented as a fixed enum on `User`; `Company` and `CompanyUser` are not modeled as tables. A future multi-tenant requirement would require a separate decision before changing this boundary.

---

## ADR-12: Assignment recipient is recorded by name in the MVP

**Status:** Accepted

The operational flow needs to record equipment handoffs to people who may not have an Inventory TI account. `Assignment.personName` therefore stores the required recipient name and surname as an immutable historical value. Existing `personId` references remain nullable for backwards compatibility with assignments created before this decision; new assignments do not require a system user.

---

## ADR-13: PostgreSQL-backed sessions with session-bound CSRF tokens

**Status:** Accepted

Authentication uses server-side sessions stored in PostgreSQL. The browser holds only a random opaque session token in an `HttpOnly`, `SameSite=Lax` cookie; the database stores its hash and expiration. JWT, local storage tokens, Redis, and other session infrastructure are not introduced for the MVP.

State-changing authenticated requests use a session-bound, HMAC-derived CSRF token. The API deterministically derives a CSRF value from the session token and `SESSION_SECRET`, exposes it through `GET /auth/csrf`, and validates it in the `X-CSRF-Token` header. The CSRF value is not persisted as a separate database row. Login is the session-establishment exception; logout and user mutations require the header.

This keeps authentication state server-side, supports explicit logout invalidation, and avoids storing authentication tokens in browser storage. A distributed session or rate-limit store requires a separate decision if the deployment topology changes.

---

## ADR-14: PostgreSQL-locked materialized stock operations

**Status:** Accepted

Inventory keeps `InventoryStock` as the materialized current state and `InventoryMovement` as append-only history. Every quantity operation updates both inside one Prisma transaction. The service creates one stock row per product if needed and locks it with PostgreSQL `SELECT ... FOR UPDATE` before checking the resulting quantity.

Movement quantities are positive for `INITIAL`, `ENTRY`, `EXIT`, and `RETURN`; `ADJUSTMENT` stores a signed non-zero delta and requires a reason. No direct stock-update endpoint exists, and the existing database trigger continues to prevent movement updates/deletes.

The movement-type quantity rules and the required `ADJUSTMENT` reason are centralized in the request schemas and inventory service. PostgreSQL continues to protect structural invariants that must hold independently of the application, including non-negative materialized stock and append-only movement history. No additional SQL constraints are introduced for these domain-specific movement semantics in Phase 5.

---

## ADR-15: Asset lifecycle is separate from quantity stock

**Status:** Accepted

Phase 6A treats each `Asset` row as the current-state representation of one physical unit belonging to an `ASSET` product. Creating, changing status, or decommissioning an asset does not create or update `InventoryStock`; quantity inventory remains exclusive to `QUANTITY` products.

Asset mutations validate domain rules in the asset service, lock mutable asset rows with PostgreSQL `SELECT ... FOR UPDATE`, and create `AuditLog` records in the same transaction. `DECOMMISSIONED` is terminal and is available only through the dedicated JEFE operation. `ASSIGNED` cannot be set through the general Phase 6A status route and remains reserved for the Phase 6B assignment transaction.

Phase 6B implements assignment and return as a separate transactional workflow. Assignment history is append-only, `createdById` is required, `endedById` is required when closed, and restrictive historical foreign keys preserve user references while user accounts are inactivated rather than deleted. PostgreSQL deferred consistency triggers protect the bidirectional Asset/Assignment invariant at commit; no InventoryStock or InventoryMovement is changed.

---

## ADR-17: Assignment history and Asset consistency are protected in PostgreSQL

**Status: Accepted**

Assignment mutations are validated in the service and guarded by an Asset row lock. The database additionally protects structural history invariants: at most one active assignment per Asset, immutable/deletion-protected Assignment history, complete close metadata, and the invariant that an assigned Asset has exactly one active Assignment. Deferred constraint triggers allow the assign and return transactions to update both tables in either order while rejecting inconsistent commits and preserving normal rollback behavior.

---

## ADR-16: English is the canonical documentation language; Spanish via a user guide

**Status:** Accepted

### Context

The project serves both technical contributors and operational end users. Technical documentation (product and technical) and the operational user base (Spanish-speaking IT support staff at Chilexpress) have different needs and different audiences.

### Decision

- **English is the canonical language** for both `docs/product/*` and `docs/technical/*`. These are the authoritative references for requirements, design, and implementation.
- **Spanish is provided through a dedicated user guide** under `docs/user-guide/es/`, written from an operational/user perspective. It is not an exhaustive technical translation.
- **Domain identifiers and terminology remain in English** in the Spanish guide (e.g., `Asset`, `JEFE`, `InventoryStock`). Translations must never introduce different domain terminology.
- No documentation generators, translation frameworks, CI translation pipelines, or automatic translation tooling are introduced. Plain Markdown is sufficient.

### Consequences

- There is exactly **one** authoritative English version of each product/technical document, avoiding uncontrolled duplication.
- The Spanish user guide explains *how to use the system* without exposing unnecessary implementation details.
- Spanish and English documentation may drift if not kept in sync manually, so the user guide is deliberately kept concise and focused on operations.

---

## ADR-17: Deployment strategy — Docker deferred, documented only

**Status:** Accepted

### Context

The repository needs a reproducible path from a clean machine to a running instance (documentation, deployment). Docker/Compose would standardize the database and service provisioning, but the tooling to validate such files (a Docker daemon) is not available in the development environment.

### Decision

- **Local development is Docker-free and fully documented.** Node >= 24 < 25, pnpm 11 (pinned `11.19.0`), and PostgreSQL are the only runtime prerequisites ([development.md](../deployment/development.md)).
- **Docker support is planned but not yet provided.** No `Dockerfile` or `docker compose` files exist. The intended approach is documented in [docker.md](../deployment/docker.md) but is **not** treated as implemented — no commands are documented as available that are not part of the current setup.
- Environment configuration follows the [Twelve-Factor](https://12factor.net/config) pattern: every write-up document (development, production, configuration) references the same environment variables and secrets policy ([configuration.md](../deployment/configuration.md)).
- Backups, scheduled automation, and CI/CD are documented as operational responsibilities / planned work, not implemented features ([backups.md](../deployment/backups.md), [production.md](../deployment/production.md)).

### Consequences

- A contributor can go from a clean machine to a running instance using the documented, currently-runnable commands only.
- No unvalidated container files exist in the repository; when Docker is implemented, it must be validated with a running daemon before being documented as available.
- Databases and secrets remain explicit environment inputs; nothing is assumed to be provided by `docker compose` defaults in documentation.

---

## ADR-18: Bootstrap administrator — explicit, interactive, no static credentials

**Status:** Accepted

### Context

Phase 1 (authentication) requires an initial user that can log in before any user-management endpoint exists. Common patterns — a default `admin/admin` account, a seeded user with a hardcoded hash, or automatic admin creation on startup every time — create security liabilities and are unusable behind a real startup.

### Decision

- The initial administrator is created by an explicit command requesting username, display name, phone, email, password and confirmation, in that order ([bootstrap and access guide](../deployment/users.md#first-administrator)); password inputs are hidden and stored only as scrypt hashes.
- The command **refuses to run when any users already exist** and uses a PostgreSQL advisory lock (`pg_advisory_xact_lock`) so concurrent execution cannot create a second bootstrap administrator.
- It writes an audit entry (`USER_BOOTSTRAP_JEFE`) and creates the account with the `JEFE` role.
- There is **no** default/backdoor user, no seeded credentials in source or seeds, and no automatic administrator creation on startup.

### Consequences

- The database is never left with a known-default credential; every real deployment has a unique initial administrator.
- Re-running the command safely fails, which prevents accidental resets on a populated database.
- Manual setup uses interactive prompts; headless provisioning supplies all six newline-separated fields through protected stdin, never literal passwords in arguments/history/logs. See the access guide for constraints and populated-database recovery limitations.

- Event sourcing — rejected (ADR-3).
- Full CQRS — rejected (ADR-3).
- Microservices/Kubernetes — rejected (ADR-1).
- Kafka/RabbitMQ/Redis/brokers — rejected (ADR-1, ADR-7).
- GraphQL — rejected; plain REST + JSON.
- OAuth/OIDC/SSO — rejected; session-based auth (see [security.md](security.md)).
- Offline mutations — rejected for MVP (ADR-6).
- Repairs module / office module — future scope only (ADR-10).

## ADR-19: Corrections derive signed compensating deltas from final quantities

**Status:** Accepted

Corrections apply only to quantitative inventory movements. A request stores the signed final `correctedQuantity` and a non-zero `delta` calculated by the backend against the movement's currently effective quantity, including prior approved corrections. Legacy delta input remains supported. Application creates one immutable `ADJUSTMENT` movement and applies that delta to the current locked `InventoryStock` row. Newly created JEFE corrections apply immediately with audited self-review; other roles create pending requests for JEFE review.

The original movement remains immutable. The correction request, compensating movement, stock update, reviewer data, and audit records are committed in one PostgreSQL transaction. Creation and review lock the original movement before the request and stock row; a partial unique index permits only one pending request per movement. Processed requests do not prevent subsequent corrections. A separate repeatable-read history endpoint applies approved differences at the original movement and recalculates subsequent balances, returning compensating records separately to avoid double counting. See [corrections.md](corrections.md).

No new workflow engine, queue, Redis component, or event-sourcing layer is introduced.
