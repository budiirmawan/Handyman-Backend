# CR-HM-11 — BAST & Customer Acceptance — FINAL CERTIFICATION

Date: 2026-09-29 (UTC)
Branch: `arena/01a0ed85-handyman-backend`
Base commit: `cf8c6e2` (CR-HM-11 PART 03)

Governance reference: `CR-HM-11_START_GOVERNANCE.md` (FROZEN,
commit `92ebbd0`).

Certification ONLY. No feature, refactor, migration, or API in this
PART. CR-HM-12 is NOT started.

## Certification record

```text
CR_HM_11_STATUS=COMPLETE
CR_HM_11_BLOCKERS=0
CR_HM_11_IMPLEMENTATION_DEFECTS=0
COMPLETE_NE_BAST_ACCEPTANCE=VERIFIED
QUOTATION_APPROVAL_NE_BAST_ACCEPTANCE=VERIFIED
FM_BAST_COUPLING=NO
```

## Delivered parts

| Part | Commit | Deliverable |
| --- | --- | --- |
| Governance | `92ebbd0` | start governance: ownership, TARGET=execution scope, lifecycle DRAFT/ISSUED/ACCEPTED/REJECTED/VOID, ISSUE/VOID vs ACCEPT/REJECT split, blockers B1–B7, PART 00–03 |
| PART 01 | `1a54bf9` | BAST aggregate + ISSUE/VOID: migration 0404 (`handyman_bast_documents` + `handyman_bast_events`), PREPARE/ISSUE/VOID, one-active-per-scope, client/scope identity immutability, append-only events; ACCEPT/REJECT not applied |
| PART 02 | `21a823d` | customer ACCEPT/REJECT + signature: migration 0405 (`handyman_bast_sign_offs`), ISSUED→ACCEPTED/REJECTED only, ACCEPT requires signature digest, sign-off bound to event (not a second owner) |
| PART 03 | `cf8c6e2` | published read contract for CR-HM-15/17/18: `customerAccepted` / `warrantyStartEligible` only when status=`ACCEPTED`; COMPLETE/CHECK_OUT/QUOTATION_APPROVAL/QC_PASS/FM_BAST_STATUS frozen as not acceptance |
| Certification | (this commit) | this document |

## Focused certification suites — 12/12 PASS

| Suite | Part | Tests |
| --- | --- | --- |
| `tests/handyman-bast-lifecycle.test.ts` | 01 | 4 |
| `tests/handyman-bast-acceptance.test.ts` | 02 | 4 |
| `tests/handyman-bast-read-contract.test.ts` | 03 | 4 |

3 suites, 12 tests, 0 failures (`npx tsx --test --test-concurrency=1`
on the three CR-HM-11 files only). No runtime defect. No full
regression / typecheck / build.

## Frozen invariants verified at certification

1. **COMPLETE != BAST Acceptance** — session COMPLETE / CHECK_OUT
   are not legal BAST actions; the PART 03 alias list publishes
   `SESSION_COMPLETE` and `CHECK_OUT` as `HANDYMAN_NOT_BAST_ACCEPTANCE`.
2. **Quotation Approval != BAST Acceptance** — `QUOTATION_APPROVAL`
   is illegal on the state machine and listed as not-acceptance.
3. **QC PASS != BAST Acceptance** — CR-HM-10 remains read-only
   sequenced truth; `QC_PASS` never maps to `ACCEPTED`.
4. **Status authority** — single `handyman_bast_documents.status`
   column. Sign-off rows are event-bound evidence (B7); they do not
   independently become truth.
5. **ISSUE/VOID (PART 01)** — ISSUE only from DRAFT; VOID from
   DRAFT or ISSUED; never VOID after ACCEPTED.
6. **ACCEPT/REJECT (PART 02)** — only from ISSUED; ACCEPT requires
   a non-empty signature digest; REJECT may omit signature.
7. **Read contract (PART 03)** — `warrantyStartEligible` is true
   iff status is `ACCEPTED` (CR-HM-15 eligibility flag only — no
   warranty engine here). Projection never invents ACCEPTED from
   ISSUED/REJECTED/VOID/DRAFT.
8. **FM firewall** — no FK to FM `bast_documents` / `work_orders`;
   `FM_BAST_STATUS` is not Handyman acceptance.
9. **No HTTP/OpenAPI** — domain module only; no `-api` sibling
   required for this CR's exit gate.
10. **No ledger / warranty runtime** — CR-HM-13 must not infer
    payment from ACCEPTED; CR-HM-15 consumes eligibility later.

## Handoff

- **CR-HM-15** — consume `warrantyStartEligible` / status `ACCEPTED`
  as the only service-warranty start gate. Do not start warranty
  from COMPLETE, quotation approval, or QC PASS.
- **CR-HM-17 / CR-HM-18** — present and command against the
  published BAST/acceptance contract; clients are not authority.
- **CR-HM-13** — must not treat ACCEPTED as payment.
- **CR-HM-08 / CR-HM-10 / CR-HM-06** — remain READ-ONLY
  prerequisites; not reopened.

CR-HM-12 is NOT started.

STOP.
