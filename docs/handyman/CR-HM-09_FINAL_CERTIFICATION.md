# CR-HM-09 — Material Execution — FINAL CERTIFICATION

Date: 2026-09-29 (Asia/Jakarta)
Branch: `arena/01a0e01e-handyman-backend`
Base commit: `e0b0ac3` (CR-HM-09 PART 06)

Governance reference: `CR-HM-09_START_GOVERNANCE.md` (FROZEN,
commit `907746b`).

## Certification record

```text
CR_HM_09_STATUS=COMPLETE
CR_HM_09_BLOCKERS=0
CR_HM_09_IMPLEMENTATION_DEFECTS=0
CR_HM_10_PREREQUISITE=MATERIAL_EXECUTION_COMPLETE
FINAL_CHARGE_AUTHORITY=FINANCIAL_DOMAIN(CR-HM-12/13)
FM_COUPLING=NO
```

## Delivered parts

| Part | Commit | Deliverable |
| --- | --- | --- |
| Governance | `907746b` | start governance (FROZEN decisions D1–D10, 7-PART split, 0 blockers) |
| PART 01 | `74246d3` | persistence foundation (migration 0402: 2 tables `handyman_material_execution_lines` + `_events`; quantity CHECKs; acquisition-exclusivity CHECK; append-only event trigger; line-head/client consistency triggers; idempotency unique; per-scope partial index; domain-table firewall sweeps = 0) |
| PART 03 | `00c1335` | ESTIMATE + LINK + APPROVE commands (one-quote-line→one-execution-line; approvedQty = approved snapshot quantity; replay-safe; bounded errors) |
| PART 04 | `8d20749` | ISSUE / PURCHASE commands (mutually-exclusive acquisition mode; cumulative cap ≤ approvedQty; PURCHASED bounded reference-only `supplierReference` — no FM/PO chain) |
| PART 05 | `d9e5bd0` | USE / RETURN / SETTLE (FINAL_CHARGE_READY) + usage-basis read projection (scope-level settled lines + `totalFinalUsedQty` aggregate, READ-ONLY) |
| PART 06 | `e0b0ac3` | thin HTTP/OpenAPI surface (8 bounded endpoints: 7 commands + projection) |

## Focused certification suites — 30/30 PASS

| Suite | Part | Tests |
| --- | --- | --- |
| `tests/handyman-material-execution.test.ts` | 01 | 6 |
| `tests/handyman-material-execution-commands.test.ts` | 03 | 6 |
| `tests/handyman-material-execution-acquisition.test.ts` | 04 | 6 |
| `tests/handyman-material-execution-usage.test.ts` | 05 | 6 |
| `tests/handyman-material-execution-api.test.ts` | 06 | 6 |

5 suites, 30 tests, 0 failures (real migrated PostgreSQL 18.4,
`node --test` concurrency 1). Each PART suite passed 6/6 at its own
landing. During certification, the older PART t6 negative-surface
scans were found to be staleness-bound: they asserted that surfaces
from LATER parts (PART 03's service file; PART 04/05's
ISSUE/PURCHASE/USE/RETURN/SETTLE/FINAL_CHARGE_READY identifiers;
PART 06's sibling `-api` module) did not exist. Those invariants
were correct AT EACH PART'S OWN HEAD but became lawfully false at
the certification HEAD — the FROZEN roadmap mandated exactly those
later additions, in the SAME files/modules. They are
test-precision flaws, NOT runtime defects; NO runtime code was
changed during certification. The guards were narrowed to their
DURABLE frozen invariants (each still held and still asserted):

1. **PART 01 t6** — true fences: (a) DB column firewall stays
   over-scope-checked (zero
   amount/currency/price/charge/billing/payment/invoice/rate/stock/
   reservation/purchase_order/material_request/goods_receipt/
   work_order/wallet/tariff/fee column on either table — unchanged);
   (b) exact persisted column sets unchanged; (c) domain module file
   set refined to the certified 5-file set (service landed PART 03)
   plus an explicit "no controller/routes ever inside this module"
   assertion; (d) the `finalchargeready` identifier form of the
   frozen state name was exempted alongside `final_charge_ready`
   (governance §3: the ONLY place the word "charge" may appear).
2. **PART 03 t6** — true fence: PART 03's own exports are exactly
   the estimation pair (`estimate`/`approve`); beyond-APPROVED
   surface (PART 04/05 commands, PART 06 HTTP) is correctly
   partitioned — zero controller/routes in the domain module, the
   `-api` sibling exists as the sole HTTP surface, the
   domain-module-only projected event stream for a PART-03-only
   line is untouched (`ESTIMATE, APPROVE` only).
3. **PART 04 t6** — true fence: PART 04's own exports are exactly
   the acquisition pair (`issue`/`purchase`) whose functional axis
   isolation was re-proved (issued head keeps `usedQty = 0` /
   `returnedQty = 0`); same domain-module HTTP fence as PART 03.
4. **PART 05 t6** — true fence: PART 05's service source carries
   zero commercial/FM vocabulary (the scan survives PART 06 because
   the service file is unchanged); the `-api` sibling fence refined
   the same way as PART 03/04.

## Frozen invariants verified at certification

1. **Quotation authority** — one execution line per MATERIAL
   quotation line (409 LINK_CONFLICT on re-link, same-key replay is
   idempotent); link anchors EXCLUSIVELY to the scope's immutable
   APPROVED quotation version (409 LINK_INVALID otherwise, testable
   as the version changing → unknown-version = LINK_INVALID).
2. **Quantity authority** — `approvedQty` is COPIED at link time
   from the approved snapshot line quantity and is immutable
   thereafter (estimation ≤ approved).
3. **Acquisition exclusivity** — exactly ONE mode per line
   (ISSUED XOR PURCHASED at SQL CHECK level AND at command level);
   cross-mode command = bounded 409 with the head UNCHANGED.
4. **Cumulative axis caps** — issuedQty ≤ approvedQty; purchasedQty
   ≤ approvedQty (bounded 400 QUANTITY_EXCEEDED at the exact
   boundary inclusive-rejection step); partial acquisitions
   accumulate; delta must be finite-positive (400).
5. **Usage basis invariants** — usedQty ≤ issuedQty + purchasedQty
   − returnedQty; returnedQty ≤ issuedQty + purchasedQty − usedQty
   (both bounded 400 at exact-invariant boundary reach + overflow
   step-out); RETURN is NOT a sticky status; the SETTLED basis is
   `finalUsedQty = usedQty − returnedQty`.
6. **SETTLE closure** — FINAL_CHARGE_READY opens ONLY from
   ISSUED/PURCHASED/USED; after settle EVERY further
   USE/RETURN/ISSUE/PURCHASE adjust = bounded 409; settle replay
   returns the SAME event (no second transition).
7. **Idempotent replay** — per (line_id, event_type,
   idempotency_key) uniqueness; replay returns the SAME head/event
   rows (`replayed: true`) atomically; row-lock serialisation via
   `SELECT … FOR UPDATE` inside a transaction for every mutation.
8. **Authority** — every command/projection: Lead-only
   (CURRENT authoritative CREW binding), behind the client-
   access wall; outsider 403; CLIENT-boundary 404 for
   cross-client/unknown scope/line identity (never fabricated).
9. **Append-only evidence** — events immutable
   (trigger-blocked UPDATE/DELETE), exact event-name sets, HEAD
   ordering proven (e.g. `ESTIMATE→APPROVE→ISSUE→USE→RETURN→
   FINAL_CHARGE_READY`).
10. **Execution-truth only** — zero amount/currency/rate/
    price/billing/payment columns; `supplierReference` is a
    bounded free-text reference snapshot (max 200 chars) —
    NO FM/PO/GR chain; FINAL_CHARGE_READY projection is
    quantities only.
11. **Thin HTTP** — authentication-only middleware (no permission
    vocabulary invented); whitelist parsers rebuilt bodies from
    scratch; authority-shaped body keys (actorUserId/clientId/
    status/timestamps/absolute quantities) structurally IGNORED
    (API t2 walk-proved); error map 400/401/403/404/409 matching
    service bounded statuses; OpenAPI parity exact (8 paths).

## Final-charge boundary (execution truth handoff)

- THE ONLY artifact CR-HM-09 emits is execution truth: approved
  quantities, issued/purchased acquisition facts, final used
  after returns (`finalUsedQty`), bounded supplier reference
  snapshot.
- CR-HM-09 computes ZERO amounts, prices, charges, bills,
  payments, invoices: verified at the DB COLUMN level
  (information_schema), at the module SOURCE level, and at the
  API PAYLOAD level (forbidden-surface scans + response-shape
  sweeps in every t6).
- The word "charge" appears EXCLUSIVELY as the state name
  FINAL_CHARGE_READY meaning "basis handoff complete" — never as
  an amount, pricing, billing, or ledger column (governance §3).
- CR-HM-12 pricing consumes the FINAL_CHARGE_READY projection
  (`scopeId` + settled line rows + `totalFinalUsedQty`) as INPUT;
  CR-HM-13 ledger posts the final material charge from the same
  handoff and owns reversal/adjustment (CR-HM-09 history is
  NEVER rewritten post-settle — bounded 409 instead); CR-HM-18
  settlement reads the certified ledger.

## FM coupling — NO

Domain-table firewall sweeps re-verified at certification:
embedded-postgres information_schema scan finds ZERO columns on
either material-execution table matching any FM token
(stock/reservation/purchase_order/material_request/goods_receipt/
work_order/...); module sources import NO inventory/FM module;
tenant FK graph reaches only Handyman tables + generic realm
(users/clients/uom/quotation snapshots).

## Handoff

- **CR-HM-10 prerequisite**: getHandymanMaterialFinalChargeReadyProjection
  (PART 05) + the API GET
  `/handyman/execution-scopes/:executionScopeId/material-lines/final-charge-ready`
  (PART 06) — READ-ONLY, Lead-gated — is the certified execution-truth
  entry point CR-HM-10 may build on top of. No workflow or settlement
  command exists here.
- **CR-HM-12/13**: FINAL_CHARGE_READY projection → pricing/ledger
  (governance §3 Handoff — CR-HM-12 pricing next, never CR-HM-09).
