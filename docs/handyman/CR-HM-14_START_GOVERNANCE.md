# CR-HM-14 — Financial Entitlement & Settlement — START GOVERNANCE

Date: 2026-09-29 (UTC)
Branch: `arena/01a0ef78-handyman-backend`
Base commit: `e2aac5759940fa008cd776c202f5b0bd126f1112`
(`origin/main` = `e2aac5759940fa008cd776c202f5b0bd126f1112`)

Governance ONLY. NO migration, NO runtime/API/OpenAPI, NO tests, NO
broad audit in this PART. This document freezes provider entitlement,
BM fee entitlement, settlement/reconciliation authority, reversal/
correction handling, the CR-HM-13 ledger handoff, invariants,
blockers, and the smallest legal PART split for CR-HM-14. It invents
no runtime, adds no SaaS billing coupling, and contains no
payment-gateway or payout-execution logic.

## §0 Roadmap row (read verbatim, `HANDYMAN_CR_CODING_ROADMAP_v1.0.md`)

Section entry — **CR-HM-14 — Financial Entitlement & Settlement**:

Scope: *Provider Entitlement; BM Fee Entitlement; settlement;
reconciliation.*
Primary authority: **Handyman-Backend**.
Depends on: **CR-HM-12, CR-HM-13**.
Preserve: *SaaS Product Entitlement != Provider/BM Financial
Entitlement; settlement is never inferred from SaaS billing or
subscription state.*

Roadmap table row 22 / exit gate:

> Entitlement derivation and settlement/reconciliation contracts
> published; derivation traces only to governed transaction/commercial
> inputs; SaaS entitlement firewall verified.

Produces contract for: **CR-HM-17, CR-HM-22**.

Matrix anchors (CR-HM-00, frozen):

- **Row 22 (Provider & BM Financial Entitlement)** — Handyman-Backend
  owns derivation of provider earning and BM fee earning from governed
  Handyman transaction and commercial rules (NEW); no client business
  authority; `SaaS Product Entitlement != Provider/BM Financial
  Entitlement`.
- **Row 23 (Settlement / Reconciliation)** — Handyman-Backend owns
  settlement states **EARNED, PAYABLE, INCLUDED_IN_SETTLEMENT,
  SETTLED** and **REVERSED / ADJUSTED / DISPUTED** exceptions (NEW);
  *"settlement must not be inferred from SaaS billing or subscription
  state"*.
- Dependency chain (matrix graph): row 20 (Customer Transaction /
  Payment) + row 21 (Commercial Agreement / BM Fee) → row 22 → row 23
  (terminal financial lifecycle).
- Capability map: **"Provider & BM Entitlement" (NEW)** — provider
  identity via `src/modules/vendors`; ledger + commercial agreements
  as governed inputs; *"This is financial entitlement, not SaaS
  product access or subscription entitlement."* **"Settlement &
  Reconciliation" (NEW)** — track the four states and the three
  exceptions over Handyman-owned inputs; audit/outbox as
  infrastructure only.
- Roadmap firewall list (carried forward): `SaaS Product Entitlement
  != Provider/BM Financial Entitlement`, `SaaS Billing != Handyman
  Customer Transaction Ledger`, `SaaS Package Price != Handyman
  quotation/final charge`.

## §1 Minimum relevant contracts read (no broad audit)

READ-ONLY inputs consumed to freeze this CR:

| Source | What it fixes for CR-HM-14 |
| --- | --- |
| `CR-HM-13_READ_CONTRACT.md` (PART 06, PUBLISHED) + `src/modules/handyman-customer-ledger-read/` | **The read-only authority input.** `readHandymanLedgerTransactionAt(executionScopeId, actorUserId)` (facts + gross/net totals + all three correction kinds) and `readHandymanLedgerClientBasisAt(clientId, actorUserId, {from,to,limit})` (windowed per-ledger net basis, default 200 / max 500). Mandatory consumption rules: gate on `authority.authoritativeForEntitlement` (fail-closed; `deniedBy` ∈ `NO_POSTED_CHARGE_FACTS` \| `PROVISIONAL_PAYMENTS_PENDING`); exclude `nonAuthoritativeTransactionIds`; **net, never gross-only**; LABOR/MATERIAL never merged; per-payment flags `CONFIRMED`-and-not-reversed only; exact money as decimal strings compared in integer cents; bounded authority-walled reads (404/403/400, no caller-supplied money/status/identity) |
| `CR-HM-13_START_GOVERNANCE.md` §5–§10, §12, §13 + `CR-HM-13_FINAL_CERTIFICATION.md` | Ledger invariants I1–I14 (append-only, one authoritative transaction per Execution Scope, allocation/paid derived not authored, forward-only corrections, zero SaaS/FM coupling); B2 *"Provider/BM entitlement derivation, settlement, reconciliation, payout vocabulary in this CR"* = STOP — i.e. this CR is the only seat for that space; §10 *"Entitlement / settlement … zero payout vocabulary (CR-HM-14)"*; §Handoff: CR-HM-14 consumes the PART 06 read family, must honour the gate, and *"holds zero permission to read SaaS state"*; PART 06 gate = `LEDGER_READ_CONTRACT_VERSION 'CR-HM-13-PART-06'` |
| `CR-HM-12_READ_CONTRACT.md` + `CR-HM-12_START_GOVERNANCE.md` §7 + `CR-HM-12_FINAL_CERTIFICATION.md` | `readHandymanBmFeeRuleConsumptionAt(clientId, asOf)` = *"THE published rule read CR-HM-14 consumes"*: fail-closed exact-version resolution, explicit `authoritativeForEntitlement` flag — **only a `DEFAULT` rule may feed entitlement derivation, a `REFERENCE` rule must never**. *"The fee VALUE is never present here (derivation is CR-HM-14's)"*; persist `binding` (clientId, agreementId, agreementVersionId, versionNumber, window) with any derived fact (B6); every CR-HM-12 figure is `CR_HM_12_BASIS_FACT` / `isFinalCharge: false` |
| `src/database/migrations/0409_create_handyman_bm_fee_rules.ts` + `src/modules/handyman-bm-fee-rules/` | The BM fee rule table `handyman_bm_fee_rule_definitions`: one rule per agreement version, basis frozen to `LABOR_ONLY`, role `DEFAULT`/`REFERENCE`, **"stores NO numeric rule facts at all: no percentage, no rate, no amount, no fee value"** — Information-Schema law proven by test (every column TEXT/UUID/TIMESTAMPTZ) |
| `CR-HM-04_EXECUTION_SCOPE_ASSIGNMENT_ACTIVATION.md` (§1–§2, tokens) + `CR-HM-04_PART04_ASSIGNMENT_BOUNDARY.md` + migration `0396` + `src/modules/handyman-scope-assignments/` | Provider attribution authority: `handyman_execution_scope_assignments` — `targetType = HANDYMAN_EXECUTION_SCOPE`, `SCOPE_STATE_REQUIRED = AUTHORIZED`, **`ACTIVE_ASSIGNMENT_PER_SCOPE = ONE`**, `REASSIGNMENT = ATOMIC_SUPERSEDE`, append-only supersession history with `supersedes_assignment_id`, **no Lead snapshot** (Lead resolves dynamically). `PROVIDER_CONTEXT_{ACTIVE}`, `CREW_{ACTIVE}`, same-Client chain. CR-HM-04 owns provider/crew identity; CR-HM-14 may only consume it |
| `src/modules/handyman-providers/` (CR-HM-04 PART 01–03) | Provider identity seat: `handyman_provider_contexts` (authoritative identity = the existing `vendors` master row), `handyman_worker_contexts`, `handyman_work_crews`, `handyman_crew_memberships`, Lead history. Status vocabulary `ACTIVE`/`INACTIVE` |
| `src/database/migrations/0401_create_handyman_work_sessions.ts` + `src/modules/handyman-work-sessions/` | Execution-time attribution evidence: sessions carry `assignmentId` + `leadWorkerId` + `leadUserId` snapshots (presence/work timelines; `BILLABLE_TIME_AUTHORITY = NO`). Used ONLY to detect conflicting provider attribution (fail-closed), never to invent a money split |
| `CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` rows 21/22/23/27–29 + `CR-HM-00_BACKEND_CAPABILITY_MAP.md` lines 40/42/43 | Ownership, gating and the SaaS firewall verbatim: entitlement is *backend-internal financial domain at freeze*; settlement states live in `Settlement / Reconciliation`; SaaS rows 27–29 are control-plane only and must never gate Handyman runtime; `SaaS Entitlement (29)` must not be treated as provider/BM financial entitlement |
| `CR-HM-06_DECISION_FREEZE.md` / roadmap firewall list | Immutable approved quotation versions + exactly ONE Execution Scope per approved version (the ledger transaction anchor CR-HM-14 inherits); `Quotation Approval != payment != settlement` |
| `CR-HM-09_FINAL_CERTIFICATION.md`, `CR-HM-11_START_GOVERNANCE.md`, `CR-HM-08_FINAL_CERTIFICATION.md` | Read-only context only: `FINAL_CHARGE_AUTHORITY = FINANCIAL_DOMAIN`; BAST `ACCEPTED` ≠ payable; CHECK_IN/COMPLETE never infer money |
| Repo precedent (targeted, not an audit) | Money = `NUMERIC(18,2)` + `VARCHAR(3)` currency from the frozen 9-currency list; integer-cents arithmetic in modules; append-only/immutability triggers; single-use `idempotency_key` with replay-returns-same-fact semantics; append-only error-code block in `src/shared/errors.ts` (last ledger codes: `HANDYMAN_CUSTOMER_LEDGER_CORRECTION_{NOT_FOUND,CONFLICT,INVALID}`); migration registration in `src/database/migrations/index.ts` (next free number ≥ **0415**); test harness = embedded PostgreSQL, serial, fresh database per suite |

## §2 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| `git fetch origin --prune` | clean; no divergence |
| PR **#5** (head `arena/01a0ee07-handyman-backend`, title *"CR-HM-13: Customer Transaction & Payment Ledger"*) | `state: MERGED`, `mergedAt: 2026-09-29T23:18:57Z`, mergeCommit `e2aac5759940fa008cd776c202f5b0bd126f1112` |
| `origin/main` | `e2aac5759940fa008cd776c202f5b0bd126f1112` |
| Session branch | `arena/01a0ef78-handyman-backend` |
| Branch based on latest `origin/main` | YES — `HEAD` = `e2aac575…112` = `merge-base(HEAD, origin/main)` = `origin/main`; ahead/behind `0/0`; worktree clean |
| **BASELINE_HEAD** | **`e2aac5759940fa008cd776c202f5b0bd126f1112`** |
| STALE / MISMATCH | **NONE** ⇒ PROCEED |
| CR-HM-14 artifacts already present | **NONE** (grep for `CR-HM-14` / `hm-14` finds only forward-reference comments inside CR-HM-12/13 modules and migrations) |
| Existing entitlement/settlement/payout runtime | **NONE** — zero handyman table, module, column, route, or error code for entitlement / settlement / reconciliation / earning / payout; `package.json` carries no gateway/provider SDK (deps: `pg`, `express`, `helmet`, `cors`, `multer`, `nodemailer`, `pdf-lib`, `exceljs`, `bcryptjs`). The only `PAYMENT_GATEWAY`-class vocabulary in the repository lives in the SaaS/legacy plane (`saas_payments`, `platform-payments`) — firewall-excluded (§11), never a pattern to copy |
| Handyman table inventory (CR-HM-04/06/08/09/10/11/12/13) | 61 `handyman_*` tables; the financial subset = the eight CR-HM-13 ledger tables + `handyman_bm_fee_rule_definitions`; nothing derives or settles money |
| Consumable published reads | `readHandymanLedgerTransactionAt`, `readHandymanLedgerClientBasisAt` (CR-HM-13 PART 06, `readOnly: true`); `readHandymanPricingContractAt`, `readHandymanLaborPricingEvaluationAt`, `readHandymanMaterialPricingCompositionAt`, `readHandymanBmFeeRuleConsumptionAt` (CR-HM-12 PART 05, zero DB import) |
| Provider attribution authority | `handyman_execution_scope_assignments` (0396, CR-HM-04 PART B/C CERTIFIED) — exactly ONE `ACTIVE` assignment per scope, supersession history retained |
| BM fee **numeric term** seat | **ABSENT** — see §13 **HARD-1** |
| BM fee **beneficiary identity** seat | **ABSENT** — see §13 **HARD-2** |
| Latest migration registered | `0414_handyman_ledger_corrections` (index registration ends at 0414) ⇒ next free ≥ **0415** |
| Assignability | PROCEED — no mismatch, no stale branch, no pre-existing CR-HM-14 artifact |

### Frozen tokens (machine-checkable)

| Token | Value |
| --- | --- |
| `ENTITLEMENT_AUTHORITY` | `CR_HM_14_HANDYMAN_BACKEND` |
| `ENTITLEMENT_BASIS` | `LEDGER_NET_CHARGED` (correction-netted, gated) |
| `FUNDING_BASIS` | `LEDGER_COLLECTED_NET` (`applied` / `netReceived`) |
| `BM_FEE_BASIS` | `LABOR_ONLY`, exact agreement version, mode `DEFAULT` only |
| `DERIVATION_GATE` | `ledger.authority.authoritativeForEntitlement === true` |
| `PROVIDER_ATTRIBUTION` | `ACTIVE_CR_HM_04_EXECUTION_SCOPE_ASSIGNMENT` (one per scope) |
| `SETTLEMENT_STATES` | `EARNED, PAYABLE, INCLUDED_IN_SETTLEMENT, SETTLED` |
| `SETTLEMENT_EXCEPTIONS` | `REVERSED, ADJUSTED, DISPUTED` |
| `PAYOUT_EXECUTION` | `OUT_OF_SCOPE` (no gateway, no rail, no bank/disbursement identity) |
| `SAAS_ENTITLEMENT_COUPLING` | `FORBIDDEN` |
| `EXTERNAL_RECONCILIATION_INGESTION` | `OUT_OF_SCOPE` (own governed change required) |
| `CR_HM_13_LEDGER_MODE` | `READ_ONLY_AUTHORITY_INPUT` |
| `NEXT_MIGRATION` | `>= 0415` |
| `CR_HM_14_ARTIFACTS_BEFORE_THIS_PART` | `NONE` |

## §3 FROZEN ownership

ONE authority: **CR-HM-14 / Handyman-Backend** owns the derivation of
provider earning and BM fee earning from governed Handyman transaction
and commercial inputs, and the settlement/reconciliation lifecycle over
those derived entitlements.

| Surface | Owner | This CR |
| --- | --- | --- |
| Provider entitlement (derived earning of the assigned provider) | CR-HM-14 | AUTHORITY |
| BM fee entitlement (derived fee earning under the client's exact agreement version) | CR-HM-14 | AUTHORITY |
| Settlement states + exceptions (EARNED / PAYABLE / INCLUDED_IN_SETTLEMENT / SETTLED + REVERSED / ADJUSTED / DISPUTED) | CR-HM-14 | AUTHORITY |
| Reconciliation of entitlements against governed ledger basis | CR-HM-14 | AUTHORITY |
| Customer transaction / charge line / payment / allocation / refund / reversal / adjustment facts | CR-HM-13 | **READ-ONLY AUTHORITY INPUT** — never written, never re-derived, never mirrored as a second ledger |
| Versioned commercial agreement + BM fee rule (basis/mode) | CR-HM-12 | READ-ONLY INPUT — `CR_HM_12_BASIS_FACT`, never a charge; `DEFAULT`-only for derivation |
| Provider / worker / crew identity, Lead history, execution-scope assignment | CR-HM-04 | READ-ONLY INPUT (attribution authority) |
| Execution Scope identity + approved quotation version | CR-HM-06 | READ-ONLY anchor (via the ledger read) |
| Work sessions / presence / work timelines | CR-HM-08 | READ-ONLY context (attribution conflict detection only; no billing) |
| Material execution settled quantities | CR-HM-09 | READ-ONLY (already composed into the ledger; not re-read for entitlement) |
| BAST / acceptance status | CR-HM-11 | READ-ONLY context; `ACCEPTED` ≠ entitlement ≠ payable |
| SaaS product/package/subscription/entitlement state, SaaS billing | Asentra-SaaS plane | **FIREWALL** — no read, no write, no FK, no inference, no naming collision |
| FM financial modules (`tenant_invoices`, `tenant_charges`, `invoice_payment_status`, `payment_receipts`, `vendor_invoices`, `vendor_service_costs`, `vendor_quotations`, `utility_tariffs`, `work_contracts`, `fx-rates`, `client-monetary-contexts`) | FM legacy | FIREWALL — pattern-only, never authority, never substrate, no dual-write |
| Gateway / acquirer / payout-rail runtime, bank or disbursement identity | — | OUT OF SCOPE — not this CR, not any CR-HM-14 PART (§7.6) |
| Shared infrastructure (`audit`, `integration-outbox`, `evidence`, generic realm `clients`, `users`, `uoms`, `currencies`) | shared | REUSE PERMITTED as infrastructure ONLY — never as financial authority |

**FK discipline (frozen):** new FKs point to CR-HM-14 tables
(entitlement, settlement, reconciliation, exception facts) and the
governed read-only anchors on the Handyman side — `handyman_customer_transactions`,
`handyman_execution_scopes`, `handyman_execution_scope_assignments`,
`handyman_provider_contexts`, `handyman_work_crews`,
`handyman_commercial_agreements` / `handyman_commercial_agreement_versions`,
`handyman_bm_fee_rule_definitions` — plus the generic realm (`clients`,
`users`). NEVERS: FM invoice/charge/receipt/cost tables, FM
`work_orders`, SaaS `platform_*` / `subscriptions` / `saas_*` /
`module_entitlements` / `feature_entitlement_configurations`, or any
gateway object. Amounts enter as **server-derived facts with immutable
anchor snapshots**, never as live pointers to a catalogue, gateway,
ledger row, or SaaS record.

**Read-only law for CR-HM-13 (frozen):** CR-HM-14 holds **zero** write
capability on the customer ledger — no posting, no allocation, no
refund, no reversal, no adjustment, no second transaction. The ledger
is consumed exclusively through the PART 06 read family, and every
consumed figure is a correction-netted fact at its own instant.

## §4 Provider Entitlement (frozen rules)

1. **What it is.** Provider entitlement is the derived financial claim
   of the provider that performed the work (provider context + crew,
   resolved from the governed assignment) over the *net committed
   basis* of the authoritative ledger transaction for that Execution
   Scope. It is an internal financial fact — **never a customer
   charge, never a ledger row, never a payment, never a SaaS
   entitlement**.
2. **Attribution unit.** One derivation unit = one CR-HM-13 ledger
   transaction (which is bound to exactly one Execution Scope, which
   carries exactly ONE `ACTIVE` CR-HM-04 assignment at derivation
   time). At most ONE provider entitlement per (transaction,
   basis kind, beneficiary) is derivable, fail-closed on a second.
3. **Attribution anchor is persisted, not re-resolved.** The
   derivation persists `assignmentId`, `handymanProviderContextId`,
   `handymanWorkCrewId` (+ the dynamically resolved Lead at the
   derivation instant, for audit only) as immutable anchors. A later
   reassignment never rewrites an existing entitlement; it changes
   only what a *future* derivation may claim.
4. **Attribution conflict ⇒ STOP, never a split.** If the scope's
   assignment history contains more than one provider context
   (supersession occurred) **or** the scope's work sessions do not all
   agree on one `assignmentId`/`leadWorkerId`, entitlement derivation
   fails closed with a bounded conflict (`MULTI_PROVIDER_ATTRIBUTION_UNRESOLVED`).
   No proration, no time-weighting, no invented share — a governed
   split basis does not exist today (§13 **COND-3**).
5. **No assignment ⇒ no entitlement.** A scope without an assignable
   provider (never assigned, or assignment not `ACTIVE`) yields a
   bounded fail-closed error, never a fabricated or "unassigned"
   entitlement.
6. **Basis = net charged, gated.** `providerEntitlementBase =
   transaction.chargedNet` — the correction-netted, gate-authorized
   figure (`laborNet + materialNet − adjustedTransactionScope`).
   Transaction-scoped adjustments are a transaction-level effect and
   flow through the transaction-level base; they are **never smeared
   onto a LABOR or MATERIAL line** (CR-HM-13 §7.3/I13 inherited).
7. **Funding = collected net.** An entitlement may only become
   `PAYABLE` / `INCLUDED_IN_SETTLEMENT` / `SETTLED` up to the funds
   actually collected and still held for that transaction
   (`applied` / `netReceived`, already net of reversed allocations,
   reversed payments and refunds). Uncollected outstanding never funds
   a payable claim (§9 E6).
8. **Composition law.** For one transaction: `Σ providerEntitlement +
   bmFeeEntitlement ≤ entitled base`, where the entitled base is
   `chargedNet` (BM fee additionally bounded by `laborNet`, §5.3).
   Entitlements partition a governed basis; they never create money.
9. **Derivation is reproducible.** A re-derivation with an unchanged
   input set returns the SAME fact (idempotent, `replayed`
   semantics); an input change produces a NEW forward fact, never an
   in-place restatement (§7).

## §5 BM Fee Entitlement (frozen rules)

1. **What it is.** BM fee entitlement is the derived fee earning
   configured by the **exact** commercial agreement version in force
   for the transaction's client — a Handyman commercial fact derived
   from Handyman transaction/commercial inputs only (CR-HM-12 §7).
2. **Version-exact, DEFAULT-only.** The rule is resolved through
   `readHandymanBmFeeRuleConsumptionAt(clientId, asOf)` with
   `asOf = the ledger transaction's posted instant`, and the
   derivation persists the returned `binding` (`clientId`,
   `agreementId`, `agreementVersionId`, `versionNumber`, window) plus
   `ruleRowId`, `basis`, `mode`. A `REFERENCE` rule
   (`authoritativeForEntitlement: false`) **must never** feed
   derivation; a missing rule, a non-exact resolution, or a
   fail-closed bounded error STOPS derivation. "Latest" is never
   resolved.
3. **LABOR_ONLY, never merged.** The frozen basis vocabulary is exactly
   `LABOR_ONLY` ⇒ the BM fee base is `transaction.laborNet` **only**.
   Material amounts, `materialNet`, and the merged `chargedNet` are
   never a BM fee base (CR-HM-13 I13 / CR-HM-12 B10 inherited). A
   transaction-scoped adjustment is never smeared into LABOR to make a
   fee base.
4. **Undecidable kind attribution ⇒ STOP.** If a correction's effect
   cannot be attributed to a LABOR charge line (e.g. a
   transaction-scoped or payment-scoped refund/reversal with no line
   anchor), the LABOR-funded BM fee basis is **not** prorated; the
   derivation fails closed for that unit (bounded conflict) until the
   effect is attributable from published facts.
5. **Never a customer charge, never SaaS-billed.** The BM fee is not
   posted to the customer ledger (CR-HM-13's charge-line vocabulary is
   closed to `LABOR`/`MATERIAL`; CR-HM-13 B13 stands), is not a
   separate customer invoice, and is never a percentage of or side
   effect of SaaS package price, subscription tier, or platform
   billing.
6. **Value authoring is BLOCKED pending two decisions.** No governed
   numeric fee term exists anywhere in the repository, and no governed
   BM beneficiary identity seat exists (§13 **HARD-1**, **HARD-2**).
   The *contract* (basis, mode, anchors, invariants, settlement
   hosting) is frozen here; a fee **VALUE** may not be authored by any
   PART until an explicit committed decision resolves both. CR-HM-14
   must never invent a rate, a default percentage, or a payee.

## §6 Settlement / reconciliation authority (frozen)

**State vocabulary is frozen by matrix row 23** (not invented here):
lifecycle `EARNED → PAYABLE → INCLUDED_IN_SETTLEMENT → SETTLED`;
exceptions `REVERSED`, `ADJUSTED`, `DISPUTED`.

| State / exception | Frozen semantics |
| --- | --- |
| `EARNED` | The derived entitlement fact exists for a gated, authoritative ledger basis. Earned ≠ collected ≠ payable. |
| `PAYABLE` | A bounded eligibility decision: the entitlement's *funded* portion is covered by collected net (`applied`/`netReceived`) and no open exception blocks it. Never authored by a caller, never inferred from `ACCEPTED`, CHECK_IN, or any SaaS state. |
| `INCLUDED_IN_SETTLEMENT` | An inclusion fact binds the entitlement (or its funded remainder) into **exactly one** settlement unit. At most once per entitlement, fail-closed. |
| `SETTLED` | Terminal: the settlement unit is closed and its included entitlements are settled for the funded amount. Terminal means no further transition of that unit; later facts are *new* exception facts, never edits. |
| `REVERSED` (exception) | The underlying ledger facts were reversed such that the entitlement no longer holds; recorded as a forward exception fact that zeroes the outstanding claim — the original entitlement row is never updated or deleted. |
| `ADJUSTED` (exception) | A corrected entitlement amount recorded as an explicit reasoned delta bound to its cause. Corrections never rewrite the entitlement they adjust. |
| `DISPUTED` (exception) | A bounded hold fact that blocks inclusion/settlement of the affected entitlement until an explicit clearing fact. Dispute **adjudication** workflow is out of scope (CR-HM-13 §12 non-blocker, unchanged). |

Frozen rules:

1. **Derived, never authored.** Every state is a projection over
   posted facts; no status column may contradict the fact set
   (CR-HM-13 I12 inherited). Direct authorship of a payable/settled
   flag is FORBIDDEN and fail-closed.
2. **Append-only transitions.** Every transition is an INSERT of a new
   fact (with actor, timestamp, cause, idempotency key); UPDATE/DELETE
   of posted state facts is trigger-blocked (CR-HM-13 I1 discipline
   extended to this domain).
3. **Funding law.** `PAYABLE + INCLUDED_IN_SETTLEMENT + SETTLED ≤
   funded basis` for the referenced entitlement's transaction; a
   settlement unit may never disburse against uncollected or refunded
   funds. Over-settlement is a bounded conflict, never a clamp.
4. **One currency per settlement unit.** A settlement unit groups only
   entitlements of exactly one currency equal to their transaction
   currency; no FX, no implicit rate, no cross-currency netting.
5. **Reconciliation is internal and exact.** Reconciliation asserts,
   per settlement unit and per window, that the sum of included
   entitlements equals the entitlement-backed, gated ledger basis of
   the referenced transactions at their anchor instants; variances
   become bounded exception facts with a machine-readable cause. Silent
   adjustment, rounding absorption, or "close enough" passes are
   FORBIDDEN.
6. **No payout execution, ever, in this CR.** Settlement records
   *state*; it does not move money. Zero gateway/payout-rail SDK, zero
   disbursement endpoint, zero bank/beneficiary-account identity, zero
   named-provider token, zero acquirer settlement-file format. Any
   future payout execution is a separate, explicitly governed change.
7. **External statements are out of scope.** Bank/acquirer/provider
   settlement-statement ingestion and matching are NOT part of this CR;
   they would require their own governed change (and would introduce
   provider coupling this CR forbids).
8. **SaaS is never consulted.** Settlement state is never inferred
   from — nor written back to — SaaS billing, subscription, pricebook,
   product, or entitlement state (matrix rows 22/23/27–29; roadmap
   preserve).
9. **Terminality and re-open.** A `SETTLED` unit is terminal. Any later
   financial reality (ledger correction, reversal, refund, dispute)
   lands as NEW exception facts on *new* units/facts — never as an
   edit of the settled history.

## §7 Reversal / correction handling (frozen)

1. **Mirror the ledger's forward-only law.** Posted entitlement and
   settlement facts are never updated or deleted; history is corrected
   by ADDING facts (CR-HM-13 §7.1/I1 extended to this domain).
2. **Correction follows cause.** A ledger `REFUND` / `REVERSAL` /
   `ADJUSTMENT` (or a reversed allocation/payment) never edits an
   entitlement; it produces a NEW entitlement correction fact bound to
   the exact ledger `correctionId` that caused it (traceability, §9
   E2/E14).
3. **Direction by kind, never by a negative literal.** Corrective facts
   carry non-negative amounts; direction is carried by the fact kind
   (reversal/adjustment kind), mirroring CR-HM-13 I6.
4. **Conservation under correction.** After every correction:
   `net entitlement ≤ chargedNet` and `funded/payable/settled ≤
   applied/netReceived`, both re-checked forward. A correction that
   would exceed an existing downstream state (e.g. reversing an
   entitlement already `INCLUDED_IN_SETTLEMENT`) is a **bounded
   conflict** requiring an explicit settlement-side exception fact —
   never a silent re-write of either side.
5. **At-most-once.** A given entitlement fact may be reversed at most
   once; a given ledger correction may drive at most one entitlement
   correction (per beneficiary/kind), enforced by uniqueness,
   fail-closed at the exact boundary.
6. **No cross-boundary corrections.** Entitlement corrections never
   migrate amounts across transactions, clients, providers, or
   currencies, and never write back into CR-HM-13, CR-HM-12, CR-HM-09,
   CR-HM-06, or CR-HM-11.
7. **Re-derivation is not a correction.** Running derivation again
   after inputs changed creates new facts; it never replaces, mutates,
   or hides the prior derivation (I1 + §4.9).

## §8 Ledger handoff (frozen — read-only authority input)

1. **Entry point.** CR-HM-14 consumes exactly
   `readHandymanLedgerTransactionAt(executionScopeId, actorUserId)`
   (per-derivation, exact transaction) and
   `readHandymanLedgerClientBasisAt(clientId, actorUserId, {from,to,limit})`
   (bounded reconciliation windows). No other path may read ledger
   tables; CR-HM-14 owns no ledger query of its own beyond these
   published reads, and never a second ledger module.
2. **Gate before anything (fail-closed).** For the exact transaction,
   `authority.authoritativeForEntitlement === true` is REQUIRED before
   any derivation; `deniedBy` (`NO_POSTED_CHARGE_FACTS`,
   `PROVISIONAL_PAYMENTS_PENDING`) STOPS derivation. At client level,
   ledgers listed in `nonAuthoritativeTransactionIds` are excluded from
   aggregates and must never be silently folded in or estimated.
3. **Net only.** Derivation uses the correction-netted figures
   (`chargedNet`, `laborNet`, `materialNet`, per-line `netAmount`,
   `applied`, `outstanding`, `receivedNet`, `netReceived`). Gross
   figures are read only to make reversals/refunds visible and to
   detect causes — never to fund an entitlement (CR-HM-13 §7.4).
4. **Separation preserved.** LABOR and MATERIAL charge lines and their
   per-kind figures stay separate in the derivation; the only merged
   figure CR-HM-14 may use is the ledger's own `chargedNet` for the
   transaction-level provider base (§4.6).
5. **Facts are truth.** Corrections are published as facts and already
   netted; CR-HM-14 never recomputes the ledger, never re-nets
   allocation/reversal/refund effects itself beyond using the published
   net figures, and never reconstructs a "true" ledger.
6. **Anchor snapshot.** Every derived fact persists the ledger anchors
   it consumed (`transactionId`, `executionScopeId`, `clientId`,
   `currency`, `contractVersion: 'CR-HM-13-PART-06'`) plus the consumed
   figure set, so the derivation is auditable and reproducible without
   re-reading history (§9 E2).
7. **Read-only guarantee.** CR-HM-13 stays byte-identical: no write of
   any kind, no migration touching ledger tables, no FK into ledger
   fact tables beyond the governed read anchors, no dependency
   inversion (the ledger never imports CR-HM-14).

## §9 Entitlement & settlement invariants (frozen, testable)

| # | Invariant |
| --- | --- |
| E1 | Append-only: no UPDATE/DELETE of any posted entitlement, settlement, or reconciliation fact; every change is an INSERT of a new fact |
| E2 | Traceability: every entitlement fact carries its governed anchors (ledger transaction + scope, assignment/provider/crew, agreement version + rule row for BM fee, currency, derivation instant, contract version) and its consumed basis figures |
| E3 | Gate law: no derivation without `authoritativeForEntitlement === true` for the exact transaction; `nonAuthoritativeTransactionIds` excluded; denials fail closed |
| E4 | Net, never gross: no entitlement is ever derived from gross figures |
| E5 | Earned bound: per transaction `entitlement ≤ chargedNet`; BM fee `≤ laborNet` |
| E6 | Funding bound: `PAYABLE + INCLUDED_IN_SETTLEMENT + SETTLED ≤ applied/netReceived` (collected, unrefunded, unreversed) for the referenced transaction |
| E7 | Composition: `Σ provider + BM fee entitlements ≤ entitled base`; entitlements never create a customer charge or exceed recorded ledger reality |
| E8 | Basis separation: BM fee is `LABOR_ONLY`, material never enters it, and no kind-scoped figure is ever smeared or prorated |
| E9 | Non-negative amounts; direction carried by fact kind, never by a negative literal |
| E10 | Money = `NUMERIC(18,2)` in SQL and integer cents in code; canonical decimal strings at every boundary; zero float arithmetic |
| E11 | Currency equality: entitlement currency = transaction currency; one currency per settlement unit; no FX, no implicit rate |
| E12 | One live entitlement per (transaction, entitlement kind, basis anchor, beneficiary); a second is a bounded conflict; unchanged-input re-derivation returns the SAME fact |
| E13 | Settlement uniqueness + terminality: an entitlement is `INCLUDED_IN_SETTLEMENT` at most once; `SETTLED` is terminal; exceptions are append-only facts |
| E14 | Reconciliation exactness: included entitlements sum exactly to the gated ledger basis they reference; variances are exception facts, never silent adjustments; every correction traces to its exact cause fact |
| E15 | Zero SaaS/FM coupling: no FK, read, write, dual-write, import, or inference against SaaS platform/billing/subscription/**entitlement** tables (`module_entitlements`, `feature_entitlement_configurations`, `module_configurations`, `platform_*`, `subscriptions`, `saas_*`) or FM financial tables |
| E16 | No payout execution surface: zero gateway/rail/disbursement runtime, vocabulary, endpoint, or bank-account identity anywhere in the CR |

## §10 Idempotency & concurrency law (frozen)

Inherited verbatim from the existing Handyman conventions (CR-HM-13 §9,
certified in CR-HM-06/09/12/13) and applied to this domain:

1. **Every mutation carries a single-use `idempotencyKey`** (bounded
   1–200 chars), with `UNIQUE` enforcement on the fact table
   (`UNIQUE (aggregate_id, event_type, idempotency_key)` for event-style
   rows; single-use `idempotency_key UNIQUE` for command-side facts).
2. **Replay returns the SAME facts** (idempotent), never a second
   financial effect; a conflicting replay (same key, different intent)
   is a bounded 409.
3. **One transactional unit:** fact + event + derived projection are
   written in ONE `withTransaction`, with the aggregate row locked
   (`SELECT … FOR UPDATE`) before evaluation.
4. **One authoritative transition per fact:** a second attempt to
   settle/reverse/adjust the same entitlement with a NEW key is a
   bounded conflict, not a second effect.
5. **Convergent intake:** any replay/retry path (audit-driven,
   scheduled, or admin-initiated) converges on the same facts; there is
   no channel that can mint a second entitlement for one basis.
6. **Authority before evaluation:** an authenticated local actor with
   client scope; caller-supplied amounts, states, beneficiaries, or
   identities are never authority (CR-HM-13 §9.6 inherited). Cross-client
   identity is a bounded 404, never a fabricated fact.

## §11 Firewalls (frozen)

| Firewall | Rule |
| --- | --- |
| **SaaS entitlement / billing** (roadmap preserve; matrix rows 22/23/27–29) | SaaS product/subscription/pricebook/billing/entitlement state is NEVER read, written, joined, inferred from, or written back to. `SaaS Product Entitlement != Provider/BM Financial Entitlement`; `settlement is never inferred from SaaS billing or subscription state` |
| **Naming collision** | CR-HM-14 vocabulary may not collide with SaaS vocabulary: no `module_entitlements`, `feature_entitlement_configurations`, `platform_entitlement*`, or `subscriptions` reference, import, table, column, or route may exist in the CR-HM-14 range; CR-HM-14 tables are `handyman_*`-prefixed and its modules `handyman-*`-named |
| **FM financial legacy** | `vendor_service_costs`, `vendor_invoices`, `vendor_invoice_payment_status`, `tenant_invoices`, `tenant_charges`, `invoice_payment_status`, `payment_receipts`, `vendor_quotations`, `utility_tariffs`, `work_contracts`, `fx-rates`, `client-monetary-contexts` — pattern-only, never authority, never substrate, no dual-write |
| **Customer ledger** | The CR-HM-13 ledger is READ-ONLY authority input: no write of any kind, no second ledger, no second write path, no re-derivation of ledger truth (CR-HM-13 B12 stands) |
| **Provider boundary** | No gateway/acquirer/payout runtime, SDK, named-provider enum/token, provider settlement-file format, disbursement endpoint, or bank/payee account identity — ever (roadmap §5.1-class boundary, inherited) |
| **Reference price** | Catalogue/reference prices inform pricing only; they are never an entitlement base and never a charge (CR-HM-12 §4.1) |
| **Presentation** | Clients (CR-HM-17/18) and integration status (CR-HM-22) consume published reads only; zero client-side entitlement/fee computation, zero client-asserted settlement state |

## §12 Minimum mapped seams (no broad audit)

1. **CR-HM-13 read seam** — `src/modules/handyman-customer-ledger-read/`
   (`readHandymanLedgerTransactionAt`, `readHandymanLedgerClientBasisAt`;
   `readOnly: true`, `contractVersion: 'CR-HM-13-PART-06'`), plus the
   `authority` gate objects (`authoritativeForEntitlement`, `deniedBy`,
   `nonAuthoritativeTransactionIds`) and the per-line/per-payment net
   flags. Read-only; never a write path.
2. **CR-HM-12 rule seam** — `readHandymanBmFeeRuleConsumptionAt` +
   `readHandymanPricingContractAt` from
   `src/modules/handyman-pricing-contract/` (zero DB import):
   version-exact `binding`, `rule.basis`, `rule.mode`,
   `rule.authoritativeForEntitlement`.
3. **CR-HM-04 attribution seam** — `handyman_execution_scope_assignments`
   via `src/modules/handyman-scope-assignments/` (`getHandymanExecutionScopeAssignment`,
   `resolveHandymanAssignmentLead`); provider/crew identity via
   `src/modules/handyman-providers/`. Read-only. Supersession history
   (the `supersedes_assignment_id` chain + retained `SUPERSEDED` rows)
   is used ONLY for the fail-closed conflict rule (§4.4); CR-HM-14
   performs that history read inside its own module and does not modify
   CR-HM-04.
4. **CR-HM-08 evidence seam** — `handyman_work_sessions`
   (`assignmentId`, `leadWorkerId`) as attribution *conflict* evidence
   only; `BILLABLE_TIME_AUTHORITY = NO` stands, and no money is
   inferred from presence/work.
5. **CR-HM-06/09 anchors (indirect)** — via the ledger read only
   (`executionScopeId`, `quotationVersionId`, per-line anchors); CR-HM-14
   opens no direct CR-HM-06/09 read.
6. **Infrastructure seam** — append-only error-code block in
   `src/shared/errors.ts`; migration registration in
   `src/database/migrations/index.ts` (next free ≥ 0415); audit /
   `integration-outbox` for infrastructure only, never financial
   authority.
7. **CR-HM-17 / CR-HM-22 outbound seam** — CR-HM-14 publishes a
   read-only, write-incapable contract (entitlement + settlement +
   reconciliation facts and states) for presentation and integration
   status; neither consumer may transition, adjust, or settle anything.
8. **SaaS firewall seam** — `module_entitlements`,
   `feature_entitlement_configurations`, `module_configurations`,
   `platform_*`, `subscriptions`, `saas_*` exist in this repository's
   adjacent space; the CR-HM-14 range reads nothing from and writes
   nothing to them, and its tests must scan for them (§11).

## §13 BLOCKERS

### HARD — must be resolved by an explicit committed decision before any PART authors the affected value

| ID | Blocker | Evidence | Rule |
| --- | --- | --- | --- |
| **HARD-1** | **No governed numeric BM fee term exists.** `handyman_bm_fee_rule_definitions` stores basis (`LABOR_ONLY`) + mode (`DEFAULT`/`REFERENCE`) only — migration 0409 states verbatim: *"stores NO numeric rule facts at all: no percentage, no rate, no amount, no fee value"*, and its test proves every column is TEXT/UUID/TIMESTAMPTZ. CR-HM-12 §7 assigns *fee rule definition + versioning* (incl. the rule's configuration) to CR-HM-12 and *fee amount derivation* to CR-HM-14 — but the configuration term itself does not exist anywhere. Matrix row 21→22 requires *"versioned commercial agreements and **configurable fee basis** must exist before BM fee entitlement calculation"* | Rule table + migration 0409 + CR-HM-12 §7/§9 B6; repo-wide scan finds no rate/percentage/amount column for any fee | **STOP** on authoring any BM fee **VALUE**. Resolution path (choose ONE and commit it as a decision record before the affected PART): **(A)** a governed CR-HM-12 follow-up PART adds the versioned numeric term seat to the fee-rule family (respects row 21→22 gating and CR-HM-12 §7 ownership; recommended), or **(B)** an explicit decision record assigns a versioned numeric term seat to CR-HM-14's own domain bound to the exact CR-HM-12 `agreementVersionId` (never mutating CR-HM-12 tables), with a written authority rationale. Silent invention of a rate, default percentage, or "fallback" value is FORBIDDEN |
| **HARD-2** | **No governed BM beneficiary identity seat exists.** The BM fee implies a payee; the repository declares no BM party identity. The only candidate seats are (a) the agreement's `clients` row (the tenant/customer organization the agreement binds to), (b) the CR-HM-01 channel attribution (`BM_SUPER_APP` + bounded free-text `originReference`, explicitly *not* an identity authority and carrying *"no BM financial entitlement"*), or (c) a future governed seat | `handyman_commercial_agreements.client_id` FK; `handyman_channel_attributions` doc/type comments; no BM/party table or column anywhere | **STOP** on attributing any BM fee fact to a payee. Resolution: an explicit committed decision naming the beneficiary seat (or deferring BM fee attribution to a later governed change). Deriving a BM fee amount whose payee is undefined is FORBIDDEN; the provider side is unaffected (provider beneficiary identity IS governed — provider context + crew from the assignment) |

Neither HARD-1 nor HARD-2 blocks this governance PART, the entitlement
fact foundation, provider entitlement derivation, settlement of provider
entitlements, or reconciliation; both block **every BM fee VALUE/PAYEE
surface**. PART 02 must therefore ship BM fee derivation as a
**fail-closed contract** (gate + anchors + invariants frozen, value
authoring structurally refused) until one path per blocker is committed.

### CONDITIONAL — real, with a deterministic fail-closed posture

| ID | Blocker | Rule |
| --- | --- | --- |
| **COND-3** | Multi-provider / mid-scope-reassignment attribution has no governed split basis. CR-HM-04 keeps exactly ONE `ACTIVE` assignment per scope with atomic supersession; work sessions may span more than one `assignmentId`/`leadWorkerId`, and no per-provider work-share or per-session billing attribution exists | **STOP** (bounded `MULTI_PROVIDER_ATTRIBUTION_UNRESOLVED`): derive only when the scope's assignment history resolves to exactly one provider context AND all sessions agree on one assignment. Never prorate, never time-weight, never invent a share. A governed split basis requires its own future change |
| **COND-4** | Unattributable correction effect: a payment/transaction-scoped refund or reversal with no LABOR line anchor | **STOP** for the affected LABOR-only (BM fee) funded basis — no proration, no estimation (§5.4) |

### STOP — authority violations (never acceptable in any PART)

| ID | Blocker | Rule |
| --- | --- | --- |
| B1 | SaaS billing/subscription/pricebook/product/entitlement state read, written, or used as an entitlement base, settlement input, or status | STOP (§11; roadmap preserve) |
| B2 | SaaS product entitlement treated as (or named as) provider/BM financial entitlement | STOP (matrix rows 22/29) |
| B3 | Any write into the CR-HM-13 ledger (posting, allocation, refund, reversal, adjustment, second transaction) or a second ledger/write path | STOP (§3, §8.7) |
| B4 | Derivation from gross figures, from a non-authoritative ledger, or from an un-gated client aggregate | STOP (§8.2/§8.3, E3/E4) |
| B5 | BM fee derived from a `REFERENCE` rule, a non-exact ("latest") version, or a non-LABOR basis | STOP (§5.2/§5.3, E8) |
| B6 | BM fee VALUE authored with HARD-1 or HARD-2 unresolved (invented rate/percentage/default/payee) | STOP (§5.6, §13) |
| B7 | Entitlement beyond the net committed basis, or payable/settled beyond collected unrefunded funds (over-settlement, silent clamp) | STOP (E5/E6) |
| B8 | Entitlement published as a customer charge, a new ledger charge-line kind, or a SaaS-billed amount | STOP (§4.1, §5.5) |
| B9 | Payment-gateway/provider-payout runtime, SDK, rail, disbursement endpoint, bank/payee account identity, or named-provider token | STOP (§6.6, E16) |
| B10 | History rewrite: UPDATE/DELETE of a posted entitlement/settlement/reconciliation fact, or re-derivation replacing a prior fact | STOP (§7.1, E1) |
| B11 | Non-idempotent mutation: missing single-use key, mutation outside one transaction/row lock, replay producing a second effect | STOP (§10) |
| B12 | Cross-currency entitlement, implicit FX, or float arithmetic on money | STOP (E10/E11) |
| B13 | FK/dual-write into FM financial or SaaS platform tables; shared infrastructure (audit/outbox/evidence) treated as financial authority | STOP (§3, E15) |
| B14 | Second write path: entitlement/settlement/reconciliation mutation reachable outside the CR-HM-14 modules, or a read contract that can write | STOP |
| B15 | Caller-supplied money, state, beneficiary, or identity accepted as authority | STOP (§10.6) |
| B16 | Runtime/migration/API/OpenAPI/tests/roadmap change in this governance PART | STOP |

Non-blockers (explicitly deferred, no authority implied): payout
execution and any provider/gateway adapter; external settlement
statement ingestion/matching; dispute adjudication workflow;
tax/discount rule runtime (CR-HM-12 §4.4 remains unclosed); FX
conversion; credit notes; provider performance derivation (CR-HM-16);
FM legacy financial cleanup; SaaS billing features; client UI
(CR-HM-17/18); the BM fee numeric term seat and its beneficiary
decision beyond §13 HARD-1/HARD-2 resolution paths.

## §14 Smallest legal PART split

| PART | Name | Allowed | Forbidden |
| --- | --- | --- | --- |
| **00** | START GOVERNANCE (this document) | Freeze authority, provider/BM fee entitlement, settlement/reconciliation states, correction law, ledger handoff, invariants, blockers, split | Runtime, migration, API/OpenAPI, tests |
| **01** | Entitlement fact foundation | Entitlement fact tables (provider + BM fee kinds) anchored to `transactionId`/`executionScopeId`, assignment + agreement-version/rule anchors, currency/amount CHECKs, closed kind/state vocabularies, append-only triggers, single-use idempotency, uniqueness per (transaction, kind, beneficiary, basis anchor) | Derivation policy, settlement states, reconciliation, gateway/payout vocabulary, ledger writes, HTTP |
| **02** | Entitlement derivation from governed inputs | Provider entitlement derivation end-to-end: gate enforcement, net-basis consumption, assignment attribution with the fail-closed conflict rule, transaction-level base, forward-only corrections bound to their ledger cause; **BM fee derivation contract** (exact version, `DEFAULT`-only, `LABOR_ONLY`, anchors, fail-closed when HARD-1/HARD-2 unresolved) | Invented rate/percentage/payee, `REFERENCE` rules, gross bases, proration, ledger writes, settlement states |
| **03** | Settlement lifecycle + reconciliation | Settlement units and transition facts for the four frozen states + three exceptions; funding-bounded inclusion/settlement; terminal `SETTLED`; reconciliation runs/variance/exception facts against gated ledger basis; one currency per unit | Payout execution/rails/banks, external statement ingestion, SaaS reads, ledger writes, dispute adjudication workflow |
| **04** | Published read contract + firewall verification | Read-only, write-incapable consumption family for CR-HM-17/CR-HM-22 (entitlement + settlement + reconciliation facts/states, net-funded figures, exception visibility); SaaS-entitlement/no-FM + invariant verification battery; byte-stability/no-mutation proof | New authority, any mutation verb, HTTP where unneeded |
| **05** | Thin HTTP/OpenAPI surface (conditional) | Bounded endpoints over PART 01–04 commands only, whitelist parsers, ignored authority-shaped body keys, OpenAPI parity | New business rules, payout/provider endpoints, entitlement-inference endpoints, any second write path |

Merge / order rules:

- **PART 02 may not land before PART 01** (anchors and vocabularies
  must exist); **PART 03 may not land before PART 02**; **PART 04 may
  not land before PART 03**. PART 01+02 MAY merge only if the gate law
  (E3), the funding law (E6) and the attribution conflict rule (§4.4)
  ship in the same commit as the fact tables and their suite proves
  them.
- **HARD-1 / HARD-2 gate rule.** No PART may author a BM fee VALUE or
  payee until one resolution path per blocker is committed as a
  decision record. PART 01 may declare the BM fee fact kind; PART 02
  must refuse BM fee value authoring structurally (bounded, fail-closed)
  while unresolved; PART 03 settles only derivable (provider-side)
  entitlements in that state.
- **PART 03 split allowance.** If reconciliation cannot be reviewed in
  one PART together with the settlement lifecycle, it splits into
  `03a settlement` + `03b reconciliation` — both remain bound by this
  governance; the split is a review-size decision, not an authority
  change.
- **PART 05 is optional**, triggered only if CR-HM-17/CR-HM-22
  consumption requires transport; it is never a second write path and
  never adds business rules.
- Migration number allocation (≥ **0415**) is a decision for the first
  persistence-bearing PART, not here.
- Do not start PART 01 until this START is committed on the assigned
  branch.

## §15 Out of scope

- No OpenAPI, no HTTP, no SQL, no tests in this PART.
- No migration and no runtime of any kind in this PART.
- No payment-gateway, acquirer, payout-rail, or disbursement runtime,
  and no bank/payee account identity — ever in CR-HM-14 (§6.6).
- No SaaS billing/subscription/pricebook/product/entitlement read or
  write of any kind.
- No FM financial module reuse, extension, or dual-write.
- No write of any kind into CR-HM-13 (or CR-HM-06/08/09/11/12).
- No external settlement-statement ingestion or matching.
- No dispute adjudication workflow.
- No changes to prior CRs' runtime, migrations, docs, or the roadmap.
- No broad audit — §12 seams only.

## Handoff

- **CR-HM-13** — the ledger stays the sole customer charge/payment
  authority and a **read-only authority input** here: nothing in
  CR-HM-14 may write, mirror, or re-derive it (B3 stands). The PART 06
  gate is mandatory on every derivation.
- **CR-HM-12** — rule facts are consumed version-exactly and
  `DEFAULT`-only; `REFERENCE ≠ final`; CR-HM-14 never re-reads
  catalogue/reference prices as a base. HARD-1 may require a governed
  CR-HM-12 follow-up (path A) before BM fee values exist.
- **CR-HM-04** — provider/crew identity and the single `ACTIVE`
  assignment are the only attribution authority; CR-HM-14 never assigns,
  reassigns, or mutates crews, and fails closed on ambiguous
  attribution (COND-3).
- **CR-HM-08 / CR-HM-09 / CR-HM-11 / CR-HM-06** — session, material,
  acceptance, and quotation facts remain read-only context; no money is
  inferred from `ACCEPTED`, CHECK_IN, or COMPLETE.
- **CR-HM-17 / CR-HM-22** — consume the PART 04 published read family
  verbatim (entitlement + settlement + reconciliation state, exceptions
  machine-visible); zero client-side computation and zero
  client-asserted settlement state.
- **Asentra-SaaS (CR-HM-19/20)** — `SaaS Product Entitlement !=
  Provider/BM Financial Entitlement`; settlement is never inferred from
  SaaS billing or subscription state; no Handyman runtime behavior is
  derived from SaaS entitlement state.

STOP after this governance PART.
