# Documentation

This is the index of the Inventory TI documentation.

The canonical documentation is written in **English**. Spanish is provided through a dedicated user guide. See [ADR-16](technical/decisions.md#adr-16-english-is-the-canonical-documentation-language-spanish-via-a-user-guide) for the language strategy.

## Product

Product documentation answers **WHAT** and **WHY** the system does.

| Document | Purpose |
| --- | --- |
| [Product README](product/README.md) | Product documentation overview. |
| [Requirements](product/requirements.md) | Goals, scope, functional and non-functional requirements. |
| [Roles](product/roles.md) | The three roles (`JEFE`, `COORDINADOR`, `SOPORTE`) and the permission matrix. |
| [Inventory](product/inventory.md) | Products, consolidated stock, movements, low stock, corrections. |
| [Assets](product/assets.md) | Asset lifecycle, statuses, and the Product/Asset distinction. |
| [Workflows](product/workflows.md) | End-to-end workflows: inventory operations, corrections, assignments. |
| [Reports](product/reports.md) | Report requirements and access. |

## Technical

Technical documentation answers **HOW** the system is built.

| Document | Purpose |
| --- | --- |
| [Architecture](technical/architecture.md) | Overall architecture and request pipeline. |
| [Structure](technical/structure.md) | Repository and module layout. |
| [Frontend](technical/frontend.md) | Frontend architecture and UX. |
| [Frontend V1–V17 coverage](planning/excel-mda/frontend-coverage-v1-v17.md) | Contract paths, archived compatibility, integration evidence and remaining rollout/UX limits. |
| [Design context](../DESIGN.md) | Shared visual intent, themes, responsive records and overlays. |
| [UX contract](../UX-CONTRACT.md) | Canonical controls and cross-screen interaction behavior. |
| [Backend](technical/backend.md) | Backend layering and conventions. |
| [Corrections contract](technical/corrections.md) | Final signed quantities, compensation, corrected running history and rollout. |
| [Database](technical/database.md) | Persistence model, integrity rules, indexes. |
| [Security](technical/security.md) | Authentication, authorization, CSRF, rate limiting. |
| [Realtime](technical/realtime.md) | WebSocket model (planned). |
| [PWA](technical/pwa.md) | PWA behavior (planned). |
| [Storage](technical/storage.md) | File storage and validation (planned). |
| [Testing](technical/testing.md) | Testing strategy and required coverage. |
| [Decisions](technical/decisions.md) | Architecture Decision Records (ADRs). |

## User Guide

Operational documentation in Spanish for end users.

| Document | Purpose |
| --- | --- |
| [Guía de usuario (es)](user-guide/es/README.md) | Spanish user guide overview. |
| [Acceso y activación](user-guide/es/authentication.md) | Login, activation, sessions and theme. |
| [Inicio — Dashboard](user-guide/es/dashboard.md) | Current-state KPIs, date-filtered movement charts and drill-downs. |
| [Catálogo](user-guide/es/catalog.md) | Product search, tracking modes, minimum stock and management. |
| [Inventario](user-guide/es/inventory.md) | How inventory works. |
| [Revisión e historia importada](user-guide/es/import-reviews.md) | JSON batch review, closed-period sets, recovery and archived receipts. |
| [Activos](user-guide/es/assets.md) | How assets are registered and managed. |
| [Asignaciones](user-guide/es/assignments.md) | How assets are assigned and returned. |
| [Correcciones](user-guide/es/corrections.md) | How corrections work. |
| [Usuarios](user-guide/es/users.md) | JEFE account creation, editing, activation codes and access reset. |
| [Mi cuenta](user-guide/es/account.md) | Inline personal-data editing and password changes. |
| [Roles](user-guide/es/roles.md) | Roles and responsibilities. |

## Deployment

Operational documentation for installing, running, and maintaining the system.

| Document | Purpose |
| --- | --- |
| [Deployment README](deployment/README.md) | Overview and quick answers. |
| [Configuration](deployment/configuration.md) | Environment variables and secrets. |
| [Development](deployment/development.md) | Local development setup (no Docker). |
| [Docker](deployment/docker.md) | Docker development/production (planned, not yet provided). |
| [Production](deployment/production.md) | Production deployment steps. |
| [Database](deployment/database.md) | Migrations and database operations. |
| [Users and access recovery](deployment/users.md) | First administrator, account creation, activation, resets and administrator handover. |
| [Backups](deployment/backups.md) | Backup strategy and restore procedures. |
| [Troubleshooting](deployment/troubleshooting.md) | Common issues and solutions. |
