# CR-HM-12 PART 06 — BM FEE TERM & BENEFICIARY PREREQUISITE — START GOVERNANCE

Status: **FROZEN GOVERNANCE**. NO runtime, NO migration, NO tests, NO
API/OpenAPI, NO ledger/SaaS/FM change in this PART.

Date: 2026-09-29 (UTC)
Branch: `arena/01a0ef78-handyman-backend`
Base commit: `c2c9cf7e2694e93a5e2575f4b32529b8d63506f1`
(`docs/handyman/CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md`, tree
`48968af2…d53`)

Authorized by: `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md` §5 —
*"Designation: `CR-HM-12 PART 06 — BM Fee Term & Beneficiary
Prerequisite` … the smallest CR-HM-12 follow-up required before BM fee
derivation"* — which resolves CR-HM-14 HARD-1 (numeric term authority =
CR-HM-12 commercial agreement, exact-version bound, `DEFAULT`-only) and
HARD-2 (BM beneficiary = explicit version-bound financial beneficiary
fact; zero client/channel-attribution inference).

## §0 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| Expected HEAD | `c2c9cf7` |
| Actual `HEAD` | **`c2c9cf7e2694e93a5e2575f4b32529b8d63506f1`** — MATCH |
| Tracked worktree | CLEAN (only the branch line) |
| Session branch | `arena/01a0ef78-handyman-backend` |
| Remote branch tip | `c2c9cf7e2694e93a5e2575f4b32529b8d63506f1` (in sync; no recovery needed) |
| `origin/main` | `e2aac5759940fa008cd776c202f5b0bd126f1112` (PR #5 merge; unchanged) |
| Next free migration | **0415** (index registration ends at `0414_handyman_ledger_corrections`) |
| Existing CR-HM-12 numeric-fee runtime | **NONE** — `handyman_bm_fee_rule_definitions` stores basis + mode only; CR-HM-12 is otherwise complete and certified |
| Existing beneficiary runtime | **NONE** — no BM party/beneficiary table, column, or vocabulary anywhere |
| CR-HM-14 dependency state | PART 01 NOT started; BM fee VALUE authoring BLOCKED until this PART is merged and certified (decision record §5 gate) |
| Mismatch / stale | **NONE ⇒ PROCEED** |

## §1 Authority and inputs (read-only; no broad audit)

| Source | What it fixes here |
| --- | --- |
| `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md` §2/§3/§4/§5 | The decision this PART implements: term kind `PERCENTAGE_OF_BASIS`, `NUMERIC` rate `> 0` and `≤ 100`, integer-basis-points law, `DEFAULT`-only, one term + one explicit beneficiary per agreement version, beneficiary kind `CLIENT_ORGANIZATION` = that version's governed `client_id`, recorded-never-derived, no channel/client inference, no SaaS/FM coupling, and the exact 6-deliverable scope |
| `CR-HM-12_START_GOVERNANCE.md` §4/§5/§6/§7/§10 | CR-HM-12 ownership (agreement versions, fee rules/basis, LABOR_ONLY default/reference model); fail-closed as-of law; "no transaction calculation inside SaaS subscription logic"; PART 05 is read-only and is never a second write path |
| `CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` rows 21→22 | *"Versioned commercial agreements and **configurable fee basis** must exist before BM fee entitlement calculation"* — the exact gap this PART closes |
| Migration `0409_create_handyman_bm_fee_rules.ts` + `src/modules/handyman-bm-fee-rules/` | The pattern to mirror verbatim: DRAFT-window INSERT guard, total UPDATE/DELETE block, `UNIQUE (agreement_version_id)`, single-use `idempotency_key UNIQUE`, `created_by_user_id`, and the no-numeric-fact Information-Schema law (which this PART extends, additively, for the term only) |
| Migration `0407_create_handyman_labor_pricing_basis.ts` | The governed-numeric-rule precedent: `NUMERIC(18,2)` + CHECK-bounded values, closed vocabularies, DRAFT-only authoring, append-only, version-`UNIQUE` |
| `src/modules/handyman-commercial-agreements/` | `HandymanCommercialAgreementVersionRecord` (`id`, `agreementId`, `clientId`, `versionNumber`, `status` ∈ `DRAFT`/`ACTIVE`/`SUPERSEDED`, window) and `resolveHandymanCommercialAgreementAt(clientId, asOf)` — the ONLY version-resolution path |
| `src/modules/handyman-pricing-contract/` (PART 05, PUBLISHED) | The read family CR-HM-14 consumes: `HandymanPricingContractBinding`, `HandymanPricingContractBmFeeRuleView`, `readHandymanBmFeeRuleConsumptionAt`, `HANDYMAN_PRICING_CONTRACT_FACT_KIND` (`CR_HM_12_BASIS_FACT`). **Additive extension only** — the published shapes stay byte-compatible |
| `src/shared/errors.ts` (append-only block, last BM codes `HANDYMAN_BM_FEE_RULE_*`) | Error-code naming/append convention |
| `src/database/migrations/index.ts` (tail = 0414) | Registration convention; next free ≥ 0415 |
| `tests/handyman-bm-fee-rule.test.ts`, `tests/handyman-pricing-contract.test.ts` | Suite conventions (real embedded PostgreSQL, serial, fresh DB per suite, firewall sweeps) |

## §2 FROZEN tokens

| Token | Value |
| --- | --- |
| `PART` | `CR_HM_12_PART_06` |
| `PART_NAME` | `BM_FEE_TERM_AND_BENEFICIARY_PREREQUISITE` |
| `MIGRATION` | `>= 0415` (first free) |
| `TABLES_ADDED` | `handyman_bm_fee_term_definitions`, `handyman_bm_fee_beneficiary_definitions` (exactly two) |
| `TERM_KINDS` | `PERCENTAGE_OF_BASIS` (closed at freeze) |
| `TERM_RATE_BOUNDS` | `> 0` and `<= 100`, `NUMERIC(7,4)`, canonical decimal string at boundaries, integer basis points in code |
| `BENEFICIARY_KINDS` | `CLIENT_ORGANIZATION` (closed at freeze) |
| `BENEFICIARY_REFERENCE` | the bound agreement version's own governed `client_id` (same-client chain enforced) |
| `AUTHORING_WINDOW` | `DRAFT_ONLY` (version status `DRAFT` at INSERT; frozen forever after) |
| `MUTABILITY` | `APPEND_ONLY` (UPDATE/DELETE trigger-blocked; revision = new agreement version) |
| `CARDINALITY` | exactly ONE term + ONE beneficiary per agreement version (`UNIQUE`) |
| `AS_OF_RESOLUTION` | `FAIL_CLOSED_EXACT_VERSION` (no "latest", no silent default) |
| `READ_MODE` | `READ_ONLY` (no mutation verb, no HTTP, no OpenAPI) |
| `FEE_VALUE_COMPUTATION` | `NONE` (CR-HM-14 only) |
| `ENTITLEMENT_SETTLEMENT` | `NONE` (CR-HM-14 only) |
| `LEDGER_INTERACTION` | `NONE` (zero CR-HM-13 table, module, or FK reference) |
| `SAAS_FM_COUPLING` | `FORBIDDEN` |
| `KNOWN_PROVIDER_VOCABULARY` | `NONE` |
| `WIRING` | `src/database/migrations/index.ts` (+1 import, +1 entry) and `src/shared/errors.ts` (appended block) — nothing else outside the CR-HM-12 boundary |

## §3 Persistence law (frozen)

One additive migration **≥ 0415**, creating **exactly two** tables and
nothing else; reverting `down`; FK graph reaches only
`handyman_commercial_agreement_versions`, `clients`, and `users`.

### 3.1 `handyman_bm_fee_term_definitions` — the version-bound numeric term

| Column | Type | Law |
| --- | --- | --- |
| `id` | `UUID PRIMARY KEY` | Server-minted |
| `agreement_version_id` | `UUID NOT NULL REFERENCES handyman_commercial_agreement_versions (id)` | The EXACT version (no other binding path exists) |
| `term_kind` | `TEXT NOT NULL` | `CHECK (term_kind IN ('PERCENTAGE_OF_BASIS'))` — closed vocabulary |
| `rate_percent` | `NUMERIC(7,4) NOT NULL` | `CHECK (rate_percent > 0 AND rate_percent <= 100)` — the ONLY numeric column in either new table |
| `idempotency_key` | `TEXT NOT NULL UNIQUE` | `CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)` (0394/0409 single-use convention) |
| `created_by_user_id` | `UUID NOT NULL REFERENCES users (id)` | Authenticated local actor |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Server clock |

Constraints/indexes: `UNIQUE (agreement_version_id)` (one term per
version, fail-closed); index `(agreement_version_id, created_at, id)`.

Triggers: `…_draft_only_trigger` BEFORE INSERT mirroring 0409 (*"may
only be authored on a DRAFT agreement version"*); `…_no_write_trigger`
BEFORE UPDATE OR DELETE raising *"append-only (supersession lands a new
agreement version)"*.

Frozen absences (Information-Schema law, test-proven): **no** amount,
currency, fee, charge, total, computed, or provenance-column beyond the
above; **no** `labour`/`material`/`transaction`/`ledger`/`payment`/
`settlement`/`entitlement`/SaaS/FM column; a percentage is
currency-free, so the term carries no currency column (the derived
value's currency is CR-HM-14's governed ledger currency).

### 3.2 `handyman_bm_fee_beneficiary_definitions` — the explicit beneficiary fact

| Column | Type | Law |
| --- | --- | --- |
| `id` | `UUID PRIMARY KEY` | Server-minted |
| `agreement_version_id` | `UUID NOT NULL REFERENCES handyman_commercial_agreement_versions (id)` | The EXACT version |
| `beneficiary_kind` | `TEXT NOT NULL` | `CHECK (beneficiary_kind IN ('CLIENT_ORGANIZATION'))` — closed vocabulary |
| `beneficiary_reference_id` | `UUID NOT NULL REFERENCES clients (id)` | Governed reference; for `CLIENT_ORGANIZATION` it MUST equal the bound version's `client_id` (same-client chain) |
| `idempotency_key` | `TEXT NOT NULL UNIQUE` | `CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)` |
| `created_by_user_id` | `UUID NOT NULL REFERENCES users (id)` | Authenticated local actor |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Server clock |

Constraints/indexes: `UNIQUE (agreement_version_id)` (one beneficiary
per version, fail-closed); index `(agreement_version_id, created_at,
id)`; a client-consistency guard (trigger, 0396-class) refusing any row
whose `beneficiary_reference_id` differs from the bound version's
`client_id`.

Triggers: the same DRAFT-window INSERT guard and total UPDATE/DELETE
block as §3.1.

Frozen absences: **no** name/contact/free-text, **no** bank account,
IBAN, rail, instrument, wallet, gateway, disbursement, payout, or
provider token, **no** SaaS/FM/party-registry FK, **no** status column
(identity is a fact, not a lifecycle).

### 3.3 Persistence invariants (testable)

| # | Invariant |
| --- | --- |
| T1 | Both tables are append-only: UPDATE and DELETE are refused by trigger on every row |
| T2 | Both tables accept INSERTs only while the bound version's status is `DRAFT`; an `ACTIVE`/`SUPERSEDED` version refuses authoring |
| T3 | At most ONE term and ONE beneficiary per agreement version (`UNIQUE`), fail-closed on a second |
| T4 | Term vocabulary is exactly `PERCENTAGE_OF_BASIS`; beneficiary vocabulary is exactly `CLIENT_ORGANIZATION`; unknown values are refused by CHECK |
| T5 | Term rate is inside `(0, 100]`; zero, negative, and > 100 are refused; NaN/infinity are unrepresentable (`NUMERIC`) |
| T6 | Beneficiary `CLIENT_ORGANIZATION` reference equals the bound version's `client_id`; a mismatch is refused |
| T7 | `idempotency_key` is single-use; `created_by_user_id` is a real `users` row; timestamps are server-set |
| T8 | FK footprint closes on `{handyman_commercial_agreement_versions, clients, users}` — zero ledger, quotation, session, material, FM, or SaaS reference |
| T9 | Reverting the migration drops exactly the two tables and their triggers/functions; no pre-existing object is touched |
| T10 | No column in either table is a fee value, charge, balance, entitlement, settlement state, or payout vector |

## §4 Authoring law (frozen — module surface)

Additions live **inside the existing CR-HM-12 boundary**; no new module
family, no new ownership.

1. **Types** (`src/modules/handyman-bm-fee-rules/handyman-bm-fee-rule.types.ts`
   or a sibling typed file in the same module): frozen vocabularies
   `HANDYMAN_BM_FEE_TERM_KINDS` / `HANDYMAN_BM_FEE_BENEFICIARY_KINDS`,
   their guards, and the record/new-record types for both facts
   (canonical decimal `ratePercent` **string** at every module
   boundary — no float ever).
2. **Repository** (same module, mirroring
   `handyman-bm-fee-rule.repository.ts`): `findTermByVersion`,
   `findTermByIdempotencyKey`, `insertTerm`; `findBeneficiaryByVersion`,
   `findBeneficiaryByIdempotencyKey`, `insertBeneficiary`. SELECT/INSERT
   only — **no** UPDATE/DELETE statement exists in the module.
3. **Service**, mirroring `prepareHandymanBmFeeRule` semantics exactly:
   - `prepareHandymanBmFeeTerm(actorUserId, { agreementVersionId, termKind, ratePercent, idempotencyKey })`
   - `prepareHandymanBmFeeBeneficiary(actorUserId, { agreementVersionId, beneficiaryKind, beneficiaryReferenceId, idempotencyKey })`
   Both: validate input shape → resolve + lock the agreement by client
   (as 0409 does) → version must exist → version must be `DRAFT` →
   idempotency replay returns the SAME row (`replayed: true`) → a
   conflicting replay (same key, different intent/version) is a bounded
   `KEY_CONFLICT` → insert inside ONE `withTransaction` with the
   aggregate locked. `beneficiaryReferenceId` is server-cross-checked
   against the version's `client_id`; caller-supplied client identity is
   never authority.
   Read side: `getHandymanBmFeeTermForVersion(agreementVersionId)` and
   `getHandymanBmFeeBeneficiaryForVersion(agreementVersionId)`, both
   returning `null` when unconfigured (never a default).
4. **Errors** — new codes appended to the `src/shared/errors.ts` block,
   named `HANDYMAN_BM_FEE_TERM_{NOT_FOUND,ALREADY_DEFINED,VERSION_NOT_DRAFT,KEY_CONFLICT,VALIDATION}`
   and
   `HANDYMAN_BM_FEE_BENEFICIARY_{NOT_FOUND,ALREADY_DEFINED,VERSION_NOT_DRAFT,KEY_CONFLICT,VALIDATION,CLIENT_MISMATCH}`,
   with bounded messages and the module's existing status-code mapping
   (`409` conflict / `404` not found / `400` validation). No error code
   may mention a fee value, entitlement, settlement, gateway, or SaaS
   vocabulary.
5. **No valuation surface.** Nothing in this PART may multiply, apply,
   evaluate, or store `rate_percent × anything`. The module publishes
   the term as data; arithmetic belongs to CR-HM-14.

## §5 Fail-closed read contract (frozen — additive PART 05 extension)

The PUBLISHED PART 05 shapes are **not modified**: `readHandymanBmFeeRuleConsumptionAt`,
`HandymanPricingContractBmFeeRuleView`, and every existing export stay
byte-compatible (`authoritativeForEntitlement` remains
`rule.mode === 'DEFAULT'`).

One **new** read is added to `src/modules/handyman-pricing-contract/`:

```text
readHandymanBmFeeConfigurationAt(clientId, asOf)
  -> {
       binding,                       // unchanged HandymanPricingContractBinding
       rule,                          // unchanged view (or bounded error when absent)
       term,                          // NEW view | null
       beneficiary,                   // NEW view | null
       unconfiguredSlots,             // NEW: sorted subset of ('TERM' | 'BENEFICIARY')
       authoritativeForEntitlement,   // NEW: rule.mode === 'DEFAULT' AND term AND beneficiary
       factKind,                      // unchanged CR_HM_12_BASIS_FACT
       isFinalCharge: false           // unchanged
     }
```

New view shapes (both carry `factKind` + `agreementVersionId` +
their row id):

- `HandymanPricingContractBmFeeTermView` —
  `{ termRowId, agreementVersionId, termKind: 'PERCENTAGE_OF_BASIS',
     ratePercent: string /* canonical decimal, e.g. "2.5000" */, factKind }`
- `HandymanPricingContractBmFeeBeneficiaryView` —
  `{ beneficiaryRowId, agreementVersionId, beneficiaryKind:
     'CLIENT_ORGANIZATION', beneficiaryReferenceId, factKind }`

Frozen read law:

1. **Version-exact.** Resolution goes through
   `resolveHandymanCommercialAgreementAt(clientId, asOf)` only; the term
   and beneficiary are read for that exact version id. "Latest", silent
   defaults, and cross-version fallbacks are FORBIDDEN.
2. **Fail-closed, machine-readable.** A missing **rule** keeps the
   existing bounded `HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE` refusal
   (nothing changes for existing consumers). A missing **term** or
   **beneficiary** does NOT throw: the read publishes `null` for that
   slot, lists it in `unconfiguredSlots`, and sets
   `authoritativeForEntitlement: false`. **CR-HM-14's derivation is what
   must then refuse a fee fact with a bounded error** — no consumer may
   treat `null` as zero, as 0 %, or as "use the reference model".
3. **No value, ever.** The read publishes a rate and a payee identity —
   never a fee amount, never a computed figure, never a settlement or
   entitlement state.
4. **Read-only.** The pricing-contract module continues to import zero
   database layer; the DAL additions live in the authoring module (§4)
   exactly as PART 04 does today.
5. **Zero SaaS/FM.** No import, identifier, or state from the SaaS/FM
   substrate exists in the extension (source-scan enforced).

## §6 Verification law (frozen — what the suites must prove)

Suites run on real embedded PostgreSQL, serial, fresh database per
suite, and each ends with a firewall/source sweep:

1. authoring only on `DRAFT`; `ACTIVE`/`SUPERSEDED` refused (both facts);
2. append-only: UPDATE/DELETE refused on both tables;
3. exactly one term and one beneficiary per version; second insert refused;
4. vocabularies closed; unknown `term_kind`/`beneficiary_kind` refused;
5. rate bounds `(0, 100]`; `0`, negative, `> 100` refused; exact decimal
   round-trip preserved (no float drift);
6. beneficiary same-client guard: mismatched `beneficiary_reference_id`
   refused;
7. idempotent replay returns the SAME row (`replayed: true`); same key +
   different version/intent = bounded `KEY_CONFLICT`;
8. fail-closed as-of: no effective version / no rule = bounded refusal;
   unconfigured term/beneficiary = explicit `null` +
   `unconfiguredSlots` + `authoritativeForEntitlement: false`
   (never a default, never a zero, never a REFERENCE substitution);
9. invariance of the PUBLISHED PART 05 surface: existing exports, shapes
   and `authoritativeForEntitlement` semantics are unchanged
   (byte-compatible consumption for existing consumers);
10. firewall sweep: zero ledger (CR-HM-13) table/column/FK/module
    reference; zero SaaS/FM identifier, table, column, FK, or import;
    zero fee-value/entitlement/settlement/gateway token in migration,
    source, or error codes;
11. FK footprint and column inventory match §3 exactly (Information
    Schema assertions); reverting `down` leaves no residue.

## §7 BLOCKERS

| ID | Blocker | Rule |
| --- | --- | --- |
| B1 | Any fee VALUE, percentage application, amount, balance, entitlement, settlement, or payout vocabulary/arithmetic in this PART | STOP (decision record §2/§5; CR-HM-14's authority) |
| B2 | A term or beneficiary not bound to an EXACT agreement version, or resolvable without exact as-of resolution | STOP (§5.1) |
| B3 | A term kind or beneficiary kind outside the closed vocabularies, or a free-text payee/name | STOP (§3.1/§3.2, decision record §2.2/§3.2) |
| B4 | Beneficiary inferred from channel attribution, client lookup, vendor/PIC, workforce, provider context, SaaS state, free text, or caller input | STOP (decision record §3.4) |
| B5 | Authoring outside the DRAFT window; any UPDATE/DELETE of an authored fact; revision by editing instead of a new version | STOP (§3, T1/T2) |
| B6 | More than one term or one beneficiary per version (or a silent first-wins/last-wins rule) | STOP (T3) |
| B7 | `null` treated as zero/absent-rate/REFERENCE fallback, or any default rate or default payee invented at read or derivation time | STOP (§5.2, decision record §2.6/§3.3) |
| B8 | A `REFERENCE` rule treated as authoritative, or the existing PART 05 `authoritativeForEntitlement` semantics changed | STOP (§5, §6.9) |
| B9 | Any CR-HM-13 ledger interaction (table, column, FK, module import, or read) | STOP (§2 `LEDGER_INTERACTION = NONE`) |
| B10 | SaaS/FM coupling: FK, read, write, import, or vocabulary against `platform_*`, `subscriptions`, `saas_*`, `module_entitlements`, `feature_entitlement_configurations`, or FM financial modules | STOP (decision record §3.6; CR-HM-12 B3/B8 stand) |
| B11 | Bank/rail/instrument/wallet/disbursement identity or any payout instruction | STOP (decision record §3.7) |
| B12 | Rate stored/compared in floating point, or a non-canonical decimal at a module boundary | STOP (§2 `TERM_RATE_BOUNDS`; repo money law) |
| B13 | HTTP/OpenAPI/controller/route added in this PART | STOP (PART 05 precedent: HTTP where unneeded) |
| B14 | Touching anything outside the CR-HM-12 boundary (ledger, quotation, session, material, BAST, roadmap, matrix) | STOP (§2 `WIRING`) |

Non-blockers (explicitly deferred): any additional term kind (flat
amount, bands, tiers, min/max), any additional beneficiary kind, fee
value derivation (CR-HM-14 PART 02), settlement/reconciliation
(CR-HM-14 PART 03), tax/discount runtime, FX, payout execution,
client UI.

## §8 Smallest legal PART split

| PART | Name | Allowed | Forbidden |
| --- | --- | --- | --- |
| **06** | START GOVERNANCE (this document) | Freeze persistence, authoring, read, invariants, blockers, split | Runtime, migration, tests, API |
| **06A** | Persistence + DB invariants | Migration ≥ 0415 with exactly the two tables of §3 (columns, CHECKs, UNIQUEs, indexes, DRAFT-window + append-only triggers, `down`), index registration, and the Information-Schema/invariant assertions of T1–T10 in its suite | Service, read contract, valuation, HTTP |
| **06B** | Authoring service + fail-closed read | Types/guards, repository, prepare/get services for both facts, error codes, and the additive §5 read (`readHandymanBmFeeConfigurationAt` + the two views) | Valuation, entitlement/settlement, ledger, SaaS/FM, HTTP |
| **06C** | Certification | (Not a code PART) certification against the decision record §5 deliverables + updated `CR-HM-12_READ_CONTRACT.md` naming the term/beneficiary read and its `unconfiguredSlots`/`authoritativeForEntitlement` law | New runtime |

Merge rules:

- **06A before 06B** (the service may not land before its tables exist);
  06A+06B MAY merge only if the DRAFT-window, append-only, cardinality,
  bounds, same-client, and fail-closed-read proofs ship in the same
  commit as the surface they assert.
- **Nothing in this PART may be merged before its own suite proves the
  corresponding T-invariant**; no repo-wide test run is required beyond
  the focused suites.
- **CR-HM-14 gate release.** Only after 06A+06B are merged and certified
  on `main` may CR-HM-14 author a BM fee VALUE (decision record §5 gate);
  CR-HM-14 PART 01 remains independently authorized and unaffected.
- Migration number allocation is fixed here as **≥ 0415**; if 0415 is
  taken by an unrelated merged change, the next free number is used and
  this document is corrected in the same commit.
- The existing `readHandymanBmFeeRuleConsumptionAt` consumers keep
  working unchanged; the new read is additive, never a replacement and
  never a second write path.

## §9 Out of scope

- No runtime, migration, tests, or API in THIS PART (governance only).
- No fee VALUE, entitlement derivation, settlement, or reconciliation
  (CR-HM-14).
- No change to the CR-HM-13 ledger, CR-HM-06 quotations, CR-HM-08
  sessions, CR-HM-09 material execution, CR-HM-11 BAST, or any prior
  CR-HM-12 PART.
- No SaaS subscription/billing/pricebook/entitlement read or write; no
  FM financial module reuse or dual-write.
- No payment gateway, rail, bank, wallet, or disbursement identity.
- No roadmap, matrix, or capability-map change — the ownership rows
  21/22 already cover this delivery.
- No broad audit — §1 sources only.

## Handoff

- **CR-HM-14** — after 06A+06B merge + 06C certification, consume
  `readHandymanBmFeeConfigurationAt` (exact-version `binding` + rule +
  term + beneficiary + `unconfiguredSlots`) as the BM fee input; gate on
  `authoritativeForEntitlement`; fail closed with a bounded error when a
  slot is unconfigured; never default a rate or a payee; persist the rule
  row id, term row id, and beneficiary row id as anchors on every derived
  fee fact. Provider entitlement, PART 01, and settlement lifecycle are
  unaffected by this PART.
- **CR-HM-12 (prior PARTs)** — PUBLISHED shapes and behaviour unchanged;
  the fee rule table stays numeric-free; this PART adds the term and
  beneficiary seats the exit gate's *"configurable fee basis"* clause
  requires.
- **CR-HM-17 / CR-HM-22** — may present the configured term/beneficiary
  as read-only commercial configuration; zero client-side computation,
  zero client-asserted fee.
- **SaaS plane** — no coupling of any kind; `SaaS Product Entitlement !=
  Provider/BM Financial Entitlement` stands.

STOP after this governance PART.
