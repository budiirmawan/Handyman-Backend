# CR-HM-13 — Customer Transaction & Payment Ledger — START GOVERNANCE

Date: 2026-09-29 (UTC)
Branch: `arena/01a0ee07-handyman-backend`
Base commit: `dcda383` (`origin/main` = `dcda3839dfab516d31495eed91d98c0bb87ac6f1`)

Governance ONLY. NO migration, NO runtime/API/OpenAPI, NO tests, NO
broad audit in this PART. This document freezes transaction/charge/
payment/allocation authority, the provider-neutral payment boundary,
idempotency law, ledger invariants, the CR-HM-14 handoff, blockers,
and the smallest legal PART split for CR-HM-13. It invents no runtime
and defines no Midtrans/provider-specific surface.

## §0 Roadmap row (read verbatim, `HANDYMAN_CR_CODING_ROADMAP_v1.0.md`)

Section entry — **CR-HM-13 — Customer Transaction & Payment Ledger**:

Scope: *Customer Transaction; Charge Line; Payment; Allocation;
Refund; Reversal; Adjustment.*
Primary authority: **Handyman-Backend**.
Preserve: *SaaS Billing != Handyman Customer Transaction Ledger.*

Roadmap table row 20 / exit gate:

> Transaction/charge-line/payment/allocation/refund/reversal/
> adjustment contracts published with immutable financial history;
> SaaS Billing firewall verified.

Dependencies (roadmap): **CR-HM-06, CR-HM-08, CR-HM-09**.
Produces contract for: **CR-HM-14, CR-HM-17**.
Matrix anchor: **row 20 (Customer Transaction / Payment)** — owns
customer charge lines, payment allocation, refund, reversal,
adjustment, and immutable financial history (NEW); clients present/
orchestrate but every financial effect is executed and recorded by
the backend; *SaaS Billing != Handyman Customer Transaction Ledger*;
never reversed.

Capability map anchor: **"Handyman Customer Transaction Ledger"
(NEW)** — infrastructure reuse only: `work-orders`, `evidence`,
`integration-outbox`, `audit`; "existing engines do not become its
financial authority". Matrix row 9→20 (*Quotation Approval != Payment
Confirmation*), row 13→20 (billable inputs bind to session truth),
row 15→20 (material usage != authoritative final material charge).

## §1 Minimum relevant contracts read (no broad audit)

READ-ONLY inputs consumed to freeze this CR:

| Source | What it fixes for CR-HM-13 |
| --- | --- |
| `CR-HM-06_DECISION_FREEZE.md` + `CR-HM-06_PART06_DOWNSTREAM_BINDING_CONTRACT.md` | F2/F4 immutable versioned quotation with LABOR/MATERIAL line snapshots (`reference_unit_amount` informational vs `final_quoted_unit_amount`); F8/F9 exactly ONE authoritative Execution Scope per approved version; F11 *"Quotation approval != payment; != settlement (CR-HM-13)"*; §10 *"Execution Scope != Payment/Settlement (CR-HM-13)"* |
| `CR-HM-09_FINAL_CERTIFICATION.md` + `CR-HM-09_START_GOVERNANCE.md` | `FINAL_CHARGE_AUTHORITY=FINANCIAL_DOMAIN(CR-HM-12/13)`; FINAL_CHARGE_READY projection is **quantities only** (`scopeId`, settled lines, `totalFinalUsedQty`); post-settle corrections are *"CR-HM-13 reversal/adjustment authority, NOT history rewrite here"* (openapi.yaml SETTLE: *"corrections live downstream in CR-HM-13 reversal/adjustment, NEVER by history rewrite here"*) |
| `CR-HM-12_START_GOVERNANCE.md` §4/§6/§7/§9/§10 + `CR-HM-12_READ_CONTRACT.md` + `CR-HM-12_FINAL_CERTIFICATION.md` | Every CR-HM-12 figure is a **basis fact** (`factKind: 'CR_HM_12_BASIS_FACT'`, `isFinalCharge: false`); *"Charge/ledger/payment authority remains CR-HM-13's; posting is never a CR-HM-12 output"*; *"any combined total is CR-HM-13's own ledger composition"*; B10 labor/material never merged; fee VALUE derivation and settlement are CR-HM-14's; read family: `readHandymanPricingContractAt`, `readHandymanLaborPricingEvaluationAt` (charge preparation), `readHandymanMaterialPricingCompositionAt` |
| `CR-HM-08_FINAL_CERTIFICATION.md` | `BILLABLE_TIME_AUTHORITY=NO` — presence/work are published; billable is not computed there (CR-HM-12 rule field `billableTimeBasis` ∈ `{PRESENCE, ACTUAL_WORK}` is the only governed seat) |
| `CR-HM-11_START_GOVERNANCE.md` / roadmap row | BAST acceptance is CR-HM-11's; *"must not infer payment from ACCEPTED"* — `ACCEPTED` is contextual only |
| Repo precedent (targeted, not an audit) | Idempotency/immutability conventions: `UNIQUE (aggregate_id, event_type, idempotency_key)` (0401, 0406), single-use global `idempotency_key TEXT NOT NULL UNIQUE` (0394, 0407, 0408, 0409); append-only event triggers; money = `NUMERIC(18,2)` + `VARCHAR(3)` currency against the frozen 9-currency list; errors appended to `src/shared/errors.ts` code block |

## §2 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| `git fetch origin --prune` | clean; no divergence |
| PR #4 (CR-HM-12, head `arena/01a0eda1-handyman-backend`) | `state: MERGED`, mergeCommit `dcda3839dfab516d31495eed91d98c0bb87ac6f1` |
| `origin/main` | `dcda3839dfab516d31495eed91d98c0bb87ac6f1` |
| Session branch | `arena/01a0ee07-handyman-backend` |
| Branch based on latest `origin/main` | YES — `HEAD` = `dcda3839…6f1` = `merge-base(HEAD, origin/main)` = `origin/main`; worktree clean |
| **BASELINE_HEAD** | **`dcda3839dfab516d31495eed91d98c0bb87ac6f1`** |
| CR-HM-13 artifacts already present | NONE (docs or runtime) |
| Existing transaction/ledger runtime | NONE — zero handyman `*_transaction*` / `*_ledger*` / `*_charge_line*` / payment / refund / allocation table, module, or column; no payment-gateway SDK in `package.json`; CR-HM-13 is **greenfield** |
| Latest migration registered | `0409_create_handyman_bm_fee_rules` (index registration ends at 0409) |
| Assignability | PROCEED — no mismatch, no stale branch |

## §3 FROZEN ownership

ONE authority: **CR-HM-13 / Handyman-Backend** owns the Handyman
Customer Transaction Ledger — the customer-facing financial record of
what was charged, what was paid, how payments were allocated, and
every refund/reversal/adjustment — with immutable financial history.

| Surface | Owner | This CR |
| --- | --- | --- |
| Customer Transaction aggregate + immutable financial history | CR-HM-13 | AUTHORITY |
| Charge Line (composition of the final charge from governed bases) | CR-HM-13 | AUTHORITY |
| Payment (recording/confirmation of received funds) | CR-HM-13 | AUTHORITY |
| Allocation (payment ↔ charge line) | CR-HM-13 | AUTHORITY |
| Refund / Reversal / Adjustment (forward-only corrections) | CR-HM-13 | AUTHORITY |
| Approved quotation version + LABOR/MATERIAL line snapshots | CR-HM-06 | READ-ONLY — never repriced (B4 inherited) |
| Execution Scope identity (one per approved version) | CR-HM-06 | READ-ONLY anchor |
| Material execution FINAL_CHARGE_READY projection (quantities only) | CR-HM-09 | READ-ONLY INPUT |
| Pricing/commercial basis facts (modes, material basis, BM fee rule) | CR-HM-12 | READ-ONLY INPUT — basis facts, `isFinalCharge: false`, NEVER ledger rows |
| Session presence/work timelines (+ `billableTimeBasis` rule field) | CR-HM-08 / CR-HM-12 | READ-ONLY INPUT to charge preparation |
| BAST / customer acceptance status | CR-HM-11 | READ-ONLY context; `ACCEPTED` ≠ paid ≠ payable |
| Provider earning / BM fee entitlement derivation, settlement, reconciliation | CR-HM-14 | NOT this CR (consumer only) |
| SaaS billing/subscription/pricebook/payment records | Asentra-SaaS plane | FIREWALL — no read, no write, no inference |
| FM financial modules (`tenant_invoices`, `tenant_charges`, `invoice_payment_status`, `payment_receipts`, `vendor_invoices`, `vendor_service_costs`, `vendor_quotations`, `utility_tariffs`, `work_contracts`) | FM legacy | FIREWALL — no reuse as authority, no dual-write |
| Shared infrastructure (`audit`, `integration-outbox`, `evidence`, generic realm `clients`/`users`/`uoms`/`currencies`) | shared | REUSE PERMITTED as infrastructure ONLY — never as financial authority |

**FK discipline (frozen):** new FKs point to Handyman tables
(customer transaction, charge line, payment, allocation, correction,
quotation versions, execution scopes) and the generic realm
(`clients`, `users`, `uoms`, `currencies`) ONLY — NEVER to FM
invoice/charge/receipt tables, FM `work_orders`, or SaaS
`platform_*` / `subscriptions` / `entitlements` tables. Money enters
as **server-composed facts**, never as live pointers to a catalogue,
gateway, or SaaS record.

## §4 Transaction & charge authority (frozen rules)

1. **The ledger is the only charge authority.** No other module may
   post a customer charge. CR-HM-12 basis facts, CR-HM-09 quantities,
   and CR-HM-06 snapshots are inputs; the composed charge line is
   CR-HM-13's own fact (§Handoff CR-HM-12 PART 05 rule 3).
2. **One authoritative transaction per Execution Scope.** CR-HM-06
   F9 yields exactly one Execution Scope per approved quotation
   version; therefore at most ONE authoritative customer transaction
   per scope, fail-closed bounded conflict. A second transaction for
   the same scope is FORBIDDEN — corrections are forward-only facts
   on the existing transaction, never a parallel ledger. (Deviation
   requires a revised freeze before implementation.)
3. **No charge without a governed basis.** Every charge line must
   resolve to an approved quotation version anchor (+ the governed
   basis fact it composes from) — fail-closed. Free-form,
   caller-supplied, or manually typed charges are FORBIDDEN, and
   authority-shaped amounts/currencies/totals in any request body
   are structurally ignored (CR-HM-06/CR-HM-09 precedent: the server
   is the only amount authority).
4. **Charge-line kind vocabulary is closed.** Only kinds backed by a
   governed source snapshot exist; today that is exactly
   `LABOR`/`MATERIAL` (CR-HM-06 migration 0392 CHECK
   `line_type IN ('LABOR','MATERIAL')`). CR-HM-13 must NOT invent a
   third kind (e.g. fee/tax/misc/other) — a new kind requires an
   explicit governed authority in its own CR first.
5. **LABOR and MATERIAL stay separate end-to-end** (CR-HM-12 §6/B10
   inherited). A charge line is never an undifferentiated merged
   amount; any combined figure is a ledger composition over separate
   lines, published as such.
6. **Charges are facts, not statuses.** Charge lines are posted once
   (idempotent), immutable thereafter, and corrected only by
   §7 forward-only facts.
7. **Server-computed arithmetic only.** Amounts are computed
   server-side in SQL `NUMERIC`; no JavaScript float arithmetic ever
   touches money (existing repo money convention).

## §5 Payment authority & provider-neutral boundary (frozen)

**Payment authority.** The ledger is the sole authority for *received
funds* facts: amount, currency, received timestamp, neutral provider
reference, and confirmation state. Nothing else in the system — and
no client — may assert that a payment happened: *Quotation Approval
!= Payment Confirmation* (CR-HM-06 F11) and *BAST `ACCEPTED` ≠
payment* (CR-HM-11) stand as law here.

**Provider-neutral boundary (frozen):**

1. **No provider-specific runtime in this CR.** Zero gateway SDK
   dependency, zero provider-hosted checkout object persisted as a
   ledger fact, zero `midtrans`/`xendit`/`stripe`-style token in
   migration, source, enum, error code, or test. The frozen PART
   split below contains no provider adapter at all; any future
   adapter is a separate, explicitly governed change.
2. **Neutral reference vocabulary only.** A payment carries at most a
   neutral category + bounded free-text provider name and provider
   reference — the same neutral shape already used as *pattern* in the
   SaaS plane (`providerType` / `providerName` / `providerReference`)
   and already precedented in Handyman by CR-HM-09's bounded
   `supplierReference` snapshot (free text ≤ 200 chars, no external
   chain). Pattern reuse ≠ authority reuse: SaaS payment records are
   never read or written (B11).
3. **Notification ≠ authority.** A gateway callback/webhook/manual
   claim is an *inbound signal*, never a settled financial fact by
   itself. An authoritative payment fact exists only after a bounded,
   server-side, replay-safe confirmation path inside CR-HM-13
   (decision deferred to its own PART; the *requirement* is frozen
   here).
4. **No provider-ledger mirroring.** The ledger records the customer
   transaction, not a copy of a gateway's transaction object: no
   gateway status enum, no gateway fee/settlement vocabulary, no
   payout or disbursement state (that space belongs to CR-HM-14 and
   is out of scope).
5. **Idempotent intake.** Duplicate notifications, replays, or
   retries must converge on the SAME fact (no double-count), keyed
   per §9 — an external reference, where present, is unique-enforced
   per transaction, fail-closed.

## §6 Allocation authority (frozen)

Allocation binds received funds to charge lines. Frozen semantics:

1. **Allocation is a fact**, append-only, created by CR-HM-13 only.
2. **Payment-bounded:** Σ allocations of a payment ≤ its amount, at
   all times; `unallocated = amount − Σ allocated ≥ 0`. Over-allocation
   is a bounded conflict, never a silent clamp.
3. **Charge-bounded:** Σ allocations against a charge line ≤ that
   line's amount (net of its own forward-only corrections), same
   fail-closed rule; a line is never settled beyond its governed
   amount.
4. **Same currency, always.** Allocation currency must equal both
   sides exactly; the ledger performs NO FX conversion and accepts no
   implicit rate. Currency is one per transaction (inherited from
   CR-HM-06's one-currency-per-version rule) and lies in the frozen
   9-currency list (`IDR, USD, SGD, MYR, AUD, EUR, GBP, JPY, CNY`).
5. **Partial allocation is legal and first-class** — including
   multiple payments funding one line and one payment funding several
   lines; leftover unallocated amount stays visible (never hidden by
   a derived "paid" flag).
6. **Settlement state is derived, never authored.** Any per-line or
   per-transaction paid/outstanding view is a projection over posted
   facts; direct authorship of a "PAID" state that can disagree with
   the facts is FORBIDDEN (fail-closed).

## §7 Refund / Reversal / Adjustment law (frozen)

1. **Immutable financial history.** Posted facts are never updated or
   deleted (trigger-enforced, mirroring existing Handyman append-only
   discipline). History is corrected by ADDING facts.
2. **Three distinct correction kinds, never collapsed:**
   - **Reversal** — negates a specific prior fact (its source) and is
     bound to that source id; a fact may be reversed at most once,
     fail-closed.
   - **Refund** — returns funds to the customer; it consumes
     allocation/paid facts and can never exceed what was actually
     received and applied, fail-closed.
   - **Adjustment** — an explicit, reasoned delta against a
     transaction/line, bound to its authority source; it never
     rewrites the underlying line.
3. **Forward-only, dated facts.** Each correction carries its own
   timestamp/actor/reason and is append-only; a correction of a
   correction is a new correction, not an edit.
4. **Downstream consumers see net, never gross-only.** Any published
   read (CR-HM-14/CR-HM-17) must make reversed/refunded amounts
   machine-visible so entitlement derivation cannot run on gross
   figures (handoff §Handoff).
5. **No cross-transaction corrections.** A reversal/refund/adjustment
   is scoped to its own transaction; corrections never migrate
   amounts between transactions or clients.
6. **CR-HM-09/CR-HM-06/CR-HM-11 are never corrected from here.** The
   ledger does not write back into material execution, quotation
   versions, or BAST (B5); their histories stay untouched.

## §8 Ledger invariants (frozen, testable)

| # | Invariant |
| --- | --- |
| I1 | Append-only: no UPDATE/DELETE of any posted financial fact; every mutation is an INSERT of a new fact |
| I2 | Immutable source snapshots: approved quotation versions, CR-HM-09 settled quantities, and CR-HM-11 acceptance are never written by this CR |
| I3 | Σ allocations per payment ≤ payment amount; `unallocated ≥ 0` at all times |
| I4 | Σ allocations per charge line ≤ line amount (net of the line's own corrections) |
| I5 | Reversal targets an existing fact at most once; refund ≤ received-and-applied; both fail-closed at the exact boundary |
| I6 | Amounts are non-negative; direction is carried by fact kind (charge / payment / refund / reversal / adjustment), never by a negative literal |
| I7 | Money = `NUMERIC(18,2)` stored/compared in SQL; quantity = `NUMERIC`; currency = `VARCHAR(3)` from the frozen 9-currency list; no float arithmetic anywhere on money |
| I8 | Exactly one currency per transaction; allocation currency equality enforced |
| I9 | At most one authoritative transaction per Execution Scope (§4.2) |
| I10 | Every financial mutation is idempotent (§9) with one authoritative transition per fact |
| I11 | Every posted fact is traceable to its governed basis anchors (transaction, charge line, and — where applicable — quotation version / execution scope / agreement version / source fact id) |
| I12 | Derived states are projections over facts; no authored status that can contradict them |
| I13 | LABOR/MATERIAL separation preserved in the published shape (I5 of CR-HM-12 §6/B10 inherited) |
| I14 | Zero SaaS/FM coupling: no FK, read, write, dual-write, or inference against FM financial or SaaS platform tables |

## §9 Idempotency & concurrency law (frozen)

Inherited verbatim from the existing Handyman conventions (0394,
0401, 0406–0409, certified in CR-HM-06/09/12):

1. **Every financial mutation carries a single-use `idempotencyKey`**
   (bounded 1–200 chars). Event-style rows use
   `UNIQUE (aggregate_id, event_type, idempotency_key)`; command-side
   facts use the single-use `idempotency_key UNIQUE` form.
2. **Replay returns the SAME rows** (idempotent, `replayed: true`
   style), never a second financial effect; a conflicting replay
   (same key, different intent) is a bounded 409.
3. **One transactional unit:** fact + event + derived head update are
   written in ONE `withTransaction`, with the aggregate row locked
   (`SELECT … FOR UPDATE` / `lockById`-family) before evaluation.
4. **Single authoritative transition per fact:** a second attempt to
   reverse/refund/settle the same fact with a NEW key is a bounded
   conflict, not a second effect.
5. **Notifications/replays from any channel converge:** the same
   external reference cannot create two payment facts.
6. **Authority checked before evaluation:** authenticated local actor
   with client scope; caller-supplied customer/actor identity is
   never authority (CR-HM-06 F6 precedent); cross-client identity is
   a bounded 404, never a fabricated fact.

## §10 Firewalls (frozen)

| Firewall | Rule |
| --- | --- |
| **SaaS Billing** (roadmap preserve; matrix rows 20/21/27–30) | SaaS package/subscription/pricebook/billing/entitlement state is NEVER read or written as a Handyman charge, payment, allocation, or ledger state; `SaaS Billing != Handyman Customer Transaction Ledger`; `SaaS Product Entitlement != Provider/BM Financial Entitlement` |
| **FM financial legacy** | `tenant_invoices`, `tenant_charges`, `invoice_payment_status`, `payment_receipts`, `vendor_invoices`, `vendor_service_costs`, `vendor_quotations`, `utility_tariffs`, `work_contracts`, `basic-expenses`, `basic-financial-reporting`, `service-charge-readiness`, `fx-rates`, `client-monetary-contexts` — pattern-only, never authority, never substrate, no dual-write |
| **SaaS platform tables** | `platform_billing`, `platform_payments`, `platform_subscriptions`, `subscriptions`, `entitlements`, `feature-entitlement-configurations`, `platform_pricebooks` — zero read, zero write, zero FK |
| **Entitlement / settlement** | Zero derivation of provider earning or BM fee entitlement, zero settlement/reconciliation states, zero payout vocabulary (CR-HM-14) |
| **Reference price** | Catalogue/reference price is never a charge (CR-HM-12 §4.1 inherited); CR-HM-13 charges only from approved snapshots + governed basis facts |
| **Presentation** | Clients (CR-HM-17/18) present and orchestrate payment only; no client-side amount computation, no client-asserted payment state (matrix row 20) |

## §11 Minimum mapped seams (no broad audit)

1. **CR-HM-06 quotation seam** — `src/modules/handyman-quotations`
   (migrations 0391–0395): approved version + LABOR/MATERIAL
   snapshots; immutable (`handyman_quotation_line_block_mutation`).
   Read-only anchor for charge composition.
2. **CR-HM-06 Execution Scope seam** — one authoritative scope per
   approved version; the ledger's transaction anchor and uniqueness
   base (§4.2).
3. **CR-HM-09 handoff seam** —
   `getHandymanMaterialFinalChargeReadyProjection` (+ its certified
   API GET): `scopeId` + settled lines + `totalFinalUsedQty`,
   **quantities only**; read-only, and the certified venue for
   post-settle corrections is exactly this ledger.
4. **CR-HM-12 read seam** —
   `src/modules/handyman-pricing-contract/` (zero DB import today):
   `readHandymanPricingContractAt` (version bundle + binding),
   `readHandymanLaborPricingEvaluationAt` (charge preparation),
   `readHandymanMaterialPricingCompositionAt`. All outputs are
   `CR_HM_12_BASIS_FACT` / `isFinalCharge: false`; persisting them as
   ledger rows is B6.
5. **CR-HM-08 / billable seam** — presence/work timelines;
   `billableTimeBasis ∈ {PRESENCE, ACTUAL_WORK}` is a CR-HM-12 rule
   field, not a CR-HM-08 fact; the ledger consumes the evaluated
   basis, never re-derives time.
6. **CR-HM-11 BAST seam** — acceptance state is contextual only; no
   gating or inference of chargeability/payment from `ACCEPTED`.
7. **Infrastructure seam** — `src/shared/errors.ts` append-only code
   block; audit/`integration-outbox` for infrastructure only;
   migration registration in `src/database/migrations/index.ts`
   (next free number ≥ 0410).
8. **CR-HM-14/CR-HM-17 outbound seam** — CR-HM-13 publishes a
   read-only, structurally write-incapable contract (governed
   transaction facts + corrections visible); neither consumer may
   post, allocate, or correct anything.

## §12 BLOCKERS

| ID | Blocker | Rule |
| --- | --- | --- |
| B1 | SaaS billing/subscription/pricebook/entitlement state read, written, or used as a ledger base or status | STOP (§10; roadmap preserve) |
| B2 | Provider/BM entitlement derivation, settlement, reconciliation, payout vocabulary in this CR | STOP (CR-HM-14) |
| B3 | Provider-specific runtime or vocabulary (gateway SDK, named-provider enum/token, gateway-hosted object persisted as a ledger fact) | STOP (§5.1–§5.2; no Midtrans-specific runtime) |
| B4 | Mutating/deleting a posted financial fact, or rewriting history instead of adding a correction | STOP (§7.1, I1) |
| B5 | Repricing/mutating an approved CR-HM-06 version, or writing into CR-HM-09 material execution / CR-HM-11 BAST | STOP (§7.6, I2) |
| B6 | A CR-HM-12 basis fact (`isFinalCharge: false`) persisted, published, or treated as a ledger row/charge | STOP (§4.1, §11.4) |
| B7 | LABOR and MATERIAL collapsed into one undifferentiated charge amount in any published shape | STOP (§4.5, I13) |
| B8 | Allocation invariants violated (Σ > payment, `unallocated < 0`, over-allocated line, zero/negative/NaN amount, silent clamp) | STOP (§6, I3–I6) |
| B9 | Cross-currency allocation, implicit FX, currency outside the frozen list, or float arithmetic on money | STOP (§6.4, I7) |
| B10 | Non-idempotent financial mutation: missing single-use key, mutation outside one transaction/row lock, replay producing a second effect | STOP (§9) |
| B11 | FK/dual-write into FM financial or SaaS platform tables; or treating shared infrastructure (`audit`, `integration-outbox`, `evidence`) as financial authority | STOP (§3, I14) |
| B12 | Second write path: posting/allocation/correction reachable outside the ledger module, or a read contract that can write | STOP |
| B13 | A charge without a governed basis; a charge-line kind outside the closed vocabulary; caller-supplied amounts/identity accepted as authority | STOP (§4.3–§4.4, §9.6) |
| B14 | Payment asserted as settled solely from a gateway callback/claim, without the bounded server-side confirmation path (§5.3) | STOP |
| B15 | Runtime/migration/API/OpenAPI/tests/roadmap change in this governance PART | STOP |
| B16 | A second authoritative transaction for the same Execution Scope | STOP (§4.2, I9) |

Non-blockers (explicitly deferred, no authority implied): gateway
adapter implementation and its webhook/outbox plumbing detail, dunning
/reminder flows, tax/discount rule runtime (CR-HM-12 §4.4 remains
unclosed), FX conversion, credit-note documents, dispute/chargeback
workflows, provider payout/settlement (CR-HM-14), FM legacy financial
cleanup, SaaS billing features, client UI (CR-HM-17/18).

## §13 Smallest legal PART split

| PART | Name | Allowed | Forbidden |
| --- | --- | --- | --- |
| **00** | START GOVERNANCE (this document) | Freeze authority, payment boundary, idempotency, invariants, handoff, blockers, split | Runtime, migration, API/OpenAPI, tests |
| **01** | Customer transaction aggregate + charge-line foundation | Transaction + charge-line rows anchored to one Execution Scope / approved version; immutable posted facts; money/currency/quantity CHECKs; closed kind vocabulary; append-only events; single-use idempotency | Payment, allocation, corrections, provider references, HTTP |
| **02** | Charge composition from governed inputs | Compose charge lines from CR-HM-06 approved snapshot (+ CR-HM-09 FINAL_CHARGE_READY quantities, CR-HM-12 basis facts) with LABOR/MATERIAL separation; fail-closed basis resolution; basis-anchor traceability (I11) | Repricing, source mutation, payment, allocation, fee/entitlement math |
| **03** | Payment recording + provider-neutral boundary | Payment facts with neutral provider reference + bounded confirmation path; unique external reference per transaction; replay-safe intake | Gateway adapter/SDK, provider enums, gateway-object mirroring, allocation, HTTP |
| **04** | Allocation | Allocation facts payment↔charge line with invariants I3–I5, partial allocation, derived paid/outstanding projections | Silent clamping, cross-currency/allocation beyond amount, settlement states (CR-HM-14) |
| **05** | Refund / Reversal / Adjustment | Forward-only correction facts bound to sources, reversal-at-most-once, refund ≤ received-and-applied, net-visible reads | History rewrite, cross-transaction correction, source-module writes |
| **06** | Published read contract + firewall verification | Read-only, write-incapable consumption family for CR-HM-14/CR-HM-17; net-vs-gross visibility for entitlement gating; no-SaaS/no-FM + invariant verification battery | New authority, any mutation verb, HTTP where unneeded |
| **07** | Thin HTTP/OpenAPI surface (conditional) | Bounded endpoints over PART 01–06 commands only, whitelist parsers, ignored authority-shaped body keys, OpenAPI parity | New business rules, provider-specific endpoints, entitlement/settlement reads |

Merge rule: PART 03+04 MAY merge only if every allocation invariant
(I3–I5) ships in the same commit as payment facts and its suite proves
them; otherwise the split stands. PART 04/05 may not land before PART
03; PART 02 may not land before PART 01's anchors exist. Migration
number allocation (≥ 0410) is a decision for the first
persistence-bearing PART, not here. PART 07 is optional and only if
CR-HM-17/18 consumption requires it; it is never a second write path.
Do not start PART 01 until this START is committed on the assigned
branch.

## §14 Out of scope

- No OpenAPI, no HTTP, no SQL, no tests in this PART.
- No migration and no runtime of any kind in this PART.
- No Midtrans (or any provider) specific runtime, SDK, endpoint, or
  vocabulary — ever in CR-HM-13's ledger core (§5.1).
- No provider/BM entitlement derivation, no settlement, no
  reconciliation, no payouts (CR-HM-14).
- No SaaS billing/subscription/pricebook runtime or reads.
- No FM financial module reuse, extension, or dual-write.
- No changes to CR-HM-06/08/09/11/12 runtime, migrations, or docs.
- No roadmap change.
- No broad audit — §11 seams only.

## Handoff

- **CR-HM-14** — consumes the PART 06 read family: governed
  transaction + charge-line + payment + allocation + correction facts
  with corrections machine-visible (net basis), gated by an explicit
  authority flag analogous to CR-HM-12's
  `authoritativeForEntitlement`; derives provider/BM entitlements
  ONLY from these facts plus versioned agreements/fee rules, and
  holds zero permission to read SaaS state (B1/B2 stand as law).
  CR-HM-13 derives no entitlement and no settlement itself.
- **CR-HM-17 / CR-HM-18** — presentation/orchestration of payment
  only; consumes published reads verbatim; zero client-side amount
  computation and zero client-asserted payment state.
- **CR-HM-06** — approved quotation versions and Execution Scope stay
  immutable; this ledger anchors to them read-only.
- **CR-HM-09** — FINAL_CHARGE_READY quantities stay read-only inputs;
  the certified venue for post-settle corrections is this ledger's
  reversal/adjustment authority.
- **CR-HM-12** — basis facts are consumed as inputs only; posting is
  never a CR-HM-12 output and never becomes a CR-HM-13 row by
  implication.
- **CR-HM-11 / CR-HM-08** — acceptance and session timelines remain
  read-only context; billing is never inferred from `ACCEPTED` or
  from CHECK_IN.

STOP after this governance PART.
