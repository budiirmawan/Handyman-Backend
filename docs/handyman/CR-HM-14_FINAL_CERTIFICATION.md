# CR-HM-14 — Financial Entitlement & Settlement — FINAL CERTIFICATION

Date: 2026-09-30. Assigned branch:
`arena/01a0efb2-handyman-backend`. Verified implementation HEAD and
assigned-branch remote tip:
`96cc7df52c865c80d0d7bc8bc2017f347abfac33`; tracked tree clean
before this documentation-only certification. The earlier local checkout
was recovered **only** from that verified remote tip after all local
implementation-file hashes matched it. PART 05's decision record is a
separate untracked documentation artifact at the verification point;
it is included with this certification commit.

**STATUS: PASS** for the governed CR-HM-14 PART 01–04 scope and PART 05
HTTP/OpenAPI gate **NOT_REQUIRED**. No implementation defect was found
in the focused certification, so no runtime change was made. This is a
bounded certification of the listed contracts and focused tests, not a
claim of full-suite/build/typecheck/CI coverage.

## Delivery and exit gate

| Part | Commit / record | Certified boundary |
| --- | --- | --- |
| 01 | `2dcebf7` | Migration 0416: immutable EARNED provider/BM fact anchors, closed kinds/bases/currency, money CHECKs, exact-version and provider-chain guards, one fact per transaction/kind, single-use key |
| 02 | `6d5d4de` | Governed-input derivation, provider attribution/conflict gate, correction-netted CR-HM-13 PART 06 net basis, exact CR-HM-12 PART 06 DEFAULT/LABOR_ONLY rate and beneficiary; migration 0417 forward-only, cause-bound entitlement corrections |
| 03 | `8ce75b2` | Migration 0418 and internal settlement: funded PAYABLE → INCLUDED_IN_SETTLEMENT → SETTLED, inclusion uniqueness, terminal history, internal MATCHED/VARIANCE reconciliation, cause-bound exceptions and dispute hold |
| 04 | `96cc7df` | `CR-HM-14_READ_CONTRACT.md` and read-only internal exact/windowed financial fact family, authority status, anchors, exception/variance visibility and firewall test |
| 05 | `CR-HM-14_PART05_HTTP_GATE_DECISION.md` | **NOT_REQUIRED**: roadmap exit gate does not mandate HTTP; matrix rows 22–23 are backend-internal at freeze, with no currently specified CR-HM-17/18 financial client presentation. Required HTTP/OpenAPI surface: **NONE**. Reopen only on explicit downstream transport need |

The roadmap row 22 exit gate is satisfied **within this backend-internal
scope**: entitlement derivation and settlement/reconciliation contracts
are published, derivation consumes governed ledger/commercial inputs,
and the SaaS product-entitlement firewall is verified. CR-HM-12 PART 06
term/beneficiary prerequisite is present and certified on the merged
base (`CR-HM-12_PART_06_FINAL_CERTIFICATION.md`); HARD-1/HARD-2 are
resolved and delivered. Neither SaaS subscription nor billing state is
an input or settlement signal.

## Focused verification

Executed **only** the four CR-HM-14 suites, serially, against fresh
embedded PostgreSQL:

```text
NODE_ENV=test LOG_LEVEL=error ./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/handyman-entitlement-part01-foundation.test.ts \
  tests/handyman-entitlement-part02-derivation.test.ts \
  tests/handyman-settlement-part03.test.ts \
  tests/handyman-financial-read-part04.test.ts

suites=4  tests=12  pass=12  fail=0  skipped=0
```

| Gate | Evidence / outcome |
| --- | --- |
| Entitlement anchors and E1/E2/E9–E12 | PART 01 SQL test: closed EARNED state and provider/BM anchors, same-client/currency/basis constraints, immutable UPDATE/DELETE refusal, cross-transaction single-use key, one earned fact per kind. PART 02: atomic two-fact command and same-key replay; another key conflicts |
| Ledger E3/E4 + attribution | PART 02: no posted charge and PENDING intake deny derivation; published CR-HM-13 PART 06 gate, correction-netted net figures, integer-cents arithmetic and active CR-HM-04 assignment/Lead anchors. Multi-provider history conflicts; no invented work share |
| Exact BM fee E2/E5/E8/E10 | PART 01/02: exact agreement/version/rule/term/beneficiary binding, `DEFAULT` only, `LABOR_ONLY` and canonical four-decimal term; absent term/beneficiary, `REFERENCE`, and unscoped correction all fail closed. Material is never folded into the fee basis; fee rounding occurs at the derived fact boundary, not through floating-point money |
| Forward correction E1/E14 | PART 02: append-only signed-by-kind deltas with exact ledger correction cause, uniqueness, replay and original EARNED row stability. PART 03: later refund becomes a new cause-bound exception and a visible variance, not a history edit or silent clamp |
| Funding, lifecycle, reconciliation E5–E7/E11/E13/E14 | PART 03: partial funding refuses PAYABLE; funded two-kind inclusion only once, single currency, exact client-window reconciliation, MATCHED before SETTLED; refund blocks closing, writes VARIANCE/exception, and late correction never reopens terminal SETTLED. Event/inclusion UPDATE/DELETE and illegal early transition are refused |
| Read and firewalls E3/E15/E16 | PART 04: published exact and bounded client reads expose persisted anchors, states, correction causes and net funded strings; deny PENDING/empty ledger, exclude non-authoritative client IDs, preserve bounded 400/403/404. Repository performs one SELECT over own facts; ledger is consumed only through CR-HM-13 published reads. Source/SQL-FK scans exclude SaaS/FM/gateway surfaces; repeated reads leave ledger, entitlement, settlement and reconciliation tables byte-identical |

**No full/regression suite, typecheck, build, or CI was run** in this
certification. No runtime/API/OpenAPI/migration file was changed here.

## Blockers and retained fail-closed limits

- **Release blockers: NONE** for the certified internal scope. HARD-1
  (numeric BM term) and HARD-2 (explicit version-bound beneficiary) are
  delivered by CR-HM-12 PART 06, not invented in CR-HM-14.
- **COND-3** multi-provider/session attribution and **COND-4**
  un-attributable correction effects retain their governed bounded
  fail-closed posture; there is no invented split or proration. Missing
  configuration and `REFERENCE` rules never create a BM fee fact.
- A dispute hold is not an adjudication/clearing workflow. External
  statement ingestion, gateway execution, payout/rail/account identity,
  FX, and SaaS/FM financial authority remain outside this CR. PART 04
  readiness is informational, not permission to settle; PART 03
  commands must recheck authority and funds under their own locks.
- PART 05 remains optional; CR-HM-17/18 do not presently require a
  financial HTTP client surface. A future downstream transport request
  must reopen the conditional gate, not infer an endpoint from this
  certification.

**STOP after certification.**
