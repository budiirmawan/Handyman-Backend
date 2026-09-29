# CR-HM-12 — Pricing & Commercial Agreement — FINAL CERTIFICATION

Date: 2026-09-29 (UTC)
Branch: `arena/01a0eda1-handyman-backend`
Base commit: `92c14d2` (CR-HM-12 PART 05)

Governance reference: `CR-HM-12_START_GOVERNANCE.md` (FROZEN,
commit `20fec4d`). Roadmap exit gate:
`HANDYMAN_CR_CODING_ROADMAP_v1.0.md` CR-HM-12 row.

Certification ONLY. No feature, refactor, migration, or API in
this PART. CR-HM-13/14 are NOT started.

## Certification record

```text
CR_HM_12_STATUS=COMPLETE
CR_HM_12_BLOCKERS=0
CR_HM_12_IMPLEMENTATION_DEFECTS=0
ROADMAP_EXIT_GATE=VERIFIED
PRICING_MODE_EXECUTION_PUBLISHED=VERIFIED
COMMERCIAL_AGREEMENT_VERSIONING_PUBLISHED=VERIFIED
BM_FEE_RULE_CONTRACT_PUBLISHED=VERIFIED
REFERENCE_PRICE_NEVER_FINAL_CHARGE=VERIFIED
NO_TRANSACTION_CALCULATION_IN_SAAS=VERIFIED
FM_SAAS_FINANCIAL_COUPLING=ZERO
QUOTATION_SNAPSHOTS_IMMUTABLE=VERIFIED
CR_HM_09_11_READ_ONLY_INPUTS=VERIFIED
SECOND_WRITE_PATH=NO
HTTP_OPENAPI_SURFACE=NONE
```

## Delivered parts

| Part | Commit | Deliverable |
| --- | --- | --- |
| Governance | `20fec4d` | start governance: ownership, pricing authority law (§4), agreement/versioning semantics (§5), labor/material + BM-fee boundaries (§6/§7), blockers B1–B10, PART 00–05 split |
| PART 01 | `f96fbad` | commercial agreement aggregate: migration 0406 (`handyman_commercial_agreements` + `_versions` + `_events`), one agreement per client, immutable DRAFT→ACTIVE→SUPERSEDED versions with [from,to) windows, root-locked append-only events keyed by single-use idempotency, fail-closed as-of resolver (`resolveHandymanCommercialAgreementAt`) — never "latest" |
| PART 02 | `6d3df41` | labor & crew pricing-mode execution contract: migration 0407, mode vocabulary HOURLY/FIXED_SCOPE/INSPECTION_FIRST/VISIT_FEE × PER_HEAD/PER_CREW + optional billable-time basis, unit_amount/currency rule facts bound to exact versions, pure deterministic half-up evaluator; no charge posting |
| PART 03 | `06a0b8b` | material pricing basis: migration 0408, per-version SETTLED_USAGE/APPROVED_QTY definition (UNIQUE per version), READ-ONLY scope composition over CR-HM-09 FINAL_CHARGE_READY settled quantities × CR-HM-06 approved MATERIAL snapshot amounts; never a final charge; never merged with LABOR (B10) |
| PART 04 | `f9c942a` | BM fee rules: migration 0409, exactly ONE rule per agreement version, basis frozen LABOR_ONLY, role DEFAULT/REFERENCE, zero numeric columns (fee VALUE derivation is CR-HM-14's), DRAFT-window authoring + total append-only, fail-closed as-of rule resolution |
| PART 05 | `92c14d2` | published read contract `src/modules/handyman-pricing-contract/` for CR-HM-06/13/14/17 (`docs/handyman/CR-HM-12_READ_CONTRACT.md`): bundle/evaluation/composition/consumption reads, `CR_HM_12_BASIS_FACT` + `isFinalCharge:false` labels, `authoritativeForEntitlement` reference≠final gate, scope-version cross-check; zero DB import — structurally no second write path |
| Certification | (this commit) | this document |

## Focused certification suites — 30/30 PASS

Real migrated PostgreSQL (embedded), serial; run 2026-09-29 at
base `92c14d2`:

| Suite | Part | Tests |
| --- | --- | --- |
| `tests/handyman-commercial-agreement.test.ts` | 01 | 6 |
| `tests/handyman-labor-pricing.test.ts` | 02 | 6 |
| `tests/handyman-material-pricing.test.ts` | 03 | 6 |
| `tests/handyman-bm-fee-rule.test.ts` | 04 | 6 |
| `tests/handyman-pricing-contract.test.ts` | 05 | 6 |

No repo-wide test/typecheck/build/CI was run (out of discipline;
none was required for certification).

## Exit-gate verification (roadmap CR-HM-12 row)

1. **Pricing-mode execution published** — PART 02 vocabulary +
   pure evaluator, version-bound, fail-closed (§4.2 ownership
   "here, nowhere else"); material basis quantification published
   by PART 03.
2. **Commercial agreement versioning published** — PART 01
   aggregate + frozen lifecycle/window/idempotency law, consumed
   unchanged by PARTs 02–05 (all bind to the exact version id).
3. **BM fee rule contracts published** — PART 04 rule table +
   PART 05 consumption read: the §7 "published rule contract
   CR-HM-14 consumes"; matrix row 21→22 precondition satisfied by
   published contracts ONLY (no entitlement computed "while here").
4. **Reference price never final charge** — §4.1 enforced three
   ways: CR-HM-12 never reads catalogue price as authority (zero
   `price-catalog` imports); every published figure carries
   `isFinalCharge: false` + basis-fact labels; a REFERENCE BM fee
   rule is machine-visible non-authoritative. Approved CR-HM-06
   snapshots are never repriced (B4) — composition reads proved
   snapshot rows byte-identical (t4, PART 05 suite).
5. **No transaction calculation inside SaaS subscription logic** —
   CR-HM-12 code contains zero SaaS/FM identifiers and zero
   SaaS/FM imports; scans show zero references to any CR-HM-12
   table/module from anywhere outside the CR-HM-12 boundary
   (no reverse coupling), and the migration FK footprint closes on
   `{clients, users, handyman_commercial_agreement*}` only.

## Blocker register — all clear

| ID | Rule | Certification evidence |
| --- | --- | --- |
| B1 | catalogue/reference price as final charge | NO — CR-HM-12 holds no catalogue read at all; PART 05 key-scan rejects final-charge-shaped fields |
| B2 | pricing/ledger/charge/payment/settlement runtime here | NO such runtime exists in any CR-HM-12 module (export-name scans, t1/t3 per suite) |
| B3 | SaaS calculation / package price as Handyman price | ZERO — source allowlists + forbidden-identifier scans across PARTs 02–05 suites; FK purity proven |
| B4 | mutation/repricing of approved CR-HM-06 versions | ZERO quotation-runtime files touched in the whole CR range; byte-identity proven in PART 05 t4 |
| B5 | CR-HM-09/CR-HM-11 reopened for pricing | ZERO files touched in `handyman-material-execution`/BAST across the range; reads only, snapshot byte-identity proven |
| B6 | fee from SaaS state, or unbound rule | rule table is FK-bound to version and UNIQUE per version; resolver never accepts "latest"; missing rule = bounded `RULE_NOT_EFFECTIVE` |
| B7 | implicit current agreement / non-fail-closed as-of | PART 01 anchor is the only resolution path; every suite asserts bounded NOT_EFFECTIVE behavior |
| B8 | FK/dual-write into FM financial modules | migration scan: no `vendor_quotations`/`tenant_invoices`/`utility_tariffs`/`work_contracts` reference; zero dual-writes (append-only triggers + read battery counts) |
| B9 | runtime in governance PART | governance commit `20fec4d` is docs-only (verified in range file list) |
| B10 | labor/material merged into one amount | structurally impossible: separate views, `mergedWithLabor: false`, no total fields |

## Non-regression posture

All CR-HM-12 commits are additive: 39 files across the range, all
inside the five CR-HM-12 modules, migrations 0406–0409 + index
registration, an append-only error-code block (68 `+` / 0 `-`),
two documents, five test files. No prior CR's runtime, migration,
API, or OpenAPI surface was modified anywhere in the range.

## Handoff state

- **CR-HM-13** — UNBLOCKED to compose final charges from its own
  CR inputs + quotation snapshots + CR-HM-09 handoff; CR-HM-12
  basis facts are consumable via the PART 05 reads, and ledger
  posting remains CR-HM-13's authority alone.
- **CR-HM-14** — UNBLOCKED: consumes `readHandymanBmFeeRuleConsumptionAt`
  (and versioned agreements) for entitlement derivation; MUST gate
  on `authoritativeForEntitlement` (REFERENCE ≠ final) and holds
  zero permission to read SaaS subscription/billing state as a
  fee base (B3/B6 stand as law, not just as scan results).
- **CR-HM-06** — F5 firewall lifted ONLY in the read direction:
  governed adjustments may reference published contract outputs;
  approved quotation versions stay immutable forever (B4).
- **CR-HM-17** — consumes the published views verbatim; zero
  client-side rule evaluation.
- **Explicitly deferred (non-blockers, by frozen §9)**: tax/
  discount runtime, billable-time derivation implementation, FX
  beyond the governed currency list, FM legacy price cleanup, SaaS
  billing features, entitlement/settlement engine.
