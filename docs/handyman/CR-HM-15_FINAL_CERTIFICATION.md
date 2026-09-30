# CR-HM-15 — Service Warranty, Claim & Rework — FINAL CERTIFICATION

Date: 2026-09-30 (UTC)
Branch: `arena/01a0f02c-handyman-backend`
Certified HEAD: `ebcc2d607164622f524e78f934e8fca7684c6f79` (PART 05)
Governance: `docs/handyman/CR-HM-15_START_GOVERNANCE.md` @ `e27cec5`
Base commit: `e259309` (`origin/main` = `f46b0e05ae15dd9d41cc42752011a004727ce6b8`)

**STATUS: PASS** — all five runtime PARTs (01–05) are certified against
the frozen START governance, and the focused CR-HM-15 regression is
green (51/51).

## §1 Scope and method

Certified surface: the transactional Handyman **service warranty, claim,
free rework, chargeable additional-work separation and published read
contract** for one execution scope, bound to a customer-accepted BAST.

Method:

1. **Baseline** — expected HEAD `ebcc2d6` verified equal to local HEAD and
   to `origin/arena/01a0f02c-handyman-backend`; tracked tree clean
   (untracked `node_modules/` only). No recovery needed.
2. **Focused CR-HM-15 regression ONLY** — the five CR-HM-15 suites, run
   with `--test-concurrency=1`. No full test run, no typecheck, no build,
   no CI, no other CR's suite.
3. **Static firewall sweep** — migrations/module imports re-read for
   FM/SaaS/asset-warranty and money/ledger coupling.
4. **Runtime changes** — none. The only change in this certification
   commit is the test-scope repair disclosed in §5 (a false positive in
   PART 01's own firewall scan; no runtime defect existed).

## §2 PART chain (frozen §8 split) — all delivered

| PART | Commit | Deliverable | Migration | Suite | Result |
| --- | --- | --- | --- | --- | --- |
| 00 | `e27cec5` | START governance (docs only) | — | — | frozen |
| 01 | `00c3d01` | Warranty aggregate + transitions | `0419` | `handyman-service-warranty-part01` | 10/10 |
| 02 | `7dec53f` | Claim intake / decision / evidence bind | `0420` | `handyman-service-warranty-claim-part02` | 12/12 |
| 03 | `88a95d5` | Free rework lifecycle | `0421` | `handyman-service-warranty-rework-part03` | 10/10 |
| 04 | `5ba27be` | Chargeable additional-work separation | `0422` | `handyman-chargeable-additional-work-part04` | 13/13 |
| 05 | `ebcc2d6` | Published read contract (no migration) | — | `handyman-service-warranty-contract-part05` | 6/6 |

Migration chain `0419 → 0420 → 0421 → 0422` is registered in order in
`src/database/migrations/index.ts`. Five modules exist:
`handyman-service-warranties`, `handyman-service-warranty-claims`,
`handyman-service-warranty-reworks`, `handyman-chargeable-additional-works`,
`handyman-service-warranty-contracts`.

## §3 Certified guarantees

### 3.1 Warranty starts ONLY from an `ACCEPTED` BAST (§5.1, B1/B2/B3)

- `HANDYMAN_SERVICE_WARRANTY_STATUSES` is frozen to exactly
  `INELIGIBLE, ACTIVE, CLAIM_OPEN, CLAIM_APPROVED, CLAIM_REJECTED,
  REWORK_IN_PROGRESS, REWORK_COMPLETE, EXPIRED`; the only write authority
  in PART 01 is `START`(ACTIVE)/`EXPIRE`(EXPIRED) and the only start
  source is `ACCEPTED_BAST`.
- `starts_at = bast_accepted_at` is a database CHECK, so the warranty
  start boundary can never drift from the acceptance instant.
- DRAFT / ISSUED / REJECTED / VOID BAST, session COMPLETE, CHECK_OUT,
  QC PASS and quotation approval are refused as start sources.

### 3.2 Claim eligibility and decision (`CLAIM_DRAFT→SUBMITTED→APPROVED/REJECTED|WITHDRAWN`)

- Claims exist only on the ORIGINAL warranty / execution scope, bind
  caller-supplied evidence **by id** from CR-HM-10 authority (read-only),
  and are state-gated: submit/approve/reject/withdraw only from their
  legal predecessor, idempotent per single-use key, one open claim per
  warranty.
- The warranty head mirrors the claim path
  (`ACTIVE→CLAIM_OPEN→CLAIM_APPROVED|CLAIM_REJECTED`, withdraw→`ACTIVE`)
  and is written only through PART 01's own head writer.

### 3.3 Free rework lifecycle (`REWORK_DRAFT→AUTHORIZED→IN_PROGRESS→COMPLETE→VERIFIED`)

- Free rework requires an `APPROVED` claim on a `CLAIM_APPROVED` head;
  it binds to that claim and, through it, the service warranty and the
  ORIGINAL execution scope / BAST (identity read from the claim row).
- One free rework per claim; forward-only ladder; `REWORK_VERIFIED` is
  terminal and closes the claim; DELETE is refused ("warranty history is
  preserved"); every rung needs its event and its matching head state,
  enforced by deferred guards.
- Verification consumes CR-HM-10 evidence/QC **read-only**: bound
  evidence must belong to the rework's own client + ORIGINAL scope, and a
  consumed QC run must belong to that scope and already be `PASSED`.

### 3.4 Chargeable additional-work separation (B8)

- A **separate** record family (`CHARGEABLE_PROPOSED →
  CHARGEABLE_AUTHORIZED | CHARGEABLE_REJECTED`) for the
  `CLAIM_APPROVED`/`CLAIM_REJECTED` pair; the free-rework record is never
  mutated into a chargeable state and the two status vocabularies are
  disjoint.
- Never-convert law, both directions: a chargeable referral is refused
  while the claim's free rework is authorized/in-progress/complete/
  verified, and once a referral exists the free rework can never leave
  `REWORK_DRAFT` (SQL firewall).
- Acceptance emits the separation fact + the **CR-HM-13 payment trigger
  fact**; the warranty head is never moved (it is not a billing state).

### 3.5 Published read contract (CR-HM-17/18)

- One versioned, read-only contract (`contractVersion = '1'`,
  `contractSource = HANDYMAN_SERVICE_WARRANTY`, `readOnly: true`)
  addressable by warranty, execution scope, claim, rework or chargeable
  referral, publishing bounded owner statuses, immutable anchors, history
  instants and non-authoritative readiness facts.
- It re-declares **no** lifecycle vocabulary (the owners' status sets stay
  authoritative), exports no mutating verb, contains no write statement,
  and keeps the owner NOT_FOUND/VALIDATION bounds.

### 3.6 History immutability

- Anchor identity (client / execution scope / BAST / warranty / claim /
  rework / chargeable) is frozen by guard; rows are never deleted
  (refusals: "warranty history is preserved", "…never deleted"); event
  streams are append-only; PART 05's write-detector over all nine
  CR-HM-15 tables is byte-identical before/after reads.
- BAST acceptance, the warranty start boundary and the service history are
  never rewritten, reopened or re-pointed (CR-HM-11 and CR-HM-10 are
  read-only prerequisites and stay untouched).

### 3.7 FM / SaaS / financial firewalls (§6/§7, B4/B6/B7)

- Zero FM/asset/vendor/SaaS tokens exist in the CR-HM-15 migration code
  or module imports; every FK target of the CR-HM-15 tables stays inside
  `handyman_*` (warranty/claim/rework/chargeable/BAST/execution
  scope/evidence/QC), `clients` and `users`.
- The only payment-worded column in the whole CR-HM-15 DDL is
  `handyman_chargeable_additional_works.payment_trigger_emitted_at` — the
  CR-HM-13 separation FACT. No amount, price, currency, ledger, payment,
  settlement or entitlement is computed, stored or published anywhere.
- The warranty head vocabulary itself admits no chargeable/asset literal;
  PART 05 publishes a firewall that refuses any projection carrying
  amount/price/currency/ledger/settlement/entitlement or an
  FM/asset/vendor/SaaS key.
- No HTTP/OpenAPI surface was added by any PART (contracts are in-process
  modules only).

## §4 Focused CR-HM-15 regression (executed)

```
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 \
  tests/handyman-service-warranty-part01.test.ts \
  tests/handyman-service-warranty-claim-part02.test.ts \
  tests/handyman-service-warranty-rework-part03.test.ts \
  tests/handyman-chargeable-additional-work-part04.test.ts \
  tests/handyman-service-warranty-contract-part05.test.ts
```

```
ok 1 - CR-HM-15 PART 04 separation guards
ok 2 - CR-HM-15 PART 04 separated chargeable execution
ok 3 - CR-HM-15 PART 02 claim lifecycle guards
ok 4 - CR-HM-15 PART 02 claim intake and decision
ok 5 - CR-HM-15 PART 05 published contract projection
ok 6 - CR-HM-15 PART 01 service warranty lifecycle guards
ok 7 - CR-HM-15 PART 01 service warranty persistence
ok 8 - CR-HM-15 PART 03 rework lifecycle guards
ok 9 - CR-HM-15 PART 03 free rework execution
# tests 51
# suites 9
# pass 51
# fail 0
# cancelled 0
```

Execution time ≈ 85 s. Scope: CR-HM-15 only (no other CR's suite, no full
run, no typecheck, no build, no CI).

## §5 Defect found and repaired during certification

**One test-scope defect; no runtime defect.**

PART 01's firewall law ("no claim/rework/chargeable/money/asset
vocabulary in PART 01's columns") selected its columns with
`table_name LIKE 'handyman_service_warranty%'`. That filter was correct
when only migration `0419` existed, but after PART 02/03 added
`handyman_service_warranty_claims` / `…_claim_events` /
`…_reworks` / `…_rework_events`, it swept those later families too — whose
legitimate `claim_id` / `rework_id` columns then tripped the law and
failed the PART 01 suite once the whole CR ran together.

Repair (this commit, test-only): the column scan is scoped to PART 01's
OWN three tables — `handyman_service_warranties`,
`handyman_service_warranty_coverages`, `handyman_service_warranty_events`
— exactly like the FK scan already in that test, preserving the law's
intent. No runtime, migration or API byte changed; the frozen head
vocabulary, guards and firewalls were verified untouched by the
regression re-run (51/51).

## §6 Blocker disposition (governance §7)

| ID | Blocker | Disposition |
| --- | --- | --- |
| B1 | session COMPLETE as warranty start | CLOSED — only `ACCEPTED` BAST starts; negatives frozen in PART 01 |
| B2 | QC PASS as warranty start | CLOSED — QC is read-only sequenced truth (PART 01/03) |
| B3 | BAST ISSUED/COMPLETE/QC_PASS as start | CLOSED — refused in PART 01 |
| B4 | Asset/FM warranty reused as authority | CLOSED — no FM coupling; PART 05 firewall refuses it |
| B5 | Runtime/migration/API in a governance PART | CLOSED — PART 00 is docs-only |
| B6 | Payment/ledger/entitlement implemented here | CLOSED — only the CR-HM-13 trigger fact is emitted |
| B7 | Asset Warranty treated as Service Warranty | CLOSED — firewall + read contract source gate |
| B8 | Free rework and chargeable work collapsed | CLOSED — separate families, disjoint vocabularies, mutual-exclusion guards |
| B9 | Claim/rework lifecycle in CR-HM-10/11 | CLOSED — authority is CR-HM-15 only; CR-HM-10/11 stay read-only |

## §7 Explicit non-claims (governance §9, deferred)

- No pricing, ledger, payment engine, settlement or entitlement — CR-HM-13
  must not infer payment from chargeable additional work without its own
  CR; CR-HM-14 must not derive entitlement from a warranty claim without
  its own CR.
- No FM Asset Warranty transition API, no legacy Vendor Warranty
  projection, no FM status dual-write, no SaaS warranty exposure.
- No HTTP/OpenAPI transport: CR-HM-17/18 consume the published contract
  module; transport is a later, separate concern.
- Non-blockers explicitly deferred: FM Asset Warranty consolidation,
  vendor settlement COM-02, permit-to-warranty EXT-XX, SaaS warranty
  exposure, credit-note documents.

## §8 Handoff

- **CR-HM-11 (BAST)** and **CR-HM-10 (evidence/QC)** remain READ-ONLY
  prerequisites: CR-HM-15 consumed them, never wrote them, never reopened
  the original BAST or the service history.
- **CR-HM-08 session seam** stays a negative: COMPLETE/CHECK_OUT ≠
  warranty start.
- **CR-HM-13** consumes the chargeable separation + payment trigger fact
  and owns every amount; **CR-HM-17/18** consume the published read
  contract; **CR-HM-14** derives no entitlement from any CR-HM-15 state.
- Warranty/claim/rework/chargeable contracts are published; Asset
  Warranty ≠ Handyman Service Warranty is verified; only `ACCEPTED` BAST
  starts warranty; no inference from COMPLETE/QC PASS. The CR-HM-15 exit
  gate is met.

## §9 Certification statement

CR-HM-15 PART 01–05 are certified against the frozen START governance at
HEAD `ebcc2d6` with the focused regression green (51/51) and no runtime
changes required. The certification commit itself contains only this
document plus the §5 test-scope repair.
