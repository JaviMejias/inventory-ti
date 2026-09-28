# Frontend

This document defines the frontend architecture, conventions, and UX requirements.

Related documents:

- [architecture.md](architecture.md) — system context.
- [structure.md](structure.md) — monorepo layout and feature organization.
- [pwa.md](pwa.md) — PWA behavior.
- [realtime.md](realtime.md) — WebSocket consumption model.
- [security.md](security.md) — session and CSRF handling in the browser.
- [decisions.md](decisions.md) — ADR-5, ADR-6.

## 1. Stack

```text
React
Vite
TypeScript (strict mode)
Tailwind CSS
```

- i18n: UI text translatable between **Spanish and English**.
- Icons: Lucide-style icons; subtle motion where appropriate. Animations are never required for functionality.
- Prefers `reduced-motion` (user preference).

## 2. Architecture

- **Feature-based organization** (see [structure.md](structure.md) §4).
- Reusable **UI primitives** for consistent building blocks.
- App infrastructure (i18n, theme, router, data fetching, websocket client) lives separate from features.
- Strict TypeScript; no `any`.

## 3. UI primitives

Current implementation uses standard HTML elements with Tailwind CSS styling. Shared UI primitives are planned:

```text
PageShell              ✅ Implemented (layout wrapper)
Button                 ✅ Implemented (standard button elements)
Input                  ✅ Implemented (standard input elements)
Dialog / Modal         ✅ Implemented (custom Dialog component with keyboard/focus management)
NumberInput            Planned
CurrencyInput          Planned
RutInput               Planned
Select                 Planned
SearchableSelect       Planned
DatePicker             Planned
Switch                 Planned
Drawer                 Planned
Table                  Planned (used inline in pages)
Pagination             Planned
Badge                  Planned (status badges rendered inline)
Toast                  Planned
EmptyState             Planned
```

### 3.1 NumberInput

- Controlled **text input** with numeric validation.
- Do **not** rely on browser-native number controls if they produce undesirable arrows/behavior.

### 3.2 CurrencyInput

- Displays Chilean-style formatting: `1.250.000`.
- Stores a **normalized numeric value**.
- **Never use floating point** for monetary values (integers/cents or equivalent). See also [database.md](database.md) and [decisions.md](decisions.md).

### 3.3 RutInput

- Displays Chilean RUT formatting: `13.558.459-2`.
- Stores a **normalized representation**.
- Validate **on frontend and backend** (backend is authoritative).

### 3.4 SearchableSelect

For large datasets:

- debounce search;
- query the backend;
- **do not load the entire dataset** unnecessarily.

## 4. UX requirements

The application must support:

- **Spanish and English** — all UI text translatable; technical identifiers/code stay in English.
- **Light and dark themes.**
- **Responsive layout.**
- **Accessibility** and keyboard navigation where appropriate.
- **Reduced-motion preferences.**
- **Loading, error, and empty states** throughout.
- **Form validation** consistent with backend rules.

State-changing requests on forms must include the CSRF token (see [security.md](security.md) §5). Error messages reflect backend structured errors where user-facing.

## 5. Data & realtime consumption

- REST is the authoritative data path (see [architecture.md](architecture.md)).
- WebSocket events refresh open views; on reconnect the client **resyncs via REST** (see [realtime.md](realtime.md)).
- Role awareness in the UI is a **UX convenience only**; the backend enforces permission (ADR-5).

## 6. Reports

- Report screens offer the shared filter set and generate PDF/XLSX via the shared report data layer (see [reports.md](../product/reports.md) and ADR-8).