# Backend

This document defines the backend architecture, layering, and conventions.

Related documents:

- [architecture.md](architecture.md) — request pipeline and context.
- [database.md](database.md) — persistence model.
- [security.md](security.md) — authentication, authorization, CSRF, rate limiting.
- [realtime.md](realtime.md) — WebSocket publishing.
- [decisions.md](decisions.md) — ADR-1, ADR-3, ADR-5.

## 1. Stack

```text
Node.js
TypeScript
Fastify
Prisma
PostgreSQL
Zod
```

## 2. Layering

```text
Route
  ↓
Validation (Zod)
  ↓
Handler
  ↓
Application/Domain Service
  ↓
Prisma (directly)
  ↓
PostgreSQL
```

- **Route**: defines HTTP method, path, and wires validation + handler.
- **Validation**: Zod schemas for request/input validation.
- **Handler**: HTTP concerns only (extract validated input, call service, map result/errors to HTTP).
- **Application/Domain Service**: business rules — this is where inventory operations, corrections, assignment rules, and authorization checks live. Services use Prisma Client directly for data access.
- **Repository**: in the current implementation, services interact with Prisma Client directly rather than through a separate repository layer. The service layer handles both business rules and data access.

**Business logic must not be coupled directly to HTTP handlers.** Services are the home of the domain rules (see §3).

## 3. Domain services and business rules

Inventory operations (`initialize`, `receive`, `issue`, `return`, `adjust`) enforce their business rules in the application/domain layer:

- quantity non-negativity and availability invariants;
- movement immutability;
- the no-direct-stock-edits rule;
- correction review rules (direct audited JEFE application; no explicit self-review of pending requests; only JEFE may review);
- role-based authorization (ADR-5).

Movement creation and materialized stock updates are **atomic** (single transaction). See [database.md](database.md) and ADR-3.

Inventory uses PostgreSQL row-level locking (`SELECT ... FOR UPDATE`) on one materialized stock row per product. Concurrent operations for a product serialize on that row. `INITIAL`, `ENTRY`, `EXIT`, and `RETURN` use positive quantities; `ADJUSTMENT` uses a signed non-zero delta and requires a reason. `InventoryMovement` has no update or delete route.

Asset creation validates the product tracking mode and active product. Status and decommission operations lock the affected `Asset` row with PostgreSQL `SELECT ... FOR UPDATE`, then update the asset and create its `AuditLog` entry in one transaction. Asset operations never update `InventoryStock`, and the general status route cannot set `ASSIGNED` or `DECOMMISSIONED` directly.

### Operation pipeline (server-side)

```text
route
  ↓
validate (Zod)
  ↓
authorize (service/guards)
  ↓
service business rules
  ↓
transaction: create movement + update materialized stock
  ↓
commit
  ↓
publish WebSocket event (after commit)
```

## 4. Validation

- Use **Zod** for request/input validation.
- Schemas that are genuinely transport-safe and shared between frontend/backend belong in `packages/shared` (see [structure.md](structure.md) §2).
- Backend validation is authoritative; duplicates with the frontend are acceptable and expected.

## 5. Authorization

- **Backend-authoritative.** Guards run server-side on every protected operation.
- Role checks: `JEFE`, `COORDINADOR`, `SOPORTE` per the matrix in [roles.md](../product/roles.md).
- Unauthorized access returns HTTP 403. See [security.md](security.md) and ADR-5.

## 6. Errors & logging

- **Structured errors**: consistent error codes/shapes (validation, authorization, not-found, conflict, domain-rule) that the frontend can map to messages.
- **Structured logging**: machine-readable logs with request ids, user ids, and domain context.
- Do not log secrets (passwords, tokens, CSRF tokens).

## 7. Realtime publishing

- Domain services/notifications publish WebSocket events **after** commit only.
- The backend is the only publisher; see [realtime.md](realtime.md) and ADR-7.

## 8. Operational concerns

- **Health checks**: expose readiness/liveness endpoints.
- **Graceful shutdown**: close HTTP and WebSocket servers, stop accepting work, let in-flight requests finish, close DB connections.
- Configuration/secrets from environment (see [security.md](security.md) §4).

## 9. Shared package discipline

Backend code does **not** put repositories, services, or logic into `packages/shared`. Only transport-safe contracts/enums/schemas live there (see [structure.md](structure.md) §2, §5).

## 10. API endpoints (current implementation)

All endpoints return JSON. This list reflects the implemented routes (`apps/api/src/app.ts` and the route modules). Endpoints planned for later phases (reports and realtime) are **not** listed.

### Conventions

- **Authentication**: session cookie `inventory_ti_session` (HttpOnly, `SameSite=Lax`, secure when `COOKIE_SECURE=true`). Obtained via `POST /auth/login`.
- **CSRF**: state-changing requests send the session-bound token in the `x-csrf-token` header, obtained from `GET /auth/csrf`.
- **Role guards**: `JEFE`, `COORDINADOR`, `SOPORTE` — see [roles.md](../product/roles.md).
- **Errors**: `{ code, message, details? }`.
  - `400 VALIDATION_ERROR` — invalid request input.
  - `401 UNAUTHENTICATED` — no/missing/expired session; `401 INVALID_CREDENTIALS` — bad login.
  - `401 INVALID_CURRENT_PASSWORD` — current password verification failed.
  - `403 ACCOUNT_PENDING` — active account exists without a configured password; complete activation first.
  - `403 FORBIDDEN` — authenticated but wrong role; `403 CSRF_INVALID` — missing/wrong CSRF token.
  - `400 INVALID_ACTIVATION_CODE` — activation code is invalid, expired, used, or mismatched.
  - `404 NOT_FOUND` — resource not found.
  - `409 CONFLICT` — duplicate unique data (also `ASSET_IDENTIFIER_CONFLICT`).
  - `429 RATE_LIMITED` — too many login or activation attempts.
  - `500 INTERNAL_ERROR` — unhandled error.

### Health

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | Returns `{ service: "api", status: "ok" }`. |

### Auth

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/auth/login` | public | `{ identifier, password }`. Sets the session cookie. Rate limited to 10 tries per 15 minutes per IP. |
| POST | `/auth/activate` | public | `{ identifier, activationCode, password }`; consumes a one-time code and does not create a session. |
| GET | `/auth/me` | session | Returns the current user. |
| GET | `/auth/csrf` | session | Returns `{ csrfToken }`. |
| POST | `/auth/password` | session + CSRF | Changes the authenticated user password, preserves the current session, and invalidates the others. |
| POST | `/auth/logout` | session + CSRF | Deletes the session and clears the cookie. |

### Users

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/users` | JEFE | List, `?isActive=`. Ordered by username. |
| GET | `/users/:id` | JEFE | Single user. |
| POST | `/users` | JEFE + CSRF | Create user (name, email, username, phone, role); leaves it pending and returns a one-time activation code. Audit: `USER_CREATED`. |
| PATCH | `/users/:id` | JEFE + CSRF | Update profile and role fields only; administrators cannot set passwords. Audit: `USER_UPDATED`. |
| POST | `/users/:id/activate` / `POST /users/:id/deactivate` | JEFE + CSRF | Activate/deactivate administratively; deactivation revokes all sessions. Audit: `USER_ACTIVATED` / `USER_DEACTIVATED`. |
| POST | `/users/:id/reset-access` | JEFE + CSRF | Invalidates the password and sessions, then returns a fresh one-time activation code. Audit: `ACCESS_RESET_REQUESTED`. |

### Catalog (products)


| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/products` | session | List, `?active=`, `?search=` (name/SKU), `?limit=` (1–100, default 25), `?offset=` (default 0). Returns `total`, `limit`, `offset`, `hasMore`. |
| GET | `/products/:id` | session | Single product. |
| POST | `/products` | JEFE + CSRF | Product names are globally unique case-insensitively. Audit: `PRODUCT_CREATED`. |
| PATCH | `/products/:id` | JEFE + CSRF | Audit: `PRODUCT_UPDATED`. |
| POST | `/products/:id/activate` / `deactivate` | JEFE + CSRF | Audit: `PRODUCT_ACTIVATED` / `PRODUCT_DEACTIVATED`. |

### Inventory (quantitative stock & movements)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/inventory/stock` | session | Stock rows, optionally filtered by `?productId=`. |
| GET | `/inventory/stock/:productId` | session | Consolidated stock row for a product. |
| GET | `/inventory/movements` | session | Filterable: `?productId=`, `?performedById=`, `?movementType=`, `?from=`, `?to=`. Ordered by `effectiveAt` desc. |
| GET | `/inventory/movements/:id` | session | Single movement. |
| POST | `/inventory/movements/initial` | JEFE + CSRF | `INITIAL` — establishes initial stock. |
| POST | `/inventory/movements/entry` | JEFE/COORDINADOR/SOPORTE + CSRF | `ENTRY` — stock in. |
| POST | `/inventory/movements/exit` | JEFE/COORDINADOR/SOPORTE + CSRF | `EXIT` — stock out. |
| POST | `/inventory/movements/return` | JEFE/COORDINADOR/SOPORTE + CSRF | `RETURN` — returned stock in. |
| POST | `/inventory/movements/adjustment` | JEFE/COORDINADOR + CSRF | `ADJUSTMENT` — signed delta + required reason. |

Movements are created atomically with the materialized stock update (row-locked) in a single transaction; movement records are immutable (see [database.md](database.md)).

### Assets and assignments (Phases 6A–6B)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/assets` | session | List, `?productId=`, `?status=`, `?assetTag=`, `?serialNumber=`, `?isActive=`, `?search=` (tag/serial/product name). |
| GET | `/assets/:id` | session | Single asset. |
| POST | `/assets` | JEFE/COORDINADOR + CSRF | Product must be ASSET-tracked and active. Audit: `ASSET_CREATED`. Duplicate tag/serial → 409. |
| PATCH | `/assets/:id` | JEFE/COORDINADOR + CSRF | Field updates. Audit: `ASSET_UPDATED`. |
| POST | `/assets/:id/status` | JEFE/COORDINADOR/SOPORTE + CSRF | General status change; cannot set `ASSIGNED` or `DECOMMISSIONED` directly. Audit: `ASSET_STATUS_CHANGED`. |
| POST | `/assets/:id/decommission` | JEFE + CSRF | Terminal. Audit: `ASSET_DECOMMISSIONED`. |
| GET | `/assignment-users` | session | Active users safe for assignment selection; never exposes `passwordHash`. |
| POST | `/assets/:id/assignments` | JEFE/COORDINADOR/SOPORTE + CSRF | Creates one active assignment and sets the asset to `ASSIGNED`. |
| GET | `/assets/:id/assignments` | session | Current assignment and assignment history for the asset. |
| POST | `/assets/:id/assignments/:assignmentId/return` | JEFE/COORDINADOR/SOPORTE + CSRF | Closes the assignment, records `endedBy`, and sets the asset to `AVAILABLE`. |
| GET | `/assignments` | session | Paginated assignment history with asset/person/active filters. |
| GET | `/assignments/:id` | session | Assignment detail. |

Asset status/decommission operations lock the asset row (`SELECT ... FOR UPDATE`) and write their `AuditLog` in the same transaction. Asset operations never touch `InventoryStock`. See [backend.md §3](#3-domain-services-and-business-rules) and [database.md](database.md).

Assignment and return operations use the same Asset row lock, keep Asset/Assignment/AuditLog atomic, and rely on the partial unique active-assignment index plus deferred PostgreSQL consistency triggers. No direct Assignment update/delete route exists.

### Corrections (Phase 7)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/inventory/movements/:movementId/corrections` | JEFE/COORDINADOR/SOPORTE + CSRF | Receives signed final `correctedQuantity` and reason (legacy `delta` supported). JEFE applies immediately; other roles create `PENDING` requests. |
| GET | `/inventory/products/:productId/history` | session | Corrected movement effects and running balances, with compensating audit records returned separately. |
| GET | `/corrections` | session | JEFE sees all; COORDINADOR/SOPORTE see only requests created by that user. Optional `?status=` filter. |
| GET | `/corrections/:id` | session | Same visibility rules as the list endpoint. |
| POST | `/corrections/:id/approve` | JEFE + CSRF | Rejects self-approval; atomically creates an `ADJUSTMENT`, updates stock, marks the request approved, and writes audit entries. |
| POST | `/corrections/:id/reject` | JEFE + CSRF | Marks a pending request rejected without changing stock. |

Creation and review lock the original movement before the correction and stock row. A partial unique index allows only one pending request per movement; approved or rejected history does not prevent a new request. The original movement is never modified or deleted. See [corrections.md](corrections.md) for the final-quantity contract, running history and rollout requirements.
