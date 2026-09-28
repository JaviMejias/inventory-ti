# Architecture

This document explains **HOW** the system is built: the overall architecture, system context, request pipeline, and the principles that govern design.

Related documents:

- [structure.md](structure.md) — repository/module layout.
- [backend.md](backend.md) — backend layering and conventions.
- [frontend.md](frontend.md) — frontend architecture and UX.
- [database.md](database.md) — persistence model.
- [realtime.md](realtime.md) — WebSocket model.
- [security.md](security.md) — authentication and authorization.
- [decisions.md](decisions.md) — ADRs (each principle has an ADR).
- Product docs: [requirements.md](../product/requirements.md), [inventory.md](../product/inventory.md).

## 1. Architectural style: modular monolith

The system is a **modular monolith**:

- one backend application (domain modules, not services);
- one web application;
- one PostgreSQL database.

Explicitly **not used**: microservices, Kubernetes, Kafka, RabbitMQ, Redis, GraphQL, full CQRS, event sourcing (see ADR-1 and ADR-2).

The MVP stays intentionally simple; physical locations, Office hierarchy, and repair management are not implemented.

## 2. System context

```text
┌───────────────────────┐      ┌──────────────────────────────┐
│     Web App (PWA)     │      │          Backend API         │
│  React · Vite · TS    │      │   Node.js · TypeScript       │
│  Tailwind             │─────▶│   Fastify · Zod · Prisma     │
│                       │      │                              │
│  REST    (HTTP JSON)  │      │  ↔ PostgreSQL (authoritative)│
│  Realtime (WebSocket) │◀────▶│  ↔ Storage abstraction       │
└───────────────────────┘      └──────────────────────────────┘
```

- **PostgreSQL/API state is authoritative.**
- **WebSocket** is a delivery channel for realtime updates, not a source of truth.
- **Storage** holds file bytes (see [storage.md](storage.md)).

## 3. Request pipeline

### 3.1 REST (state-changing operations)

```text
Client request
    ↓
validation (Zod)
    ↓
authorization (backend, authoritative)
    ↓
application/domain service (business rules)
    ↓
database transaction
    ↓
commit
    ↓
publish WebSocket event
```

- Events are published **only after** a successful commit.
- A failed transaction leaves no partial state and produces no success event.
- See [backend.md](backend.md) and [realtime.md](realtime.md).

### 3.2 Inventory operations specifically

```text
inventory operation
        ↓
validate
        ↓
authorize
        ↓
database transaction
        ↓
create immutable movement
        +
update materialized current stock
        ↓
commit
        ↓
publish realtime event
```

See [workflows.md](../product/workflows.md). Details of immutability/materialization in [database.md](database.md) and ADR-3.

### 3.3 Reads

Reads go through the same route → validation → authorization → service/repository chain and return JSON. Realtime keeps open views fresh; on reconnect, clients **resync through REST**.

## 4. Key principles (summary)

| # | Principle | Where |
| --- | --- | --- |
| 1 | Modular monolith | ADR-1 |
| 2 | PostgreSQL authoritative persistence | ADR-2 |
| 3 | Immutable movements + materialized current stock (no event sourcing, no CQRS) | ADR-3 |
| 4 | Products vs. Assets | ADR-4 |
| 5 | Backend-authoritative authorization | ADR-5 |
| 6 | Online-first PWA | ADR-6 |
| 7 | WebSocket events published only after commit | ADR-7 |
| 8 | Shared report data layer | ADR-8 |
| 9 | Storage abstraction | ADR-9 |
| 10 | Inventory without physical locations | ADR-10 |

Each ADR is documented in [decisions.md](decisions.md).

## 5. Frontend ↔ backend boundaries

- Frontend sends JSON over HTTP REST, plus WebSocket for realtime events.
- All business rules are enforced on the backend. The frontend implements UX and role-aware presentation only (ADR-5).
- API contracts/types shared where genuinely transport-safe via `packages/shared` (see [structure.md](structure.md)).

## 6. Environment/configuration

- Configuration and secrets come from the environment (see [security.md](security.md) §4).
- The system must support health checks and graceful shutdown (see [backend.md](backend.md) §8).

## 7. Deployment shape (future, not MVP work)

- The MVP is designed to deploy as a small set of artifacts (web assets + one Node API + one PostgreSQL). Containerization/CI/CD are out of scope of this documentation phase; when implemented they must not change the architectural principles above.
