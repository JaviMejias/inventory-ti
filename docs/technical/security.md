# Security

This document defines authentication, authorization, CSRF, secret handling, rate limiting, and upload validation.

Related documents:

- [backend.md](backend.md) — authorization in the request pipeline.
- [frontend.md](frontend.md) — UX-only role restrictions.
- [pwa.md](pwa.md) — session survival across PWA updates.
- [decisions.md](decisions.md) — ADR-5 (backend-authoritative authorization).

## 1. Authentication model: sessions

- **Session-based authentication.** No OAuth/OIDC/SSO.
- Login identifier: **username or email**, implemented. Usernames use a restricted character set; username and email have separate unique constraints.
- Passwords are validated against stored hashes.

### Session cookie

- **HTTP-only** session cookie.
- **Secure** in production (HTTPS).
- Appropriate **SameSite** configuration.
- **Session expiration** uses an absolute lifetime configured by `SESSION_TTL_HOURS`; `lastUsedAt` is telemetry and does not extend the session.
- **Logout** invalidates the session server-side.

### Phase 3 implementation

- Sessions are persisted in PostgreSQL in the `Session` table and contain only a hash of the random session token, the user reference, timestamps, and expiration.
- The browser receives the raw token only in the host-only `inventory_ti_session` cookie. It is `HttpOnly`, has configurable SameSite (default `Lax`), uses `Secure` when `COOKIE_SECURE=true`, and defaults to eight-hour expiration. `SameSite=None` requires Secure. `WEB_ORIGIN` controls CORS, not cookie domain.
- `SESSION_SECRET` must be configured with a sufficiently long random value in production; development and test environments may use the local-development fallback.
- The API re-checks the session and the user's active status on every protected request. Inactive users cannot log in; deactivation deletes all of their sessions atomically with the status change.
- Passwords use Node.js `scrypt` with a random salt. The API accepts passwords with at least 12 characters, including a letter and a number, and never returns `passwordHash`.
- A newly created or administratively reset account has a null `passwordHash` and is pending activation. The API generates a 128-bit random activation code, stores only its SHA-256 hash, expires it after 24 hours, invalidates previous codes, and marks it used transactionally on successful setup.
- The raw activation code is returned only by user creation or administrator reset, is never logged or included in user listings, `/auth/me`, or `AuditLog`, and activation never creates a session.
- Self-service password changes require the current password and CSRF; the current session is preserved and all other sessions are invalidated. Automatic email/SMS recovery, OAuth/OIDC/SSO, and 2FA remain out of scope.
- `User.phone` is stored as a nullable labor-contact field for compatibility with existing rows; the MVP does not send SMS, use it for recovery, or implement phone MFA.

### Active administrator floor

The API rejects deactivation, demotion or access reset that would remove the last **usable** JEFE (`409 LAST_ADMIN_REQUIRED`): active, role JEFE and password configured. Pending/inactive JEFEs do not count. User administration and fixture-account quarantine share a transaction advisory lock; the administrative actor is rechecked inside the transaction. Own access reset is separately forbidden (`403 SELF_ACCESS_RESET`). These are application invariants, not protection against direct operator SQL. See [user administration](../deployment/users.md).

Login, activation and password changes serialize against account mutations with user row locks. Login rechecks that the verified hash and account state are unchanged under the lock; password change verifies the current password against locked state. This prevents sessions/password changes based on stale credentials after reset/deactivation.

## 2. Authorization

- **Backend-authoritative** (ADR-5): every protected operation checks authorization server-side.
- Roles: `JEFE`, `COORDINADOR`, `SOPORTE` per [roles.md](../product/roles.md).
- Unauthorized operations return **HTTP 403**.
- Frontend role restrictions are UX only.

Inventory permissions are enforced server-side: `JEFE` can initialize stock, operate, and adjust; `COORDINADOR` can perform operational movements and authorized adjustments; `SOPORTE` can perform entry, exit, and return operations but cannot adjust stock. All inventory mutations require the existing CSRF header.

Phase 6A asset permissions are also enforced server-side. `JEFE` and `COORDINADOR` may create and edit assets; all roles may move operational assets; `SOPORTE` has the restricted operational status set documented in `roles.md`; and only `JEFE` may decommission. Every asset mutation requires the session-bound CSRF header. Frontend role gating remains UX-only.

Phase 6B assignment reads require authentication. Assignment and return mutations are restricted server-side to `JEFE`, `COORDINADOR`, and `SOPORTE`, and require the session-bound CSRF header. `/assignment-users` returns only active users and a safe public projection; it never returns `passwordHash`. The assignment workflow locks the Asset row and validates the target user as active inside the transaction.

Corrections are backend-authorized and require CSRF for every mutation. All roles may create a correction for a quantitative movement. New `JEFE` corrections apply immediately with audited self-review. Only `JEFE` may review pending requests; explicit approval/rejection of one's own pending request remains forbidden. `COORDINADOR` and `SOPORTE` may see only requests created by that user and cannot review them. Application uses a PostgreSQL transaction and current locked stock, so a correction cannot create negative current stock or partial audit/history state. See [corrections.md](corrections.md).

## 3. Passwords & secrets

- Passwords: **scrypt-hashed** with a random salt; never returned through public user projections.
- **Secrets come from environment/configuration** — never committed to the repository, never logged.
- Secrets include: database credentials, session secret, CSRF secret (if separate), storage credentials (future).

## 4. CSRF protection (requirement)

- Required for cookie-authenticated state-changing requests.
- The implemented mechanism is a server-validated, session-bound HMAC-SHA256 token derived using `SESSION_SECRET` (details below).
- State-changing requests (POST/PUT/PATCH/DELETE, and equivalent WebSocket-introduced mutations if any) carry the CSRF token.
- CSRF tokens are never logged.

### Phase 3 implementation

- The API uses a session-bound, HMAC-derived CSRF token without placing the CSRF token in browser storage or in an authentication cookie.
- An authenticated client obtains `GET /auth/csrf`; the API deterministically derives the token from the session token and `SESSION_SECRET`, and validates it server-side in the `X-CSRF-Token` header. The CSRF value is not persisted as a separate database row.
- Logout and user mutations require the CSRF header. Login is the unauthenticated session-establishment exception.

## 5. Rate limiting

- Sensitive endpoints (e.g., login) should have **rate limiting**.

Login and activation have separate in-memory limits per app instance: 10 failed plus in-flight attempts per source IP in 15 minutes. Reservations prevent parallel requests from bypassing the limit; successful attempts reset that endpoint's failure counter. The counters are not shared across processes and reset with process restart. A distributed store is not implemented.

`TRUST_PROXY` defaults to `loopback`; use `false` without a proxy or explicit trusted IPs/CIDRs. Blanket trust and `/0` are rejected. Proxy topology must preserve an authenticated forwarding chain rather than trust arbitrary client headers. See [configuration](../deployment/configuration.md).

## 6. File uploads (planned)

No upload routes or file-storage adapter are implemented. These requirements apply if storage is added:

- **Validate uploads**: MIME type, file size, and dimensions where applicable.
- File bytes go through the storage abstraction (see [storage.md](storage.md)).
- Never execute/disable upload as a channel for code; store via abstraction.

## 7. Error handling & logging

- Structured errors must not leak internals (no stack traces, no SQL, no secrets).
- Structured logs include request/user/domain context, never credentials or tokens.
- See [backend.md](backend.md) §6.

## 8. PWA/session interplay

- Application updates must preserve the session (see [pwa.md](pwa.md) §6).
- Cache policies must **not** cache private inventory API data (see [pwa.md](pwa.md) §3).
