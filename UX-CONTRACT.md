# Inventory TI UX Contract

This contract records frontend interaction ownership. Product rules, permissions, and lifecycle constraints remain owned by the API and the technical/product documentation.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | `apps/web/src/ui/primitives/Select.tsx` | `DESIGN.md` + shared primitive | simple / searchable | keyboard, popup geometry, narrow viewport |
| Form | `Field`, `Button`, `Alert` and feature validation | shared UI + feature form | create / edit | label, validation, submit |
| Toast | `apps/web/src/ui/feedback/ToastProvider.tsx` | `DESIGN.md` + shared provider | success / info / warning / error | live region, deduplication, timing, narrow viewport |
| Scrollbar | `apps/web/src/styles.css` | global stylesheet | table/dialog geometry only | browser inspection |
| Responsive records | `DataTable` column `mobileRole` + shared `ui-record-table` styles | `DESIGN.md` + shared table styles | identity / field / full / actions / context | long values, narrow cards, action reachability, desktop regression |
| Theme | `apps/web/src/theme/theme.ts`, shared `ThemeSwitcher`, and root CSS tokens | `DESIGN.md` + local preference | light / dark / system on app and authentication | persistence, system change, contrast |
| CRUD | feature route and API behavior | backend policy + feature | create / edit / activate | full flow |

## Shared behavior

- `Select` is authored. Small fixed option sets use its simple variant; large entity sets use the same component with local search. Searchable popups render at most five initial matches, keep the current selection reachable, and disclose when more matches require refining the query. It owns focus, Arrow keys, Enter, Escape, visible selection, bounded scrolling and popup positioning. A popup opened during a dialog's entrance animation remeasures its anchor when that animation finishes, so its width and position do not retain the dialog's temporary scale.
- Active/inactive state is represented with the shared `Switch`. The feature owns the server mutation and any confirmation required by the operation.
- Dialogs stay fixed and centered in the viewport regardless of the page's scroll position, preserve focus, close through Escape when not busy, restore trigger focus without scrolling the underlying list, keep long content internally scrollable, and respect reduced motion. Initial focus must not move the page; cleanup also restores focus for conditionally unmounted history/detail dialogs. Opening or closing a read-only dialog preserves loaded rows and filters.
- Remote list search is debounced for 300 ms, keeps a visible clear control, and ignores stale responses through feature request IDs.
- Loading uses stable button geometry and table skeletons; empty and request errors use shared feedback components.
- Toasts use the single root provider and fixed top-right placement. Identical messages within two seconds replace each other; at most four remain visible. Success, information and warning messages close after five seconds, while errors persist until dismissed. When an actionable mutation fails inside a dialog, the localized recovery message appears inline in that dialog and is echoed through the shared error toast so it remains visible without hiding the form context.
- Auto-dismiss pauses during pointer hover or keyboard focus. Toasts acknowledge server-confirmed outcomes; validation and actionable request failures remain inline, and raw backend errors never become toast copy.
- All feature requests use `apps/web/src/lib/api.ts`. Error codes and HTTP/network failures are translated by `getApiErrorMessage`; modal request handlers use the shared `useRequestError` hook to return that same message for the inline alert and publish a persistent error toast. List loading errors stay visible in their page/table. A failed history load is an error state with retry, never an empty history.
- Failed incremental requests preserve the loaded rows and pause automatic loading until an explicit retry or filter change. Page loading failures expose retry and do not masquerade as empty datasets; a failed dashboard refresh never renders unconfirmed zero metrics or empty charts. Confirmations stay open after a failed mutation.
- Toasts join the browser top layer through a manual popover, hosted inside the active native dialog when one is open. This keeps the notification visible and its dismiss control reachable while the rest of the document is inert. When a mutation closes or unmounts that dialog, the provider resolves a connected host before opening the popover; the notification moves to the remaining dialog or page without being lost or crashing the application. Network failures describe an unconfirmed result and recommend refreshing before repeating a stock-changing operation.
- Theme preference is stored locally as `light`, `dark`, or `system`. System mode follows `prefers-color-scheme` changes without overriding an explicit user choice.
- Shared feedback preserves semantic color roles in every theme: brand yellow for identity/action/active/highlight, blue for information, green for success, orange for warning and red/rose for danger. Solid brand yellow always uses black text.
- Shared controls expose a visible blue focus indicator, a consistent disabled treatment and token-owned surfaces. Surface, dropdown and dialog are the only shared elevation roles.
- Primary navigation stays in the full-width top header on desktop and becomes a fixed, equal-width, icon-only bottom bar below 1024px. Each link keeps its Spanish accessible name and native title tooltip. It respects safe-area insets and the content shell reserves clearance so navigation never covers page actions.
- Responsive rows preserve the full identity, status, permissions, actions and dataset navigation. `mobileRole` explicitly defines card structure; the first or last desktop column does not implicitly become its header/footer. Inventory's native tables use the same `data-card-role` contract. Long values wrap without hiding information or forcing lateral scrolling. Corrections retain original/result values in their adjustment context when the equivalent standalone columns are hidden. Cards use document scrolling and shared responsive loading/empty feedback.
- When a table value is visually clipped, the shared `OverflowText` owner exposes its complete value on hover and keyboard focus. Responsive cards wrap the same text in place, so touch users can read it without relying on a hover tooltip.

## Authentication behavior

Authentication uses the shared theme preference and an in-flow brand/theme header in both sign-in and activation. Narrow screens show the sign-in form without the desktop story panel; document scrolling keeps fields, errors and submit reachable on short screens. Login uses shared Button/Alert feedback, owned validation, password-manager autocomplete and an accessible show/hide control. Busy submission preserves button dimensions and blocks duplicate requests. Invalid credentials preserve the identifier and clear the password. Sign-in and activation set localized document titles and restore the previous title when leaving.

## User administration behavior

- The Users toolbar always exposes “Nuevo usuario” to `JEFE`, including when the list contains records or has active filters. It uses the shared `PageToolbar` action slot and the existing user editor, matching Catalog's create entry point.
- Creation collects the name, unique username, email, phone and role. A successful request closes the editor, refreshes the current list and opens the activation-code dialog; the person configures their own password during activation. Existing filters remain applied, so a new account may not match the current view.
- Failed creation keeps the editor and its values open with localized inline and toast feedback. Busy submission blocks repeat submits. Backend authorization and CSRF remain owned by `POST /users` in `apps/api/src/auth/routes.ts`; only `JEFE` may create accounts.

## Inventory asset status behavior

- “Cambiar estado” appears in each active, unassigned asset's action dock and responsive record card. It uses the shared `Dialog`, `Field`, `Select`, `Button`, existing status badges and toast provider; the current and proposed states remain visible before submission.
- State options follow `changeAssetStatus` in `apps/api/src/routes/assets-service.ts`: support may select available, reserved, under review or in repair; jefe/coordinador may also select in warranty or lost. The current state, assigned and decommissioned are never selectable. Assigned assets must use the existing return workflow first; decommissioned/inactive assets have no operational-state action.
- The selection starts empty. Saving requires an allowed destination, blocks duplicate requests, and sends `POST /assets/:id/status` with CSRF protection. Failure keeps the selection and dialog open with Spanish inline and toast feedback.
- Only the server-confirmed asset replaces its row. Search, active filters, loaded record counts and the list's scroll remain intact; an asset that no longer matches the active state filter disappears from that filtered list. The modal completes its shared exit animation before unmounting. The existing history endpoint supplies the audit event, including actor, date and previous/new state; frontend code never invents a successful history entry.

## Catalog behavior

- Products use the existing API filters and incremental load-more behavior.
- A search clear control clears only text. An empty-state recovery clears all filters relevant to that tab.
- Only `JEFE` sees management controls. The backend remains the authorization authority.
- Activating or inactivating a record requires confirmation; the switch reflects the persisted state and does not optimistically change before the request completes.
- All data tables use the full content width on desktop. At widths up to 1023px, semantic rows reflow into labeled record cards; identity and actions remain full-width and each dataset keeps its existing pagination or incremental load-more control. Inventory quantity and asset tables follow the same card layout without horizontal scrolling.
- Catalog is one continuous operational surface for products. Its command header owns the active context, while filters and column headers share one uninterrupted theme-aware control band before the data. Light mode uses warm paper surfaces and dark mode uses ink surfaces.
- Creating or editing a product and activating or inactivating it produces action-aligned toast feedback after server confirmation. The application describes inactivation honestly and does not label it as deletion.
- Asset create/edit/status/decommission, assignment/return, inventory movements, correction requests and correction reviews use the same server-confirmed toast pattern.

## Corrections and quantity history

The business rules come from [the backend corrections contract](docs/technical/corrections.md). The editor sends the final signed quantity; the server owns the resulting delta and current corrected baseline. EXIT direction is fixed to subtraction, INITIAL/ENTRY/RETURN to addition, and only ADJUSTMENT offers a direction switch. Zero may cancel the movement effect.

- JEFE sees “Aplicar corrección” and immediate-application guidance; other roles see “Solicitar corrección” and review guidance. Feedback follows the returned status, not an assumed pending outcome.
- Creation refreshes eligible movements on every opening and respects server-owned `canCorrect` metadata independently of correction-list pagination, filters, or visibility. Compensating movements and pending originals are unavailable; processed originals may be corrected again.
- Tables and review dialogs distinguish the persisted previous quantity, final quantity, and difference applied to stock. They never reconstruct repeated corrections from the immutable original amount.
- Quantity history uses the corrected-history endpoint and displays running before/after balances. Compensating audit records appear in a separate disclosure and are not counted again. Asset history remains unchanged. Historical negatives and stock/history divergence are explicit warnings.
- Validation failures preserve inputs with Spanish field feedback; operation failures use the shared, visible toast recovery. Loading, empty eligibility, and failed history/movement loads have distinct states and explicit retry.
- The correction form constrains its grid tracks to the available width, including long movement labels on mobile. History cards size to their full content so running balances and correction notes never overlap subsequent events.
