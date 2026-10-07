# CR-HM-12 PART 06 — BM FEE PREREQUISITE — FINAL CERTIFICATION

Date: 2026-09-30 (UTC)
Branch: `arena/01a0ef78-handyman-backend`
Certified HEAD: `0428bddb72e2b4444b95b4c803e51d5989761a6e`
(base: `1ce8d1b` PART 06A, `0428bdd` PART 06B; governance `90d557b`;
tree `8cb89e0e52daaf9a8443374925ad5f2e1323975e`)

Governance reference: `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` (FROZEN,
commit `90d557b`). Authorization: `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md`
(commit `c2c9cf7`) §2/§3/§5, which resolved CR-HM-14 HARD-1 and HARD-2.
Published contract: `CR-HM-12_READ_CONTRACT.md` §5 (PART 06B extension).
Roadmap anchors: `HANDYMAN_CR_CODING_ROADMAP_v1.0.md` CR-HM-12 entry /
table row 21; `CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` rows 21→22.

Certification ONLY. **No implementation defect was found, so no runtime
change was required.** PART 06 (governance), 06A (persistence) and 06B
(authoring + read) are certified; PART 06C is this document.

## Certification record

```text
CR_HM_12_PART_06_STATUS=CERTIFIED
CR_HM_12_PART_06_PARTS_06_06A_06B=DELIVERED
CR_HM_12_PART_06_BLOCKERS=0
CR_HM_12_PART_06_IMPLEMENTATION_DEFECTS=0
HARD_1_BM_FEE_TERM=RESOLVED_AND_DELIVERED
HARD_2_BM_BENEFICIARY=RESOLVED_AND_DELIVERED
EXACT_VERSION_BINDING=VERIFIED
DRAFT_WINDOW_AUTHORING=VERIFIED
APPEND_ONLY_IMMUTABILITY=VERIFIED
ONE_TERM_ONE_BENEFICIARY_PER_VERSION=VERIFIED
RATE_BOUNDS_CANONICAL_DECIMAL=VERIFIED
SAME_CLIENT_BENEFICIARY_CHAIN=VERIFIED
FAIL_CLOSED_READ=VERIFIED
UNCONFIGURED_SLOT_IS_EXPLICIT_NULL=VERIFIED
PART_05_READ_COMPATIBILITY=VERIFIED
FEE_VALUE_COMPUTATION=NONE
LEDGER_COUPLING=ZERO
SAAS_FM_COUPLING=ZERO
HTTP_OPENAPI_SURFACE=NONE
REVERT_EXECUTED_AND_REAPPLIED=VERIFIED
WIRING=INDEX_REGISTRATION_PLUS_ERROR_CODES_ONLY
CR_HM_14_BM_FEE_VALUE_GATE=RELEASED_ON_MERGE_TO_MAIN
EXIT_GATE_BLOCKED=NO
```

## Delivered parts (PART 06 / 06A / 06B)

| Part | Commit | Deliverable |
| --- | --- | --- |
| Governance 06 | `90d557b` | `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` — frozen persistence law (§3), authoring law (§4), the additive fail-closed read contract (§5), verification law (§6), blockers B1–B14 (§7), PART split 06A/06B/06C (§8), out-of-scope (§9), handoff |
| PART 06A | `1ce8d1b` | migration `0415_create_handyman_bm_fee_prerequisite` — exactly two version-bound tables (`handyman_bm_fee_term_definitions`, `handyman_bm_fee_beneficiary_definitions`), closed vocabularies, `NUMERIC(7,4)` rate bounded `(0, 100]`, `UNIQUE (agreement_version_id)` per table, single-use idempotency keys, DRAFT-window INSERT guard, total UPDATE/DELETE block, same-client beneficiary guard, exact `down`; index registration; `tests/handyman-bm-fee-prerequisite-persistence.test.ts` |
| PART 06B | `0428bdd` | term + beneficiary authoring inside the existing family (`prepareHandymanBmFeeTerm`, `prepareHandymanBmFeeBeneficiary`, exact getters), typed repository (SELECT/INSERT only), 11 bounded error codes, frozen vocabularies/guards, canonical-decimal rate law, and the additive `readHandymanBmFeeConfigurationAt` (+ 2 views, `unconfiguredSlots`, composite authority gate) in the PUBLISHED pricing-contract module; `tests/handyman-bm-fee-prerequisite-configuration.test.ts` |
| Certification 06C | (this commit) | this document + `CR-HM-12_READ_CONTRACT.md` §5 |

Range inventory (`90d557b..0428bdd`): **13 files, 2,519 insertions,
7 deletions** — all inside the CR-HM-12 boundary (`handyman-bm-fee-rules`,
`handyman-pricing-contract`, migration 0415 + index registration,
appended error-code block, two suites). The 7 deletions are import-line
rewrites and one comment line; **no existing function body was modified**
(PART 05 byte-compatibility evidence below).

## Focused regression — 12/12 PASS

Real embedded PostgreSQL 18.4, migrated from zero, serial, **fresh
database per run**; executed at HEAD `0428bdd` on 2026-09-30:

```
NODE_ENV=test LOG_LEVEL=error DB_HOST=127.0.0.1 DB_PORT=55434 DB_USER=postgres \
DB_PASSWORD=postgres DB_SSL=false npx tsx --test --test-concurrency=1 \
  tests/handyman-bm-fee-prerequisite-persistence.test.ts \
  tests/handyman-bm-fee-prerequisite-configuration.test.ts
```

| Suite | Part | Tests | Result |
| --- | --- | --- | --- |
| `handyman-bm-fee-prerequisite-persistence.test.ts` | 06A | 6 | **6/6 PASS** |
| `handyman-bm-fee-prerequisite-configuration.test.ts` | 06B | 6 | **6/6 PASS** |
| **Total** | | **12** | **12/12 PASS, 0 fail, 0 skipped** |

No repo-wide test, typecheck, build, or CI run was performed (out of
discipline for this PART; none was required for certification).

## What each PART proves

**PART 06A (persistence + DB invariants).**

1. exactly two additive tables with the frozen column inventory; the
   rate is the only numeric column (`precision 7 / scale 4`); no
   amount/charge/balance/entitlement/settlement/payout/bank/currency/
   status/free-text/SaaS-FM column exists (T10);
2. DRAFT-window authoring on both tables, refused once the version is
   `ACTIVE` — including raw-SQL service bypass (T2); trigger inventory
   (5 triggers, 3 functions) asserted;
3. total append-only: UPDATE and DELETE refused on every row (T1);
4. exactly one term and one beneficiary per EXACT agreement version
   (T3); single-use idempotency key across versions (T7);
5. closed vocabularies; rate `(0, 100]` with `0`/`-1`/`100.0001`/`NaN`
   refused by CHECK and `±Infinity` refused by the precision-bounded
   NUMERIC (22003); boundary `100` → `'100.0000'`, `2.5` → `'2.5000'`
   (exact decimal, no float) (T4/T5);
6. same-client beneficiary chain: a foreign client is refused by the
   guard, a non-client reference before any row lands; no channel/
   vendor/caller identity is representable (T6);
7. FK footprint closes on `{handyman_commercial_agreement_versions,
   clients, users}` (5 FKs) — zero ledger, quotation, session, material,
   BAST, FM, or SaaS reference (T8);
8. executing `down` removes exactly the two tables and this PART's three
   functions with the pre-existing anchors untouched, and `up` restores
   the frozen surface (T9);
9. no other migration touches either table; 0415 registered last (T8/T9).

**PART 06B (authoring + fail-closed read).**

1. frozen term vocabulary (`PERCENTAGE_OF_BASIS`) and beneficiary
   vocabulary (`CLIENT_ORGANIZATION`), plus the slot vocabulary
   (`TERM`, `BENEFICIARY`); the barrel exposes no
   evaluation/derivation/valuation surface;
2. term authoring: one per version, DRAFT-only, canonical decimal STRING
   (`'2.5'`→`'2.5000'`, `'100'`→`'100.0000'`), `(0,100]` at 4-dp scale,
   unknown kind/version bounded, replay returns the SAME fact, a
   conflicting replay is `KEY_CONFLICT` with zero extra rows;
3. beneficiary authoring: bound to the version's OWN client
   (`CLIENT_MISMATCH` otherwise, including arbitrary UUIDs), closed kind,
   one per version, DRAFT-only, replay identity;
4. fail-closed configuration read: no effective version → PART 01
   bounded refusal; **no rule → the existing
   `HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE` refusal is preserved**; a
   missing term/beneficiary is an explicit `null` + sorted
   `unconfiguredSlots` + `authoritativeForEntitlement: false`
   (never zero, never 0 %, never a REFERENCE substitution); fully
   configured ⇒ `true`; historical as-of resolves the frozen
   half-configured version (version-exact, never "latest"); a
   `REFERENCE` rule stays non-authoritative even with both slots
   present;
5. PART 05 byte-compatibility: `readHandymanBmFeeRuleConsumptionAt`
   publishes the identical key set and
   `authoritativeForEntitlement === (mode === 'DEFAULT')`; the new read
   composes the identical `binding` and rule view (deep-equal asserted)
   and only ADDS keys; no amount/value/currency/settlement/ledger/
   payment key exists in the published shape; repeated reads of both
   surfaces leave all three tables byte-identical;
6. firewall sweep: both modules carry no controller/routes/HTTP; the
   contract module holds zero DB capability and zero SQL; the authoring
   module holds provenance-related DB logic only; no SaaS/FM/ledger
   table reference anywhere; no rate-application or valuation expression
   in code; no fee-value/payout/settlement error code; both modules are
   unwired from `src/routes`.

## Independent certification evidence (beyond suites)

| Claim | Evidence |
| --- | --- |
| Exact-version binding | `REFERENCES handyman_commercial_agreement_versions (id)` + `UNIQUE (agreement_version_id)` in migration 0415 for both tables; resolution only through `resolveHandymanCommercialAgreementAt` + per-version reads; cross-checks `assertBoundToVersion` for term and beneficiary in the configuration read |
| Fail-closed behaviour | Rule-absent keeps `HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE`; slot-absent is explicit `null` + `unconfiguredSlots` + non-authoritative flag; no default rate, no default payee, no "latest" |
| PART 05 compatibility | `git diff 1ce8d1b..0428bdd -- src/modules/handyman-pricing-contract` contains **no modified function body** (deletions are import-line rewrites only); suite case t5 deep-equals `binding` and `rule` between the two reads and asserts the unchanged key set |
| Zero fee-value math | No `ratePercent × base`, `applyRate`, `computeFee`, or amount column exists; the only arithmetic is the integer ten-thousandths rate validation; no currency column on a percentage fact |
| Zero ledger coupling | No `handyman_customer_*`, `handyman_charge_*`, `handyman_payment_*`, or `handyman_ledger_*` reference in migration, module, or error code; FK graph excludes the ledger |
| Zero SaaS/FM coupling | No `platform_*`, `saas_*`, `subscriptions`, `module_entitlements`, `feature_entitlement_configurations`, `tenant_*`, `vendor_*`, tariff/receipt/invoice/contract table reference anywhere in the range; no entitlement/settlement/payout vocabulary in code (comments only, and only as negations) |
| No HTTP/OpenAPI | No controller/routes/openapi/swagger file or symbol; neither module is imported by `src/routes/**`; no route or schema added |
| Boundary discipline | `git diff --name-only` over the range lists only CR-HM-12 files (+ the appended `src/shared/errors.ts` block and the migration index registration); no CR-HM-06/08/09/11/13 file, no roadmap/matrix change |
| Wiring | `src/database/migrations/index.ts` +1 import / +1 entry (0415 last); `src/shared/errors.ts` appended 11 codes; nothing else outside the CR-HM-12 modules |

## Blocker register B1–B14 — all clear

| ID | Rule | Certification evidence |
| --- | --- | --- |
| B1 | Fee VALUE / amount / balance / entitlement / settlement / payout vocabulary or arithmetic in this PART | NO — data-only surface; no valuation expression in code; error codes scanned |
| B2 | Term or beneficiary not bound to an EXACT agreement version | NO — FK + `UNIQUE` per version; exact-version resolution and cross-checks |
| B3 | Kind outside the closed vocabularies, or a free-text payee | NO — CHECK-enforced vocabularies; no name/contact/free-text column |
| B4 | Beneficiary inferred from channel attribution, client lookup, vendor/PIC, workforce, SaaS, free text, or caller input | NO — server-side equality with the version's own `client_id`; `CLIENT_MISMATCH` otherwise; DB guard replicates it |
| B5 | Authoring outside DRAFT; UPDATE/DELETE of an authored fact; revision by editing | NO — DRAFT-only INSERT guard; total UPDATE/DELETE block; revision = a new version |
| B6 | More than one term or beneficiary per version, or first/last-wins | NO — `UNIQUE (agreement_version_id)` + service-level `ALREADY_DEFINED`; no silent rule |
| B7 | `null` treated as zero/absent-rate/REFERENCE fallback; default rate or payee invented | NO — explicit `null` + `unconfiguredSlots` + non-authoritative; nothing defaults |
| B8 | `REFERENCE` treated as authoritative; PART 05 semantics changed | NO — composite gate requires `DEFAULT`; PART 05 read unchanged and byte-compatible |
| B9 | Any CR-HM-13 ledger interaction | NO — zero ledger reference in migration, modules, tests, or error codes |
| B10 | SaaS/FM coupling | NO — zero reference to SaaS platform/entitlement/subscription or FM financial tables |
| B11 | Bank/rail/instrument/wallet/disbursement identity or payout instruction | NO — no such column, field, vocabulary, or dependency exists |
| B12 | Float rate or non-canonical decimal | NO — `NUMERIC(7,4)` in SQL, canonical decimal strings and integer ten-thousandths in code; zero float columns |
| B13 | HTTP/OpenAPI/controller/route added | NO — none exists in either module; unwired from `src/routes` |
| B14 | Touching anything outside the CR-HM-12 boundary | NO — range file list is CR-HM-12-only plus additive wiring |

## Exit-gate effect (matrix rows 21→22)

Matrix row 21→22 requires *"versioned commercial agreements and
configurable fee basis must exist before BM fee entitlement calculation"*.
Before this PART that precondition was satisfied only at the
**contract** level (basis + role existed; the configurable numeric term
did not). With PART 06A/06B certified:

- the **configurable fee basis** now exists as governed, version-bound
  data (term + beneficiary) with closed vocabularies and exact bounds;
- CR-HM-14 HARD-1 (no governed numeric term) and HARD-2 (no governed
  beneficiary seat) are **delivered**, not merely decided;
- CR-HM-14's BM fee **VALUE** authoring gate (decision record §5)
  **releases once this range is merged to `main`** — the gate text reads
  *"merged and certified on `main`"*, and this certification is issued on
  the assigned branch at `0428bdd`; the merge to `main` is the remaining
  procedural step, not a technical blocker;
- CR-HM-14 PART 01 (entitlement fact foundation) and provider-side
  derivation remain independently authorized and unaffected.

## Non-regression posture

Range `90d557b..0428bdd`: 13 files, 2,519 insertions, 7 deletions — 11
files inside the two CR-HM-12 module families, 1 migration + its index
registration, an appended error-code block (+23), and 2 focused suites.
No prior CR's runtime, migration, API, or OpenAPI surface was modified;
no existing function body was rewritten; PART 05's published shapes and
semantics are provably byte-compatible (`git diff` body audit + suite
t5). No roadmap, matrix, or capability-map change.

## Explicitly deferred (non-blockers, per frozen governance §7)

Additional term kinds (flat amount, bands, tiers, min/max), additional
beneficiary kinds, fee VALUE derivation (CR-HM-14 PART 02),
settlement/reconciliation (CR-HM-14 PART 03), tax/discount runtime, FX,
payout execution, external settlement statement ingestion, client UI
(CR-HM-17/18). The conditional thin HTTP/OpenAPI surface (PART 05 rule)
remains unnecessary — no consumer requires transport.

## Handoff state

- **CR-HM-14 — RELEASED (pending merge to `main`).** Consume
  `readHandymanBmFeeConfigurationAt` for the BM fee input: gate on
  `authoritativeForEntitlement`; treat `unconfiguredSlots` as a
  bounded refusal (never a default rate or payee); persist the rule,
  term, and beneficiary row ids plus `binding` as anchors on every
  derived fee fact. CR-HM-14 PART 01 may proceed immediately.
- **CR-HM-12 (PART 01–05)** — published shapes and behaviour unchanged;
  the fee-rule table remains numeric-free; this PART adds the two
  version-bound seats the exit gate's "configurable fee basis" clause
  requires.
- **CR-HM-06 / CR-HM-09 / CR-HM-11 / CR-HM-13** — untouched; the ledger
  remains the sole customer charge/payment authority and is not
  referenced by this range.
- **CR-HM-17 / CR-HM-22** — may present the configured term and
  beneficiary as read-only commercial configuration; zero client-side
  rule evaluation or computation.
- **Asentra-SaaS** — no coupling of any kind; `SaaS Product Entitlement
  != Provider/BM Financial Entitlement` stands.

STOP after this certification PART.
