# Inventory TI

Internal IT inventory management system for the IT support office at **Chilexpress**.

> **Status: documentation only. Implementation has not started.**
> This repository currently contains product and technical documentation describing the system to be built. No application source code, configuration, or schema files exist yet.

## Purpose

The system replaces manual, spreadsheet-based IT inventory tracking with a web application that provides:

- Current inventory visibility across quantity-based products and individually tracked equipment (assets).
- Product and quantity detail.
- Assignment history for assets (who has what, and who had it before).
- Movement history of every inventory-changing operation.
- Low-stock visibility at product level.
- Correction workflows for reversing or fixing inventory mistakes.
- User accountability through roles and an audit log.
- Reports, a dashboard, and realtime updates for connected users.

## Current MVP scope

- **One** active physical inventory location: **Chilexpress Enea**.
- Three roles: `JEFE`, `COORDINADOR`, `SOPORTE`.
- Products (quantity-based), Assets (individually tracked), Assignments, InventoryMovements, Corrections, AuditLog, Reports, a Dashboard, and realtime updates.
- The application is **online-first** (PWA). Offline inventory mutations are out of MVP scope.

### Deliberately out of MVP scope

- Company-wide distributed inventory.
- Multi-location inventory workflows / transfers between locations.
- Office hierarchy management.
- A repair management subsystem (`IN_REPAIR` and `IN_WARRANTY` are modeled as asset statuses only).
- Offline inventory mutations.

Future extensibility (Office hierarchy, additional locations, repairs) is anticipated in the architecture but intentionally not implemented.

## High-level stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js, TypeScript, Fastify, Prisma, PostgreSQL, Zod |
| Frontend | React, Vite, TypeScript, Tailwind CSS |
| Realtime | WebSocket |
| Delivery | PWA (installable, online-first) |

No microservices, Kubernetes, Kafka, RabbitMQ, Redis, GraphQL, CQRS, or event sourcing.

## Documentation structure

```text
inventory-ti/
├── README.md
└── docs/
    ├── product/          # WHAT and WHY the system does
    │   ├── requirements.md
    │   ├── roles.md
    │   ├── inventory.md
    │   ├── assets.md
    │   ├── workflows.md
    │   └── reports.md
    └── technical/        # HOW it works
        ├── architecture.md
        ├── structure.md
        ├── frontend.md
        ├── backend.md
        ├── database.md
        ├── security.md
        ├── realtime.md
        ├── pwa.md
        ├── storage.md
        ├── testing.md
        └── decisions.md
```

## Major architectural principles

1. **Modular monolith.** One deployable backend and one web frontend. Domain modules, not microservices.
2. **PostgreSQL is authoritative.** Database and API state are the single source of truth.
3. **Immutable movements + materialized stock.** Inventory changes are recorded once as immutable `InventoryMovement` records; current stock is a separately maintained materialized representation updated atomically in the same transaction.
4. **Products vs Assets.** Products are catalog items; assets are individually tracked physical units. Assignments relate an asset to a person and are not inventory movements.
5. **Backend-authoritative authorization.** Role checks are enforced in the backend; frontend restrictions are UX only.
6. **Online-first PWA.** The app caches its shell, reconnects, and resyncs from the API. No offline mutations.
7. **Realtime after commit.** WebSocket events are published only after a successful database transaction.
8. **Shared report data layer.** Reports reuse the same filtered dataset as the inventory/movement views.
9. **Storage abstraction.** Database stores file metadata; file bytes go through a storage abstraction (filesystem in MVP, object storage later).

## MVP architecture

```text
Client request → validation → authorization → database transaction
     (create immutable movement + update materialized stock)
        → commit → publish WebSocket event → client resyncs
```

See [docs/technical/architecture.md](docs/technical/architecture.md) for details.

## Terminology

| Term | Meaning |
| --- | --- |
| Product | A catalog item / type (e.g., Notebook, Mouse). |
| Consumable product | A product tracked by quantity (e.g., Keyboard, current stock 25). |
| Asset | An individually trackable physical unit (e.g., a specific Dell Latitude, serial ABC123). |
| Assignment | The relationship `Asset ↔ Person`, with its own history. |
| InventoryMovement | An immutable record of an inventory-changing operation. |
| Materialized Stock | The current-state representation of stock, updated transactionally. |
| Correction | A workflow to compensate an existing inventory movement. |
| AuditLog | A record of what a user did in the system. |
| Location | A physical inventory location. MVP has exactly one: Enea. |# inventory-ti
