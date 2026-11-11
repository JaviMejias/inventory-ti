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

- **Implemented frontend:** sign-in/activation, product catalog, quantity/asset inventory, assignment/return and status flows, corrections, JEFE user administration, personal account editing and Dashboard consultation.
- **Planned:** reports, realtime WebSocket, PWA/offline and storage. Dashboard is already a consultation view composed from existing REST reads, not an implemented dedicated backend aggregation module.
- **Pending policy decision:** current Dashboard navigation includes SOPORTE, while the product permission matrix excludes that role. See the [documented discrepancy](../technical/frontend.md#unresolved-dashboard-access-policy); this status summary does not amend permissions.

See the [README](../../README.md) for the current status.
