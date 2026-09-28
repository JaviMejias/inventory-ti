# Product Documentation

This section answers **WHAT** and **WHY** for the Inventory TI system.

The product documentation is written in **English** (canonical language, see [ADR-16](../technical/decisions.md#adr-16-english-is-the-canonical-documentation-language-spanish-via-a-user-guide)). Spanish is provided through the [user guide](../user-guide/es/README.md).

## Documents

- [Requirements](requirements.md) — goals, scope, functional and non-functional requirements.
- [Roles](roles.md) — the three roles and the permission matrix.
- [Inventory](inventory.md) — products, consolidated stock, movements, low stock, corrections.
- [Assets](assets.md) — asset lifecycle, statuses, and the Product/Asset distinction.
- [Workflows](workflows.md) — end-to-end workflows: inventory operations, corrections, assignments.
- [Reports](reports.md) — report requirements and access.

## Implemented vs. planned

- **Implemented:** authentication, product catalog, quantitative inventory, asset management (Phase 6A), and asset assignments (Phase 6B).
- **Implemented:** corrections. **Planned:** reports, dashboard, realtime WebSocket, PWA, storage.

See the [README](../../README.md) for the current status.
