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
│   ├── web/                # React + Vite + TypeScript + Tailwind PWA
│   │   └── src/
│   │       ├── features/   # Feature-based: auth, home (catalog/inventory/assets)
│   │       ├── ui/         # Shared UI primitives (PageShell)
│   │       ├── i18n/       # Translation stubs (es/en)
│   │       ├── theme/      # Dark mode initialization
│   │       └── config/     # Environment configuration
│   └── api/                # Fastify + TypeScript backend
│       └── src/
│           ├── auth/       # Authentication module (routes, schemas, service, types)
│           ├── catalog/    # Product catalog module
│           ├── routes/     # Inventory and asset routes + services
│           ├── config/     # Database and environment configuration
│           └── lib/        # Shared utilities (errors, password)
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

- `repairs/` is **not** an MVP implementation module (repair management is out of scope).
- `offices/` is **not** required as an MVP implementation module (Office is future extensibility).
- Module boundaries are **domain boundaries**. They do **not** imply excessive abstraction, per-module HTTP servers, or per-module databases. They are logical layers inside the single backend (see [backend.md](backend.md)).

### Module responsibilities (summary)

| Module | Responsibility |
| --- | --- |
| auth | Session authentication, login/logout, session validation, CSRF for state-changing requests. |
| users | User account management (JEFE-only). |
| roles | Role administration and the role matrix. |
| products | Product catalog, low-stock threshold. |
| inventory | Inventory operations (INITIAL/ENTRY/EXIT/RETURN/ADJUSTMENT), movements, materialized stock. |
| assets | Asset lifecycle and statuses. |
| assignments | Asset ↔ Person assignments and assignment history. |
| corrections | Correction workflow (request/review/approve/reject + compensating movement). |
| notifications | Realtime event publishing and in-app notifications (low-stock, corrections, etc.). |
| dashboard | Dashboard aggregations. |
| audit | AuditLog of user/system actions. |

## 4. Frontend feature-based organization

Frontend areas follow features, not layers. Current implementation:

```text
apps/web/src/features/
  auth/               # Authentication (login, session, context)
  home/               # Main application pages
    HomePage.tsx      # Session shell, role-aware sections
    CatalogPage.tsx   # Product catalog management
    InventoryPage.tsx # Consolidated stock, assets, movements
    AssetsPage.tsx    # Asset lifecycle management and assignment entry point
    AssignmentPanel.tsx # Current assignment, return, and history UI
```

Planned but not yet implemented:

```text
apps/web/src/features/
  dashboard/          # Dashboard aggregations
  assignments/        # Reserved for a future dedicated assignment area; current UI lives with AssetsPage
  corrections/        # Correction workflow
  reports/            # Report generation
  users-admin/        # User administration
```

Shared UI primitives and app infrastructure are separate (`ui/`, `config/`, `i18n/`, `theme/`). See [frontend.md](frontend.md).

## 5. Boundary rules

- **Shared package discipline:** code moves into `packages/shared` only when it is genuinely shared, transport-safe, and version-safe. Server-only or client-only code stays in `apps/api` or `apps/web` respectively.
- **No cross-feature backdoors:** features communicate through public APIs/contracts, not by importing each other's internals.
- **Simplicity first:** module boundaries exist to keep the domain legible, not to add plumbing.
