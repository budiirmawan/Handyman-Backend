# FINAL BACKEND GAP AUDIT — PART 01

**Repository:** `budiirmawan/Handyman-Backend`
**Audit date:** 2026-10-24 (UTC)
**Audited baseline:** `fb65c17e7f48f4896df2104256aa5d25f6fd07b4` (`origin/main`, merged PR #60)
**Working branch:** `arena/2d32486d-handyman-backend`
**Mode:** audit only; static tracing plus small focused verification batches; no full-suite run, deployment, migration against a real environment, runtime/business change, or access to another repository.

> ## Verdict
>
> **Backend FINAL FREEZE: NOT READY.**
> **Biznet/Coolify production release: NO-GO.**
> **Production migration: NO-GO.**
>
> No P0 cross-tenant authorization bypass, wrong Finance/Manager authority decision, or partial schema corruption was found. Release is nevertheless blocked by three reproduced implementation defects, three core test-evidence defects, absent CI, and four environment/data/disaster-recovery gates.

## 1. Final counts

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

“Backend coding” here means a change in this repository, including application code, tests, OpenAPI, migration-integrity code, or CI workflow configuration. It does not mean new business modules. Conditional work in BA-21/BA-22 and optional notification rewiring in BA-20 are **not** included in the 14.

### Classification distribution

| Classification | Count | IDs |
|---|---:|---|
| `PARTIAL` | 5 | BA-01, BA-02, BA-03, BA-19, BA-20 |
| `MISSING` | 0 | — |
| `TEST-DEBT` | 9 | BA-04, BA-05, BA-06, BA-12, BA-13, BA-14, BA-15, BA-16, BA-17 |
| `CONFIGURATION` | 7 | BA-07, BA-08, BA-09, BA-10, BA-11, BA-21, BA-22 |
| `FRONTEND-DEPENDENCY` | 1 | BA-18 |
| `IMPLEMENTED` | 0 in the gap register | Implemented capabilities are in `E2E_CAPABILITY_MATRIX.md` |

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

## 4. Severity and blocking rules

- **P0:** proven critical exploit/data loss/wrong business authority or corruption requiring immediate incident handling.
- **P1:** must close before FINAL FREEZE or production sign-off; includes core safety evidence that currently cannot execute reliably.
- **P2:** limited hygiene/scalability debt or a conditional policy decision; not an unconditional Biznet blocker under the currently approved scope.
- **Biznet-blocking YES/NO** is independent of whether an item needs Backend coding. A fully green repository-wide `npm test` is not claimed; if release policy later makes that an absolute gate, every remaining red test also becomes a mechanical pipeline blocker.

## 5. P1 gap register — release/freeze blockers

| ID | Priority | Persona / stage | Expected behavior | Actual evidence and exact references | Classification | Impact | Required solution | Backend coding | Biznet-blocking |
|---|---|---|---|---|---|---|---|---|---|
| **BA-01** | **P1** | Android / push registration; sensitive data | FCM token is write-only in requests and absent from every response, evidence row, event, and log (PR #58 P-6.5). | `src/modules/push-tokens/push-token.service.ts:74-89` maps `pushToken`; the same mapper is used at `:276`, `:310`, `:324`, `:356`, `:372`. `src/modules/push-tokens/push-token.types.ts:63-77` and `docs/api/openapi.yaml:107225+` publish it. Browser responses omit equivalent secrets. Isolated lifecycle suite: 10/10, proving behavior but not secrecy. | `PARTIAL` | Credential reflection violates the approved custody law and can leak through client telemetry/logged responses; real-device P-6.5 cannot pass. | Remove the token from all registration/list/deactivation DTOs and OpenAPI responses, keep it required only on input, add response/log/evidence sweeps, and coordinate the Android contract change. | **YES** | **YES** |
| **BA-02** | **P1** | Operations/catalog admin / SERVICE price authoring | Disallowed ACTIVE currency returns governed 400 `CLIENT_CURRENCY_NOT_ALLOWED`, never an unhandled 500. | Reproduced HTTP 500 above. `src/modules/price-catalog-entries/price-catalog-entry.service.ts:410` calls raw `assertActiveAllowedCurrency`; raw errors are at `src/modules/client-monetary-contexts/index.ts:14-17`; the typed 400 wrapper already exists at `:25-30`. | `PARTIAL` | Invalid configuration produces a generic server fault and noisy raw error; authoring contract and operational diagnostics are unreliable. | Use the typed command guard on this path; add HTTP tests for inactive and disallowed currencies, exact error code, and no row/outbox write; update error metadata only if required. | **YES** | **YES** |
| **BA-03** | **P1** | Platform/DBA / migration rollback | Rollback with valid 0478 data either restores the prior schema safely or stops before mutation with an explicit data decision; never silently deletes tiers. | Reproduced populated rollback failure above. `0478_service_price_tier_key.ts:76-103` recreates the old exclusion at `:81-95` before dropping `service_price_key` at `:100-103`; concurrent keyed ACTIVE tiers valid under `:59-73` cannot fit the old constraint. | `PARTIAL` | Documented rollback cannot handle valid production-shaped data. Transactionality prevented partial corruption in the reproduction, but recovery is not dependable. | Migration-owner-reviewed down repair or preflight guard/forward recovery strategy; preserve all price facts; add populated concurrent-tier down/up tests and execute the approved strategy on a staging copy. Do not rewrite applied up history blindly. | **YES** | **YES** |
| **BA-04** | **P1** | Tenant PIC, Operations, Manager / quotation-dependent safety suites | Fixtures decide quotations as the active PIC-linked user, so assignment/work/BAST/finance assertions execute without weakening PIC-personal authority. | Current quotation cases 6/7/9 return 403 `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`. PR #59 measured 32 work-session failures plus two building-scope failures. The same stale pattern remains in `tests/handyman-bast-signoff-scope-guard.test.ts:435-437`, `tests/handyman-chargeable-additional-work-scope-guard.test.ts:472-474`, and `tests/handyman-customer-transaction-scope-guard.test.ts:371-373`, all deciding as `adminUserId` instead of the PIC user created earlier. | `TEST-DEBT` | Core work-session, scope, BAST, and transaction guards cannot all be cited as production evidence; false reds conceal the assertions that matter. | Repair fixtures to create/authenticate the linked PIC and use that actor; preserve the 403 negative cases; rerun every affected suite on disposable DBs and record exact counts. | **YES** | **YES** |
| **BA-05** | **P1** | Operations/Crew Lead / worker admission and assignment | The isolated crew-admission harness models the current assignment-response dependency and executes all 26 safety cases. | Current run: **18 PASS / 8 FAIL**, each red is `42P01 relation "handyman_assignment_responses" does not exist`. `tests/handyman-crew-worker-admission.test.ts` creates TEMP fixtures but no assignment-response table; production reaches `src/modules/assignment-responses/assignment-response.repository.ts:278` from `src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts:431`. | `TEST-DEBT` | Eight assignment/revalidation/provider/Client-mismatch cases prove nothing beyond fixture failure. This is not evidence of a production missing table. | Add the current TEMP contract or use a fully migrated isolated schema; do not mock away `ensurePendingForAssignment`; rerun all 26 and retain the 18 passing negative checks. | **YES** | **YES** |
| **BA-06** | **P1** | Operations / scheduling, permit, and unit-access readiness | The mutation+journal atomicity tests are deterministic and cannot pass/fail because of random UUID ordering. | `tests/handyman-permit-readiness.test.ts:450-464`, `tests/handyman-scheduling-readiness.test.ts:475-489`, and the analogous unit-access assertion use `ORDER BY created_at ASC, id ASC`. Rows in one transaction share `NOW()` and UUID tie-breaking is random; PR #58 D-02…D-04 and PR #59 D-3 document flaky results. | `TEST-DEBT` | The highest-value zero-partial-commit evidence is unreliable and can mask a real atomicity regression. | Assert the complete event set/count/content without assuming random order, or use a genuinely governed sequence only if order is a product contract. Repeat the three suites and failure-injection cases. | **YES** | **YES** |
| **BA-07** | **P1** | CI/release owner / all stages | Required CI runs hermetic typecheck, contract, migration, lifecycle, and notification/push lanes with visible failures and branch checks. | No `.github/workflows/ci.yml` or other CI workflow exists. `tests/push01-part06-closure-and-final-freeze.test.ts:731-758` reads that absent file; PR #58 D-18/G-6 remains open. | `CONFIGURATION` | There is no automated merge/release signal; current red and flaky lanes cannot be systematically contained. | Add a least-privilege workflow and required checks with isolated PostgreSQL profiles, explicit focused release lanes, populated migration rollback, and no ignored failures. Configure GitHub branch protection separately. | **YES** | **YES** |
| **BA-08** | **P1** | Care Frontend, Operations/Manager, PWA, Android, Platform / integrated staging | Real consumers and a production-like Coolify environment prove compatibility, exact IAM/Building grants, migrations, HTTPS/CORS, persistent evidence, one writer/scheduler, restart persistence, and load smoke. | `docs/contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_PENDING_GAP_REGISTER.md:24-25` records FG-03/FG-04 open. This audit ran only disposable/local evidence and did not enter consumer repositories. `docs/HANDYMAN_BIZNET_COOLIFY_DEPLOYMENT.md:120-145` is procedural; no staging/production migration status, live E2E, load test, or deployment evidence exists. | `CONFIGURATION` | Source-level parity cannot prove browser/APK compatibility or live infrastructure behavior. | After BA-01…BA-07, deploy the release candidate to isolated staging; run consumer order Care → Operations/Manager → PWA → Android, positive/negative IAM cases, migration status/up and rollback rehearsal, storage restart, and load smoke. Attach consumer-signed reports. | **NO** | **YES** |
| **BA-09** | **P1** | Platform/Operations + browser/Android / notification activation | VAPID/FCM credentials, provider selectors, per-tenant rules/templates, registered devices, real delivery, dedupe/retry, and no-secret evidence are proven. | Real IN_APP/Web Push/FCM adapters exist, but `.env.example:29` uses `PUSH_PROVIDER=noop`; `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PRODUCTION_PREREQUISITES.md:115-137,145-167` records P-6.x/G-1…G-7 environment and real-device gates. BA-01 independently violates P-6.5. | `CONFIGURATION` | Deploying code alone produces no governed notification delivery; provider/device behavior remains unproven. | Provision secrets outside Git, configure `webpush`/`fcm` only in the intended environment, create ACTIVE templates/rules before fan-out, and run physical browser/Android delivery, rotation, retry, dedupe, isolation, and secret-sweep checks. | **NO** (apart from BA-01/BA-07) | **YES** |
| **BA-10** | **P1** | Operations/Finance / per-Client catalog and commercial data | Each production Client has an explicit idempotent 8-category/24-service import, monetary context, ACTIVE tier price facts, and approved commercial/BM term/beneficiary configuration. | `handyman-parameterized-catalog.starter.ts:7-29` defines 8/24 and deliberately **no amounts**; import is explicit through `/service-catalog/parameterized/starter-import`, not automatic seed. Catalog engine tests are 37/37, but no persisted production population or pricing/BM readback was supplied. | `CONFIGURATION` | An implemented engine can still yield an empty/unpriced catalog or fail-closed quotation/BM evaluation. The engine must not be confused with actual 24-service operational data. | Run and record the import per Client; verify stable codes/counts/no duplicates; configure allowed currencies and real price tiers; approve commercial agreements and BM prerequisites; execute quote/settlement readbacks. | **NO** | **YES** |
| **BA-11** | **P1** | Platform/DBA / backup and disaster recovery | Scheduled encrypted off-host paired PostgreSQL+evidence backups, retention, and a measured isolated restore drill prove RPO/RTO. | `docs/HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md:3-6` explicitly says no automatic backup/retention/live restore; `:25-41` marks policy recommendations; `:75-104` is a procedure, not executed evidence. | `CONFIGURATION` | Database dumps alone omit evidence bytes; recovery, integrity, and restoration time are unproven. | Implement operator/platform-owned scheduling, encryption, off-host retention and alerting; perform a paired restore into isolation; verify DB/evidence references, hashes, migration history, grants, startup and restart; record RPO/RTO. | **NO** | **YES** |

## 6. P2 gap register — non-blocking debt and conditional decisions

| ID | Priority | Persona / stage | Expected behavior | Actual evidence and exact references | Classification | Impact | Required solution | Backend coding | Biznet-blocking |
|---|---|---|---|---|---|---|---|---|---|
| **BA-12** | **P2** | Notification inbox / legacy contract test | The exact public-record assertion includes the governed `navigationTarget` projection. | `src/modules/notifications/notification.service.ts:40-54` returns `navigationTarget` at `:50`; `tests/notification.test.ts:191-209` still asserts an exact key list without it. Historical PR #58 D-01; source mismatch remains, not freshly re-executed here. | `TEST-DEBT` | Stale red test; the record write/public projection itself is not shown defective. | Update the exact expectation and assert null/present navigation-target behavior without removing existing fields. | **YES** | **NO** |
| **BA-13** | **P2** | Native push / historical closure guards | Closure tests prove PR-local migration invariants, not that the whole repository forever ends at 0336 or never gains 0337. | `tests/push01-part05-mobile-contract-and-openapi.test.ts:504-511` asserts no 0337; sibling part04c/part04d/part06 guards pin the 0336 end state while actual head is 0480. Historical D-14…D-17; not freshly re-executed. | `TEST-DEBT` | Four stale closure failures, no runtime migration defect implied. | Scope assertions to the CR change set or rebaseline them while preserving registry uniqueness/order checks. | **YES** | **NO** |
| **BA-14** | **P2** | Tenant/quotation contract tests | The suite uses a live session and scans only quotation-reachable response schemas for downstream fields. | Disposable run: one case 11 `INVALID_SESSION`; case 10 fails because `handyman-quotations-api.test.ts:967-977` scans every `HandymanExecutionScope*` schema and catches `crewId` in the separate authorized assignment response. The other three reds are BA-04. | `TEST-DEBT` | One stale fixture and one false “leak” signal prevent the legacy suite from being green. No quotation-response `crewId` leak is proven; the catalog quotation lane is green. | Repair session setup and traverse actual quotation response `$ref`s; keep the anti-smuggling assertion. Treat assignment-DTO minimization, if desired, as a separately approved contract decision—not as a proven cross-tenant leak. | **YES** | **NO** |
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
- Quotation approval is tenant-PIC-personal and creates scope atomically; rejection creates no scope. Current legacy fixture failures do not overturn the green 37-test catalog quotation evidence.
- ADD/REDUCE variation behavior is implemented and freshly **3/3 PASS**.
- Field-feed authority is freshly **22/22 PASS**; the old FG-10 14-failure field-feed item is closed by the current fixture/source.
- Care workspace admission is freshly **15/15 PASS**; only the separate property-scope structural pin remains red.
- QR/geofence APIs, hashed QR inventory, server-side verdicts, challenge supersession, exact-Building guards, and configuration history exist. Admin UI is optional consumer work, not missing Backend capability.
- Finance verification, allocation/reconciliation, invoice readbacks, PAID readiness, and Manager CLOSE exist. No bank attestation or payment-gateway execution is silently required.
- CLOSE is permission-based, not a role-string comparison. This is the approved RBAC design; production custom grants are checked under BA-08.
- Warranty, claims, free rework, chargeable additional work, and additive rectification/reinspection exist. No generic destructive reopen is required by the frozen model.
- BM entitlements and settlement units/events/exceptions/reconciliations exist; external payout and SaaS entitlement are deliberately separate.
- IN_APP, Web Push, and FCM adapters are real code capabilities. Production activation and secret custody are separate gates; no client callable push-send route exists.
- Migration runner startup/history protections and per-ID transactions exist. The specific populated 0478 down defect does not justify claiming all migrations are broken.

## 8. Historical-debt reconciliation

| Historical item | Current disposition |
|---|---|
| PR #58 “18 baseline-identical failures” | **Not reported as 18 current failures.** D-13 was fixed by PR #59 commit `46bce25`. D-01…D-12 and D-14…D-18 are carried only where source/current evidence still supports them, grouped by root cause. |
| PR #59 D-1/D-2 work-session/building fixture drift | Carried in BA-04; historical counts are labeled historical, while current quotation failures independently prove the same stale actor pattern. |
| PR #59 D-3 journal flake | Carried in BA-06. |
| PR #59 D-4 webhook literals | Carried in BA-17. |
| FG-10 field-feed 14 failures | **Closed for this audit:** current fixture includes dispatch releases/assignment responses and the suite is 22/22 PASS. |
| FG-10 Care admission + scope failures | **Partially superseded:** admission is now 15/15; scope has one current structural red, carried in BA-15. |
| FG-10 BM-fee migration pin | Current 5/6 run confirms one stale structural red, carried in BA-15; runtime configuration checks pass. |
| PR #60 five quotation failures | Freshly reproduced as 6 PASS / 5 FAIL; split between BA-04 (three) and BA-14 (two). |
| PR #60 three scope-variation failures | **Not reproduced:** current isolated suite is 3/3 PASS; no remaining variation gap is recorded. |
| PR #60 price-catalog 47 historical failures | Not used as a current count. The underlying invalid-currency 500 was independently reproduced once through real HTTP and is BA-02. |
| PR #60 `crewId` “leak” | Current evidence shows the static assertion scans an unrelated assignment schema. No customer quotation leak is claimed; the test defect is BA-14. |
| PR #58 G-8 inspection-event ratification | Closed; no open gap. GD-5/GD-7 decisions remain BA-20. |

## 9. Security, isolation, concurrency, and sensitive-data conclusion

- **Authentication/RBAC:** canonical permissions, active session resolution, exact-Building access, PIC-personal decisions, current-Lead field authority, Finance permission separation, and Manager CLOSE dual guards are present in source and focused tests.
- **Cross-Building/tenant:** focused finance/arrival/field-feed tests include sibling, foreign-Building, foreign-Client, inactive assignment, and superseded actor denials. No new cross-tenant bypass was found.
- **Privilege escalation:** role names do not independently grant authority; production custom role/permission grants still need live census under BA-08.
- **Idempotency/concurrency:** quotation decisions, assignment responses, variations, payment/close commands, outbound delivery keys, and work-session transitions use keyed replay/conflict and/or row/version guards. BA-06 means three readiness journal tests are not reliable evidence, not that a production atomicity violation was reproduced.
- **Audit history:** operational events and domain event tables preserve additive history; QC/BAST/warranty models avoid destructive reopen. No generic audit deletion path was identified in the traced Handyman lifecycle.
- **Sensitive data:** BA-01 is a confirmed response-custody violation. Browser push response mappers omit endpoint/key secrets. QR opaque values are not recoverable from inventory and hashes are not publicly projected. Evidence bytes require persistent backup with the DB (BA-11).
- **Migrations:** the inventory is coherent, but BA-03 prevents a production rollback claim. The failed down remained transactional in the reproduction; no corruption is asserted.

## 10. Release decision and handoff

1. Complete the seven release-blocking Backend repository items: **BA-01 through BA-07**.
2. In parallel, prepare—but do not activate prematurely—the four non-code release workstreams: **BA-08 through BA-11**.
3. Re-run focused tests and OpenAPI after every contract/migration repair; then execute staged consumer, real-device, migration, persistence, and restore evidence.
4. Handle P2 items according to `BACKEND_REMAINING_WORK_ROADMAP.md`; do not let conditional PR #47, PSrE, or optional notification wiring silently expand scope.
5. Use `BIZNET_COOLIFY_RELEASE_GATE.md` for the final signed gate. Until every P1 gate is closed with evidence, the decisions remain:

**Backend FREEZE: NOT READY — Production migration: NO-GO — Biznet production readiness: NO-GO.**
