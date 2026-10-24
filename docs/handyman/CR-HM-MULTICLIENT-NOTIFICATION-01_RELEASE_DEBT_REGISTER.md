# CR-HM-MULTICLIENT-NOTIFICATION-01 — RELEASE DEBT REGISTER

**The reconciliation of the 18 baseline-identical non-PASS tests.**

| | |
| --- | --- |
| **Registered at** | `404b7c8` (the PART 04 certification commit) — re-verified at the FINAL REVIEW HEAD |
| **Baseline proof** | a detached worktree at the certification baseline `126399f` — **every** non-PASS below reproduces **identically** on the untouched baseline |
| **Total** | **18** |
| **Caused by this CR** | **0** — none of the 18 is a PART 01/02/03/04 regression |
| **Relabelled as a pass** | **none** — every row below is a recorded failure with an owner, a severity and a production gate |
| **Standing instruction** | record the pre-existing reds separately; **do not fix them inside this CR**; **do not weaken an assertion** to hide them |
| **Companion records** | `..._FINAL_CERTIFICATION.md` §4 (the certification-time proof) · `..._FINAL_REVIEW_GOVERNANCE.md` §5 (the FINAL REVIEW re-run) |

---

## 1. Severity scale

| Severity | Meaning |
| --- | --- |
| **S1 — Blocker** | can cause data loss, a cross-tenant leak, or a wrong business decision in production |
| **S2 — Major** | disables a capability or a CI signal, and therefore **masks real regressions** in a governed area |
| **S3 — Minor** | a stale test expectation with **no** production effect |

**No S1 exists.** The 18 debts are test-harness and closure-criteria debts; none of
them can produce a wrong production behaviour. The two **S2** families are the
ones that matter operationally, because each of them **disables a suite** that
would otherwise protect a governed area.

---

## 2. The register

### 2.1 D-01 — the BE-26A inbox record shape (S3)

| | |
| --- | --- |
| **Suite** | `tests/notification.test.ts` → "BE-26A notification record — internal creation seam" |
| **Test** | "recordNotification persists the full record (type, recipient, source refs, channel, status, timestamps)" |
| **Failure** | `ERR_ASSERTION` — the test asserts an **exact** key list of the returned record; it now also carries `navigationTarget` (the public projection of the `navigation_target_type` / `navigation_target_id` columns added by **migration 0358**, an unrelated CR). The write path itself is correct; the **expectation** is stale. |
| **Owner** | **CR-BE-NOTIFY-PROV-01 / BE-26A** (the inbox-record authority) |
| **Severity** | **S3** — a stale expectation; no production effect; the inbox row is written correctly |
| **Production gate** | **G-7 (hygiene)** — not a release blocker |
| **Disposition** | Update the expectation in the BE-26A suite to include `navigationTarget`. **Not in this CR** — it is another CR's contract. |
| **Baseline proof** | identical at `126399f` (and at `9a15ad6` before PART 01) |

### 2.2 D-02 … D-04 — the journal-ORDER tie-break flake family (S2)

| | |
| --- | --- |
| **Suites** | **D-02** `tests/handyman-permit-readiness.test.ts` (CR-HM-05 PART 03) · **D-03** `tests/handyman-scheduling-readiness.test.ts` (CR-HM-05 PART 01) · **D-04** `tests/handyman-unit-access-readiness.test.ts` (CR-HM-05 PART 02) |
| **Test** | "9: mutation + journal atomic (failure = zero partial commits)" |
| **Failure** | `ERR_ASSERTION` — the test asserts the **order** of two journal rows that are written **in one transaction**. `created_at` defaults to `NOW()`, which is **transaction-scoped**, so both rows share the timestamp and the tie-break is the **random UUID** primary key (`ORDER BY created_at ASC, id ASC`). The expected order is therefore a coin flip. |
| **Owner** | **CR-HM-05** (the readiness authorities) |
| **Severity** | **S2** — the assertion that is supposed to prove **atomicity** (the highest-value assertion in the readiness suites) is **unreliable**, so a genuine atomicity regression would pass unnoticed |
| **Production gate** | **G-7 (hygiene)** — not a release blocker, but the atomicity guarantee of the readiness authorities is currently **unproven by the suite** |
| **Disposition** | Assert the **set** of journal rows (or order by a deterministic tie-break such as a monotonic sequence), keeping the atomicity assertion intact. **Not in this CR** — the readiness authorities are frozen for this CR. |
| **Baseline proof** | identical at `126399f` — **fails in 4 of 4 baseline runs**, 2 of the 3 suites red each run (which two trip varies); at the FINAL REVIEW HEAD, **D-02 (permit) and D-03 (scheduling) tripped and D-04 (unit access) passed** — a different pair than the baseline runs, which is the family's nature |
| **Note** | PART 03 **cannot** be the cause: the PART 03 insertion happens **after** both journal rows and cannot reorder them. The flake is a property of the pre-existing assertion. |

### 2.3 D-05 … D-12 — the crew-worker-admission harness defect (S2)

| | |
| --- | --- |
| **Suite** | `tests/handyman-crew-worker-admission.test.ts` (crew & worker admission — CR-HM-WORKER-COMPETENCY-01 / CR-HM-04) |
| **Tests (8)** | "registered Crew assigns and reassigns atomically without booking or acceptance" · "registered no-login helper remains eligible through workforce identity and placement" · "failed registration revalidation leaves prior ACTIVE allocation and audit intact" · "execution proposal revalidates every member of existing allocation" · "valid execution proposal remains PROPOSED, with no confirmation or acceptance" · "inactive historical membership is not treated as an active task member" · "execution proposal rejects allocation Client mismatch even when Crew registration is valid" · "execution proposal rejects allocation/provider mismatch instead of borrowing Crew registration" |
| **Failure** | `42P01` — `relation "handyman_assignment_responses" does not exist`. The suite starts its own embedded PostgreSQL on port **55521** and calls `initDatabase(...)` **without `migrateUp`**, so the **migration 0472** table (the PART 01 assignment-response authority) is absent in that cluster. |
| **Owner** | **CR-HM-WORKER-COMPETENCY-01 / CR-HM-04** (the crew & worker-admission harness) |
| **Severity** | **S2** — the suite's **8 crew-admission safety assertions currently prove nothing**: they fail on a missing table before they can assert the assignment-revalidation, tenant-mismatch and provider-mismatch rules |
| **Production gate** | **G-7 (hygiene)** — not a release blocker for *this* CR (the crew-admission behaviour is unchanged by it), but the **crew/worker-admission rules are currently unguarded by the suite** |
| **Disposition** | Run `migrateUp` against the suite's own cluster (or point it at the migrated shared cluster). **Not in this CR** — it is another CR's harness. |
| **Baseline proof** | identical at `126399f` — the same 8 failures with the same `42P01` |

### 2.4 D-13 — the readiness OpenAPI parity guard (S2)

| | |
| --- | --- |
| **Suite** | `tests/handyman-readiness-api.test.ts` → "CR-HM-05 PART 06A — readiness HTTP/OpenAPI surface" |
| **Test** | "10: OpenAPI/runtime parity; ZERO target-binding/arrival/FM APIs" |
| **Failure** | the expected path list in the guard is **older than the published OpenAPI document**; the guard asserts a route set that the repository has since moved past (through unrelated CRs) |
| **Owner** | **CR-HM-05 PART 06A** (the readiness HTTP/OpenAPI surface) |
| **Severity** | **S2** — a **stale contract-parity guard** is worse than no guard: it reports a false red today and would report a false **green** for any real drift it no longer covers |
| **Production gate** | **G-7 (hygiene)** — not a release blocker |
| **Disposition** | Re-derive the expected path list from the current published contract. **Not in this CR** — PART 03 publishes **no** path, and the CR-HM-16 contract is frozen for this CR. |
| **Baseline proof** | identical at `126399f` |

### 2.5 D-14 … D-18 — the CR-BE-PUSH-01 legacy closure guards (S3 ×4, S2 ×1)

| | |
| --- | --- |
| **D-14** | `tests/push01-part04c-delivery-evidence-and-telemetry.test.ts` → "adds no migration 0337 and no new API route" — **S3** |
| **D-15** | `tests/push01-part04d-final-integration-closure.test.ts` → "confirms the final PART 04 migration state: 0334-0336 and no 0337" — **S3** |
| **D-16** | `tests/push01-part05-mobile-contract-and-openapi.test.ts` → "adds no migration — the governed sequence ends at 0336" — **S3** |
| **D-17** | `tests/push01-part06-closure-and-final-freeze.test.ts` → "closes the migration sequence at 0336 with no duplicate or gap" — **S3** |
| **D-18** | `tests/push01-part06-closure-and-final-freeze.test.ts` → "records which PUSH suites are still absent from the CI gate (B-03 OPEN)" — **S2** |
| **Owner** | **CR-BE-PUSH-01** (the native-push CR that wrote these closure guards) |
| **Failure** | **D-14 – D-17**: the repository already contains a `0337_…` migration from an unrelated CR, and the registry head has since moved past `0336` — the guards assert an **absence** that other CRs legitimately filled. **D-18**: `.github/workflows/ci.yml` does not exist in this checkout, so the guard cannot record the pipeline membership it asserts. |
| **Severity** | **D-14 – D-17: S3** — stale closure criteria of a **closed** CR; they assert the *absence* of a migration, not a broken behaviour. **D-18: S2** — it records a **real, open** gap: the PUSH suites genuinely are absent from the CI pipeline (release gate **G-6**). |
| **Production gate** | **D-18 → G-6 (CI gate B-03)** — a genuine release gate, tracked as such. **D-14 – D-17 → G-7 (hygiene)** |
| **Disposition** | D-14 – D-17: re-baseline the CR-BE-PUSH-01 closure criteria against the current migration sequence (a CR-BE-PUSH-01 follow-up). D-18: close the CI gate B-03 by adding the PUSH suites to the pipeline. **Not in this CR** — the guards belong to CR-BE-PUSH-01, and this CR must not rewrite another CR's closure criteria. |
| **Baseline proof** | identical at `126399f` (and at `9a15ad6` before PART 01) — 88/93 in the push01 batch, the same 5 reds |

---

## 3. Summary

| ID | Area | Count | Severity | Owner | Production gate |
| --- | --- | --- | --- | --- | --- |
| D-01 | BE-26A inbox record | 1 | S3 | CR-BE-NOTIFY-PROV-01 | G-7 |
| D-02 – D-04 | readiness journal-ORDER flake | 3 | **S2** | CR-HM-05 | G-7 |
| D-05 – D-12 | crew-worker-admission harness | 8 | **S2** | CR-HM-WORKER-COMPETENCY-01 / CR-HM-04 | G-7 |
| D-13 | readiness OpenAPI parity | 1 | **S2** | CR-HM-05 PART 06A | G-7 |
| D-14 – D-17 | CR-BE-PUSH-01 migration closure guards | 4 | S3 | CR-BE-PUSH-01 | G-7 |
| D-18 | CR-BE-PUSH-01 CI gate B-03 record | 1 | **S2** | CR-BE-PUSH-01 / CI owner | **G-6** |
| | **total** | **18** | **0 × S1, 5 × S2, 13 × S3** | | |

### 3.1 The two S2 families that deserve the first triage

1. **D-05 … D-12 (8 cases)** — a one-line harness fix (`migrateUp` on the suite's own cluster) restores **eight** crew-admission safety assertions. Highest value per line of any debt in this register.
2. **D-02 … D-04 (3 cases)** — a deterministic tie-break restores the **atomicity** assertion of the three readiness authorities, which is the assertion that proves "a failure leaves zero partial commits".

**D-18** is the only debt that maps onto a **release gate** rather than a hygiene item: until the PUSH suites are in the pipeline, the CI signal for this CR's own transports is missing.

### 3.2 The statement this register exists to make

> **None of the 18 is a defect of CR-HM-MULTICLIENT-NOTIFICATION-01.** Every one
> of them reproduces identically on the untouched certification baseline
> `126399f` (and the two families D-05…D-12 and D-14…D-18 also on `9a15ad6`,
> before PART 01). They are recorded here with owners, severities and gates so
> that they are **owed**, not forgotten — and they are **not** converted into
> passes anywhere in this CR: no assertion was weakened, no suite was deleted,
> and no failure was relabelled.
