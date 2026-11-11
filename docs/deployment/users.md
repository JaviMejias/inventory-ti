# User Administration and Access Recovery

This guide covers the implemented **backend** lifecycle. There is no public registration, default account, automatic email/SMS delivery, recovery link or administrator endpoint that sets somebody else's password. Accounts are deactivated rather than deleted to preserve history.

## First administrator

Configure the root `.env`, install dependencies and apply migrations, then run from the repository root:

```bash
pnpm bootstrap:admin
```

The API need not be running. Bootstrap requires an **empty `User` table**, including inactive/pending accounts. Creation is serialized with a PostgreSQL advisory lock and records `USER_BOOTSTRAP_JEFE` with the active, password-configured administrator.

Provide six inputs in order:

1. Username.
2. Display name.
3. Phone.
4. Email.
5. Password (hidden).
6. Password confirmation (hidden).

Noninteractive mode reads the same six newline-separated fields from stdin. Use protected secret-management input, not literal passwords in arguments, shell history, checked-in files or CI logs. Interactive bootstrap is the recommended manual procedure.

Interactive prompts and validation messages are in Spanish. Each field is validated immediately against the same backend schema; an invalid field is requested again without losing accepted inputs. Password requirements are shown before entry, and a mismatch repeats **confirmation only**. Passwords remain hidden and are preserved exactly, including leading/trailing spaces. With piped stdin, the six-field order is unchanged: invalid or incomplete input exits nonzero without creating an account rather than consuming later lines as retries.

## Field validation

| Field | Required for creation/bootstrap | Rules |
| --- | --- | --- |
| `username` | Yes | 3–100 characters; letters, digits, `.`, `_`, `-`; trimmed. |
| `displayName` | Yes | 1–150 characters; trimmed. |
| `email` | Yes | Valid email, at most 255 characters; trimmed. Must not conflict with an existing login identifier. |
| `phone` | Yes | 7–40 characters; digits, spaces, `+`, `(`, `)`, `.`, `-`; trimmed. Contact only, not MFA/recovery. |
| `role` | Yes in API creation | `JEFE`, `COORDINADOR`, `SOPORTE`; bootstrap always creates `JEFE`. |
| Password | Bootstrap/activation only | 12–128 characters with at least one ASCII letter and one digit. Choose a unique strong password. |

Legacy rows can have null email/phone; profile updates allow clearing those fields. This does not make them optional in new-user creation.

## Authenticate an administrative client

1. `POST /auth/login` with `{ "identifier": "your-username-or-email", "password": "your-password" }`. Use a secure HTTP client; do not put real credentials in shell arguments or share request captures.
2. Retain the `inventory_ti_session` cookie.
3. `GET /auth/csrf` with the cookie; read `csrfToken`.
4. Protected mutations send the cookie, `x-csrf-token` and `Content-Type: application/json`.

Paths below are native API paths. With the [production proxy](production.md#https-reverse-proxy), prepend `/api`. Secure production cookies cannot be used over plain HTTP. `GET /auth/me` returns public user data, never hashes/codes.

## Create a user

Only a logged-in `JEFE` may call `POST /users`. Example body (fictional contact data):

```json
{
  "username": "soporte.demo",
  "displayName": "Demo Support",
  "email": "soporte.demo@example.com",
  "phone": "+56 9 1234 5678",
  "role": "SOPORTE"
}
```

Do **not** send `password`, `passwordHash` or `isActive`; extra fields are rejected. A `201` returns `{ user, activationCode }`. The account is administratively active but pending password setup (`isActive: true`, `isActivated: false`). Audit: `USER_CREATED`.

The raw code is available only in creation/reset responses, not lists, audits or later reads. Deliver it privately to the intended user over an approved channel. Treat it as a credential; never put it in tickets, shared documents or logs.

## Activate the password, then log in

The user calls public `POST /auth/activate` with their username/email, code and chosen password:

```json
{
  "identifier": "soporte.demo",
  "activationCode": "REPLACE_WITH_THE_ONE_TIME_CODE",
  "password": "ExampleOnly2026!",
  "passwordConfirmation": "ExampleOnly2026!"
}
```

This password is documentation only; do not reuse it. Confirmation is optional in the API but must match when supplied. Codes expire after **24 hours**, are single-use and stored only as SHA-256 hashes. Activation consumes the code and configures the password atomically. It returns the user but **does not create a session**: log in separately.

An inactive account cannot activate its password until a JEFE administratively activates it. Lost/used/expired codes cannot be read back; another JEFE must issue a fresh reset. Login before setup returns `403 ACCOUNT_PENDING`.

## Administrative activation is not password activation

| Operation | Result |
| --- | --- |
| `POST /users/:id/activate` | Sets `isActive=true`; does not set a password or issue a code. |
| `POST /users/:id/deactivate` | Sets `isActive=false` and revokes sessions atomically; history remains. |
| `POST /users/:id/reset-access` | Clears password, revokes sessions, invalidates previous codes; returns `{ user, activationCode }` with a fresh 24-hour code. Does not reactivate an inactive user. |
| `PATCH /users/:id` | Changes profile/role, never another user's password. |

All require JEFE and CSRF. Own access reset is forbidden (`403 SELF_ACCESS_RESET`); use password change instead. Reset audit: `ACCESS_RESET_REQUESTED`. Afterwards the user must activate and log in again; old sessions/password/code cannot be reused.

`GET /users` supports `isActive`, `search`, `limit` (1–100, default 25), `offset` (default 0); returns `users`, `total`, `limit`, `offset`, `hasMore`, ordered by username. `GET /users/:id` returns one public user. Use `isActivated` to distinguish setup from administrative status.

## Own profile and password

- `PATCH /auth/me`: `displayName`, `email` and/or `phone`, not role/username. Requires session and CSRF. Audit: `PROFILE_UPDATED`.
- `POST /auth/password`: `{ currentPassword, newPassword }`; requires session and CSRF, verifies current password, preserves this session and revokes the others. Wrong current password: `401 INVALID_CURRENT_PASSWORD`.
- `POST /auth/logout`: session and CSRF; deletes this session and clears the cookie.

## Preserve administrative access

Deactivation, demotion or access reset that would leave **no usable JEFE** returns `409 LAST_ADMIN_REQUIRED`. Usable means `role=JEFE`, `isActive=true`, with a configured password. A pending/inactive second JEFE does **not** count. User administration is serialized and the actor's authority is rechecked inside the transaction.

For handover: create/promote the replacement, deliver a code if needed, have them activate and successfully log in, and verify administrative access **before** removing the old JEFE's access. A merely created account is not recovery coverage.

If no existing JEFE can log in, the public API cannot appoint a new administrator and bootstrap refuses a populated database. First check the database target, account status and available second JEFE without exposing secrets. Recovery requires an authorized operator, verified backup and a separately reviewed recovery procedure; **no automated bypass is implemented**. Never erase users or reset the database to rerun bootstrap.

## Errors and operational checks

### Historical fixture-account quarantine

For old test accounts accidentally left by earlier test runs, preview the narrowly verified candidates first:

```bash
pnpm --filter @inventory-ti/api quarantine:test-users
```

The preview is read-only. This is **not** a general account/product cleanup tool: it verifies known fixture identities, contact data, role and fixture password hash. It deliberately does not select accounts merely because their names look generic. Preserve legitimate records and confirm a usable nonfixture JEFE exists before considering application.

Only an operator who has reviewed the preview, backup and targets should run:

```bash
pnpm --filter @inventory-ti/api quarantine:test-users --apply
```

Application deactivates confirmed accounts, clears their password, revokes sessions/codes and writes `TEST_ACCOUNT_QUARANTINED`; it does not delete users or inventory/audit history. It refuses if no usable nonfixture JEFE would remain. New tests use disposable databases, so this is not part of routine test execution. No quarantine is performed by this documentation update.

### Common responses

- `400 VALIDATION_ERROR`: check required fields, especially email/phone.
- `400 INVALID_ACTIVATION_CODE`: code invalid/expired/used or for another identifier; request a reset.
- `409 CONFLICT`: duplicate username/email/login identifier.
- `403 ACCOUNT_PENDING`: configure password first.
- `409 LAST_ADMIN_REQUIRED`: activate another usable JEFE first.
- `429 RATE_LIMITED`: login and activation each reserve failed plus in-flight attempts per IP, up to 10 per 15 minutes. Success resets that endpoint's failure counter. Limits are in-memory per instance, not distributed; configure trusted proxies correctly.

In staging, verify first JEFE login, protected reads, CSRF-protected administration and replacement-admin activation before opening a new installation. Never run fixture tests against production data. See [backend API reference](../technical/backend.md) and [troubleshooting](troubleshooting.md).
