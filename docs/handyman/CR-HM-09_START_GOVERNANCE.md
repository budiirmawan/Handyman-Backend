# CR-HM-09 — Material Execution — START GOVERNANCE

Date: 2026-09-29 (Asia/Jakarta)
Branch: `arena/01a0e01e-handyman-backend`
Base commit: `74f2bd1` (CR-HM-08 certified COMPLETE —
`CR_HM_09_PREREQUISITE=WORK_SESSION_EXECUTION_COMPLETE`)

Governance ONLY. NO migration, NO runtime/API/OpenAPI/tests in this
PART. This document freezes the authority, aggregate, and lifecycle
decisions for CR-HM-09. Does not invent runtime.

## §1 Position in the frozen roadmap

Roadmap row 9: **Material Execution** — depends on CR-HM-06 (quotation
authorization), unblocks CR-HM-13 (payment ledger), CR-HM-18
(settlement). Scope vocabulary: *Estimated, Approved,
Issued/Purchased, Used, Returned, final usage basis*. Standing rule:
**final material charge remains financial-domain authority — material
usage != authoritative final material charge**.

Upstream verified read-only inputs:

- **CR-HM-06** `handyman_quotation_versions` + `handyman_quotation_lines`
  (immutable snapshot; `line_type='MATERIAL'`, `source_item_id` FK
  `inventory_items`, quantity, UOM, currency, final quoted amounts)
  — the APPROVED/ISSUED customer-authorization source. READ-ONLY
  link target only.
- **CR-HM-06 PART 06** deterministic `HandymanExecutionScope`
  (PHASE, MAINTAINER, `executionScopeId`) — the ONLY execution target.
- **CR-HM-08** work-session ladder + `MATERIAL_RUN` work-clock state
  — consumed READ-ONLY as execution CONTEXT (a transaction may
  reference the active session in MATERIAL_RUN, but never owns or
  mutates session semantics). **MATERIAL_RUN (research intent =
  field team fetches/collects material) != a material transaction**,
  and a material transaction must NEVER open/material-run Boolean
  meanings onto session state.

## §2 FROZEN decisions

### D1 — Exact aggregate/state model (ONE aggregate, two axes)

**Aggregate: `handyman_material_execution_line`** — one row per
IDENTIFIABLE material line in an execution scope (optionally linked
to one quotation MATERIAL line; ALSO PLAIN/NON-QUOTATION lines are
legal: field work ALWAYS discovers unquoted material needs that are
documented here the same way).

Per-ROW holdings, all server-derived quantities, one row evolves:

```text
scopeId, quotationVersionId?, quotationLineId?, sourceItemId
(inventory_items, read-only master reference),
description, uomId (grounded by item UOM),
quantities: estimatedQty | approvedQty | issuedQty |
purchasedQty | usedQty | returnedQty | finalUsedQty (derived),
acquisition: NONE|ISSUED|PURCHASED  (mutually exclusive),
status: ESTIMATED / APPROVED / ISSUED_OR_PURCHASED /
USED / SETTLED(FINAL_CHARGE_READY),
version (optimistic lock), changelog events (see D6).
```

FROZEN axis reason: a line may be ISSUED from warehouse stock OR
PURCHASED by the field team — NEVER both (acquisition enum enforces
exclusivity; per-line quantity ledger keeps states additive). The
public lifecycle collapses to the roadmap vocabulary:

```text
ESTIMATED → APPROVED → ISSUED|PURCHASED → USED → RETURNED(if unused)
→ FINAL_CHARGE_READY
```

`RETURNED` is a QUANTITY ADJUSTMENT on the line, not a sticky line
status: after a full return the line's finalUsedQty = 0 and the line
settles; after a partial return the line keeps its used remainder.

### D2 — Quantity invariants (DB-CHECK enforced, no soft checks)

1. All quantity columns `> 0` or `0` per column definition; nullable
   until their axis is entered (`estimatedQty` required at creation).
2. `usedQty <= issuedQty + purchasedQty - returnedQty` at ALL times
   (returned can only reduce issued-not-used remainder).
3. `returnedQty <= issuedQty + purchasedQty - usedQty` at ALL times
   (cannot return more than what physically remains issued/purchased).
4. `returnedQty <= issuedQty + purchasedQty` (sanity bound).
5. Partial USE and partial RETURN are both LEGAL; each adjustment is
   a new bounded transition, never an UPDATE overwrite of history.
6. Returned material NEVER flows back through CR-HM-09 into FM
   inventory-modules tables (stock movements/reservations live in FM;
   Handyman-owned stock is OUT of scope — physical restock/receipt is
   downstream operator procedure, not a module contract).
7. No balance recomputation outside the aggregate; a line's final
   usage basis is ONLY `finalUsedQty = usedQty - returnedQty`
   (derived, CHECK consistent, never independently supplied).

### D3 — Source/reference/quotation snapshot links

- Every line MUST carry `scopeId` (deterministic execution scope —
  the ONLY execution key, no task/work-order id).
- Every line MAY carry exactly ONE pair
  (`quotation_version_id`, `quotation_line_id`) FK'd to CR-HM-06
  immutable snapshot tables when the line realizes an approved
  quotation MATERIAL line. The link is REFERENCE ONLY — CR-HM-09
  NEVER mutates quotation rows, NEVER recomputes commercial fields.
- `source_item_id` FK `inventory_items` is REQUIRED for item-based
  lines (catalogue reference); free-text non-catalogue lines are
  legal on an approved-by-authority basis only when the crew records
  a bounded description + UOM (field reality).
- CR-HM-02 common-material profiles and reference-price views remain
  INPUT-ONLY read seams for `estimated/approved` composition. **The
  catalogue reference price is NEVER a transaction charge.**
- Quoted authority record: a quotation-line-linked row copies ONLY
  `estimatedQty ≤ approvedQty` from the quotation line's approved
  quantity at link time; later quotation-version supersession does
  NOT rewrite existing execution lines (link stays to its original
  version; a NEW link row may be created for the newer version).

### D4 — ISSUED vs PURCHASED semantics

- **ISSUED** = material drawn from provider/company-managed stock for
  the scope; recorded as `issuedQty` with NO price truth and NO FM
  `material-requests`/`inventory-*` mutation in this CR. The line's
  acquisition axis becomes ISSUED at first issue; ISSUED may occur in
  multiple partial issues (each is a bounded sub-event inside the
  same line ledger, capped by approved authority).
- **PURCHASED** = material procured by the field team during
  execution (MATERIAL_RUN context or otherwise); recorded as
  `purchasedQty` with a bounded supplier/receipt REFERENCE string (a
  reference, not the FM purchase-order chain). Acquisition axis
  becomes PURCHASED at first purchase.
- A line adopts EXACTLY ONE acquisition mode (`acquisition IN
  ('ISSUED','PURCHASED')` after first acquisition; `CHECK` enforces
  no mode change once set). Mixed-mode execution across the SAME
  scope is expressed as TWO lines of that scope, never one line with
  both columns non-null.
- Neither axis implies USED: issued/purchased is POSSESSION
  recording; only an explicit USE transition consumes quantity.

### D5 — USED / RETURNED rules

- USED: explicit bounded transition `usedQty += n` with
  `usedQty ≤ issued+purchased-returned` (D2). USE may OCCUR WITH a
  CR-HM-08 session reference (`sessionId` nullable) — reference only,
  no session mutation; session is not required for material truth.
- RETURNED: explicit bounded transition `returnedQty += n` (partial
  legal), cap D2.3, only from the SAME acquisition the line adopted.
- Returned quantity REDUCES final usage: `finalUsedQty = usedQty -
  returnedQty` is the ONLY usage basis handed downstream.
- Once a line enters FINAL_CHARGE_READY aggregation (§D13 handoff),
  no further USE/RETURN adjustments: bounded 409
  MATERIAL_LINE_SETTLED. Corrections after settle = compensating
  downstream action (CR-HM-13 reversal/adjustment authority), NOT
  history rewrite.
- Customer-supplied material (CR-HM-02 customer material option):
  recorded as PURCHASED-by-none = NOT modeled in D1 aggregates; if a
  scope needs such recording it is a zero-authority observation line
  with quantities 0 and must be documented — BLOCKED without a later
  decision (flagged; not part of the 09 lifecycle).

### D6 — Evidence/audit requirements

- Append-only `handyman_material_execution_events` sibling log:
  `(lineId, eventType ENUM[ESTIMATED, APPROVED, LINKED, ISSUED,
  PURCHASED, USED, RETURNED, SETTLED], deltaQty NUMERIC(12,3),
  resultingQty NUMERIC(12,3), quotationLinkId?, sessionId?,
  reference string?, idempotencyKey NOT NULL, actorUserId NOT NULL,
  server created_at DEFAULT NOW)`; immutability trigger blocks
  UPDATE/DELETE (proven Handyman trigger precedent).
- The LINE row carries derived/materialized current columns updated
  ONLY from inside the same tx as its event append (client-consistency
  trigger precedent: line head and event tail must agree).
- Bills/receipts for PURCHASED lines: `reference` string only in
  09 — evidence attachment authority stays with CR-HM-02 evidence
  catalogue + CR-HM-10 staged evidence vocabulary (MATERIAL stage);
  09 stores the reference, not the media.
- All timestamps DB-server NOW(); callers supply no timestamps.

### D7 — Idempotency/concurrency boundary

- ALL mutations carry `idempotencyKey` (uuid); unique per
  `(line, event_type, idempotency_key)` — replay returns the SAME
  recorded event with `replayed: true`, no double quantity effect.
- Concurrency: row lock `SELECT … FOR UPDATE` on the checkout guard
  + deterministic scope serialization via
  `resolveScopeAssignmentLock` (CR-HM-04): the SAME authoritative
  Lead lock that serializes session commands serializes material
  mutations per scope; race = bounded 409, never partial state.
- Optimistic `version` column on the line is NOT required beyond the
  Lead lock (single-writer pattern); kept out to avoid dual fencing.
- Bounded terminal conflicts: one_estimate→approve authority flow per
  quotation line (linking an already-linked quotation line to a
  different execution line → bounded 409 — re-execute via new line).

### D8 — Existing reusable primitives vs required extensions

REUSE (read-only inputs, never mutated):

- `inventory_items` master (`code/name/itemType/uomId`, ACTIVE gate)
  — bounded item identity, same bounded-reference pattern as
  CR-HM-02 PART 02 profiles.
- CR-HM-02 common-material profiles + reference-price lookup view
  (input only at ESTIMATED/APPROVED composition).
- CR-HM-06 `handyman_quotation_versions`/`_lines` (link targets).
- CR-HM-04 execution scope + Lead authority (`resolveHandymanQuery*`,
  `resolveScopeAssignmentLock`), actor = authenticated Lead user only.
- CR-HM-08 session row + MATERIAL_RUN state (context reference).
- Common Handyman immutability/client-consistency trigger precedent.

NOT reused — explicitly EXCLUDED FM seams (no coupling, certified in
later PARTs): `material-requests`, `material-request-items`,
`material-issue/return-notes`, `inventory-material-reservations`,
`inventory-stock-movements/balances/batches/stock-locations`,
`inventory-work-order-material-usages`, `purchase-requests`,
`purchase-orders`, `goods-receipts`, vendor registry. Handyman
material execution is its own ledger; FM workflows are not adopted.

NEW (module-owned): `handyman_material_execution_lines` +
`handyman_material_execution_events` tables, ONE migration, ONE
domain module + ONE thin `-api` module (CR-HM-08 PART 05 pattern).

### D9 — Blockers

**ZERO.** Ready:

- CR-HM-09 governance decision on customer-supplied observation
  lines explicitly deferred to a later decision (D5) — tracked, not
  blocking the ISSUED/PURCHASED lifecycle.

### D10 — Smallest legal PART split

```text
PART 01 — governance freeze (THIS DOCUMENT)
PART 02 — persistence foundation: ONE migration (2 tables, quantity
          CHECK invariants, acquisition exclusivity CHECK, append-only
          event trigger, line-head/client consistency, idempotency
          unique, per-scope partial index) + types/errors/repo;
          domain-table firewall sweeps = 0.  NO runtime service.
PART 03 — ESTIMATE + LINK + APPROVE commands: create line (quotation
          link or plain), approve authority flow, idempotent replay,
          one-link-per-quotation-line, bounded errors.
PART 04 — ISSUED / PURCHASED commands (mutually exclusive
          acquisition axis, capped by approved, partials, references,
          sessionId reference optional).
PART 05 — USED + RETURNED commands (partial adjustments, D2 caps,
          acquisition-consistent returns, SETTLE transition +
          FINAL_CHARGE_READY read projection (scope-level line list +
          aggregated finalUsedQty — READ-ONLY read model only; naming
          confirmed as usage basis, never charge).
PART 06 — thin HTTP/OpenAPI exposure (9–10 bounded endpoints,
          idempotencyKey-only bodies, OpenAPI exact parity, forbidden
          financial/ownership surface absent).
PART 07 — FINAL CERTIFICATION (focused suites 6+6+6+6+? totals per
          PART; firewalls; final doc).
            Expected certification records to mirror CR-HM-08:
            CR_HM_09_STATUS=COMPLETE / _BLOCKERS=0 /
            _IMPLEMENTATION_DEFECTS=0 /
            FINAL_CHARGE_AUTHORITY=FINANCIAL_DOMAIN(CR-HM-12/13) /
            FM_COUPLING=NO.
```

## §3 Handoff

- **CR-HM-12 pricing** consumes the FINAL_CHARGE_READY read
  projection (`scopeId` + line-level `finalUsedQty` + unit-reference
  context) as INPUT to its own pricing authority. CR-HM-09 NEVER
  computes amounts; ZERO charge/currency columns on execution lines.
- **CR-HM-13 ledger** posts the final material charge from the same
  handoff after CR-HM-12 pricing; reversal/adjustment authority is
  13, never 09 (D5).
- **CR-HM-18 settlement** reads the certified ledger.

FINAL_CHARGE boundary for THIS CR: the ONLY artifact CR-HM-09 emits
is execution truth (approved quantities, issued/purchased, final used
after returns). THE WORD "CHARGE" may appear in this module ONLY as
the `FINAL_CHARGE_READY` SETTLED state name meaning "basis handoff
complete" — never as an amount, pricing, billing, or ledger column.
