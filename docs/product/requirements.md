# Product Requirements — IT Inventory Management

This document answers **WHAT** and **WHY** for the internal IT inventory management system of the Chilexpress IT support office.

- For **HOW** these requirements are implemented, see the [technical documentation](../technical/architecture.md).
- For terminology, see the [glossary](#glossary).

## 1. Goal

Replace and improve the manual, spreadsheet-based tracking of IT inventory with a single web application that is **the** reference for:

- what physical IT inventory exists (at current stock level),
- what each individual piece of equipment is and where it is in its life,
- who is holding which equipment,
- everything that has happened to the inventory (movement history),
- corrections to inventory mistakes (with accountability and traceability),
- low-stock visibility,
- reports and a dashboard,
- live updates for connected users.

## 2. Context

- **Organization:** Internal IT support office at Chilexpress.
- **Current MVP footprint:** one consolidated inventory for the IT support team; physical locations are not tracked.
- The original pain point: manual spreadsheets cannot reliably answer "what do we have, in what quantity, and who has which unit" and provide accountability and history.

## 3. Scope

### 3.1 In scope for the MVP

- User accounts with three roles: `JEFE`, `COORDINADOR`, `SOPORTE`.
- Catalog management: Products.
- Inventory management for quantity-based (consumable) products.
- Individual tracking of Assets (equipment with serial/id, status, assignment history).
- Assignments (Asset ↔ Person) with full history.
- Immutable inventory movement history.
- Correction workflow for inventory movements.
- Low-stock visibility (threshold at product level).
- Audit log of user/system actions.
- Dashboard with current inventory visibility.
- Reports (PDF and XLSX) over a shared filtered dataset.
- Realtime updates over WebSocket for connected users.
- PWA delivery, online-first.
- UI in Spanish and English (i18n).

### 3.2 Out of scope for the MVP

The MVP deliberately does **not** include:

- Distributed/company-wide inventory across many physical locations.
- Multi-location inventory workflows, location selection, or location transfers.
- Office / department hierarchy management (`Office` is anticipated as future extensibility only).
- A repair management subsystem. `IN_REPAIR` and `IN_WARRANTY` exist only as asset statuses.
- Offline inventory mutations.
- OAuth/OIDC/SSO (session-based authentication is used).
- Microservices, queues, event buses, or distributed infrastructure.

Anything listed as "future extensibility" is anticipated in the architecture but must not be implemented as MVP functionality.

## 4. Functional requirements

### 4.1 Authentication

- FR-AUTH-1: Users authenticate with a username or email identifier and a password.
- FR-AUTH-2: Sessions are HTTP-only cookies, with server-side session lifecycle.
- FR-AUTH-3: Users can log out; logout invalidates the session.
- FR-AUTH-4: Global (JEFE) administrators can manage users and roles.

### 4.2 Catalog

- FR-CAT-1: The system manages Products.
- FR-CAT-2: A Product is a catalog item/type (e.g., Notebook, Mouse, Keyboard, Monitor).
- FR-CAT-3: A Product is tracked **either by quantity** (consumable) **or by assets** (individually tracked units). See [inventory.md](inventory.md) and [assets.md](assets.md).
- FR-CAT-4: Each product has a low-stock threshold; a product is low stock when `current stock <= threshold`.
- FR-CAT-5: The low-stock threshold is configured at **product level** in the MVP (not per location).

### 4.3 Inventory visibility

- FR-INV-1: The system exposes current stock of quantity-based products.
- FR-INV-2: The system exposes the physical asset count and the available asset count per asset-based product.
- FR-INV-3: The system exposes the movement history of every inventory-changing operation.
- FR-INV-4: The dashboard shows current inventory visibility, low-stock items, and recent activity.
- FR-INV-5: Low-stock products are highlighted on the dashboard and in reporting.

### 4.4 Assets

- FR-ASSET-1: An Asset is an individually trackable physical unit belonging to a Product.
- FR-ASSET-2: Each asset has exactly one of the documented statuses. See [assets.md](assets.md).
- FR-ASSET-3: Each asset has an assignment history. See section 4.5.

### 4.5 Assignments

- FR-ASGN-1: An Assignment links a specific asset to a person.
- FR-ASGN-2: Assigning an asset changes its status to `ASSIGNED`; it does not remove the asset from physical inventory.
- FR-ASGN-3: Returning an asset ends the active assignment and frees the asset (status becomes `AVAILABLE` or as business rules dictate).
- FR-ASGN-4: The system records full assignment history: who has the asset now, who had it before, when it was assigned, and when it was returned.
- FR-ASGN-5: Assignments are **not** inventory movements. See [inventory.md](inventory.md).

### 4.6 Inventory operations

- FR-OP-1: Authorized users perform inventory operations: initialize, receive (ENTRY), issue (EXIT), return (RETURN), and adjust (ADJUSTMENT).
- FR-OP-2: Every inventory operation creates an immutable InventoryMovement and atomically updates materialized current stock.
- FR-OP-3: Normal inventory changes cannot be performed through arbitrary direct stock edits.
- FR-OP-4: Realtime events are published for connected users after the operation commits.

### 4.7 Corrections

- FR-COR-1: A Correction references an existing InventoryMovement and requires a reason and final signed quantity; the backend derives its compensating delta.
- FR-COR-2: JEFE corrections apply immediately with audited self-review; explicit self-review of pending requests is forbidden.
- FR-COR-3: Only `JEFE` can review pending requests; `COORDINADOR` and `SOPORTE` create pending requests but cannot approve or reject.
- FR-COR-4: An approved correction creates a compensating InventoryMovement. The original movement is never modified.
- FR-COR-5: Corrections are fully traceable: states `PENDING`, `APPROVED`, `REJECTED`.
- FR-COR-6: Processed requests permit subsequent corrections; corrected running history recalculates later balances without rewriting movement amounts or double-counting compensation.

### 4.8 Audit

- FR-AUD-1: The system records an AuditLog of user actions (e.g., created a user, changed a role, edited a product, approved a correction, changed configuration).
- FR-AUD-2: InventoryMovements and AuditLog are kept as separate concepts. See [inventory.md](inventory.md).

### 4.9 Reports

- FR-REP-1: Reports are generated in PDF and XLSX.
- FR-REP-2: Reports are produced from the same filtered dataset as the corresponding inventory/movement views.
- FR-REP-3: Filters include date range, movement type, user, product, asset, and relevant status.
- FR-REP-4: Only authorized roles can access reports. See [reports.md](reports.md) and [roles.md](roles.md).

### 4.10 Realtime

- FR-RT-1: Connected clients receive live updates after committed inventory operations and other subscribed changes.
- FR-RT-2: WebSocket is a notification/delivery channel, **not** the source of truth.
- FR-RT-3: A client that disconnects resyncs authoritative data through the REST API.

### 4.11 Internationalization

- FR-I18N-1: The application UI supports **Spanish and English**.
- FR-I18N-2: UI text is translatable; technical identifiers and code remain in English.

## 5. Non-functional requirements

- NFR-ACC: Backend authorization is authoritative for all operations, role checks included. Frontend restrictions are UX only.
- NFR-CON: Inventory is consolidated by product; simplicity is preferred over speculative physical-location tracking.
- NFR-IMM: Inventory movements are immutable and are never edited after creation.
- NFR-INT: Movement creation and materialized stock update are atomic (all-or-nothing).
- NFR-SEC: Secrets come from environment/configuration; passwords are securely hashed; file uploads are validated.
- NFR-FEAT: The PWA is online-first; new versions are detected and applied without losing the session.
- NFR-UX: Spanish and English, light and dark themes, responsive layout, accessibility, keyboard navigation, reduced-motion preference, loading/error/empty states, form validation.

## 6. Out-of-scope features documented for the future

These may become real requirements later. They are explicitly **not** MVP:

- **Office hierarchy** (`Office` organization level).
- **Multi-location inventory workflows** and location transfers.
- **Repair management** (a `repairs` module).
- **Offline inventory mutations**.

## Glossary

| Term | Definition |
| --- | --- |
| Product | A catalog item / type (e.g., Notebook, Mouse). |
| Consumable product | A product tracked by quantity (e.g., Keyboard, current stock 25). |
| Asset | An individually trackable physical unit (e.g., Dell Latitude, serial ABC123). |
| Assignment | The relationship `Asset ↔ Person`, with its own history. |
| InventoryMovement | An immutable record of an inventory-changing operation. |
| Materialized Stock | The current-state representation of stock, updated transactionally. |
| Correction | A workflow to compensate an existing inventory movement. |
| AuditLog | A record of what a user did in the system. |
| Low stock | `current stock <= product-level threshold`. |
