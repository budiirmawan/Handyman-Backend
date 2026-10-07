# CR-HM-13 — Customer Transaction & Payment Ledger — FINAL CERTIFICATION

Date: 2026-09-29 (UTC)
Branch: `arena/01a0ee07-handyman-backend`
Base commit: `0b39e12` (CR-HM-13 PART 06)

Governance reference: `CR-HM-13_START_GOVERNANCE.md` (FROZEN, commit
`7d13897`). Published contract: `CR-HM-13_READ_CONTRACT.md` (PART 06).
Roadmap exit gate: `HANDYMAN_CR_CODING_ROADMAP_v1.0.md` CR-HM-13 entry
/ table row 20.

Certification ONLY. No feature, refactor, migration, runtime, API, or
OpenAPI change in this PART — **no CR-HM-13 defect was found, so no
runtime change was required**. PART 00–06 were reviewed; PART 07 is
recorded below as a gate decision.

## Certification record

```text
CR_HM_13_STATUS=COMPLETE
CR_HM_13_PARTS_00_06=DELIVERED
CR_HM_13_BLOCKERS=0
CR_HM_13_IMPLEMENTATION_DEFECTS=0
ROADMAP_EXIT_GATE=VERIFIED
CONTRACTS_PUBLISHED=VERIFIED
IMMUTABLE_FINANCIAL_HISTORY=VERIFIED
LEDGER_INVARIANTS_I1_I14=VERIFIED
SAAS_BILLING_FIREWALL=VERIFIED
FM_FINANCIAL_COUPLING=ZERO
SECOND_WRITE_PATH=NO
HTTP_OPENAPI_SURFACE=NONE
PART_07_HTTP_OPENAPI=NOT_REQUIRED
EXIT_GATE_BLOCKED=NO
CR_HM_14_HANDOFF=UNBLOCKED
CR_HM_17_HANDOFF=UNBLOCKED
```

## Delivered parts (PART 00–06)

| Part | Commit | Deliverable |
| --- | --- | --- |
| Governance (00) | `7d13897` | start governance: transaction/charge/payment/allocation authority, provider-neutral boundary, idempotency law (§9), ledger invariants I1–I14 (§8), firewalls + blockers B1–B16 (§10/§12), handoff, PART 00–07 split (§13) |
| PART 01 | `bc7f92d` | transaction aggregate + charge-line foundation: migration 0410 (`handyman_customer_transactions`, `handyman_charge_lines`, `handyman_customer_transaction_events`) — one authoritative transaction per Execution Scope, OPEN_POSTED facts from CR-HM-06 approved snapshots, append-only triggers, frozen kind/currency vocabularies, single-use idempotency |
| PART 02 | `9a5c1a1` | governed charge composition: migration 0411 (`handyman_charge_line_bases`) — composition anchors (mandatory, deferred-enforced), LABOR = CR-HM-06 approved amount, MATERIAL bound by CR-HM-09 settled quantities / CR-HM-12 basis facts; never a reprice, never a merged amount |
| PART 03 | `efd4094` | provider-neutral payments: migration 0412 (`handyman_customer_payments`, `handyman_customer_payment_events`) — PENDING-only intake, bounded confirmation path, closed channel vocabulary, neutral free-text provider references, unique external reference per transaction, append-only evidence, one-way decision |
| PART 04 | `a2869dc` | allocation: migration 0413 (`handyman_payment_allocations`) — allocation facts with I3–I5 invariants (payment bound, charge-line bound, currency equality), PARTIAL allocation first-class, allocations only from CONFIRMED payments, derived unallocated/outstanding (nothing authored) |
| PART 05 | `be3b3f0` | refund / reversal / adjustment: migration 0414 (`handyman_ledger_corrections`) — forward-only correction facts, three kinds never collapsed, reversal-at-most-once (partial unique indexes), refund ≤ received-and-applied, bounded reasoned adjustments that never rewrite the line, net-visible reads |
| PART 06 | `0b39e12` | published read contract: `src/modules/handyman-customer-ledger-read/` + `docs/handyman/CR-HM-13_READ_CONTRACT.md` — read-only, structurally write-incapable consumption family for CR-HM-14/CR-HM-17 with gross AND net figures, machine-visible corrections, and the `authoritativeForEntitlement` gate; no-SaaS/no-FM + invariant verification battery |
| Certification | (this commit) | this document |

Persistence inventory: migrations **0410–0414** creating exactly eight
ledger tables — `handyman_customer_transactions`,
`handyman_customer_transaction_events`, `handyman_charge_lines`,
`handyman_charge_line_bases`, `handyman_customer_payments`,
`handyman_customer_payment_events`, `handyman_payment_allocations`,
`handyman_ledger_corrections`; five 5-file modules; six test suites;
two documents; migration registration + an appended error-code block.

## Focused certification suites — 36/36 PASS

Real migrated PostgreSQL (embedded 18.4), serial, **fresh database per
suite**; run 2026-09-29 at base `0b39e12`. Each suite's case 6 is a
firewall/source sweep.

| Suite | Part | Tests | Proves |
| --- | --- | --- | --- |
| `tests/handyman-customer-transaction.test.ts` | 01 | 6 | one transaction per scope; snapshots copied (caller amounts structurally impossible); LABOR/MATERIAL separate; UPDATE/DELETE blocked; replay-safe posting; no payment surface |
| `tests/handyman-charge-composition.test.ts` | 02 | 6 | LABOR = approved snapshot; CR-HM-12 basis fact anchors but never reprices; MATERIAL from settled quantities; fail-closed unsettled; mandatory anchors; no provider/entitlement surface |
| `tests/handyman-customer-payments.test.ts` | 03 | 6 | PENDING-only intake; neutral rails + bounded free text; single-decision confirmation; external-reference convergence; immutable money + append-only evidence; no gateway runtime |
| `tests/handyman-payment-allocation.test.ts` | 04 | 6 | partial allocation first-class; CONFIRMED-only allocatable; transaction/currency binding; exact charge-line boundary; LABOR/MATERIAL separate + nothing authored; no refund/settlement/gateway surface |
| `tests/handyman-ledger-corrections.test.ts` | 05 | 6 | refund ≤ received-and-applied; reversal exact + at-most-once; payment reversal requires full un-application; bounded reasoned adjustments; forward-only, never cross-transaction; no entitlement/settlement/gateway surface |
| `tests/handyman-ledger-read-contract.test.ts` | 06 | 6 | facts + gross/net + all correction kinds + gate; net independently recomputable over byte-stable gross; fail-closed gate (PENDING, empty ledger); windowed client basis with authority walls; structural write-incapacity + byte-identical ledger under the read battery; firewall + invariant battery |

No repo-wide test/typecheck/build/CI was run (out of discipline; none
was required for certification).

## Exit-gate verification (roadmap row 20)

> *Transaction/charge-line/payment/allocation/refund/reversal/adjustment
> contracts published with immutable financial history; SaaS Billing
> firewall verified.*

1. **Contracts published** — transaction + charge-line (PART 01/02),
   payment (PART 03), allocation (PART 04), refund/reversal/adjustment
   (PART 05) facts, and the PART 06 read family
   (`readHandymanLedgerTransactionAt`,
   `readHandymanLedgerClientBasisAt`) published in
   `docs/handyman/CR-HM-13_READ_CONTRACT.md` with `contractVersion:
   'CR-HM-13-PART-06'` and `readOnly: true`. Every command is
   idempotent (`replayed` semantics) and bounded.
2. **Immutable financial history** — append-only/immutability triggers
   are live on all eight ledger tables (verified from `pg_trigger`:
   `*_block_mutation` / `*_guard` / `*_guard_mutation`), and every
   suite proves UPDATE/DELETE refusal on the fact tables; the PART 06
   read battery leaves the whole ledger fingerprint byte-identical.
   History is corrected only by ADDING facts (PART 05).
3. **SaaS Billing firewall verified** — zero SaaS/FM identifier, table,
   column, or FK anywhere in the ledger range; the FK footprint closes
   on the ledger itself, the CR-HM-06/12 read-only anchors
   (quotation lines/versions, execution scopes, agreement versions,
   pricing basis definitions) and the generic realm (`clients`,
   `users`). No reverse coupling: outside the CR-HM-13 boundary no
   module references a ledger table. `SaaS Billing != Handyman
   Customer Transaction Ledger` holds as structure, not convention.

## Invariant register (I1–I14) — verification evidence

| # | Invariant | Evidence |
| --- | --- | --- |
| I1 | Append-only, no UPDATE/DELETE of posted facts | immutability triggers on all eight tables; suites 01 t4, 03 t5, 04 t5, 05 t5 + raw-SQL refusals; ledger fingerprint identical after PART 06 read battery |
| I2 | Immutable source snapshots (CR-HM-06/09/11 never written) | range touches exactly two pre-existing files, both additively (migration registration +15, error codes +34, zero deletions); no CR-HM-06/09/11 runtime file modified |
| I3 | Σ allocations per payment ≤ payment amount; `unallocated ≥ 0` | allocation guard trigger; suite 04 t2/t4; PART 06 invariant battery (ledger *and* raw SQL both fail closed) |
| I4 | Σ allocations per charge line ≤ line amount | same guard (charge-line branch); suite 04 t4; PART 06 battery |
| I5 | Reversal at most once; refund ≤ received-and-applied | partial unique indexes `…_reversal_payment_idx` / `…_reversal_alloc_idx`; corrections guard; suite 05 t1–t3; PART 06 battery |
| I6 | Non-negative amounts; direction carried by fact kind | `CHECK (amount > 0)` on payments/allocations/corrections, `>= 0` on charge lines/bases; correction reconciliation holds in the published net basis (`chargedNet = laborNet + materialNet − adjustedTransactionScope`) |
| I7 | Money = `NUMERIC(18,2)`; no float | every ledger money column is `numeric(18,2)` (`amount`, `unit_amount`; `applied_qty` is the quantity `numeric(14,3)`); **0** float columns; all module arithmetic is bigint cents |
| I8 | One currency per transaction; allocation equality | currency CHECKs on six ledger tables; composite FKs `(transaction_id, currency)`; allocation currency-equality guard (no FX, no implicit rate) |
| I9 | At most one authoritative transaction per Execution Scope | uniqueness + scope-consistency trigger; suite 01 t1; PART 06 battery (second OPEN ⇒ bounded 409) |
| I10 | Every financial mutation idempotent | `UNIQUE (transaction_id, idempotency_key)` on allocations and corrections, `UNIQUE (transaction_id, event_type, idempotency_key)` on payment events (+ transaction events); single-use external reference per transaction; replay returns the SAME fact in every suite |
| I11 | Every posted fact traceable to its governed basis anchors | `handyman_charge_line_bases` with mandatory-anchor + consistency triggers; FKs to quotation lines/versions, execution scopes, agreement/agreement-version and pricing basis rows |
| I12 | Derived states are projections; no authored status | ledger fact tables carry no status/balance/settled columns; unallocated/outstanding/net summaries are computed in the PART 04/05/06 reads |
| I13 | LABOR/MATERIAL separation preserved | closed line-kind vocabulary; allocation kind-equality guard; published shape keeps per-kind fields and publishes no merged money key (PART 06 t6) |
| I14 | Zero SaaS/FM coupling | FK footprint scan, column-name scan, and source token scans (PART 06 t6) plus range-level scans |

## Blocker register B1–B16 — all clear

| ID | Rule | Certification evidence |
| --- | --- | --- |
| B1 | SaaS billing/subscription/pricebook/entitlement as ledger base or status | ZERO — no SaaS table, column, FK, import, or vocabulary anywhere in the range |
| B2 | SaaS platform entitlement as provider/BM entitlement | ZERO — the ledger derives no entitlement at all (CR-HM-14's) |
| B3 | FM financial legacy as substrate | ZERO — no `tenant_invoices`/`vendor_*`/`utility_tariffs`/`work_contracts`/`fx-rates`/`client-monetary-contexts` reference or FK |
| B4 | Cross-CR write into CR-HM-06/09/11/12 runtime | ZERO — those modules are read-only anchors here; no file touched in the range |
| B5 | Source-module writes from corrections | ZERO — PART 05 writes only `handyman_ledger_corrections` |
| B6 | CR-HM-12 basis fact treated as a ledger row/charge | NO — basis facts only ANCHOR composition (PART 02 t2); they are never posted |
| B7 | LABOR/MATERIAL collapsed into one amount | NO — separate kinds end-to-end; published read has no merged total |
| B8 | Allocation invariants violated | NO — guarded in DB and asserted at the exact boundary (suites 04, 06 battery) |
| B9 | Cross-currency / implicit FX / float money | NO — currency equality guard + composite FKs; zero float money columns |
| B10 | Non-idempotent financial mutation | NO — single-use keys, one transactional unit with row lock, replay returns the same fact |
| B11 | FK/dual-write into FM financial or SaaS tables; infra as authority | NO — FK footprint closed; audit/outbox/evidence never used as financial authority |
| B12 | Second write path (outside the ledger module; writable read contract) | NO — commands live only in the five ledger modules; the PART 06 contract contains no mutation verb, no DDL, no transaction handle, and every statement is a `SELECT` (t5) |
| B13 | Charge without governed basis; ungoverned kind; caller-supplied authority | NO — anchors mandatory, kinds closed, all amounts/identity server-derived |
| B14 | Payment asserted settled from a gateway claim | NO — only the bounded server-side confirmation path decides |
| B15 | Runtime/migration/API/OpenAPI change in the governance PART | NO — `7d13897` is docs-only |
| B16 | Second authoritative transaction per Execution Scope | NO — I9 enforced and asserted |

## PART 07 gate decision (recorded)

**PART_07 = NOT_REQUIRED. EXIT_GATE_BLOCKED = NO.**

- The exit gate quoted verbatim in governance §0 contains no HTTP or
  OpenAPI term; both of its clauses are delivered by PART 06 (published
  contract + firewall/invariant verification).
- §13: *"PART 07 is optional and only if CR-HM-17/18 consumption
  requires it; it is never a second write path."* No CR-HM-14/17/18
  consumption spec exists in this repository, so the trigger cannot be
  demonstrated; CR-HM-14 (the gating consumer) is a backend CR that
  consumes the published module contract in-process.
- Precedent: CR-HM-12 — which likewise *produces contract for CR-HM-14,
  CR-HM-17* — published its read contract as a module with zero HTTP and
  was certified (row 06's "HTTP where unneeded" mirrors this).
- Evidence of absence: no CR-HM-13 `-api` module, no registration in
  `src/routes/index.ts`, and no CR-HM-13 path or schema in
  `docs/api/openapi.yaml` (only descriptive deferral strings inside
  CR-HM-09/CR-HM-10 operation descriptions).
- If CR-HM-17/18 later requires transport, PART 07 remains available as
  a thin wrapper over PART 01–06 commands with whitelist parsers and
  OpenAPI parity — never new business rules, provider endpoints, or
  entitlement/settlement reads.

No decision-record commit was required by governance for this gate; the
decision is recorded here at certification.

## Handoff state

- **CR-HM-14 — UNBLOCKED.** Consumes the PART 06 read family (facts +
  net basis) and MUST gate on `authority.authoritativeForEntitlement`,
  honouring `deniedBy`
  (`NO_POSTED_CHARGE_FACTS` | `PROVISIONAL_PAYMENTS_PENDING`) and
  `nonAuthoritativeTransactionIds`; corrections are machine-visible as
  facts and already netted into every net figure. CR-HM-13 derives no
  entitlement and no settlement, and CR-HM-14 holds zero permission to
  read SaaS state.
- **CR-HM-17 / CR-HM-18 — UNBLOCKED.** Present and orchestrate payment
  only; consume the published reads verbatim (zero client-side amount
  computation, zero client-asserted payment state).
- **CR-HM-06 —** approved versions and Execution Scopes stay immutable
  anchors; PART 02 never repriced them.
- **CR-HM-09 —** FINAL_CHARGE_READY remains a quantities-only input;
  this ledger is the certified venue for post-settle corrections.
- **CR-HM-12 —** basis facts consumed as inputs only; nothing was
  posted from them; `isFinalCharge: false` still holds.
- **CR-HM-11 / CR-HM-08 —** acceptance and session timelines stayed
  read-only context; no billing inferred from `ACCEPTED` or CHECK_IN.

## Non-regression posture

Range `dcda383..0b39e12`: **40 files, 12,466 insertions, 0 deletions**
— 38 new files (5 migrations, 24 module files across five 5-file
modules, 6 test suites, 2 documents, plus the new error codes) and 2
pre-existing files modified additively only (`src/database/migrations/
index.ts` +15, `src/shared/errors.ts` +34). No prior CR's runtime,
migration, API, or OpenAPI surface was modified anywhere in the range.

## Explicitly deferred (non-blockers, per frozen §12)

Gateway adapter implementation and its webhook/outbox plumbing, dunning
/reminder flows, tax/discount rule runtime (CR-HM-12 §4.4 stays
unclosed), FX conversion, credit-note documents, dispute/chargeback
workflows, provider payout/settlement (CR-HM-14), FM legacy financial
cleanup, SaaS billing features, client UI (CR-HM-17/18), and the
conditional PART 07 thin HTTP/OpenAPI surface.
