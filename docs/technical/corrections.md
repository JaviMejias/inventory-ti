# Backend corrections contract

## Create a correction

`POST /inventory/movements/:movementId/corrections` requires an authenticated operator and CSRF.

```json
{ "correctedQuantity": -2, "reason": "Se entregaron dos unidades, no tres" }
```

`correctedQuantity` is the final **signed stock effect** of the movement, not the current stock of the product. EXIT uses negative values; INITIAL, ENTRY and RETURN use positive values; ADJUSTMENT preserves its signed effect and may cross zero. Zero cancels the effective quantity without deleting the original movement. Integer limits apply; no-op and direction-changing corrections return 400.

The backend calculates `delta = correctedQuantity - currentEffectiveQuantity`. The current effect includes all previously approved corrections to this original movement. The response includes `previousQuantity`, `correctedQuantity` and `delta`. Exactly one of `correctedQuantity` or legacy `delta` is accepted. Legacy delta clients remain supported, with the same role and validation rules.

- JEFE: creates and applies an APPROVED correction in one transaction. The requester is also the reviewer, and the approval audit records `autoApplied: true`.
- COORDINADOR/SOPORTE: creates a PENDING request without changing stock. A JEFE approves or rejects it. Explicit self-review of pending requests remains forbidden, including legacy requests created by a JEFE.
- Only one PENDING request is allowed per original movement. Rejection or approval allows a subsequent request, while retaining all earlier records.
- Compensating movements cannot themselves be corrected. Submit subsequent corrections against the original movement.

Creation/review lock the original movement first, then the request where applicable. Application also locks the product stock row. This consistent order prevents duplicate processing and serializes competing stock changes. The request, compensation, stock and audits commit or roll back together. Negative current stock and stock overflow return 409; failed reviews leave the request pending, while failed direct JEFE application leaves no request behind.

## Corrected running history

`GET /inventory/products/:productId/history` requires authentication and supports the movement list filters `from`, `to`, `movementType` and `performedById`.

It returns:

- `movements`: chronological original records with `originalQuantity` (signed), `effectiveQuantity`, `correctionDelta`, `balanceBefore`, `balanceAfter` and correction metadata.
- `compensatingMovements`: separate audit records; **do not add them to the corrected running balances**.
- `stockQuantity`: materialized current stock; normal stock reads remain O(1).
- `historyQuantity`: final balance of the complete corrected history, even when response movements are filtered.
- `isConsistent`: whether the full corrected balance matches materialized stock.
- `hasNegativeBalance`: whether any historical corrected balance is negative. Backdated operations or old inconsistent data can cause this; corrections validate current available stock, not historical availability.

Balances start at zero and INITIAL contributes its quantity. The full history is calculated before filtering, so filtered rows retain their real opening balance. Reads use a repeatable-read snapshot. Ordering is `effectiveAt`, `createdAt`, then `id` as a deterministic tie-breaker. Original movement quantities/dates are never rewritten. Existing `/inventory/movements` endpoints remain the unmodified audit view.

Example: correcting an EXIT from -3 to -2 applies +1 once. Current stock 4 becomes 5; every corrected balance from that original movement onward gains 1. Correcting the same movement next to -4 applies -2, not -1 against the original -3.

## Deployment and frontend handoff

Migration `0011_correction_final_quantity` backfills final quantities from immutable movement effects and recorded deltas, adds a required `correctedQuantity`, and enforces one pending request with a partial unique index. It does not change existing stock or movements.

After backing up and reviewing pending migrations, run `pnpm db:migrate` and restart the API. This command also deploys any earlier pending migrations: in particular, `0010_remove_locations` drops location distinctions, so review its backup warning first. Integration tests must use a separate disposable PostgreSQL database, not the user's inventory.

The frontend sends signed final quantities, displays persisted before/after values, distinguishes direct JEFE application from pending review, permits subsequent requests for processed originals, and consumes corrected running history. Spanish recovery messages cover correction validation, stale requests and stock overflow. Movement reads also return `originalQuantity`, `effectiveQuantity`, `canCorrect` and `compensatingCorrectionId`, allowing eligibility to remain independent of correction-list pagination, filters and requester visibility. Legacy delta clients remain compatible; normal movement reads retain their immutable `quantity` as the audit view.

## Frontend verification (2026-09-28)

Verification used isolated API/web servers and a disposable, fully migrated database. No production inventory records or local development migration state were changed.

- Browser: JEFE changed movement six of twenty from -3 to -2; stock and full-history balance changed from 4 to 5. A subsequent correction began at the effective -2 and changed it to -4 with delta -2.
- Browser: SOPORTE submitted -4 to -3 as PENDING without changing stock. JEFE approval applied +1 exactly once. Rejection of a later request preserved stock and allowed another request against the original.
- Browser: no-op validation, Spanish insufficient-stock notification above the open modal, preserved form values, exclusion of pending originals, and history retry after a simulated 503.
- Browser: 20 original history events with separately disclosed compensations; mobile checks at 390 × 844 verified equal selector/popup width, Escape focus restoration, and non-overlapping history cards. Screenshots are local artifacts under `output/playwright/` (ignored by Git).
- All 88 backend behavioral tests and all 30 current frontend tests passed, including five correction-model tests. Targeted ESLint, API/web TypeScript checks and the web production build passed. The build still warns about its large main bundle.

The available local Node runtime was 26.7.0; the project declares Node 24.x. React Doctor's full scan reported 46 warnings across the application (59/100); this is not a clean global health audit. Relevant placeholder-label warnings were checked against the actual shared Field labels and browser accessibility snapshots; loading-reset warnings were checked against guarded finally blocks. Broad complexity/performance refactors and other chats' in-progress changes were left out of scope. The premium static audit also reports shared React Select components as native selects because it lowercases tag names, plus scripted documentation buttons as handlerless; these findings were inspected, not suppressed with native-control waivers.

The real local database was inspected read-only and still had migrations only through `0009_remove_categories`. Deploying `0010_remove_locations` and `0011_correction_final_quantity` remains a separate, backup-reviewed step.
