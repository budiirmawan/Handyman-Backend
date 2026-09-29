# CR-HM-12 — Pricing & Commercial Agreement — START GOVERNANCE

Date: 2026-09-29 (UTC)
Branch: `arena/01a0eda1-handyman-backend`
Base commit: `f2d2689` (`origin/main` = `f2d26895c4bc614a5a0267367dff416419646ee1`)

Governance ONLY. NO migration, NO runtime/API/OpenAPI/tests in this
PART. This document freezes ownership, pricing authority,
commercial-agreement/version rules, labor/material boundaries, the
BM-fee boundary, blockers, and the smallest legal PART split for
CR-HM-12. Does not invent runtime.

## §1 Position in the frozen roadmap

Roadmap row 12: **Pricing & Commercial Agreement**.

Scope vocabulary: *labor pricing modes; crew pricing modes; material
pricing basis; commercial agreement; BM fee rules/basis*.

Primary authority: **Handyman-Backend**.

Depends on (roadmap table): **—** (none).

Produces contract for: **CR-HM-06, CR-HM-14, CR-HM-17**.

Exit gate:
> Pricing-mode execution, commercial agreement versioning, and BM
> fee rule contracts published; reference price never final charge;
> no transaction calculation inside SaaS subscription logic.

Preserve (roadmap): catalogue/reference price is an input only,
never the final transaction charge; no transaction calculation
inside SaaS subscription logic.

Matrix anchors (CR-HM-00, frozen):

- Row 21 (Commercial Agreement / BM Fee): Handyman-Backend owns
  versioned commercial agreements and configurable fee basis, with
  the LABOR_ONLY default/reference model (NEW); clients do no rule
  evaluation; SaaS has no transaction calculation.
- Capability map "Handyman Pricing Execution" (NEW): pricing modes
  HOURLY, FIXED_SCOPE, INSPECTION_FIRST, VISIT_FEE, including crew
  pricing modes; catalog/reference prices are inputs only; pricing
  execution is NOT owned in `price-catalog-entries`.
- Capability map "Commercial Agreement & BM Fee Rules" (NEW):
  versioned agreements, configurable fee basis, LABOR_ONLY
  default/reference model; shared audit infra reuse allowed.

CR-HM-09 (Material Execution) and CR-HM-11 (BAST) are **READ-ONLY
prerequisites** (both certified). They are not reopened, not
mutated, and never become pricing/commercial authority.

## §2 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| `origin/main` | `f2d26895c4bc614a5a0267367dff416419646ee1` (exact match to assignment) |
| Session branch | `arena/01a0eda1-handyman-backend` |
| Branch based on that main | YES (`merge-base` = `f2d2689`; HEAD = `f2d2689`; worktree clean) |
| CR-HM-09 FINAL CERTIFICATION | READ-ONLY input: `FINAL_CHARGE_READY` projection = quantities only; `FINAL_CHARGE_AUTHORITY=FINANCIAL_DOMAIN(CR-HM-12/13)`; "CR-HM-12 pricing next, never CR-HM-09" |
| CR-HM-11 FINAL CERTIFICATION | READ-ONLY input: BAST `ACCEPTED` ≠ payment; CR-HM-11 closed CR-HM-12 untouched; no re-open |
| CR-HM-06 quotation authority | READ-ONLY: immutable version snapshots; F5 firewall already reserves pricing/commercial/BM-fee authority for this CR |
| CR-HM-08 session seam | READ-ONLY: PRESENCE/ACTUAL_WORK timelines published; BILLABLE_TIME explicitly deferred to CR-HM-12 |
| Existing commercial runtime | NONE — no `pricing_mode`/commercial-agreement/BM-fee column, table, or module exists in `src`; CR-HM-12 is greenfield |
| FM financial/commercial modules | FIREWALL (no reuse as authority) — see §3 |

## §3 FROZEN ownership

ONE authority: **CR-HM-12 / Handyman-Backend** owns pricing-mode
execution (labor + crew), the material pricing basis, the versioned
commercial agreement, and BM fee rules/basis for Handyman.

| Surface | Owner | This CR |
| --- | --- | --- |
| Labor pricing modes (HOURLY, FIXED_SCOPE, INSPECTION_FIRST, VISIT_FEE — capability map vocabulary) | CR-HM-12 | AUTHORITY |
| Crew pricing modes | CR-HM-12 | AUTHORITY |
| Material pricing basis | CR-HM-12 | AUTHORITY |
| Commercial agreement aggregate + versioning | CR-HM-12 | AUTHORITY |
| BM fee rules / fee basis (incl. LABOR_ONLY default/reference) | CR-HM-12 | AUTHORITY |
| Catalogue/reference price entries + governed lookup | `price-catalog-entries` (existing authority) | READ-ONLY INPUT (`price-catalog-lookup` resolver: building scope anchor + exact currency + as-of, fail-closed) |
| Quotation versions + LABOR/MATERIAL line snapshots + customer approval | CR-HM-06 | READ-ONLY — never repriced retroactively |
| Crew / Lead-PIC identity + assignment truth | CR-HM-04 | READ-ONLY INPUT to crew modes |
| Session presence/work timelines | CR-HM-08 | READ-ONLY INPUT (billable derivation is CR-HM-12's to define later, if at all) |
| Material execution FINAL_CHARGE_READY projection | CR-HM-09 | READ-ONLY INPUT (quantities only) |
| BAST / customer acceptance status | CR-HM-11 | READ-ONLY; `ACCEPTED` ≠ payable ≠ price |
| Charge-line posting, payment, ledger, reversal | CR-HM-13 | NOT this CR |
| Provider earning / BM fee entitlement derivation, settlement | CR-HM-14 | CONSUMER (rules only; no derivation here) |
| SaaS product/package/subscription pricing | Asentra-SaaS plane | FIREWALL |
| FM financial/commercial modules (`vendor_quotations`, `vendor_service_costs`, `tenant_invoices`, `tenant_charges`, `utility_tariffs`, `work_contracts`, `payment_receipts`, `invoice_payment_status`, `platform_pricebooks`, `platform_billing`, `platform_payments`, `platform_subscriptions`, `subscriptions`) | FM/SaaS legacy | FIREWALL — no reuse as Handyman commercial authority, no dual-write |

**FK discipline (frozen):** new FKs point to Handyman tables
(e.g. `handyman_quotation_versions`, `handyman_execution_scopes`)
and generic realm (`clients`, `users`, `uoms`, `currencies`) ONLY —
NEVER to FM `work_orders`, FM quotation/invoice/tariff tables, or
SaaS `platform_*` tables. `price-catalog-entries` facts may be
referenced as **inputs resolved at composition time**, never stored
as live re-pricing pointers (CR-HM-06 snapshot discipline extends
here). Shared audit infrastructure ≠ ownership of commercial truth.

## §4 Pricing authority (frozen rules)

1. **Reference price is never final charge.** `price-catalog-entries`
   / catalogue views are informational inputs only. The
   customer-approved immutable quotation snapshot (CR-HM-06) remains
   the only charge-visible fact a customer approved. CR-HM-12
   governs *how prices are computed/managed* (CR-HM-06 Q7
   precedent); it must not retroactively invalidate approved
   snapshots.
2. **Pricing-mode execution is owned here, nowhere else.** Mode
   vocabulary (HOURLY, FIXED_SCOPE, INSPECTION_FIRST, VISIT_FEE) +
   crew modes are frozen roadmap/capability-map vocabulary; names
   only in this start. No mode field exists on quotation headers,
   lines, or execution scopes today; adding governed mode/basis
   facts is a later PART decision — never mutation of an approved
   quotation version.
3. **BILLABLE_TIME belongs to this CR's envelope.** CR-HM-08
   publishes presence/work timelines and refuses billable; only a
   CR-HM-12 later PART may define a billable-time derivation basis
   (still producing no charge rows — posting is CR-HM-13).
4. **Governed commercial adjustments (tax/discount).** CR-HM-06 §B
   reserved them for CR-HM-12 ("NO authority exists at freeze ⇒
   NOT included"). If supplied later, they land as NEW governed
   facts bound to an agreement version / as-of basis — approved
   quotation snapshots are never edited in place.
5. **Fail-closed discipline is inherited.** Any as-of resolution
   (agreement version, fee basis, price basis) must resolve
   exactly or fail — mirroring `price-catalog-lookup` (building
   anchor + exact currency + as-of). No implicit "current
   agreement", no silent default pricing.

## §5 Commercial agreement & versioning rules (frozen — semantics only, no runtime)

- **Aggregate:** one commercial agreement per client (realm
  `clients`), versioned; each version immutable once effective.
- **Versioning:** supersession creates a NEW version; an effective
  version's commercial facts (pricing modes, material basis, fee
  rules) are NEVER mutated — same discipline as CR-HM-06 quotation
  versions; revisions never rewrite history.
- **Binding:** every consumer fact (pricing basis applied, fee rule
  evaluated) binds to the EXACT agreement version id + as-of
  timestamp; a consumer never resolves "latest" at read time.
- **Uniqueness:** at most one ACTIVE version per agreement per
  as-of instant, enforced fail-closed (bounded conflict, not
  first-wins).
- **Scope of agreement authority:** agreements configure HOW
  pricing/fee rules are computed; they never post charges, never
  mint payments, never touch SaaS subscription state, and never
  override an approved quotation for an already-approved scope.
- **BM fee basis:** configurable per agreement version; a
  LABOR_ONLY default/reference model is the frozen roadmap
  vocabulary (§1). Basis names/enums land in a later PART — not
  invented as runtime here.

## §6 Labor/material boundary (frozen)

The CR-HM-06 structural separation (`line_type IN ('LABOR',
'MATERIAL')`, migration 0392 CHECK) is preserved end-to-end:

```text
LABOR basis     = approved LABOR lines (+ governed crew/timeline
                  inputs from CR-HM-04 / CR-HM-08)
MATERIAL basis  = approved MATERIAL lines + CR-HM-09
                  FINAL_CHARGE_READY settled quantities
                  (finalUsedQty / totalFinalUsedQty)
```

- CR-HM-12 consumes the CR-HM-09 projection **as input only**
  (cert §Handoff); it must not write material-execution tables,
  reopen a settled line, or reinterpret acquisition history.
- The two bases never merge into one undifferentiated figure in
  any published contract; any downstream combined total is
  CR-HM-13 ledger composition, not CR-HM-12 pricing output.
- Material basis is quantity-bounded by the approved snapshot
  (usage ≤ approved quantities — CR-HM-09 law); pricing must not
  invent material quantities, supplier facts, or a PO/GR chain.
- Labor basis never fabricates presence/work time (CR-HM-08
  append-only truth) and never infers billable time from
  CHECK_IN alone.

## §7 BM-fee boundary (frozen)

| In CR-HM-12 (AUTHORITY) | Out of CR-HM-12 |
| --- | --- |
| Fee rule definition + versioning (basis, mode, LABOR_ONLY default/reference) | Fee amount DERIVATION per transaction = CR-HM-14 |
| Binding rules to exact agreement versions | Posting/collecting any fee = CR-HM-13/14 |
| Publishing the rule contract CR-HM-14 consumes | Settlement/reconciliation = CR-HM-14 |
| Reference to governed inputs (quotation snapshots, price catalog as-of) | Any read of SaaS subscription/invoice/billing state as a fee base = FORBIDDEN |

The BM fee is a **Handyman commercial fact** derived from Handyman
transaction/commercial inputs. It is never a percentage of, or a
side effect of, SaaS package price, subscription tier, or platform
billing. CR-HM-14's blocker (matrix row 21→22: "versioned
commercial agreements and configurable fee basis must exist before
BM fee entitlement calculation") is satisfied by published rule
contracts only — CR-HM-12 must not compute entitlements "while
here".

## §8 Minimum mapped pricing/commercial seams

No broad audit. Only seams required to freeze this CR:

1. **CR-HM-06 quotation seam** — `src/modules/handyman-quotations`
   (migrations 0391–0395): immutable versions, LABOR/MATERIAL
   separation, `reference_unit_amount` informational vs
   `final_quoted_unit_amount` snapshot; F5 firewall comment
   ("NO CR-HM-12 pricing modes/rules") marks the exact hand-off
   point. CR-HM-12 reads snapshots; never reprices them.
2. **Price-catalog seam** — `src/modules/price-catalog-entries`
   `price-catalog-lookup` resolver: reference input, fail-closed,
   as-of; capability map forbids moving pricing execution into
   this authority.
3. **CR-HM-09 material seam** —
   `getHandymanMaterialFinalChargeReadyProjection` (+ certified
   API read surface): scope + settled lines + `totalFinalUsedQty`;
   quantities only; read-only for CR-HM-12.
4. **CR-HM-08 timeline seam** — session presence/work event
   projections; BILLABLE_TIME is published as "not computed here
   (CR-HM-12 concern)" — the derivation seat, if a later PART
   takes it, is CR-HM-12's.
5. **CR-HM-04 crew seam** — crew/Lead-PIC binding is the identity
   input for crew pricing modes; CR-HM-12 never owns crew lifecycle.
6. **CR-HM-11 BAST seam** — acceptance state is pricing-irrelevant
   context; CR-HM-12 must not gate or infer price from `ACCEPTED`
   (payment is CR-HM-13's to decide against its own CR).
7. **CR-HM-13/14 outbound seams (published contracts only)** —
   CR-HM-13 composes final charges from quotation snapshots +
   CR-HM-09 handoff (CR-HM-12 basis facts may inform charge
   preparation per its own CR); CR-HM-14 derives provider/BM fee
   entitlements from governed transactions + CR-HM-12 agreement/
   fee versions. Neither is implemented here.
8. **SaaS firewall seam** — `platform_subscriptions` /
   `platform_pricebooks` / `platform_billing` exist in this repo's
   FM/SaaS-adjacent space; CR-HM-12 reads nothing from and writes
   nothing to them for transaction pricing.
9. **CR-HM-17 presentation seam** — clients render/submit against
   published contracts only; zero pricing/commercial rule
   evaluation client-side (matrix row 21).

## §9 BLOCKERS

| ID | Blocker | Rule |
| --- | --- | --- |
| B1 | Catalogue/reference price treated as final charge | STOP; `price-catalog-entries` output is input-only |
| B2 | Pricing/ledger/charge-line/payment/settlement runtime in this CR | STOP (CR-HM-13 / CR-HM-14) |
| B3 | Transaction calculation inside SaaS subscription logic; SaaS package price used as Handyman price | STOP (roadmap preserve; matrix rows 21–22) |
| B4 | Mutation/repricing of an approved CR-HM-06 quotation version | STOP; new governed facts only, new versions only |
| B5 | CR-HM-09 material execution or CR-HM-11 BAST reopened/modified for pricing | STOP; READ-ONLY inputs |
| B6 | BM fee derived from SaaS billing/subscription state, or fee rules not bound to an exact agreement version | STOP (§7) |
| B7 | Implicit "current agreement" / non-fail-closed as-of resolution | STOP; fail-closed only (§4.5, §5) |
| B8 | FK/dual-write into FM financial modules (`vendor_quotations`, `tenant_invoices`, `utility_tariffs`, `work_contracts`, …) as Handyman commercial authority | STOP (§3) |
| B9 | Runtime/migration/API/OpenAPI/tests in this governance PART | STOP |
| B10 | Labor/material bases merged into one undifferentiated published amount | STOP (§6) |

Non-blockers (explicitly deferred): tax/discount rule runtime,
billable-time derivation implementation, FX beyond the existing
governed currency list, FM legacy price cleanup, SaaS billing
features, client UI (CR-HM-17/18), entitlement/settlement engine
(CR-HM-14).

## §10 Smallest PART split

| PART | Name | Allowed | Forbidden |
| --- | --- | --- | --- |
| **00** | START GOVERNANCE (this document) | Freeze ownership/pricing authority/agreement rules/boundaries/blockers/split | Runtime, migration, API |
| **01** | Commercial agreement aggregate + versioning | Agreement rows, immutable versions, fail-closed as-of resolution, lifecycle guards | Pricing math, fee amounts, ledger |
| **02** | Labor & crew pricing-mode execution contract | Mode vocabulary (HOURLY / FIXED_SCOPE / INSPECTION_FIRST / VISIT_FEE, plus crew modes) as basis definitions bound to agreement versions; optional billable-time basis definition | Charge posting, session/crew mutation, quotation reprice |
| **03** | Material pricing basis contract | Basis definitions over CR-HM-09 FINAL_CHARGE_READY + approved MATERIAL snapshots (quantities → basis facts only) | Reopening material history, PO/GR chain, ledger posting |
| **04** | BM fee rules/basis contract | Fee rule rows bound to agreement versions; LABOR_ONLY default/reference vocabulary frozen | Entitlement derivation, settlement, SaaS reads |
| **05** | Published read contract + firewall verification | Contracts for CR-HM-06/14/17 consumption; reference≠final and no-SaaS-computation checks | New authority, second write path, HTTP where unneeded |

Do not start PART 01 until this START is committed on the assigned
branch. PART 02/03/04 may not land before the PART 01 version
anchor exists (all basis/rule facts bind to exact agreement
versions). Do not treat PART 05 as a second write path. Migration
number allocation (≥ 0406) is a decision for the first
persistence-bearing PART, not here.

## §11 Out of scope

- No OpenAPI, no HTTP, no SQL, no tests in this PART.
- No customer transaction ledger, no payment/refund/reversal
  (CR-HM-13).
- No provider/BM entitlement derivation, no settlement/
  reconciliation (CR-HM-14).
- No warranty, no BAST changes, no material-execution changes,
  no quotation-snapshot edits.
- No SaaS subscription/billing/pricebook runtime of any kind.

## Handoff

- **CR-HM-06** — future governed adjustments/commercial snapshots
  may reference CR-HM-12 outputs; approved versions stay
  immutable; F5 firewall stands until PART 05 publishes.
- **CR-HM-14** — consumes versioned agreements + bound fee rules
  to derive provider/BM entitlements; may not read SaaS state as a
  fee/entitlement base (matrix rows 21→22 satisfied only by
  published contracts).
- **CR-HM-17** — presentation/orchestration only; consumes the
  published pricing/commercial read contracts; zero client-side
  rule evaluation.
- **CR-HM-13** — composes final charges from its own CR inputs;
  CR-HM-12 basis facts do not become ledger rows by implication.
- **CR-HM-09 / CR-HM-11** — remain READ-ONLY certified inputs;
  untouched by every CR-HM-12 PART.

STOP after this governance PART.
