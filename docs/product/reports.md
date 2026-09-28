# Reports

This document defines report requirements: what is reported, who may report, and how reports are produced.

Related documents:

- [requirements.md](requirements.md) — overall WHAT/WHY.
- [inventory.md](inventory.md) — movements and materialized stock.
- [technical/decisions.md](../technical/decisions.md) — ADR-8 (shared report data layer).

## 1. Purpose

Reports answer operational and administrative questions about inventory and movements:

- What stock do we have (current state)?
- What has happened over a period (movements)?
- Which products are low stock?
- Which assets are in which status?
- Who did what?

## 2. Output formats

- **PDF** — for printing/sharing.
- **XLSX** — for offline analysis.

## 3. Shared report data layer

Reports use the **same filtered dataset** as the corresponding inventory/movement views.

- One filtering/data-query layer serves both the on-screen views **and** the report generators.
- There is **no separate, independent filtering logic** for PDF vs. XLSX.
- A single filtered dataset is rendered to the requested format.

See ADR-8.

## 4. Filters

The report filter set includes:

- date range
- movement type
- user
- product
- asset
- relevant status (asset status / correction status as applicable)

## 5. Access

| Role | Access |
| --- | :---: |
| `JEFE` | ✅ |
| `COORDINADOR` | ✅ |
| `SOPORTE` | ❌ |

(The MVP does not grant `SOPORTE` report access.)

## 6. Typical reports (MVP)

1. **Current stock** (consumables by product; assets by status) — snapshot of materialized stock.
2. **Movement history** — filtered by the criteria above.
3. **Low-stock products** — products where `current stock <= threshold`.
4. **Corrections** — correction requests and their outcome (traceability).
5. **Assignments** — current/historical assignment records (who has what).

Final report set is implementation-derived from the shared filter layer; the list above is a starting point and must not introduce a second filtering implementation.
