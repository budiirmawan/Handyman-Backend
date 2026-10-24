# CR-HM-SERVICE-CATALOG-01 — FINAL REVIEW (Backend Integration & Release Readiness)

**Repository:** `budiirmawan/Handyman-Backend`
**Release branch:** `arena/d4d4105f-handyman-backend`
**HEAD:** `a999648b` — *"docs(migrations): reserve 0476 for the in-flight E2E PR #59, move this CR to 0477-0480"*
**Baseline under test:** `origin/main` = `ee20d21` (fetched, not assumed)
**Scope:** PART 01 + PART 02 + PART 03 of CR-HM-SERVICE-CATALOG-01
**Phase constraints honoured:** no merge, no deploy, no seed, no Biznet production PostgreSQL
contact, no new module implementation, no PR before this review.

This document is the review record. Every number below was **measured** in a
throwaway integration worktree; nothing is carried over from an earlier phase's
simulation.

---

## 1. HEAD and commit lineage

| Item | Value |
|---|---|
| Release branch HEAD | `a999648b` |
| Previous release commits | `c92a346b` (PART 03) → `08733cd2` (PART 02) → `dc4453d` (PART 02 code) → `82604d4`/`09ff9b8` (PART 01) |
| Merge base with `origin/main` | `9a15ad6b` |
| `origin/main` at review time | `ee20d21` (11 commits ahead of the merge base) |
| Working tree at review start | clean, in sync with `origin/arena/d4d4105f-handyman-backend` |
| Diff vs `origin/main` | **37 files, +14,587 / −36** |

The four Service-Catalog migrations, the new module, the OpenAPI surface, the
focused test suites and the delivery docs are all on the release branch. No
file outside this CR's scope was touched: the 37 changed files contain **no**
payment, settlement, BM-fee, finance, invoice, charge, Bast or QR module.

---

## 2. Merge readiness against the latest `main`

`main` was re-fetched with `git fetch --all --prune` and verified with
`git ls-remote` — it is still `ee20d21` and did not move during the review.

**Simulation A — this release lands first** (`/tmp/hm-final-sim`, branch
`tmp/final-review-sim`):

* `git merge origin/main` into the release branch → **exactly ONE conflict**:
  `src/database/migrations/index.ts` (the import block and the ordered array).
  Resolution: keep `0473`–`0475` from `main`, then append this CR's migrations
  in numeric order. **No migration is dropped from either side.**
* `docs/api/openapi.yaml`, `src/routes/index.ts` and `src/shared/errors.ts`
  auto-merge cleanly.
* `npx tsc --noEmit` → **clean**. `npm run build` → **exit 0**.
* PART 01–03 focused suites → **37/37 PASS**. Census + Handyman freeze →
  **28/28 PASS** after the census re-pin.
* Disposable PostgreSQL, FRESH → **477** migrations, 8 `handyman_service_*`
  tables, all key columns present, `0470`…`0479` contiguous, rollback ×2 →
  475 (the `0480` column gone), re-apply → 477.
* Upgrade path (`main` 473 → merged 477): 16 `handyman_service_*` tables, 2/2
  new columns, rollback ×4 → 473, re-apply → 477 — **an in-place, additive
  upgrade with no destructive step**.

**Simulation B — the E2E PR lands first** (`/tmp/hm-e2e-sim`, branch
`tmp/e2e-collision-sim`): see §3 and §7.

**Verdict:** the release branch merges into `main` with one mechanical
resolution in the migration registry. Readiness: **GO**.

---

## 3. Migration collision check

`main` ends at `0475`. The release branch originally claimed `0476`–`0479`.
The in-flight Backend E2E PR **#59** (`CR-HM-FIELD-OPERATIONS-01`, branch
`arena/a61abf59`) claims `0476_handyman_assignment_response_client_keys`
itself — a **same-number collision** that would put two migrations numbered
`0476` into `main`, plus two hard conflicts (`src/database/migrations/index.ts`
and `tests/handyman-contract-freeze-03-openapi.test.ts`).

**Resolution executed in this review** — `0476` is reserved for PR #59 and this
CR moves one step up:

| # | Migration | Was |
|---|---|---|
| 0476 | `0476_handyman_assignment_response_client_keys` | **reserved for PR #59** |
| 0477 | `0477_handyman_parameterized_service_catalog` | 0476 |
| 0478 | `0478_service_price_tier_key` | 0477 |
| 0479 | `0479_handyman_service_variant_attribute_lifecycle` | 0478 |
| 0480 | `0480_handyman_service_request_item_inherited_attributes` | 0479 |

`main`'s `0473`–`0480` is now contiguous **whichever order the two PRs land
in**. The renumber touches only migration ids, exported symbols, the registry
imports/array and the delivery docs — no SQL body changed, no schema changed,
and no environment had applied the old numbers (this CR was never merged or
deployed).

**Proof in the E2E-first tree** (`main` + PR #59 + this release): FRESH apply
→ **478** migrations, 8 catalogue tables, `service_price_key`,
`handyman_service_variant_attributes.status/deactivated_*` and
`inherited_attribute_values` all present, ledger `0470`…`0479` contiguous,
rollback ×2 → 476 (the `0480` column gone), re-apply → 478.

**Proof in the release-first tree** (`main` + this release): FRESH 477,
`0470`…`0479` contiguous, rollback → 475, re-apply → 477; upgrade from `main`
473 → 477 → rollback → 473 → re-apply 477.

---

## 4. OpenAPI parity

| Tree | Paths | Schemas | Operations |
|---|---|---|---|
| This release branch | 1,549 | 2,324 | 2,054 |
| Merged tree (`main` + PR #59 + this release) | 1,556 | 2,334 | 2,065 |

Parity is **asserted, not eyeballed**:

* `tests/openapi-operational-final-parity.test.ts` — every runtime route
  appears in the specification (normalised parity `2054/2054` on this branch,
  `2065/2065` on the merged tree), duplicate `operationId` = 0, broken local
  `$ref` = 0, zero authenticated documented operations without a canonical 401,
  platform SaaS control-plane untouched at **69**.
* `tests/openapi-operational-structural-closure.test.ts` — the reconciled
  census arithmetic, `RUNTIME_NOT_DOCUMENTED` = 1 (only the app root `GET /`),
  speculative routes = 0.
* `tests/handyman-contract-freeze-03-openapi.test.ts` — the Handyman surface
  is frozen and compared **set-wise** between the runtime router and the
  specification; the forbidden-path guard must stay empty.

Census pins (measured with the repo's own helper, not assumed):

| Pin | This branch | Merged tree (E2E first) |
|---|---|---|
| Total runtime routes | 2,056 | 2,067 |
| Platform SaaS runtime | 69 | 69 |
| Operational runtime | 1,987 | 1,998 |
| In-scope operational runtime | 1,986 | 1,997 |
| Distinct in-scope operational | 1,985 | 1,996 |
| Operational OpenAPI | 1,985 | 1,996 |
| OpenAPI total | 2,054 | 2,065 |
| Handyman surface / annotated | 294 / 197 | 301 / 203 |

---

## 5. Verification results

All runs below are **focused** (the suites this CR touches plus the census and
freeze guards). No full-suite rerun, no artificial delay, no polling loop.

| Check | Result |
|---|---|
| `npx tsc --noEmit` (release branch) | **clean** |
| `npm run build` (release branch) | **exit 0** |
| PART 01 focused suite | **15/15 PASS** |
| PART 02 focused suite | **12/12 PASS** |
| PART 03 focused suite | **10/10 PASS** |
| Census + freeze (release branch) | **28/28 PASS** |
| Release branch combined | **65/65 PASS** |
| Merged tree (main + PR #59 + release) | **37/37** Service-Catalog + **28/28** census/freeze = **65/65 PASS** |
| Merged tree typecheck | **clean** |
| Disposable PostgreSQL — fresh / rollback / re-apply (release-first) | 477 → 475 → 477 **PASS** |
| Disposable PostgreSQL — upgrade from `main` 473 | 473 → 477 → rollback → 473 → 477 **PASS** |
| Disposable PostgreSQL — fresh / rollback / re-apply (E2E-first) | 478 → 476 → 478 **PASS** |
| Affected regression (8 request / inspection / scope suites), release branch vs baseline `9a15ad6` | 64 tests / 61 pass / 3 fail on **both**, identical failing sets → **0 new failures** |

**Assertion-transparency ledger.** Exactly three assertions were re-pinned, all
of them size guards whose *content* guard was left untouched:

1. `handyman-contract-freeze-03-openapi.test.ts`: Handyman surface 287→294 and
   annotated 190→197 (this CR's own +7 route-guarded operations). The
   set-equality parity assertion and the forbidden-path guard are unchanged.
2. `handyman-quotations-api.test.ts`: quotation path count 10→14. The count was
   already stale in the baseline (12 paths vs an expectation of 10); the
   forbidden-path filter that actually guards the contract is unchanged.
3. `tests/price-catalog-entries.test.ts`: the hand-written SERVICE `INSERT`
   now carries `service_price_key` so the intended constraint is the one
   reported. **The test still fails exactly as before** — no failure is hidden.

No product assertion was weakened to manufacture a PASS.

---

## 6. Baseline defect assessment

The baseline (`9a15ad6`) carries **52 pre-existing failures** in the suites
this CR touches. Each was triaged against the Service-Catalog production path.

### 6.1 The 47 price-catalog failures — **NON-BLOCKING** (one-line follow-up CR)

*Root cause (proved, stack-traced):* `price-catalog-entry.service.ts:410` calls
`assertActiveAllowedCurrency` (the **raw** helper), which throws a plain
`Error`; the route maps it to **HTTP 500** instead of a 400. The
`client_allowed_transaction_currencies` fixture is never seeded by
`tests/price-catalog-entries.test.ts`, so the guard always trips. The typed
`assertActiveAllowedCurrencyCommand` (AppError → 400) already exists in
`src/modules/client-monetary-contexts/index.ts` and is simply unused.

*Why it does not block this release:* the defect is in the **price-catalog
entry authoring path**, not in the Service-Catalog pricing resolver. The
Service-Catalog suites seed the client's allowed currency (IDR) and pass 37/37;
the resolver enforces tier coherence and fails closed. The behaviour is also
identical on the baseline — this CR introduces **zero** new failures here.

*Follow-up (do NOT fix inside this release):* switch the service to the typed
`assertActiveAllowedCurrencyCommand` so the error is a 400 with the
`CLIENT_CURRENCY_NOT_ALLOWED` code. Changing it now would touch the OpenAPI
error-code parity surface during a release freeze. **Operational workaround:**
configure the Client monetary context before creating SERVICE price facts.

### 6.2 The 5 quotation failures — **NON-BLOCKING**

3× `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN` (the test acts as a tenant PIC
where the realm demands another actor), 1× `INVALID_SESSION` (401, expired
session fixture), 1× the `crewId` leak (see 6.3). All are fixture/authority
mismatches that reproduce identically on the baseline; the Service-Catalog
quotation lane (prepare → revision → approve) is exercised green in the
PART 03 suite with a tenant-PIC actor.

### 6.3 The `crewId` exposure — **REQUIRE SEPARATE CR** (pre-existing, out of scope)

`HandymanExecutionScopeAssignmentResponseView`
(`src/modules/handyman-scope-assignments/handyman-scope-assignment.types.ts`,
~line 72) returns `crewId`, `leadWorkerContextId`, `leadUserId`,
`respondedByUserId` and `respondedByWorkerId`; the same fields are published in
`docs/api/openapi.yaml` (~line 101323). It is reachable through the shared
approval → Execution-Scope-assignment lane, has **no coupling** to the Service
Catalog module (no shared table, service or route), and is not introduced by
this CR. It must be triaged in its own CR (response-view slimming +
spec + client impact) rather than smuggled into a Service-Catalog release.

### 6.4 Classification summary

| Defect | Count | Class | Evidence |
|---|---|---|---|
| Price-catalog currency guard returns 500 | 47 | NON-BLOCKING + follow-up CR | stack-traced root cause; identical on baseline; our suites seed the currency and pass |
| Quotation tenant-PIC / session fixture | 4 | NON-BLOCKING | identical on baseline; PART 03 proves the real actor flow green |
| `crewId` (and 4 sibling identifiers) in the scope-assignment response view | 1 | REQUIRE SEPARATE CR | pre-existing, spec-published, no Service-Catalog coupling |
| 3 `handyman-scope-variations` failures | 3 | NON-BLOCKING | identical failing set on release branch and baseline `9a15ad6` |

---

## 7. Backend E2E dependency

| Item | Value |
|---|---|
| E2E PR | **#59** — `CR-HM-FIELD-OPERATIONS-01`, branch `arena/a61abf59`, base `main`, **OPEN**, MERGEABLE/CLEAN, 67 files, +6,965/−77, created 2026-10-24 07:06:31Z |
| E2E migration | `0476_handyman_assignment_response_client_keys` |
| E2E freeze pin | 294 operations / 196 annotated |
| Shared files with this CR | 5 — `docs/api/openapi.yaml`, `src/database/migrations/index.ts`, `src/routes/index.ts`, `src/shared/errors.ts`, `tests/handyman-contract-freeze-03-openapi.test.ts` |
| Code dependency of this CR on #59 | **none** — this CR does not import, call or extend any #59 symbol |
| Coupling | the **migration-number space** and the **census/freeze size pins** only |

**Both landing orders are proven:**

* **#59 first** (simulation B): merging this release on top of `main` + #59
  yields **two** conflicts — `src/database/migrations/index.ts` and the freeze
  test — both resolvable by keeping both sides (registry `0473`…`0480` in
  numeric order; freeze summed to **301 operations / 203 annotated**).
  Verified in that tree: typecheck clean, Service-Catalog **37/37**, census +
  freeze **28/28** after re-pinning the census to **2,067 / 1,998 / 1,997 /
  1,996 / 2,065**, and a fresh disposable PostgreSQL applies **478** migrations
  and rolls back cleanly.
* **This release first**: #59 renumbers its `0476` → `0481` and re-pins its
  freeze to **301 / 203**. That is a mechanical change on the #59 side.

**Parallel starter branch.** `arena/379e97a6` (`d6e2a1b4`) carries a duplicate
PART 01 implementation (its own `service-catalog-master` module and
`0473_service_catalog_starter.ts`, whose `0473` already collides with `main`).
It has **no PR** and must be **superseded**, never merged.

---

## 8. GO / NO-GO for the Release PR

### **GO** — create ONE Release PR (Service Catalog) → `main`.

All release blockers that this review could identify are resolved or
classified out of scope with evidence:

* Migration-number collision with the in-flight E2E PR — **resolved**
  (`0476` reserved, this CR → `0477`–`0480`, both landing orders proven).
* Merge conflict against the latest `main` — **one mechanical conflict**, in the
  migration registry only, resolved by keeping both sides.
* OpenAPI / census / freeze parity — **asserted and green** on the release
  branch and on the E2E-first merged tree.
* Schema migration path — **additive**, proven fresh / upgrade / rollback /
  re-apply on disposable PostgreSQL.
* Baseline failures — **0 new**; the 52 pre-existing failures are classified
  (NON-BLOCKING / REQUIRE SEPARATE CR) with root causes, not suppressed.
* Approval, payment, settlement and BM-fee lifecycles — **untouched**: none of
  those modules appears in the 37 changed files; the only cross-module
  extension is `price_catalog_entries.service_price_key`, whose tier coherence
  is enforced in the resolver.

**Conditions carried into the PR body (no code work implied):**

1. Merge with `src/database/migrations/index.ts` resolved by keeping **both**
   sides in numeric order.
2. If #59 has landed first, re-pin the census to **2,067 / 1,998 / 1,997 /
   1,996 / 2,065** and the freeze to **301 / 203** before merging.
3. The follow-up CR for the price-catalog currency guard (500 → 400) is
   **not** part of this release.

**Explicitly NOT done here:** merge, deploy, seed, Biznet production contact,
or any change to the E2E branch.

---

## 9. Handoff contract

### 9.1 Operations Admin

| # | Instruction |
|---|---|
| O-1 | The Service Catalog is **governed**: a catalogue entry is `DRAFT` until it is activated; activation is the only moment it can be priced. Do not pre-create price facts for a `DRAFT` service. |
| O-2 | A service may carry **several simultaneously ACTIVE price tiers**; each fact carries a `service_price_key` (the tier key, e.g. the variant code or `''` for the plain tier). Two ACTIVE facts for the **same service + currency + scope** are rejected by a database constraint — the tier key is how coexistence is expressed, not a loophole. |
| O-3 | A price fact for a service needs a currency that the **Client monetary context allows** (`client_allowed_transaction_currencies`). If it is missing, authoring fails — today with a **500** (known defect, follow-up CR); the fix is to configure the Client monetary context. |
| O-4 | The resolver is **fail-closed**: an unknown attribute, a missing price rule, an ambiguous rule, a currency mismatch, a missing unit of measure or a missing commercial profile never produces a number. It resolves to `INSPECTION_REQUIRED` / `MANUAL_REVIEW` / `PRICE_NOT_AVAILABLE` and the quotation stays empty. **Never fabricate a price to close a ticket.** |
| O-5 | The unit price of a price fact must be **greater than zero** (database `CHECK`). A zero-price line is rejected by the API and by the database. |
| O-6 | Variant attributes have a **lifecycle** (`ACTIVE` / `INACTIVE` / `RETIRED`). Retiring one needs the administrator id. An `INACTIVE`/`RETIRED` choice is **never inherited** into new request items. |
| O-7 | A request item's inherited attribute values are **materialised** at creation: a later catalogue change never rewrites an existing item, and an approved quotation is immune to catalogue changes. To adopt a new catalogue value, create a **quotation revision**. |
| O-8 | Contradictions are refused: creating an item whose reported values contradict the selected variant returns **400**. Detaching a variant drops the inherited values; re-selecting a variant recomputes them and re-checks the contradiction. |
| O-9 | The Starter import is **idempotent and concurrency-safe**; it never overwrites existing data. Re-running it is safe. |
| O-10 | Access condition vocabulary (including `SPECIAL_EQUIPMENT`) is fixed by migration `0479`; it is not a per-service policy. |
| O-11 | RBAC is unchanged: catalogue reads need `service_catalog.read`, catalogue administration needs `service_catalog.manage`; tenant and Client/Building scope, audit trails and tenant isolation are preserved. |
| O-12 | Commercial model: **the customer pays Handyman directly; Handyman pays the BM cooperation fee.** Nothing in this CR changes that flow. |

### 9.2 Customer Care

| # | Instruction |
|---|---|
| C-1 | A service is quoted from the **catalogue + the customer's own reported attributes**. If an attribute is unknown or missing, the flow routes to **inspection** (`INSPECTION_REQUIRED`) or **manual review** — it never invents a price. |
| C-2 | The customer may state the attributes that matter (capacity, type, drive type, …). If what they state contradicts the selected variant, the request is **refused with a clear 400** — ask them to correct the value or pick a different variant; do not force it through. |
| C-3 | After an inspection, a **quotation revision** is issued (version 2, `ISSUED`) and the customer/tenant PIC **approves** it. Only an approved quotation becomes the commercial basis. |
| C-4 | Approvals require the tenant PIC actor and an **unexpired** validity window. An expired or not-yet-issued quotation cannot be approved — issue a revision. |
| C-5 | Request items are per-unit facts (quantity + unit of measure). A **mixed** request (e.g. several different capacities) is quoted as separate lines; there is no double charging for the same unit. |
| C-6 | The customer pays Handyman directly. Payment, settlement and the BM cooperation fee are **unchanged** by this release — Customer Care should continue to use the existing payment lane. |

### 9.3 Delivery record

* PART 01 — `docs/handyman/CR-HM-SERVICE-CATALOG-01_PART01.md`
* PART 02 — `docs/handyman/CR-HM-SERVICE-CATALOG-01_PART02.md`
* PART 03 — `docs/handyman/CR-HM-SERVICE-CATALOG-01_PART03.md`
* This review — `docs/handyman/CR-HM-SERVICE-CATALOG-01_FINAL_REVIEW.md`
