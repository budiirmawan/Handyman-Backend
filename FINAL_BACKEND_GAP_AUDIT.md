# FINAL BACKEND GAP AUDIT — PART 01

**Repository:** `budiirmawan/Handyman-Backend`
**Audit date:** 2026-10-24 (UTC)
**Audited baseline:** `fb65c17e7f48f4896df2104256aa5d25f6fd07b4` (`origin/main`, merged PR #60)
**Working branch:** `arena/2d32486d-handyman-backend`
**Mode:** Part 01 used audit-only static tracing plus small focused verification batches. Parts 02–09 record separately authorized, scoped remediation and disposable verification; no full-suite run, real-environment deployment/migration, or access to another repository occurred.

> ## Verdict
>
> **Backend FINAL FREEZE: NOT READY.**
> **Biznet/Coolify production release: NO-GO.**
> **Production migration: NO-GO.**
>
> No P0 cross-tenant authorization bypass, wrong Finance/Manager authority decision, or partial schema corruption was found. Part 01 identified three reproduced implementation defects, three core test-evidence defects, absent CI, and four environment/data/disaster-recovery gates.
>
> **PART 02 UPDATE:** BA-01 is now **CLOSED** at implementation/OpenAPI/focused-test level by `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_FCM_RESPONSE_SECURITY_REMEDIATION.md`. Real-device/provider activation remains BA-09. The overall verdict is unchanged.
>
> **PART 03 UPDATE:** BA-02 is now **CLOSED** at implementation/OpenAPI/focused-test level. Price Catalog creation uses the existing typed Client-currency command authority; ACTIVE but disallowed USD returns 400 `CLIENT_CURRENCY_NOT_ALLOWED`, no price/event/outbox rows are written, and unexpected infrastructure failures remain HTTP 500.
>
> **PART 04 UPDATE:** BA-03 is now **CLOSED** at implementation/disposable-recovery level. The existing runner refuses a populated 0478 SERVICE-price downgrade before destructive DDL, with explicit forward-fix/paired-restore guidance; the historical migration and registry are unchanged. Raw failure atomicity, CLI failure reporting, an isolated stopped-writer database restore, catalog reads, and controlled forward recovery were executed on disposable PostgreSQL. This is not a staging/production or native paired DB+evidence restore claim. BA-04 through BA-11 remain open, so the overall verdict is unchanged.
>
> **PART 05 UPDATE:** the previously unregistered replacement/correction defect is now registered as **BA-23 (P1)** and **CLOSED** at implementation/focused-test level. Valid replacement and correction reached a 25-column insert with only 24 expressions; `insertWithId()` now supplies the missing `$25` for the already-aligned `created_by_user_id` value. All 11 original failures pass, invalid-command rollback and concurrent-replacement conflict guards were added, and the separate stale direct-insert fixture was corrected without weakening its assertion. No migration or contract change was made. BA-04 through BA-11 remain open, so the overall verdict is unchanged.
>
> **PART 06 UPDATE:** BA-04 is now **CLOSED** at local test/evidence level. Fresh disposable-PostgreSQL reproduction measured 23 PASS / 45 FAIL / 0 SKIPPED across the 14 affected files, then fixture-only repairs restored the PIC, workforce-placement, dispatch, guarded-QC, and Lead-proposition arrangements without changing runtime code or authority. Final affected-file evidence is 67 PASS / 1 FAIL / 0 SKIPPED out of 68; the sole red is BA-14's independent over-broad OpenAPI schema selector, not a PIC or lifecycle failure. Dedicated PIC/scope authority checks pass 28/28, current OpenAPI checks pass 28/28, and typecheck passes. BA-05 through BA-11 remain open, so the overall verdict is unchanged.
>
> **PART 07 UPDATE:** BA-05 is now **CLOSED** at local test/evidence level. The unchanged crew-admission suite reproduced 18 PASS / 8 FAIL / 0 SKIPPED, all eight stopping on missing TEMP `handyman_assignment_responses`. A one-file fixture repair now models the real 0472/0476 response/history contract and existing notification-intent dependencies without mocking eligibility or `ensurePendingForAssignment`; all 26 cases pass. Migration-backed assignment-response and competency lanes add 5/5 and 11/11, OpenAPI remains 28/28, and typecheck passes. No runtime or contract change was made. BA-06 through BA-11 remain open, so the overall verdict is unchanged.
>
> **PART 08 UPDATE:** BA-06 is now **CLOSED** at local test/evidence level. The unchanged readiness suites reproduced 29 PASS / 1 FAIL / 0 SKIPPED, with scheduling case 9 reversing the two same-transaction event types under random UUID tie-breaking. Three test assertions now compare exact event-type/entity-ID multisets while retaining all rollback and row/event-count guards. Five complete repetitions passed 150/150, readiness HTTP/history/OpenAPI passed 10/10, the OpenAPI trio passed 28/28, and typecheck passed. No runtime, migration, or contract change was made. BA-07 through BA-11 remain open, so the overall verdict is unchanged.
>
> **PART 09 UPDATE:** Under the CR Owner's manual-certification decision, BA-07 is now **CLOSED at the local verification implementation/evidence boundary**. The clean canonical change retains the fail-closed runner, five lanes, self-tests, migration validators, and **621 PASS / 0 FAIL / 0 SKIPPED** previously recorded local product evidence across 58 files. Paid GitHub Actions and required hosted checks are deliberately not adopted; no workflow file is included. The 621 tests were not repeated during history reconstruction. Manual release approval before merging remains part of Final Review, and BA-08 through BA-11 remain open, so the overall verdict is unchanged.

## 1. Final counts

### Current open items after Part 09

| Measure | Count |
|---|---:|
| Open audit items | **15** |
| **P0** | **0** |
| **P1 — release/freeze blockers** | **4** |
| **P2 — non-blocking debt or conditional policy** | **11** |
| Items requiring a change in this Backend repository | **7** |
| ├─ Release-blocking Backend coding items | **0** |
| └─ Non-blocking Backend coding/test/contract debt | **7** |
| Items not requiring Backend coding | **8** |
| Unconditional Biznet-blocking items | **4** |
| Closed register items | **8 — BA-01, BA-02, BA-03, BA-23, BA-04, BA-05, BA-06, BA-07** (BA-23 was added and closed in Part 05; BA-04/BA-05/BA-06 closed in Parts 06/07/08; BA-07 closed at the manual-certification boundary in Part 09) |

### Part 01 baseline counts

| Measure | Count |
|---|---:|
| Open audit items | **22** |
| **P0** | **0** |
| **P1 — release/freeze blockers** | **11** |
| **P2 — non-blocking debt or conditional policy** | **11** |
| Items requiring a change in this Backend repository | **14** |
| ├─ Release-blocking Backend coding items | **7** |
| └─ Non-blocking Backend coding/test/contract debt | **7** |
| Items not requiring Backend coding | **8** |
| Unconditional Biznet-blocking items | **11** |

“Backend coding” here means a change in this repository, including application code, tests, OpenAPI, migration-integrity code, or local certification configuration. It does not mean new business modules. Conditional work in BA-21/BA-22 and optional notification rewiring in BA-20 are **not** included in either the Part 01 baseline 14 or the current 7. BA-23 was newly registered as a P1 implementation defect and closed in Part 05, so its add-and-close has net-zero effect on the open counts. BA-07's Part 09 closure reduces the current open P1 and Backend coding totals by one; all current totals above are recalculated from the register rows, not inferred from historical arithmetic alone.

### Classification distribution

| Classification | Count | IDs |
|---|---:|---|
| `PARTIAL` | 2 | BA-19, BA-20 |
| `MISSING` | 0 | — |
| `TEST-DEBT` | 6 | BA-12, BA-13, BA-14, BA-15, BA-16, BA-17 |
| `CONFIGURATION` | 6 | BA-08, BA-09, BA-10, BA-11, BA-21, BA-22 |
| `FRONTEND-DEPENDENCY` | 1 | BA-18 |
| `IMPLEMENTED` | 8 closed register items | BA-01 (Part 02), BA-02 (Part 03), BA-03 (Part 04), BA-23 (Part 05), BA-04 (Part 06), BA-05 (Part 07), BA-06 (Part 08), BA-07 (Part 09 manual source certification); other implemented capabilities are in `E2E_CAPABILITY_MATRIX.md` |

## 2. Authority model preserved by this audit

The following are audit rules, not proposals to redesign the product:

- **Customer Care** mediates tenant requests; it does not inherit Operations, Finance, QC, BAST, settlement, or CLOSE authority merely through a role name.
- **Operations/Manager `/admin`** is a consumer presentation surface. Backend authority lives in domain routes plus permission and exact-Building checks; a missing `/admin` URL prefix is not a missing Backend capability.
- **Field PWA and native Android** use the same server-side assignment, arrival, work, and evidence authorities. Clients never compute the authoritative geofence verdict, price, payment state, or settlement state.
- **Tenant quotation decisions** are personal to the active authorized Tenant PIC on an unexpired `ISSUED` version. Approval atomically creates the Execution Scope; rejection does not.
- **Finance**, not Care, a client payment callback, or a field actor, verifies payment evidence and confirms/rejects payments. No payment-gateway or bank rail is invented.
- **Manager CLOSE** is implemented by the permission pair `finding.close` + `handyman.finance.read`, exact-Building access, non-field-actor checks, and readiness gates. Canonical `MANAGER` holds the pair; role names alone grant nothing. Production custom-role grants still require live review.
- **BM/provider settlement** is an internal entitlement/reconciliation/settlement authority, not evidence that an external payout occurred and not SaaS subscription entitlement.
- **QC/BAST/service history is additive.** Fresh QC runs, defect rectification/reinspection, warranty claims, and warranty rework are the governed recovery path. Destructive generic `REOPENED` transitions are intentionally absent.
- **External PSrE/e-signature, bank-receipt attestation, and optional notification families** remain conditional policy decisions, not silently approved requirements.

## 3. Evidence actually used

### 3.1 Baseline and inventory

- PRs **#58, #59, and #60 are merged** and ancestral to the audited main. PR #47 is the only open Backend PR; it is conflicting and is not merged authority.
- Migration inventory: **478 files, 478 unique registry IDs, no duplicate file numbers, head 0480**. The 0449 and 0469 gaps are documented intentional/reserved gaps.
- Current OpenAPI checks passed **28/28**: **2,065 normalized operations**, **301 Handyman operations**, unique operation IDs, resolved local references, canonical auth metadata, and seeded-permission checks.
- `npm run typecheck`: **PASS**. No build or full repository test-suite PASS is claimed.

### 3.2 Focused execution at the audited baseline

| Focused batch | Result | Interpretation |
|---|---:|---|
| `cr-hm-service-catalog-01-part01` through `part03` | **37/37 PASS** | Parameterized catalog, variants, price resolution, starter import, quotation preparation/revision/decision |
| `handyman-e2e-finance-close-api`, `handyman-e2e-financial-reconciliation-close`, `handyman-arrival-configuration-part04` | **32/32 PASS** | Finance/close/reconciliation scenarios, RBAC/scope denials, QR/geofence configuration and supersession |
| Notification certification, producer part01, browser push part02, legacy `mobile-push-token` | **63 PASS / 9 FAIL** | All nine failures were authenticated mobile-token calls receiving 401 in the shared-DB invocation |
| Isolated embedded `mobile-push-token` rerun | **10/10 PASS** | Current token lifecycle works; the shared invocation is non-hermetic; returned raw tokens remain visible |
| OpenAPI operational parity, structural closure, Handyman freeze-03 | **28/28 PASS** | Static contract/census evidence, not live consumer compatibility |
| `handyman-scope-variations` | **3/3 PASS** | ADD, REDUCE, terminal/idempotency/concurrency behavior |
| `handyman-field-feed-authority` | **22/22 PASS** | Current field-feed authority; supersedes the historical FG-10 field-feed debt |
| `handyman-crew-worker-admission` | **18 PASS / 8 FAIL** | Eight cases stop on missing TEMP `handyman_assignment_responses`; 18 other admission checks pass |
| Care workspace admission + property scope | **28 PASS / 1 FAIL** | Admission 15/15; scope 13/14; only the stale exact route-family list fails |
| BM-fee prerequisite configuration | **5 PASS / 1 FAIL** | Only the impossible “no migration >=0416” closure assertion fails |
| Quotation API on a disposable migrated PostgreSQL | **6 PASS / 5 FAIL** | Three stale PIC-actor fixtures, one stale session fixture, one over-broad schema selector; zero skips in this run |

The first quotation attempts produced ten skips and one static failure because no default test database was available. Those skips were not counted as passes. The subsequent disposable-database run above is the authoritative result.

### 3.3 Direct defect reproductions

1. **Currency error mapping:** a real `POST /api/v1/price-catalog/entries` with the required idempotency header and an ACTIVE but non-Client-allowed USD returned **HTTP 500 `INTERNAL_SERVER_ERROR`**. The server logged the raw `Error: Currency is not allowed for client`. No invalid row was written.
2. **Populated 0478 rollback:** after a fresh 478-migration apply and insertion of two valid concurrent ACTIVE service-price tiers, rollback of 0480 and 0479 succeeded; 0478 failed while recreating `price_catalog_entries_service_window_exclusion`. The transactional runner retained head 0478 and retained `service_price_key`; no partial schema corruption was observed.
3. **Native token response:** source mapping and the isolated 10/10 lifecycle suite confirm that registration/list/deactivation responses contain the raw FCM `pushToken`, contrary to PR #58 P-6.5.

Scratch databases/scripts used for reproductions were removed. No assertion was changed.

### 3.4 Part 03 BA-02 remediation evidence

All Part 03 database runs used disposable PostgreSQL. Counts below are per invocation, not additive: the 65-test acceptance batch reruns the six-test BA-02 suite and the six-test Price Catalog OpenAPI suite.

| Focused invocation | Result | Evidence |
|---|---:|---|
| `price-catalog-currency-validation` before the production fix | **4 PASS / 2 FAIL / 0 SKIPPED** | Authorized ACTIVE-but-disallowed USD and INACTIVE JPY each returned the reproduced HTTP 500; price/event/outbox before-and-after equality assertions passed before the status assertions failed. |
| The identical BA-02 suite after the fix | **6 PASS / 0 FAIL / 0 SKIPPED** | Allowed USD 201; disallowed USD 400 `CLIENT_CURRENCY_NOT_ALLOWED`; inactive JPY 400 `CURRENCY_INACTIVE_OR_UNKNOWN`; unknown THB 400 `VALIDATION_ERROR`; 401/403/cross-Client denial; zero invalid writes; injected currency-lookup outage remains 500 `INTERNAL_SERVER_ERROR`. |
| BA-02 + Price Catalog OpenAPI + price selection + catalog parts 01–03 | **65 PASS / 0 FAIL / 0 SKIPPED** | Includes the 37 catalog variant/pricing/quotation tests and 16 selection tests; valid pricing and variant/quotation behavior remains green. |
| `cur02-part01-command-currency` on a separate disposable database | **8 PASS / 0 FAIL / 0 SKIPPED** | Existing Vendor/Service Cost and Basic Expense consumers retain active/allowed, inactive, unknown, legacy-read, and cross-Client behavior after the shared wrapper was narrowed. |
| Operational parity + structural closure + Handyman freeze + Price Catalog OpenAPI | **34 PASS / 0 FAIL / 0 SKIPPED** | The existing operational/structural/freeze trio remains 28/28 and Price Catalog adds 6/6 after documenting the two exact create-time currency errors. |
| `npm run typecheck` | **PASS** | Final TypeScript check after implementation and test changes. |

A broader bounded preservation invocation (`price-catalog-entries`, selection, vendor-tier, override, SERVICE reference price, BA-02, Price Catalog OpenAPI, and catalog parts 01–03) finished **95 PASS / 12 FAIL / 0 SKIPPED** out of 107 at Part 03. Every BA-02, selection, OpenAPI, and catalog variant/quotation assertion passed. The 12 reds were separate pre-existing residual failures, not BA-02 regressions: 11 replacement/correction cases reached `insertWithId` SQL with 25 values but only 24 placeholders, and one direct-insert guard tripped `price_catalog_entries_service_price_key_check` before its expected subject-shape CHECK. Part 03 did not repair, weaken, or conceal those failures and closed only BA-02. **Part 05 subsequently resolved all 12:** the 11 runtime failures are registered and closed as BA-23, and the stale fixture now supplies a valid plain tier key so its original subject-shape assertion executes. See §3.6; this Part 03 result is retained as historical failing-first evidence, not a current red count.

### 3.5 Part 04 BA-03 remediation evidence

All Part 04 downgrade, backup, restore, and recovery executions used disposable PostgreSQL 18.4. No Railway, Biznet, staging, or production database was accessed. Counts are per invocation, not additive.

| Focused invocation | Result | Evidence |
|---|---:|---|
| Initial five-test `migration-0478-recovery` suite before the runner guard | **3 PASS / 2 FAIL / 0 SKIPPED** | The populated runner attempt failed with the raw PostgreSQL error instead of the required safety message, and the single non-conflicting keyed tier down succeeded instead of being refused. Failure-atomicity assertions passed before those expected-control assertions failed. |
| Final `migration-0478-recovery` suite | **6 PASS / 0 FAIL / 0 SKIPPED** | Raw historical failure; populated runner + CLI refusal before mutation; single-tier silent-loss prevention; empty-data 0478 down/up; isolated stopped-writer restore and authenticated price reads; failed-new-migration rollback followed by forward-fix re-run. |
| Catalog parts 01–03 + BA-02 currency regression | **43 PASS / 0 FAIL / 0 SKIPPED** | Existing parameterized catalog, variants, tier pricing, quotation preparation/revision/decision, and currency behavior remain compatible. |
| `handyman-service-variants` with explicit disposable DB configuration | **6 PASS / 0 FAIL / 0 SKIPPED** | Executes the six cases that were environment-skipped in the auxiliary mixed invocation. |
| `npm run typecheck` | **PASS** | Final source TypeScript check. |

The raw historical reproduction migrated through 0480 and created two valid, overlapping ACTIVE SERVICE price rows distinguished only by `service_price_key`. After 0480 and 0479 were removed through the runner, historical 0478 down failed with **SQLSTATE `23P01`**, constraint `price_catalog_entries_service_window_exclusion`, and message `could not create exclusion constraint "price_catalog_entries_service_window_exclusion"`; PostgreSQL detail reported `conflicts with key`. The schema, all price-table columns/constraints, public table inventory, both tiers, catalog row, and ledger IDs/timestamps were unchanged after rollback. A separate raw historical attempt ran inside an explicit disposable transaction solely to retain this incompatibility evidence after the operational guard was installed; it is not an operator bypass.

The selected strategy is **A+B: forward-only paired backup/restore plus forward fix**. `src/database/migrate.ts` now preflights 0478 inside the existing migration transaction and advisory lock, before any 0478 DDL. Any populated SERVICE price catalog is refused because both keyed and plain rows would lose key identity and the historical up has no populated-row key backfill. The error reports total/keyed row counts and says to keep 0478 applied and use a forward fix or paired backup/restore. CLI exit is non-zero and no `Rolled back …` success line is emitted. Empty-data down/up remains executable. Migration 0478 and the canonical registry are byte-unchanged; no migration was added, renumbered, or given a second authority.

Strategy **C** is not approved: an older artifact has an older canonical registry and fails exact-history readiness on 0478–0480 IDs, while its SERVICE insert does not populate the non-null tier key. Strategy **D** was not used. Runtime 0477 price rules/quotation snapshots and current repositories depend on tier-aware behavior even though 0479/0480 have no direct `service_price_key` DDL reference; normal down order remains 0480, 0479, then guarded 0478.

The recovery proof stopped writers and the source PostgreSQL cleanly, copied its data directory, and started that copy as a fresh isolated server/port without reinitialization. The restored database retained all 478 ledger IDs/timestamps, the public table inventory, every price-table column/constraint, representative service-catalog data, and both valid tiers. Exact-history readiness passed, `migrateUp` was a no-op, and authenticated `GET /api/v1/price-catalog/entries/{id}` returned both restored keys with HTTP 200. A separate synthetic failed migration left neither DDL nor ledger state, then succeeded through the same runner after a forward fix.

This is **database-only physical disposable proof**, not a native `pg_dump`/`pg_restore` rehearsal, not a paired evidence-byte restore, and not a production RTO measurement. Native client binaries and live infrastructure were unavailable. Staging/target execution remains **BA-08**; scheduled encrypted off-host DB+evidence backup and measured paired restore remain **BA-11**. The recovery runbook records write freeze, recovery-point/RPO limits, RTO components, explicit loss approval, and single-writer cutover.

Auxiliary results are not hidden: a mixed legacy invocation finished **26 PASS / 1 FAIL / 6 SKIPPED** out of 33. Its six variant skips were subsequently executed 6/6 as above; its sole red was the already disclosed stale direct-insert subject-shape assertion, which tripped the tier-key CHECK first and was corrected in Part 05 without weakening the assertion. A separate legacy `migrate.test.ts` invocation finished **0 PASS / 1 FAIL / 0 SKIPPED**: after down succeeded through 0370, intentionally irreversible 0369 rejected every further down, so only 108 rather than all 478 IDs were pending on reapply. That pre-existing whole-history test limitation is outside BA-03; the new focused empty-data 0478 round-trip passed and no legacy assertion was weakened.

### 3.6 Part 05 BA-23 remediation evidence

All Part 05 database reproductions and verification runs used fresh, migrated, disposable PostgreSQL 18.4. No Railway, Biznet, staging, or production database was accessed. Counts are per invocation; historical failing-first counts are not added to final coverage.

| Focused invocation | Result | Evidence |
|---|---:|---|
| Original `price-catalog-entries` + `price-catalog-vendor-tier` + `price-catalog-override` before the fix | **25 PASS / 11 FAIL / 0 SKIPPED** out of 36 | Valid replacement/correction returned HTTP 500 `INTERNAL_SERVER_ERROR`; PostgreSQL logged `INSERT has more target columns than expressions` at `insertWithId()`. These are exactly the 11 previously disclosed runtime failures. |
| Temporary pre-fix HTTP rollback probe | **1 PASS / 0 FAIL / 0 SKIPPED** | After both valid commands returned 500, the predecessor remained ACTIVE with original price/window, null successor/deactivation fields, one catalog row, only its original two operational events, no outbox marker, and no persisted replacement/correction idempotency key. The probe was removed after reproduction. |
| Entries file with the two new replacement guards before the fix | **15 PASS / 3 FAIL / 0 SKIPPED** out of 18 | The original valid-replacement red plus both new guards failed: invalid replacement did not reach its governed overlap response and concurrent replacements produced 500/500. |
| The three focused files after the fix | **38 PASS / 0 FAIL / 0 SKIPPED** | All 11 original failures now pass, as do the new invalid-replacement rollback and concurrent-replacement guards. Covers replacement/correction success, immutable history/audit, idempotency, currency and validity windows, Client/Building authorization, tier isolation, overlap rollback, and RFQ reference-snapshot stability. |
| Complementary selection + Price Catalog OpenAPI + SERVICE reference + BA-02 currency + catalog parts 01–03 + variant-file invocation | **71 PASS / 0 FAIL / 6 SKIPPED** out of 77 | All executed tests passed, including the corrected subject-shape fixture, OpenAPI/runtime parity, quotation price bases/snapshots, tier and SERVICE pricing. The six skips were explicitly the older `handyman-service-variants` file's unavailable default database, not silent product skips. |
| `handyman-service-variants` against an explicit disposable PostgreSQL listener | **6 PASS / 0 FAIL / 0 SKIPPED** | Executed all six cases skipped by the preceding invocation; no database skip remains unverified in the final coverage. |
| `npm run typecheck` | **PASS** | Final TypeScript check after source, test, and fixture changes. |

The disjoint final file sets therefore executed **115 unique tests with 115 PASS / 0 FAIL / 0 SKIPPED after the explicit variant rerun** (38 focused + 71 complementary + 6 variants). This is bounded Price Catalog/catalog evidence, not a full-repository suite PASS.

The production root cause was narrow: `INSERT_COLUMNS` and `insertValues()` already defined the same 25 fields in the same order, and ordinary `insertEntry()` already used `$1` through `$25`. Only `insertWithId()`, called by replacement and correction after predecessor closure, stopped at `$24` while binding all 25 values. The omitted expression corresponded to the final `created_by_user_id` column. The repair adds only `$25`; column order, bound values, constraints, routes, permissions, service transactions, and update statements are unchanged. Related insert/update paths were inspected, no second caller or defect was found, and no migration was necessary.

The final guards prove an invalid open-ended replacement that overlaps another ACTIVE same-tier authority returns 409 `PRICE_CATALOG_WINDOW_OVERLAP` with both predecessors still ACTIVE, no successor/idempotency row, and no replacement audit event. Two concurrent replacements of one predecessor serialize to one 201 successor and one 409 `PRICE_CATALOG_NOT_ACTIVE`, with one lineage link and one audit trail. Existing correction overlap rollback, sequential idempotency conflict, historical RFQ snapshot, quotation snapshot, currency, cross-Client, tier-key, validity-window, SERVICE variant, and OpenAPI checks all remain green.

The separate stale fixture was not a second runtime defect: its SERVICE direct insert omitted the now-mandatory `service_price_key`, so the tier-key CHECK fired before the subject-shape CHECK it intended to test. The fixture now supplies the valid plain key `''`; the expected `price_catalog_entries_subject_shape_check` rejection is unchanged and now executes. No assertion or database constraint was weakened.

BA-23 is closed only at local implementation/focused-test level. It does not close staging/consumer verification **BA-08**, per-Client price population **BA-10**, or paired backup/restore **BA-11**, and it does not claim production readiness.

### 3.7 Part 06 BA-04 remediation evidence

All Part 06 database reproductions and verification runs used migrated, disposable PostgreSQL 18.4 on an isolated local listener. No Railway, Biznet, staging, or production database was accessed. Every affected file ran individually with explicit database configuration; counts below are exact per invocation, and no database-unavailable skip was promoted to a pass.

The failing-first run freshly measured **23 PASS / 45 FAIL / 0 SKIPPED out of 68** across the 14 affected files. Quotation was 6/5/0 (three BA-04 PIC failures plus two BA-14 failures), the nine work-session files were 10/32/0, building-scope part02 was 7/2/0, and BAST, chargeable additional work, and customer transaction were each 0/2/0. Nineteen failures reached the stale PIC decision actor; 24 shared work-session failures stopped at missing workforce-to-Building placement. Later runs exposed the next stale fixture prerequisites—dispatch release, guarded QC, and Lead-only chargeable proposal—rather than being hidden or bypassed.

The repair is test-only. Existing PIC-linked users now receive credentials/sessions where HTTP authentication is required and are the decision actors; an explicit administrator/non-PIC decision still returns 403 `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`. Lead/helper fixtures have the independently required active workforce Building placement. Work-session fixtures create a confirmed EXECUTION appointment and capacity reservation and call the real dispatch-readiness/release service before arrival and work. BAST/chargeable fixtures reuse the existing versioned Supervisor QC PASS helper with verified bytes. Chargeable PROPOSE uses the current Crew Lead while ACCEPT/REJECT retain their customer-side authority and exact-Building denial checks. No `src/` runtime file, OpenAPI document, migration, or production authority was changed.

| Final affected file on fresh disposable PostgreSQL | PASS | FAIL | SKIPPED |
|---|---:|---:|---:|
| `handyman-quotations-api` | 10 | 1 | 0 |
| `handyman-building-scope-guard-part02` | 9 | 0 | 0 |
| `handyman-bast-signoff-scope-guard` | 2 | 0 | 0 |
| `handyman-chargeable-additional-work-scope-guard` | 2 | 0 | 0 |
| `handyman-customer-transaction-scope-guard` | 2 | 0 | 0 |
| `handyman-work-session-checkin-start-scope-guard` | 2 | 0 | 0 |
| `handyman-work-session-close-scope-guard` | 2 | 0 | 0 |
| `handyman-work-session-commands` | 6 | 0 | 0 |
| `handyman-work-session-lifecycle` | 6 | 0 | 0 |
| `handyman-work-session-reads-scope-guard` | 2 | 0 | 0 |
| `handyman-work-session-workclock-scope-guard` | 2 | 0 | 0 |
| `handyman-work-session-workclock` | 6 | 0 | 0 |
| `handyman-work-sessions-api` | 6 | 0 | 0 |
| `handyman-work-sessions` | 10 | 0 | 0 |
| **Affected-file total** | **67** | **1** | **0** |

The only affected-file red is quotation case 10, the already registered **BA-14** selector that scans the separate `HandymanExecutionScopeAssignmentResponseView` schema and reports its authorized `crewId`. BA-04 quotation cases 6/7/9 pass, case 11's authenticated PIC session and approval now also pass, and the case-6 non-PIC negative remains explicit. This residual P2 test defect is disclosed rather than rewritten or counted as BA-04 evidence.

| Complementary invocation | Result | Evidence |
|---|---:|---|
| `handyman-tenant-decision-authority` + `handyman-quotation-decision` + `handyman-execution-scope` | **28 PASS / 0 FAIL / 0 SKIPPED** (6 + 12 + 10) | Exact active PIC, NULL/inactive/wrong-company/wrong-space denials, atomic APPROVE/REJECT and scope lineage, replay/conflict and rollback behavior. |
| `handyman-contract-freeze-03-openapi` + `openapi-operational-final-parity` + `openapi-operational-structural-closure` | **28 PASS / 0 FAIL / 0 SKIPPED** (13 + 7 + 8) | Current 2,065-operation / 301-Handyman-operation parity, IDs, references, authentication and permission metadata. |
| `npm run typecheck` | **PASS** | Final TypeScript check after all fixture/helper changes. |

The disjoint final bounded set therefore contains **123 PASS / 1 FAIL / 0 SKIPPED out of 124 tests** (68 affected + 28 authority + 28 OpenAPI). BA-04 is closed because its PIC-dependent assertions all execute and pass with zero skips and unchanged production authority. The single BA-14 red, BA-05/BA-06 core evidence debt, BA-07 CI, and BA-08 through BA-11 environment/consumer/data/recovery gates remain open. This is not a full-repository suite PASS or a production-readiness claim.

### 3.8 Part 07 BA-05 remediation evidence

Part 07 changed only `tests/handyman-crew-worker-admission.test.ts`. The suite owns its disposable embedded PostgreSQL cluster and TEMP fixtures; no Railway, Biznet, staging, production, or other real database was accessed. No full-repository suite was run.

The unchanged failing-first invocation measured **18 PASS / 8 FAIL / 0 SKIPPED out of 26**. Every red stopped with SQLSTATE `42P01`, `relation "handyman_assignment_responses" does not exist`, before the intended assignment/revalidation assertion. This freshly confirms the registered evidence defect rather than relying on PR #58's historical count.

The root cause is fixture drift, not a missing production table or runtime/security defect. Migration 0472 creates the canonical response and append-only event tables; 0476 adds the client idempotency key. Assignment and reassignment call the real `ensurePendingForAssignment` / `recordSupersededEvent` path in the same transaction, then use the existing assignment-notification producer. The isolated TEMP harness contained none of those current dependencies. The previous Worker Competency final review had repaired a different competency-table drift in this same suite; the Assignment Response certification separately proves the real 0472 schema, so neither historical record is treated as proof that the current harness was healthy.

The smallest repair adds the TEMP response/event columns and uniqueness keys used by the real repository, plus the existing IN_APP dedupe key and empty subscription surface needed by the real notification-intent path. No subscription is fabricated and no provider is invoked. `ensurePendingForAssignment`, competency evaluation, provider/crew/Lead/Building eligibility, and assignment/proposal services remain unmocked. Existing rejection assertions now also require zero response, response-event, and notification rows; the successful reassignment case additionally proves two PENDING responses and two `ASSIGNMENT_PENDING_CREATED` plus one `ASSIGNMENT_SUPERSEDED` event.

| Focused invocation | PASS | FAIL | SKIPPED | Evidence |
|---|---:|---:|---:|---|
| `handyman-crew-worker-admission` before the fixture repair | 18 | 8 | 0 | Exact eight-case `42P01` reproduction. |
| `handyman-crew-worker-admission` after the fixture repair | 26 | 0 | 0 | All eight formerly aborted cases and all 18 existing cases execute; provider/Client mismatch, member revalidation, prior-allocation preservation, and no-partial-write assertions pass. |
| `handyman-assignment-response-part02b` | 5 | 0 | 0 | Fully migrated disposable-schema Crew Lead/Inspector response, reassignment, notification, work-start, cross-Building, and rollback evidence. |
| `handyman-competency-assignment` | 11 | 0 | 0 | Fully migrated disposable-schema competency admission, every-member qualification, cross-Client/Building denial, and failed-reassignment preservation. |
| `handyman-contract-freeze-03-openapi` + `openapi-operational-final-parity` + `openapi-operational-structural-closure` | 28 | 0 | 0 | Current contract parity remains 13 + 7 + 8; no OpenAPI change was needed. |
| `npm run typecheck` | — | — | — | **PASS**, exit 0. |

The disjoint final test lanes therefore total **70 PASS / 0 FAIL / 0 SKIPPED out of 70** (26 + 5 + 11 + 28). BA-05 is closed at local evidence level only; live consumer/staging proof remains BA-08. BA-06 readiness-journal evidence and BA-07 CI remain release blockers. BA-14's separately registered quotation selector debt remains visible from Part 06 and was not changed, rerun, or counted in this Part 07 lane.

### 3.9 Part 08 BA-06 remediation evidence

Part 08 changed only `tests/handyman-permit-readiness.test.ts`, `tests/handyman-scheduling-readiness.test.ts`, and `tests/handyman-unit-access-readiness.test.ts`. All database execution used a fresh, local, disposable PostgreSQL cluster and isolated `asentra_ba06` database. No Railway, Biznet, staging, production, or other real database was accessed, and no full-repository suite was run.

The unchanged failing-first invocations produced the following fresh baseline:

| Unchanged suite | PASS | FAIL | SKIPPED | Result |
|---|---:|---:|---:|---|
| `handyman-permit-readiness` | 10 | 0 | 0 | Passed this invocation; retained the same latent random-order assertion. |
| `handyman-scheduling-readiness` | 9 | 1 | 0 | Case 9 returned `CREATED, CREATED, SUPERSEDED` instead of `CREATED, SUPERSEDED, CREATED`. |
| `handyman-unit-access-readiness` | 10 | 0 | 0 | Passed this invocation; retained the same latent random-order assertion. |
| **Total** | **29** | **1** | **0** | Fresh reproduction of the registered flake family. |

The root cause is test-harness ordering debt, not a reproduced production atomicity or event-delivery defect. `recordOperationalEvent` generates a random UUID for each event. The two supersession journal inserts occur in one transaction, whose `created_at` defaults to transaction-scoped `NOW()`; therefore `ORDER BY created_at ASC, id ASC` breaks their timestamp tie by random UUID. The readiness API contract requires deterministic readiness-row history and supersession links, not operational-event ordering by UUID. No new sequence, migration, runtime reordering, or notification change is justified by this evidence.

The smallest correction removes that false chronological assumption from the three assertions. Each now sorts and compares the exact `(event type, entity ID)` multiset: two CREATED events must reference the original and replacement readiness rows, and one SUPERSEDED event must reference the original row. The existing guards still require rejected supersede and duplicate-create attempts to leave readiness and operational-event counts unchanged, and successful supersession to add exactly one readiness row and two operational events. This strengthens entity-content verification without weakening count, rollback, authorization, or lifecycle assertions.

| Post-repair invocation | PASS | FAIL | SKIPPED | Evidence |
|---|---:|---:|---:|---|
| `handyman-permit-readiness`, five complete repetitions | 50 | 0 | 0 | Ten distinct cases per round; case 9 exact journal multiset and rollback guards pass every round. |
| `handyman-scheduling-readiness`, five complete repetitions | 50 | 0 | 0 | Ten distinct cases per round; the freshly reproduced order flake does not recur. |
| `handyman-unit-access-readiness`, five complete repetitions | 50 | 0 | 0 | Ten distinct cases per round; case 9 exact journal multiset and rollback guards pass every round. |
| `handyman-readiness-api` | 10 | 0 | 0 | HTTP create/read/supersede/history, permission, anti-smuggling, deterministic readiness history, and OpenAPI/runtime parity. |
| `handyman-contract-freeze-03-openapi` + `openapi-operational-final-parity` + `openapi-operational-structural-closure` | 28 | 0 | 0 | Current 13 + 7 + 8 contract checks; no OpenAPI change was needed. |
| `npm run typecheck` | — | — | — | **PASS**, exit 0. |

The final bounded execution total is **188 PASS / 0 FAIL / 0 SKIPPED out of 188 executed results**: 150 repeated readiness-service results (30 distinct cases × five rounds), ten readiness HTTP cases, and 28 OpenAPI cases. There are **68 distinct final cases** (30 + 10 + 28); the repeated executions are reported separately rather than presented as distinct coverage. BA-06 is closed at local test/evidence level only. BA-07 CI and BA-08 through BA-11 consumer/environment/data/recovery gates remain open; BA-14 remains independent P2 debt and was not changed, rerun, or counted here. This is not a full-suite or production-readiness claim.

### 3.10 Part 09 — BA-07 manual release source certification

The CR Owner replaced the hosted-CI approach with a manual local/Arena certification policy. The clean canonical change is based directly on `de33600` and retains the checked-in 58-file manifest, per-file TAP runner, runner self-test, migration-registry and fresh CLI lifecycle validators, and `docs/HANDYMAN_CI_SOURCE_CERTIFICATION.md`. It contains **no GitHub Actions workflow addition** and no required-check or branch-protection dependency. Node.js 22, locked `npm ci`, PostgreSQL 18, disposable local databases, per-file timeouts, and TAP/JSON/Markdown evidence remain mandatory.

The five manual verification lanes and their previously recorded local results are:

| Lane | Files | PASS | FAIL | SKIPPED | Evidence |
|---|---:|---:|---:|---:|---|
| `static-contracts` | 3 | 28 | 0 | 0 | Typecheck and static contract evidence. |
| `catalog-commerce` | 12 | 123 | 0 | 0 | BA-02 and BA-23 regressions included. |
| `core-lifecycle` | 31 | 254 | 0 | 0 | BA-04/05/06 and bounded BA-14/BA-15 selections included. |
| `notification-security` | 11 | 210 | 0 | 0 | BA-01 response-security/native/browser lanes included. |
| `migration-recovery` | 1 | 6 | 0 | 0 | BA-03 disposable recovery suite. |
| **Total product results** | **58** | **621** | **0** | **0** | Local evidence, not GitHub-hosted CI evidence. |

The same local evidence recorded typecheck PASS, **478 files = 478 registry entries**, head `0480_handyman_service_request_item_inherited_attributes`, fresh CLI apply/status 478, and a no-op second apply with unchanged IDs/timestamps. The synthetic runner self-test proved a passing control exits zero and deliberate failure/skip fixtures exit nonzero. The runner continues to reject timeouts, missing summaries, nonzero exits, failures, cancellations, skips, todos, and PASS/TESTS count drift.

Per the Owner's explicit direction, the 621 product tests were **not repeated** while reconstructing clean pushable history. The table is retained as evidence from the pre-reconstruction implementation tree, not represented as a new execution on the replacement SHA or as hosted evidence. The reconstruction changes only certification policy/scripts and records; product tests, runtime, migrations, OpenAPI, and production configuration are unchanged.

Three checked-in selections still exclude only the registered BA-13 global 0336-cap case, BA-14 quotation case 10, and BA-15 BM-fee t1, while requiring exactly 17, 10, and 5 passing results respectively. They do not close those P2 items; BA-14 remains independent P2 debt.

**Closure boundary:** BA-07 is closed because the Owner-approved manual verification mechanism and local evidence are implemented and retained. The runbook requires source SHA, UTC timestamps, archived TAP/JSON/Markdown evidence with a SHA-256 digest, and named manual approval before merging. That approval remains pending Final Review. Automated GitHub checks are deliberately not adopted and are not claimed. BA-08 through BA-11 and production release/migration remain open/NO-GO.

## 4. Severity and blocking rules

- **P0:** proven critical exploit/data loss/wrong business authority or corruption requiring immediate incident handling.
- **P1:** must close before FINAL FREEZE or production sign-off; includes core safety evidence that currently cannot execute reliably.
- **P2:** limited hygiene/scalability debt or a conditional policy decision; not an unconditional Biznet blocker under the currently approved scope.
- **Biznet-blocking YES/NO** is independent of whether an item needs Backend coding. A fully green repository-wide `npm test` is not claimed; if release policy later makes that an absolute gate, every remaining red test also becomes a mechanical pipeline blocker.

## 5. P1 gap register — release/freeze blockers

| ID | Priority | Persona / stage | Expected behavior | Actual evidence and exact references | Classification | Impact | Required solution | Backend coding | Biznet-blocking |
|---|---|---|---|---|---|---|---|---|---|
| **BA-01** | **P1** | Android / push registration; sensitive data | FCM token is write-only in requests and absent from every response, evidence row, event, and log (PR #58 P-6.5). | `src/modules/push-tokens/push-token.service.ts:74-89` maps `pushToken`; the same mapper is used at `:276`, `:310`, `:324`, `:356`, `:372`. `src/modules/push-tokens/push-token.types.ts:63-77` and `docs/api/openapi.yaml:107225+` publish it. Browser responses omit equivalent secrets. Isolated lifecycle suite: 10/10, proving behavior but not secrecy. **PART 02 STATUS — CLOSED:** public mapper/type and OpenAPI no longer expose the token; native register/list/delete, delivery, browser and contract evidence is recorded in `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_FCM_RESPONSE_SECURITY_REMEDIATION.md`. Production device/provider sweeps remain BA-09. | `IMPLEMENTED` in Part 02 (was `PARTIAL`) | Credential reflection violates the approved custody law and can leak through client telemetry/logged responses; real-device P-6.5 cannot pass. | Remove the token from all registration/list/deactivation DTOs and OpenAPI responses, keep it required only on input, add response/log/evidence sweeps, and coordinate the Android contract change. **Implemented and verified in Part 02.** | **YES — completed** | **NO after Part 02; BA-09 remains blocking** |
| **BA-02** | **P1** | Operations/catalog admin / SERVICE price authoring | Disallowed ACTIVE currency returns governed 400 `CLIENT_CURRENCY_NOT_ALLOWED`, never an unhandled 500. | **PART 03 STATUS — CLOSED:** the create command now calls `assertActiveAllowedCurrencyCommand`; the existing wrapper translates only `CLIENT_CURRENCY_NOT_ALLOWED` and `CURRENCY_INACTIVE_OR_UNKNOWN` and rethrows unexpected failures. Failing-first HTTP 500 and rollback evidence plus post-fix 6/6 HTTP regression, 65/65 acceptance, 8/8 shared-currency, 34/34 OpenAPI, and typecheck evidence are in §3.4. No migration was added; the create operation now names both exact 400 codes. | `IMPLEMENTED` in Part 03 (was `PARTIAL`) | The former generic server fault and noisy raw domain error are removed from Price Catalog creation; genuine infrastructure failures remain server errors. | **Implemented and verified in Part 03:** reuse the typed command guard, preserve the raw authority for internal callers, prove no price/event/outbox write, and retain valid creation/idempotent replay and tenant denial. | **YES — completed** | **NO after Part 03; BA-06 through BA-11 remain blocking** |
| **BA-03** | **P1** | Platform/DBA / migration rollback | Rollback with valid 0478 data either restores the prior schema safely or stops before mutation with an explicit data decision; never silently deletes tiers. | **PART 04 STATUS — CLOSED locally:** the existing runner rejects populated 0478 down before DDL with row counts and forward-fix/paired-restore guidance; runner/CLI failures preserve schema, tiers and ledger, empty-data down/up remains, and disposable stopped-writer restore plus controlled forward recovery passed. Raw SQLSTATE 23P01, single-tier loss prevention, 6/6 focused tests and recovery-runbook scope are in §3.5. Historical 0478/registry are unchanged. | `IMPLEMENTED` in Part 04 (was `PARTIAL`) | Unsafe populated down is now stopped rather than erasing tier identity or relying on a constraint failure. No staging/native paired-restore or production claim is made. | **Implemented and verified in Part 04:** forward-only A+B control and operator documentation. Execute the same approved strategy on the actual staging/target copy under BA-08 and automated paired DB+evidence recovery under BA-11. | **YES — completed** | **NO after Part 04; BA-06 through BA-11 remain blocking** |
| **BA-04** | **P1** | Tenant PIC, Operations, Manager / quotation-dependent safety suites | Fixtures decide quotations as the active PIC-linked user, so assignment/work/BAST/finance assertions execute without weakening PIC-personal authority. | **PART 06 STATUS — CLOSED locally:** fresh failing-first evidence was 23 PASS / 45 FAIL / 0 SKIPPED across 14 files. Fixture-only repairs now use authenticated PIC decision actors, valid workforce Building placements, real dispatch release, guarded QC, and current-Lead chargeable proposal. Final affected evidence is 67 PASS / 1 FAIL / 0 SKIPPED out of 68; the sole red is BA-14's unrelated schema selector. Dedicated PIC/scope checks are 28/28, OpenAPI 28/28, and typecheck PASS; exact per-file counts are in §3.7. | `IMPLEMENTED` in Part 06 (was `TEST-DEBT`) | PIC, assignment, work-session, BAST, chargeable, customer-transaction, and exact-Building assertions now execute locally. No runtime transition or cross-tenant defect was reproduced, and no production/live-consumer claim is made. | **Implemented and verified in Part 06:** preserve PIC-personal and non-PIC 403 behavior, approval/assignment/dispatch sequencing, additive QC/BAST history, Lead/customer chargeable separation, and exact-Building isolation. Reverify with real consumers under BA-08. | **YES — completed** | **NO after Part 06; BA-06 through BA-11 remain blocking** |
| **BA-05** | **P1** | Operations/Crew Lead / worker admission and assignment | The isolated crew-admission harness models the current assignment-response dependency and executes all 26 safety cases. | **PART 07 STATUS — CLOSED locally:** unchanged failing-first evidence was 18 PASS / 8 FAIL / 0 SKIPPED, all SQLSTATE 42P01 on the absent TEMP response table. The one-file TEMP fixture now models 0472/0476 response/history and current notification-intent dependencies without mocking the real eligibility or response chain. Final admission 26/26, migration-backed assignment-response 5/5, competency 11/11, OpenAPI 28/28, typecheck PASS; all have zero skips. See §3.8. | `IMPLEMENTED` in Part 07 (was `TEST-DEBT`) | All eight previously aborted assignment/revalidation/provider/Client-mismatch cases now execute, and the original 18 checks remain meaningful. No production missing table, cross-tenant bypass, or runtime transition defect was found. | **Implemented and verified in Part 07:** retain real `ensurePendingForAssignment`, response history, notification dedupe, provider/crew/Lead/Building eligibility, and zero-partial-write assertions. Reverify with real consumers under BA-08. | **YES — completed** | **NO after Part 07; BA-06 through BA-11 remain blocking** |
| **BA-06** | **P1** | Operations / scheduling, permit, and unit-access readiness | The mutation+journal atomicity tests are deterministic and cannot pass/fail because of random UUID ordering. | **PART 08 STATUS — CLOSED locally:** fresh unchanged evidence was 29 PASS / 1 FAIL / 0 SKIPPED, with scheduling case 9 reversing the same-transaction CREATED/SUPERSEDED pair. The three test assertions now compare exact event-type/entity-ID multisets and retain all rollback/count guards. Five complete repetitions passed 150/150, readiness HTTP 10/10, OpenAPI 28/28, and typecheck PASS, all with zero skips. See §3.9. | `IMPLEMENTED` in Part 08 (was `TEST-DEBT`) | Deterministic zero-partial-commit evidence is restored without a runtime change. No production atomicity, notification, tenant-isolation, or lifecycle defect was reproduced. | **Implemented and verified in Part 08:** assert exact event/entity content without random UUID chronology; preserve rejected-operation count equality and successful one-row/two-event atomicity. Reverify with real consumers under BA-08. | **YES — completed** | **NO after Part 08; BA-07 through BA-11 remain blocking** |
| **BA-07** | **P1** | Release owner / all stages | A repeatable fail-closed source-certification mechanism covers typecheck, contract, migration, lifecycle, and notification/push lanes with visible failures and retained evidence. | **PART 09 STATUS — CLOSED AT MANUAL-CERTIFICATION BOUNDARY:** the CR Owner selected the local/Arena runner and deliberately rejected paid GitHub Actions/required-check adoption. The clean canonical change contains no workflow file. Five lanes and exact TAP/count validation remain; previously recorded local product evidence is 621/0/0 across 58 files, with typecheck, 478/478 registry, CLI lifecycle, and failure/skip self-test evidence. The 621 tests were not repeated during reconstruction. See §3.10. | `IMPLEMENTED` in Part 09 (was `CONFIGURATION`) | The manual mechanism can certify a reviewed source SHA without hosted CI. It does not itself approve a merge or prove live consumer/provider/infrastructure/data/recovery readiness. | **Implemented under the Owner policy:** retain the runbook and artifacts, record SHA/timestamps/evidence digest, and obtain named manual approval before merging. Final Review approval and BA-08 through BA-11 remain pending; any later source change requires new evidence or explicit Owner acceptance. | **YES — completed** | **NO after Part 09; BA-08 through BA-11 and final approval remain blocking** |
| **BA-08** | **P1** | Care Frontend, Operations/Manager, PWA, Android, Platform / integrated staging | Real consumers and a production-like Coolify environment prove compatibility, exact IAM/Building grants, migrations, HTTPS/CORS, persistent evidence, one writer/scheduler, restart persistence, and load smoke. | `docs/contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_PENDING_GAP_REGISTER.md:24-25` records FG-03/FG-04 open. This audit ran only disposable/local evidence and did not enter consumer repositories. `docs/HANDYMAN_BIZNET_COOLIFY_DEPLOYMENT.md:120-145` is procedural; no staging/production migration status, live E2E, load test, or deployment evidence exists. | `CONFIGURATION` | Source-level parity cannot prove browser/APK compatibility or live infrastructure behavior. | With BA-01/BA-02/BA-03 closed and after BA-04…BA-07, deploy the release candidate to isolated staging; run consumer order Care → Operations/Manager → PWA → Android, positive/negative IAM cases, migration status/up and rollback rehearsal, storage restart, and load smoke. Attach consumer-signed reports. | **NO** | **YES** |
| **BA-09** | **P1** | Platform/Operations + browser/Android / notification activation | VAPID/FCM credentials, provider selectors, per-tenant rules/templates, registered devices, real delivery, dedupe/retry, and no-secret evidence are proven. | Real IN_APP/Web Push/FCM adapters exist, but `.env.example:29` uses `PUSH_PROVIDER=noop`; `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PRODUCTION_PREREQUISITES.md:115-137,145-167` records P-6.x/G-1…G-7 environment and real-device gates. The Part 01 BA-01 response violation is closed in Part 02; production P-6.5/provider/device evidence remains unexecuted. | `CONFIGURATION` | Deploying code alone produces no governed notification delivery; provider/device behavior remains unproven. | Provision secrets outside Git, configure `webpush`/`fcm` only in the intended environment, create ACTIVE templates/rules before fan-out, and run physical browser/Android delivery, rotation, retry, dedupe, isolation, and secret-sweep checks. | **NO** (apart from BA-01/BA-07) | **YES** |
| **BA-10** | **P1** | Operations/Finance / per-Client catalog and commercial data | Each production Client has an explicit idempotent 8-category/24-service import, monetary context, ACTIVE tier price facts, and approved commercial/BM term/beneficiary configuration. | `handyman-parameterized-catalog.starter.ts:7-29` defines 8/24 and deliberately **no amounts**; import is explicit through `/service-catalog/parameterized/starter-import`, not automatic seed. Catalog engine tests are 37/37, but no persisted production population or pricing/BM readback was supplied. | `CONFIGURATION` | An implemented engine can still yield an empty/unpriced catalog or fail-closed quotation/BM evaluation. The engine must not be confused with actual 24-service operational data. | Run and record the import per Client; verify stable codes/counts/no duplicates; configure allowed currencies and real price tiers; approve commercial agreements and BM prerequisites; execute quote/settlement readbacks. | **NO** | **YES** |
| **BA-11** | **P1** | Platform/DBA / backup and disaster recovery | Scheduled encrypted off-host paired PostgreSQL+evidence backups, retention, and a measured isolated restore drill prove RPO/RTO. | `docs/HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md:3-6` explicitly says no automatic backup/retention/live restore; `:25-41` marks policy recommendations; `:75-104` is a procedure, not executed evidence. | `CONFIGURATION` | Database dumps alone omit evidence bytes; recovery, integrity, and restoration time are unproven. | Implement operator/platform-owned scheduling, encryption, off-host retention and alerting; perform a paired restore into isolation; verify DB/evidence references, hashes, migration history, grants, startup and restart; record RPO/RTO. | **NO** | **YES** |
| **BA-23** | **P1** | Operations/catalog admin / Price Catalog replacement and governed correction | Valid replacement/correction creates exactly one ACTIVE successor atomically, preserves predecessor history and audit, and replays/conflicts under the established idempotency and row-lock policy. | **PART 05 STATUS — CLOSED locally:** failing-first reproduction returned HTTP 500 in 11 cases because `insertWithId()` supplied 24 expressions for 25 aligned columns/values. The repository now includes `$25` for `created_by_user_id`; ordinary creation and all service/update authorities are unchanged. Pre-fix rollback was observed directly; final focused 38/38, complementary 71/71 executed, explicit variants 6/6, and typecheck evidence are in §3.6. | `IMPLEMENTED` in Part 05 (newly registered P1 defect) | Before the fix, valid replacement and correction could not create successors; failed transactions left no partial writes. Normal creation was unaffected, and no cross-tenant, history-rewrite, or financial-authority defect was reproduced. | **Implemented and verified in Part 05:** add the missing placeholder, retain column/value order and database constraints, add invalid-replacement rollback and concurrent-replacement guards, and correct the separate stale fixture without weakening its subject-shape assertion. Reverify on the exact release candidate under BA-08. | **YES — completed** | **NO after Part 05; BA-06 through BA-11 remain blocking** |

## 6. P2 gap register — non-blocking debt and conditional decisions

| ID | Priority | Persona / stage | Expected behavior | Actual evidence and exact references | Classification | Impact | Required solution | Backend coding | Biznet-blocking |
|---|---|---|---|---|---|---|---|---|---|
| **BA-12** | **P2** | Notification inbox / legacy contract test | The exact public-record assertion includes the governed `navigationTarget` projection. | `src/modules/notifications/notification.service.ts:40-54` returns `navigationTarget` at `:50`; `tests/notification.test.ts:191-209` still asserts an exact key list without it. Historical PR #58 D-01; source mismatch remains, not freshly re-executed here. | `TEST-DEBT` | Stale red test; the record write/public projection itself is not shown defective. | Update the exact expectation and assert null/present navigation-target behavior without removing existing fields. | **YES** | **NO** |
| **BA-13** | **P2** | Native push / historical closure guards | Closure tests prove PR-local migration invariants, not that the whole repository forever ends at 0336 or never gains 0337. | `tests/push01-part05-mobile-contract-and-openapi.test.ts:504-511` asserts no 0337; sibling part04c/part04d/part06 guards pin the 0336 end state while actual head is 0480. Historical D-14…D-17. **Part 02 rerun:** Part 05 finished 17 PASS / 1 FAIL / 0 SKIPPED; the sole failure was this exact no-0337 assertion. | `TEST-DEBT` | Four stale closure failures, no runtime migration defect implied. | Scope assertions to the CR change set or rebaseline them while preserving registry uniqueness/order checks. | **YES** | **NO** |
| **BA-14** | **P2** | Tenant/quotation contract tests | The suite uses a live session and scans only quotation-reachable response schemas for downstream fields. | **Part 06 current run: 10 PASS / 1 FAIL / 0 SKIPPED.** The authenticated PIC fixture repaired case 11 and all three BA-04 actor reds. Sole remaining red: case 10 scans every `HandymanExecutionScope*` schema and catches `crewId` in the separate authorized assignment response. | `TEST-DEBT` | One false “leak” signal prevents the legacy suite from being green. No quotation-response `crewId` leak is proven; the catalog quotation lane and current OpenAPI trio are green. | Traverse actual quotation response `$ref`s; retain the repaired live PIC session and anti-smuggling assertion. Treat assignment-DTO minimization, if desired, as a separately approved contract decision—not as a proven cross-tenant leak. | **YES** | **NO** |
| **BA-15** | **P2** | Care workspace and BM fee / structural guards | Exact route/migration pins reflect approved growth or remain scoped to the original CR diff. | Current Care batch 28/29: admission 15/15, scope 13/14; only `tests/handyman-care-workspace-scope.test.ts:322-327` rejects legitimate newer Care routes. BM fee 5/6: only `tests/handyman-bm-fee-prerequisite-configuration.test.ts:198-211` expects no migration >=0416 despite head 0480. | `TEST-DEBT` | False missing-capability/closure signals; all runtime assertions in these two suites passed. | Rebaseline or scope the structural assertions, retaining explicit phantom-route and duplicate-registry negative controls. | **YES** | **NO** |
| **BA-16** | **P2** | Android token tests / test harness | The default focused invocation is hermetic or declares its external DB requirement explicitly. | Shared-DB notification batch produced nine 401s; isolated embedded `mobile-push-token` passed 10/10. `tests/mobile-push-token.test.ts` is the affected suite. This is harness debt, not an Android runtime regression. | `TEST-DEBT` | Misleading failure signal and unreliable local/CI reproduction. | Give the suite the same embedded bootstrap/profile in CI and document required env for shared mode; retain lifecycle coverage and add BA-01 secrecy checks. | **YES** | **NO** independently; CI closure is BA-07 |
| **BA-17** | **P2** | WhatsApp webhook / OpenAPI hygiene | Published error codes are registered in the shared catalog or explicitly marked route-local. | `src/modules/whatsapp-callback/whatsapp-callback.routes.ts:64,78` emits `WEBHOOK_SIGNATURE_INVALID` and `WEBHOOK_PAYLOAD_INVALID`; `docs/api/openapi.yaml:23750` publishes both, but they are not shared `ERROR_CODES` entries (PR #59 D-4). | `TEST-DEBT` | Documentation/tooling inconsistency on a non-Handyman surface; no Handyman authority impact found. | Register typed shared errors or annotate an intentional local namespace and add a parity guard. | **YES** | **NO** |
| **BA-18** | **P2** | Operations admin / QR-geofence configuration | Operators use an `/admin` UI **or** an approved API-tooling runbook; Backend capability exists in either case. | Six configuration/read/deactivation APIs exist. `docs/handyman/CR-HM-FIELD-OPERATIONS-01_FINAL_REVIEW.md` §5.3 documents the operator API journey; no admin UI exists in this Backend repository. Arrival configuration tests are included in the 32/32 batch. | `FRONTEND-DEPENDENCY` | Usability/operational ownership only; not a missing QR/geofence Backend engine. | Frontend may add screens; otherwise formally approve the merged API runbook, including QR printing, opaque-code one-time handling, deactivation, and access control. | **NO** | **NO**, provided the API runbook is accepted before operation |
| **BA-19** | **P2** | Operations / geofence history and QR inventory at scale | Large per-Building history/inventory reads are bounded and paginated. | `src/modules/handyman-geospatial-policies/handyman-geospatial-policy.service.ts:283-303` returns full history; `src/modules/handyman-arrival-locations/handyman-arrival-location.service.ts:364-384` exposes inventory without page inputs; PR #59 accepts this at current volumes. | `PARTIAL` | Response size and memory grow with policy/QR fleet age; no current functional failure demonstrated. | Add backward-compatible cursor/limit semantics when volume thresholds require them, with exact-Building and no-secret regression tests. | **YES** | **NO** |
| **BA-20** | **P2** | Notification governance / event coverage and IN_APP dedupe | Owners explicitly accept or schedule GD-5 unwired families and GD-7 IN_APP per-subscription behavior. | `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_FINAL_CERTIFICATION.md:96-130,336-338` records 26 event types, 18 authoritative call sites, GD-5 unwired crew/diagnosis/status/readiness-superseded families, and GD-7 outbound-ledger dedupe without IN_APP dedupe. G-8 inspection ratification is closed. | `PARTIAL` | Optional alerts may be absent and duplicate IN_APP rows can mirror multiple subscriptions; neither changes financial/lifecycle authority. Current governance calls these documented decisions, not universal notification proof. | Record owner acceptance of current semantics or open a separately estimated producer/dedupe CR. Recommended current decision: retain new-ACTIVE readiness notification and document IN_APP behavior. | **NO** for the decision; optional future wiring is not counted | **NO** under the documented scope |
| **BA-21** | **P2** | Product/Finance / bank-receipt attestation dependency | The merged payment contract remains authoritative unless Product/Finance explicitly requires attestation; any revival uses a non-colliding migration and fresh review. | PR #47 is OPEN/CONFLICTING and proposes old migration 0459, now occupied by request cancellation; current head is 0480. Current payment confirmation validates idempotency/authority and Care proof remains separate. `docs/contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_PENDING_GAP_REGISTER.md:26` (FG-05) marks this conditional; `src/database/migrations/index.ts` is the current registry authority. | `CONFIGURATION` | Merging as-is would conflict and alter the approved Finance surface; absence of the unmerged proposal is not a current capability defect. | Product/Finance must defer/close it or rebase, renumber after the then-current head, reapprove the contract, and rerun focused tests. Do not duplicate or merge it in this audit. | **NO** now | **NO**, unless Finance makes attestation mandatory; then reclassify P1 |
| **BA-22** | **P2** | Tenant/Legal/Security / external BAST e-signature | Current authenticated BAST acceptance with `signatureDigest` and same-scope evidence is sufficient unless PSrE/ECDSA is explicitly approved. | `docs/contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_PENDING_GAP_REGISTER.md:27` (FG-06) records external PSrE/ECDSA as unimplemented and its SD decisions as Proposed/Pending, not runtime authority. Internal BAST accept/reject/sign-off APIs and evidence bindings exist. | `CONFIGURATION` | External legal/non-repudiation assurance is not claimed; no defect in the approved internal acceptance flow is implied. | Obtain Product/Legal/Security accept/reject decisions. If external signing is mandated, create a separate provider/security CR and reclassify its release effect. | **NO** now | **NO** under current policy |

## 7. Confirmed capabilities and non-gaps

The detailed route/service/table matrix is in `E2E_CAPABILITY_MATRIX.md`. Key conclusions that must not be inverted into false gaps:

- The **parameterized engine exists**: categories, generic attributes, variants, commercial profiles, tiered price rules, explicit starter import, quotation preparation/revision, and inherited request-item attributes. Actual per-Client data is the separate BA-10 gate.
- The **24-service starter definition is not 24 populated production catalogs** and intentionally contains no prices.
- Quotation approval is tenant-PIC-personal and creates scope atomically; rejection creates no scope. Part 06 repaired the PIC fixtures; the legacy quotation file is now 10/1 with only BA-14's unrelated schema-selector red, alongside the green 37-test catalog quotation evidence.
- ADD/REDUCE variation behavior is implemented and freshly **3/3 PASS**.
- Field-feed authority is freshly **22/22 PASS**; the old FG-10 14-failure field-feed item is closed by the current fixture/source.
- Care workspace admission is freshly **15/15 PASS**; only the separate property-scope structural pin remains red.
- QR/geofence APIs, hashed QR inventory, server-side verdicts, challenge supersession, exact-Building guards, and configuration history exist. Admin UI is optional consumer work, not missing Backend capability.
- Finance verification, allocation/reconciliation, invoice readbacks, PAID readiness, and Manager CLOSE exist. No bank attestation or payment-gateway execution is silently required.
- CLOSE is permission-based, not a role-string comparison. This is the approved RBAC design; production custom grants are checked under BA-08.
- Warranty, claims, free rework, chargeable additional work, and additive rectification/reinspection exist. No generic destructive reopen is required by the frozen model.
- BM entitlements and settlement units/events/exceptions/reconciliations exist; external payout and SaaS entitlement are deliberately separate.
- IN_APP, Web Push, and FCM adapters are real code capabilities. Production activation and secret custody are separate gates; no client callable push-send route exists.
- Migration runner startup/history protections and per-ID transactions exist. Part 04 adds a populated-0478 down preflight and verified forward/recovery controls without rewriting history; unrelated intentionally irreversible migrations remain explicitly unsupported by whole-history down tests.

## 8. Historical-debt reconciliation

| Historical item | Current disposition |
|---|---|
| PR #58 “18 baseline-identical failures” | **Not reported as 18 current failures.** D-13 was fixed by PR #59 commit `46bce25`. D-01…D-12 and D-14…D-18 are carried only where source/current evidence still supports them, grouped by root cause. |
| PR #58 D-05…D-12 crew-admission fixture drift | **Closed locally in Part 07 / BA-05:** fresh 18/8/0 reproduction and final 26/26 plus migration-backed 5/5 and 11/11 are in §3.8. The real 0472/0476 authority was not changed. |
| PR #59 D-1/D-2 work-session/building fixture drift | **Closed locally in Part 06 / BA-04:** fresh baseline and final per-file evidence are in §3.7; all nine work-session files are 42/42 and building-scope part02 is 9/9, with zero skips. |
| PR #59 D-3 journal flake | **Closed locally in Part 08 / BA-06:** fresh 29/1/0 reproduction, five repeated 30/30 rounds, readiness HTTP 10/10, and unchanged production event semantics are in §3.9. |
| PR #59 D-4 webhook literals | Carried in BA-17. |
| FG-10 field-feed 14 failures | **Closed for this audit:** current fixture includes dispatch releases/assignment responses and the suite is 22/22 PASS. |
| FG-10 Care admission + scope failures | **Partially superseded:** admission is now 15/15; scope has one current structural red, carried in BA-15. |
| FG-10 BM-fee migration pin | Current 5/6 run confirms one stale structural red, carried in BA-15; runtime configuration checks pass. |
| PR #60 five quotation failures | Fresh Part 06 baseline reproduced 6 PASS / 5 FAIL. PIC/session repair resolved four; the file is now 10 PASS / 1 FAIL with only BA-14's over-broad schema selector remaining. |
| PR #60 three scope-variation failures | **Not reproduced:** current isolated suite is 3/3 PASS; no remaining variation gap is recorded. |
| PR #60 price-catalog 47 historical failures | Not used as a current count. The invalid-currency 500 was independently reproduced and BA-02 is closed in Part 03. The separate 12 residual reds from the bounded Part 03 preservation run were recorded in §3.4 rather than relabeled as the historical 47 or attributed to the currency fix; Part 05 resolved the 11 runtime failures as BA-23 and corrected the one stale fixture (§3.6). |
| PR #60 `crewId` “leak” | Current evidence shows the static assertion scans an unrelated assignment schema. No customer quotation leak is claimed; the test defect is BA-14. |
| PR #58 G-8 inspection-event ratification | Closed; no open gap. GD-5/GD-7 decisions remain BA-20. |

## 9. Security, isolation, concurrency, and sensitive-data conclusion

- **Authentication/RBAC:** canonical permissions, active session resolution, exact-Building access, PIC-personal decisions, current-Lead field authority, Finance permission separation, and Manager CLOSE dual guards are present in source and focused tests.
- **Cross-Building/tenant:** focused finance/arrival/field-feed tests include sibling, foreign-Building, foreign-Client, inactive assignment, and superseded actor denials. No new cross-tenant bypass was found.
- **Privilege escalation:** role names do not independently grant authority; production custom role/permission grants still need live census under BA-08.
- **Idempotency/concurrency:** quotation decisions, assignment responses, variations, payment/close commands, outbound delivery keys, and work-session transitions use keyed replay/conflict and/or row/version guards. Part 05 additionally executed Price Catalog replacement replay, invalid-command rollback, and concurrent replacement one-successor/one-conflict checks. Part 08 closed BA-06 by making the three readiness journal assertions deterministic and entity-specific; no production atomicity violation was reproduced.
- **Audit history:** operational events and domain event tables preserve additive history; QC/BAST/warranty models avoid destructive reopen. No generic audit deletion path was identified in the traced Handyman lifecycle.
- **Sensitive data:** BA-01 was a confirmed response-custody violation at the Part 01 baseline and is remediated by Part 02; production P-6.5 sweeps remain BA-09. Browser push response mappers omit endpoint/key secrets. QR opaque values are not recoverable from inventory and hashes are not publicly projected. Evidence bytes require persistent backup with the DB (BA-11).
- **Migrations:** the inventory is coherent. BA-03 is closed locally by pre-DDL refusal and forward/recovery evidence; the raw failed down remained transactional and no corruption is asserted. Actual target rehearsal and native paired recovery remain BA-08/BA-11, so production migration stays NO-GO.

## 10. Release decision and handoff

1. BA-01, BA-02, and BA-03 are closed in Parts 02, 03, and 04; newly registered BA-23 is closed in Part 05 with no net change to the historical open-item arithmetic; BA-04, BA-05, and BA-06 are closed in Parts 06, 07, and 08. **BA-07 is closed in Part 09 at the CR Owner-approved manual source-certification boundary**, leaving no open release-blocking Backend coding item. Named manual release approval before merging remains a Final Review gate, and BA-08 through BA-11 remain independent non-code release gates.
2. In parallel, prepare—but do not activate prematurely—the four non-code release workstreams: **BA-08 through BA-11**.
3. Re-run focused tests and OpenAPI after every contract/migration repair; then execute staged consumer, real-device, migration, persistence, and restore evidence.
4. Handle P2 items according to `BACKEND_REMAINING_WORK_ROADMAP.md`; do not let conditional PR #47, PSrE, or optional notification wiring silently expand scope.
5. Use `BIZNET_COOLIFY_RELEASE_GATE.md` for the final signed gate. Until every P1 gate is closed with evidence, the decisions remain:

**Backend FREEZE: NOT READY — Production migration: NO-GO — Biznet production readiness: NO-GO.**
