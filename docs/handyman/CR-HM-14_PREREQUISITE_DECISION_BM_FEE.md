# CR-HM-14 — PREREQUISITE DECISION — BM FEE TERM & FINANCIAL BENEFICIARY

Status: **FROZEN DECISION RECORD**. Governance ONLY — NO runtime, NO
migration, NO API/OpenAPI, NO tests, NO roadmap change in this PART.

Date: 2026-09-29 (UTC)
Branch: `arena/01a0ef78-handyman-backend`
Base commit: `a0acbd474decd5090ba1de20970b36894255fbbd`
(CR-HM-14 START GOVERNANCE, tree `26a489df…bed`)

Resolves: `CR-HM-14_START_GOVERNANCE.md` §13 **HARD-1** and **HARD-2**,
by selecting the path-**A** resolution recorded there (governed CR-HM-12
follow-up), and by freezing the numeric BM fee term authority and the
BM financial beneficiary identity as **read-only inputs CR-HM-14
consumes** — never as facts CR-HM-14 may invent.

## §0 Scope of this decision

| In this decision record | Out of this decision record |
| --- | --- |
| Resolution of HARD-1 and HARD-2 (§2, §3) | Any migration, table, column, service, read, HTTP, or OpenAPI change |
| Frozen read-only consumption law for CR-HM-14 (§4) | Any BM fee **value** computation (still gated, §5) |
| The smallest CR-HM-12 follow-up required before BM fee derivation (§5) | Starting CR-HM-14 PART 01, PART 02, or any PART |
| The exact edits this decision makes to CR-HM-14 START governance (§6) | Roadmap, matrix, capability-map, CR-HM-12, CR-HM-13 or any prior CR change |

## §0.1 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| Expected HEAD | `a0acbd4` |
| Actual `HEAD` | **`a0acbd474decd5090ba1de20970b36894255fbbd`** — MATCH |
| Tracked worktree | CLEAN (`git status --short` = empty; only the branch line) |
| Session branch | `arena/01a0ef78-handyman-backend` |
| Remote branch tip | `a0acbd474decd5090ba1de20970b36894255fbbd` (in sync) |
| `origin/main` | `e2aac5759940fa008cd776c202f5b0bd126f1112` (unchanged; PR #5 merge) |
| Mismatch / stale | **NONE ⇒ PROCEED** |

## §1 Authoritative basis (read verbatim, no reinterpretation)

- **Matrix row 21 (Commercial Agreement / BM Fee):** *"Own versioned
  commercial agreements and configurable fee basis, with the LABOR_ONLY
  default/reference model (NEW)."* Gating note (row 21→22): *"Versioned
  commercial agreements and configurable fee basis must exist before BM
  fee entitlement calculation; no transaction calculation inside SaaS
  subscription logic."*
- **Matrix row 22 (Provider & BM Financial Entitlement):**
  *"Own derivation of provider earning and BM fee earning from governed
  Handyman transaction and commercial rules (NEW)."* Firewall:
  *"SaaS Product Entitlement != Provider/BM Financial Entitlement."*
- **Capability map, "Commercial Agreement & BM Fee Rules" (NEW):**
  *"Maintain versioned commercial agreements and configurable fee basis;
  a default/reference model may use LABOR_ONLY … Handyman owns agreement
  versions and fee rules."*
- **CR-HM-12 `§7 BM-fee boundary`:** in-scope *"Fee rule definition +
  versioning (basis, mode, LABOR_ONLY default/reference)"* and *"Binding
  rules to exact agreement versions"*; out-of-scope *"Fee amount
  DERIVATION per transaction = CR-HM-14"*, *"Settlement/reconciliation
  = CR-HM-14"*, *"Any read of SaaS subscription/invoice/billing state as
  a fee base = FORBIDDEN"*; and the decisive sentence: *"The BM fee is a
  **Handyman commercial fact** derived from Handyman transaction/
  commercial inputs. It is never a percentage of, or a side effect of,
  SaaS package price, subscription tier, or platform billing."*
- **Migration 0409 (CR-HM-12 PART 04)** + its module: the rule row
  stores basis `LABOR_ONLY` + mode `DEFAULT`/`REFERENCE` only — *"stores
  NO numeric rule facts at all: no percentage, no rate, no amount, no
  fee value"* — authored DRAFT-window only, append-only, one rule per
  agreement version (`UNIQUE (agreement_version_id)`).
- **Migration 0407/0408 precedent (CR-HM-12 PART 02/03):** governed
  numeric rule facts are stored as `NUMERIC(18,2)` (+ frozen currency
  list where applicable), CHECK-bounded, DRAFT-window authored,
  append-only, one definition per agreement version.
- **CR-HM-01 (channel attribution):** `originReference` is *"bounded
  free text"*; the attribution explicitly carries *"no BM financial
  entitlement"*; `CR-HM-01_FINAL_VALIDATION.md` §123: *"attribution ≠ BM
  financial entitlement; attribution ≠ SaaS entitlement"*.
- **CR-HM-04:** provider/worker/crew identity and the single `ACTIVE`
  execution-scope assignment are the provider attribution authority;
  *"BM/customer can NEVER directly assign a worker or crew."*
- **CR-HM-14 START GOVERNANCE** §5 (BM fee entitlement rules), §13
  (HARD-1, HARD-2, path A/B), §14 (HARD gate rule), Handoff.

## §2 DECISION-1 — HARD-1 resolution: numeric BM fee term authority

**DECIDED (path A, as recommended in START §13):** the numeric BM fee
term is **a CR-HM-12 commercial agreement authority** — a rule fact
bound to the EXACT agreement version. CR-HM-14 never owns, stores,
defaults, or infers it.

Frozen law:

1. **Authority.** A BM fee term is authored and owned by the CR-HM-12
   commercial-agreement boundary, on the `handyman_bm_fee_rule_definitions`
   family, keyed to one `agreement_version_id` (one term per version,
   `UNIQUE`, fail-closed). It is a **rule fact**
   (`factKind: 'CR_HM_12_BASIS_FACT'`, `isFinalCharge: false`) — never a
   charge, never a ledger row, never an entitlement row.
2. **Term kind vocabulary (closed at freeze).** Exactly
   **`PERCENTAGE_OF_BASIS`** — a rate applied to the governed
   `LABOR_ONLY` basis. This is the reading compelled by CR-HM-12 §7
   (*"never a percentage of … SaaS package price"* implies a percentage
   of a Handyman commercial base). Any additional term kind (e.g. a flat
   amount per transaction, a tiered/share schedule, a min/max band)
   requires an explicit governed change to CR-HM-12 first — CR-HM-14
   must NEVER invent one, and flat/banded/min-max semantics are
   FORBIDDEN until such a change.
3. **Value law.** The rate is an exact bounded decimal, `> 0` and
   `≤ 100`, stored as `NUMERIC` (at least 4 decimal places of
   precision), with zero float arithmetic anywhere; comparison and
   derivation run in integer basis points
   (`feeCents = round(laborNetCents × rateBasisPoints / 10 000)`).
   Rounding is half-up at one place only (the fee fact), never
   re-rounded, never negative, never "absorbed" into a customer charge.
   Exact column name/precision are the follow-up PART's decision; the
   semantics above are frozen.
4. **Binding, not resolution.** The term binds to the EXACT
   `agreementVersionId` resolved for the ledger transaction's posted
   instant; the resolved `binding` (clientId, agreementId,
   agreementVersionId, versionNumber, window) is persisted with every
   derived fee fact. "Latest", implicit current, and silent defaults
   remain FORBIDDEN (CR-HM-12 §4.5 inherited).
5. **DEFAULT-only.** Only a rule whose `mode = 'DEFAULT'`
   (`authoritativeForEntitlement: true`) may feed derivation; a
   `REFERENCE` term stays a published reference and NEVER feeds a fee
   fact.
6. **Still not a value.** This decision freezes the term's **authority,
   shape, and constraints** — not the runtime seat. No PART may author a
   BM fee value until the §5 follow-up delivers the seat AND the
   configuration is authored by a client (a version with basis
   `LABOR_ONLY`, a term row, and an explicit beneficiary row). **An
   unconfigured version yields no BM fee entitlement — fail-closed, never
   a default rate.**

**HARD-1 status: RESOLVED (authority seat decided; seat delivery gated
by §5).** STOP lifted for *design/consumption law*, retained for *value
authoring* until the follow-up lands.

## §3 DECISION-2 — HARD-2 resolution: BM financial beneficiary identity

**DECIDED:** the BM fee beneficiary is an **explicit, version-bound
financial beneficiary fact** on the same CR-HM-12 agreement-version
boundary. CR-HM-14 resolves the payee ONLY by reading that fact.

Frozen law:

1. **Explicit seat.** A beneficiary fact is authored per agreement
   version (one per version, `UNIQUE`, fail-closed, DRAFT-window only,
   append-only), carrying: `agreementVersionId`, a closed
   `beneficiaryKind`, a governed `beneficiaryReferenceId`, and the
   authoring actor/timestamp. It is a **rule/identity fact**, never a
   payout instruction, never a bank account, never a SaaS record.
2. **Closed kind vocabulary at freeze: exactly `CLIENT_ORGANIZATION`.**
   For this kind the governed reference is the agreement version's own
   `client_id` (the Handyman customer organization bound by that
   version — the B2B party whose agreement produces the fee), which
   CR-HM-12 already holds; **no new party entity is minted and no vault
   or payment-instrument identity is created**. Any further kind
   (e.g. a provider-context beneficiary or an external commercial
   party) requires an explicit governed change to CR-HM-12 first.
3. **Explicitness law.** The beneficiary must be **recorded**, not
   derived. A missing beneficiary fact makes the fee underivable
   (fail-closed) — CR-HM-14 must never fall back to any other identity.
4. **Forbidden inference sources (frozen — "no client/channel
   attribution inference").** The beneficiary is NEVER inferred from,
   defaulted from, or resolved through:
   - channel attribution (`handyman_channel_attributions`, the
     `BM_SUPER_APP` origin, or `originReference` free text — which
     CR-HM-01 declares carries *no* BM financial entitlement);
   - any client/facility/customer record lookup performed at derivation
     time (the derivation does no identity resolution of its own);
   - `vendors`, vendor PICs, workforce profiles, `tenantPic`, provider
     contexts, crews, or assignment rows (provider attribution belongs to
     provider entitlement only — §4.3);
   - SaaS state of any kind;
   - free text, caller input, request body, environment, or
     configuration of the acting user.
5. **Same-client chain.** The beneficiary reference must be consistent
   with the version's `client_id` and with the entity acting on the
   agreement (CR-HM-12 same-client discipline inherited); a
   cross-client beneficiary is a bounded conflict, never a coercion.
6. **No SaaS/FM coupling.** The beneficiary seat has zero FK, read,
   write, or vocabulary overlap with SaaS platform/billing/subscription/
   entitlement tables (`module_entitlements`,
   `feature_entitlement_configurations`, `platform_*`, `subscriptions`,
   `saas_*`) or FM financial modules (`vendor_*`, `tenant_*`,
   `payment_receipts`, `invoice_payment_status`, `utility_tariffs`,
   `work_contracts`, `client-monetary-contexts`).
7. **Not a payout.** The beneficiary fact identifies the party a fee is
   owed to; it is NOT a payout instruction, carries no rail/bank/
   instrument identity, and CR-HM-14 executes no payout (START §6.6
   stands).

**HARD-2 status: RESOLVED (identity seat decided; seat delivery gated by
§5).**

## §4 Frozen consumption law for CR-HM-14 (both inputs read-only)

1. **Read-only inputs.** CR-HM-14 consumes exactly two CR-HM-12 read
   surfaces: the existing `readHandymanBmFeeRuleConsumptionAt(clientId,
   asOf)` (basis + mode + authority flag + `binding`) extended by the §5
   follow-up with the term and beneficiary facts. It writes nothing in
   CR-HM-12 and holds no rule-authoring capability.
2. **Derivation owns only the VALUE.** The fee amount is derived by
   CR-HM-14 from (a) the gated, correction-netted ledger `laborNet`
   (CR-HM-13 PART 06 read; `authority.authoritativeForEntitlement =
   true` required) and (b) the version-bound term and beneficiary.
   Nothing else may enter the fee.
3. **Beneficiary resolution is a read, not an inference.** One third
   read remains separate: the provider beneficiary of *provider*
   entitlement is the CR-HM-04 attribution (assignment → provider
   context + crew) per START §4; this decision does not touch it. The BM
   fee beneficiary is the §3 seat only.
4. **Gate order (fail-closed, all four required):** ledger gate true →
   exact agreement version resolved → `mode = 'DEFAULT'` → term +
   beneficiary present. A failure at any step yields NO fee fact and a
   bounded error; never a partial, estimated, prorated, or defaulted fee.
5. **Basis law unchanged.** `LABOR_ONLY` only; material never enters a
   BM fee base; no smearing of transaction-scoped adjustments; no
   proration of unattributable corrections (START §5.3/§5.4 unchanged).
6. **Anchors persisted.** Every derived fee fact carries `binding`
   (clientId, agreementId, agreementVersionId, versionNumber, window) +
   rule row id + term row id + beneficiary fact id + the ledger anchors
   (transactionId, executionScopeId, currency, ledger contract version)
   + the consumed `laborNet` figure — full traceability (START E2).
7. **Zero SaaS/FM coupling.** No read, write, FK, import, or inference
   against the SaaS/FM substrate, and no SaaS-state influence on any
   fee, settlement, or reconciliation fact — including the resolution
   path of this decision's two inputs.
8. **Amendment trigger.** If any required input (term kind, rate bounds,
   beneficiary kind, or the binding law) later changes, the change lands
   as a NEW agreement version + NEW rule/term/beneficiary facts; existing
   derived fee facts are never restated (START §7.1, E1).

## §5 Smallest CR-HM-12 follow-up required before BM fee derivation

**Designation: `CR-HM-12 PART 06 — BM Fee Term & Beneficiary
Prerequisite`.** It extends the CR-HM-12 boundary already frozen in
`CR-HM-12_START_GOVERNANCE.md` (PART split §10); it is NOT a new top-level
CR, changes NO roadmap/matrix/capability-map row, and mints no new
ownership. Its only purpose is to make matrix rows 21→22 executable:
*"configurable fee basis must exist before BM fee entitlement
calculation."*

| # | Deliverable | Bounded content |
| --- | --- | --- |
| 1 | Governance (docs only) | Follow-up START governance freezing the term and beneficiary vocabularies, bounds, DRAFT-window/append-only laws and the fail-closed read contract — consistent with this decision record |
| 2 | Migration **(≥ 0415, first free)** | Exactly TWO additive tables on the existing agreement-version anchor: a fee **term** table (`UNIQUE (agreement_version_id)`, kind `PERCENTAGE_OF_BASIS`, `NUMERIC` rate `> 0 AND ≤ 100`, DRAFT-window INSERT guard, UPDATE/DELETE blocked — the 0407/0408/0409 pattern verbatim) and a **beneficiary** table (`UNIQUE (agreement_version_id)`, kind `CLIENT_ORGANIZATION`, same-client consistency check, same guards). No other table, no column added to any existing table |
| 3 | Module additions | Types + repository + service additions inside the EXISTING `src/modules/handyman-bm-fee-rules/` (and the agreement resolver) family: author-on-DRAFT, fail-closed as-of resolution, one-per-version. No new module family, no entitlement math, no settlement, no ledger, no HTTP |
| 4 | Extended published read | One read over the exact version returning `{ basis, mode, authoritativeForEntitlement, term: { kind, rate } \| null, beneficiary: { kind, referenceId } \| null, binding }`, still `CR_HM_12_BASIS_FACT` / `isFinalCharge: false`, zero derived fee VALUE, and explicit `null` (never a silent default) when a slot is unconfigured |
| 5 | Tests (real PostgreSQL, serial, fresh DB) | DRAFT-window authoring only; append-only/immutability refusals; exactly one term + one beneficiary per version; `UNIQUE` + same-client violations fail closed; rate bounds and NaN/float refusal; fail-closed as-of; unconfigured version ⇒ explicit `null`; zero fee-VALUE computation; SaaS/FM firewall scans; no CR-HM-13 ledger reference |
| 6 | Docs | Follow-up governance + certification and the updated `CR-HM-12_READ_CONTRACT.md` naming the term/beneficiary read. (The CR-HM-14 side — HARD-1/HARD-2 relabelled RESOLVED, §5.6, §14 gate, Handoff — is already updated by this decision record's own commit, §6.) |

Gate and sequencing law:

- **Gate.** CR-HM-14 may design, implement, and ship PART 01 (entitlement
  fact foundation, provider side included) and provider-side derivation;
  **BM fee VALUE authoring and any BM fee fact in any environment require
  this follow-up merged and certified on `main`.** Unconfigured versions
  remain fail-closed no-fee.
- **Sequencing.** The follow-up is CR-HM-12's own PART and may proceed on
  its own branch/PR; CR-HM-14 PART 02 must fail closed for the BM side
  until then. Nothing in CR-HM-14 may pre-empt the follow-up by adding a
  rate/beneficiary seat of its own (that would void decision-1/2 and
  re-open HARD-1/HARD-2).
- **Forbidden in the follow-up.** Entitlement derivation or fee-value
  computation; settlement/reconciliation; any CR-HM-13 ledger write or
  reference; any SaaS read/write/FK; any FM financial reuse; payout,
  rail, bank, or instrument identity; channel-attribution-based
  beneficiary; tax/discount runtime; FX; roadmap or matrix change; HTTP
  (unless a consumer requires transport — and then never a second write
  path).

## §6 Effect on CR-HM-14 START governance (this commit)

Exactly two documents change: this record (new) and
`CR-HM-14_START_GOVERNANCE.md` (edited, docs-only):

1. §5.6 — "Value authoring is BLOCKED pending two decisions" →
   both decisions are now made; value authoring is gated solely by the
   §5 follow-up (CR-HM-12 PART 06).
2. §13 — HARD-1 and HARD-2 rows relabelled **RESOLVED** with the
   DECISION-1/DECISION-2 texts and a pointer to this record.
3. §14 — the HARD gate rule updated: the gate is now the follow-up
   PART, not a pending decision.
4. Handoff (CR-HM-12 bullet) — updated to name the follow-up PART and
   this record.

Everything else in the START governance (ownership, provider
entitlement, settlement/reconciliation authority, reversal/correction
law, ledger handoff, invariants E1–E16, idempotency, firewalls, seams,
COND-3/COND-4, B1–B16, PART split, out-of-scope list) stands unchanged.

## §7 Freeze record

| Token | Value |
| --- | --- |
| `HARD_1` | **RESOLVED** — numeric BM fee term = CR-HM-12 commercial agreement authority, exact-version bound, kind `PERCENTAGE_OF_BASIS`, `NUMERIC` rate `>0..≤100`, integer-basis-points arithmetic, `DEFAULT` only |
| `HARD_2` | **RESOLVED** — BM beneficiary = explicit version-bound financial beneficiary fact, kind `CLIENT_ORGANIZATION`, reference = that version's governed `client_id`; no channel/client inference |
| `BM_FEE_TERM_AUTHORITY` | `CR_HM_12_COMMERCIAL_AGREEMENT_VERSION` |
| `BM_FEE_TERM_KINDS` | `PERCENTAGE_OF_BASIS` (closed at freeze) |
| `BM_FEE_RATE_BOUNDS` | `> 0` and `≤ 100`, `NUMERIC` ≥ 4 dp, no float, integer basis points |
| `BM_BENEFICIARY_SEAT` | `VERSION_BOUND_EXPLICIT_FACT` |
| `BM_BENEFICIARY_KINDS` | `CLIENT_ORGANIZATION` (closed at freeze) |
| `BENEFICIARY_INFERENCE` | `FORBIDDEN` (channel attribution, client lookup, vendor/PIC, SaaS, free text, caller input) |
| `CR_HM_14_CONSUMPTION_MODE` | `READ_ONLY_INPUT || DERIVES_VALUE_ONLY` |
| `CR_HM_14_RULE_WRITE` | `NONE` |
| `SAAS_FM_COUPLING` | `FORBIDDEN` |
| `PAYOUT_EXECUTION` | `OUT_OF_SCOPE` (unchanged) |
| `CR_HM_12_FOLLOWUP` | `CR_HM_12_PART_06_BM_FEE_TERM_AND_BENEFICIARY` |
| `BM_VALUE_AUTHORING_GATE` | `CR_HM_12_PART_06_MERGED_AND_CERTIFIED` |
| `UNCONFIGURED_VERSION_OUTCOME` | `NO_BM_FEE_ENTITLEMENT_FAIL_CLOSED` |
| `CR_HM_14_PART_01_GATE` | `UNCHANGED (START §14 governs; not started by this record)` |
| `RUNTIME_MIGRATION_API` | `NONE_IN_THIS_PART` |

STOP after this decision record. No runtime, no migration, no API, no
CR-HM-14 PART 01 in this PART.
