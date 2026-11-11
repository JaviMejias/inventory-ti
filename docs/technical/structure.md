# Repository & Module Structure

This document defines the intended repository layout and conceptual domain modules.

Related documents:

- [architecture.md](architecture.md) — system architecture.
- [backend.md](backend.md) — layering inside modules.
- [frontend.md](frontend.md) — feature-based frontend organization.
- [decisions.md](decisions.md) — ADRs.

## 1. Monorepo layout

```text
inventory-ti/
├── apps/
│   ├── web/                # React + Vite + TypeScript + Tailwind (PWA planned)
│   │   └── src/
│   │       ├── features/   # auth/account, home operational views, admin/users
│   │       ├── ui/         # Shared primitives, layouts, tables, overlays, feedback
│   │       ├── lib/        # API/error translation, date ranges, page aggregation
│   │       ├── i18n/       # Translation stubs (es/en)
│   │       ├── theme/      # Light/dark/system preference and initialization
│   │       └── config/     # Environment configuration
│   └── api/                # Fastify + TypeScript backend
│       └── src/
│           ├── auth/       # Sessions, activation, user administration, guards/limits
│           ├── catalog/    # Product catalog module
│           ├── routes/     # Inventory, assets, assignments, corrections, health
│           ├── config/     # Database and environment configuration
│           ├── scripts/    # Bootstrap and reviewed fixture-account quarantine
│           └── lib/        # Errors, passwords, integer bounds and product locks
├── packages/
│   └── shared/             # Transport-safe shared concepts only
├── prisma/                 # Prisma schema and migrations
├── docs/                   # This documentation
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.json
```

Rationale and package boundaries in ADR-1 (modular monolith) and ADR-4.

## 2. `packages/shared`

Contains **only** genuinely shared, transport-safe concepts:

- enums (movement types, asset statuses, correction states, roles);
- API contracts/types;
- validation schemas where genuinely shared (Zod);
- simple constants.

It must **not** contain:

- Prisma models or database access;
- repositories;
- backend services or business logic;
- server-only code;
- frontend implementation.

Avoid a "shared everything" package (see ADR-4 and §5 below).

## 3. Backend conceptual modules

Domain module boundaries:

```text
auth/
users/
roles/
products/
inventory/
assets/
assignments/
corrections/
notifications/
dashboard/
audit/
```

Notes:

- This list is **conceptual**, not a literal set of current directories/endpoints. Backend code is grouped under `auth/`, `catalog/` and `routes/`; roles are fixed, not a separate administration API. Notifications/realtime and backend dashboard aggregations are planned; audit writes occur inside domain transactions.

- `repairs/` is **not** an MVP implementation module (repair management is out of scope).
- `offices/` is **not** required as an MVP implementation module (Office is future extensibility).
- Module boundaries are **domain boundaries**. They do **not** imply excessive abstraction, per-module HTTP servers, or per-module databases. They are logical layers inside the single backend (see [backend.md](backend.md)).

### Module responsibilities (summary)

| Module | Responsibility |
| --- | --- |
| auth | Session authentication, login/logout, session validation, CSRF for state-changing requests. |
| users | User account management (JEFE-only). |
| roles | Fixed enum and authorization matrix; no separate role-administration endpoint. |
| products | Product catalog, low-stock threshold. |
| inventory | Inventory operations (INITIAL/ENTRY/EXIT/RETURN/ADJUSTMENT), movements, materialized stock. |
| assets | Asset lifecycle and statuses. |
| assignments | Asset ↔ Person assignments and assignment history. |
| corrections | Correction workflow (request/review/approve/reject + compensating movement). |
| notifications | Planned realtime publishing/notification persistence, not implemented. |
| dashboard | Planned backend aggregations; no dedicated endpoint. |
| audit | AuditLog of user/system actions. |

## 4. Frontend feature-based organization

Frontend areas follow features, not layers. Current implementation:

```text
apps/web/src/features/
  auth/
    auth.tsx           # Sign-in, activation, session provider
    auth-context.ts    # Authentication context contract
    AccountPage.tsx    # Inline personal-data editing and password change
  admin/
    UsersPage.tsx      # JEFE-only user administration and activation/reset codes
  home/
    HomePage.tsx       # Dashboard consultation and drill-down modals
    dashboard-model.ts # Current snapshot and period movement calculations
    CatalogPage.tsx    # Products (no category screen)
    InventoryPage.tsx  # Quantity/asset tabs; history, status and assignments
    asset-status.ts    # Status labels and role-aware destination options
    CorrectionsPage.tsx # Requests, direct application and review details
    correction-model.ts # Final-quantity form semantics
```

`App.tsx` mounts these route owners. `AssetsPage.tsx` and `AssignmentPanel.tsx` remain in the repository but are not separate active routes; current asset and assignment workflows are integrated into InventoryPage. Do not describe retained source files as additional navigation destinations.

Dashboard is an implemented consultation view composed from existing REST reads, not a separately implemented domain module or dedicated aggregation endpoint. Its presence under `home/` does not mean it is still planned. Corrections and Users are also implemented despite not having directories named after every conceptual module.

Dedicated report screens, realtime subscriptions, uploads and PWA/offline behavior remain planned. Shared UI and infrastructure are separate (`ui/`, `lib/`, `config/`, `i18n/`, `theme/`). Translation files are stubs, not a complete bilingual UI. See [frontend.md](frontend.md) for route access, dataset loading and the pending SOPORTE/Dashboard policy decision.

## 5. Boundary rules

- **Shared package discipline:** code moves into `packages/shared` only when it is genuinely shared, transport-safe, and version-safe. Server-only or client-only code stays in `apps/api` or `apps/web` respectively.
- **No cross-feature backdoors:** features communicate through public APIs/contracts, not by importing each other's internals.
- **Simplicity first:** module boundaries exist to keep the domain legible, not to add plumbing.
