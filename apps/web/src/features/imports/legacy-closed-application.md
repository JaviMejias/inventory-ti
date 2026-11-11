# Readonly V11 rules1 receipts

`ClosedApplication` is a union of `CurrentClosedApplication` (rules2) and the deeply
readonly `LegacyClosedApplication` (rules1), discriminated by `rulesVersion`.
Both the saved-result component and the receipt reader accept this union. The
rules2 branch still uses `validateClosedPlan`; writes and explicit recovery still
bind the current actor, original input, request ID and plan ID. Current intent
creation requires 1–25 periods and clones only the normalized request fields for
every period, independently of the stored response snapshots.

Evidence for the historical shape:

- `docs/planning/excel-mda/contrato-api-v10.md`, “Respuesta y vigencia”: rules1
  sources retain capture/batch/source/record/candidate IDs, original sheet/row,
  capture `sourceRevision`, effective day/precision, fields and snapshot digest.
- `contrato-api-v11.md`, “Respuesta y consultas” and “Compatibilidad de lecturas”:
  the complete plan and exact period snapshot are stored; detail GET omits
  `reused`. Persisted assignments have unknown historical actors. Application
  recorder/time are separate from the historical start/end instants.
- `contrato-api-v12.md`, “Integración con las asignaciones V10/V11”: rules2 adds
  `evidenceVersion`, `amendmentId` and `capturedSourceRevision`, changes the meaning
  of `sourceRevision`, and preserves earlier receipts without rewriting them.
- `apps/api/src/imports/assignment-apply-service.ts`: `getAssignmentApplication`
  reads the stored application with `receiptInclude` (items and assignments) and
  returns it directly. The serializer does not rebuild stored JSON through the
  current planner. Migration `0020_import_closed_assignments` preserves the
  rules1 plan, exact period snapshots, endpoint bindings and assignment values.

Consequently the present GET can serve genuine stored rules1 JSON. The legacy
reader validates that archived contract and its receipt/assignment bindings; it
does not infer a V12 projection, fill missing fields, compute new fingerprints,
consult current evidence, or claim current business eligibility. Sources with
any V12 projection fields are rejected as mixed contracts. An unknown source
day remains unknown even when separately backed exact start/end dates exist.

The common receipt header preserves the original recorder and capture time.
The legacy period view uses existing metadata, feedback, source-field, issue and
pagination primitives; it displays original offset dates, confirmed Chile times,
capture revision and provenance without a fictional version zero or “no
amendment” conclusion. It exposes no correction, replay or write action.

Legacy snapshots are rejected by intent/input creation and by write/recovery
response validation, even if their actor/request IDs match. Malformed,
incomplete, mixed, mismatched or unsupported snapshots fail with the existing
`INVALID_RESPONSE` path; the existing receipt UI offers a read retry and never
reports them as empty or successfully applied. No backend fallback is needed.

Validation uses explicit contract fixtures, not a production receipt or a real
Excel import. Cryptographic authenticity and deployed storage availability are
not established by client shape checks. Current assignment corrections that
make an included assignment disagree with the original snapshot still fail the
existing strict receipt binding; this compatibility path does not invent a
corrected-history projection.
