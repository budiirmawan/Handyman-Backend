# BACKEND REMAINING WORK ROADMAP

**Audit baseline:** `fb65c17e7f48f4896df2104256aa5d25f6fd07b4`
**Current decision:** Backend FINAL FREEZE **NOT READY**; Biznet release and production migration **NO-GO**.
**Scope discipline:** this is a post-audit roadmap, not authorization to implement, merge, deploy, open a duplicate PR, revive PR #47, or change another repository. Execute only after FINAL REVIEW and explicit owner approval.

## 1. Work totals and execution rule

| Work class | Release-blocking | Non-blocking / conditional | Total |
|---|---:|---:|---:|
| Backend repository coding/test/OpenAPI/migration/CI items | **7** | **7** | **14** |
| Environment, operations, consumer, or policy items | **4** | **4** | **8** |
| **Total audit items** | **11** | **11** | **22** |
| Severity | **P1 = 11** | **P2 = 11** | **P0 = 0** |

Execution rule: close **BA-01 through BA-11** with evidence before declaring FINAL FREEZE or production GO. P2 hygiene may proceed in separate small CRs but must not expand the approved business authority or be hidden by disabling tests.

## 2. Required execution order

```text
FINAL REVIEW / owner approval
            │
            ▼
Wave 1 — three production-integrity repairs (BA-01, BA-02, BA-03)
            │ focused tests + OpenAPI + populated migration proof
            ▼
Wave 2 — three core evidence repairs (BA-04, BA-05, BA-06)
            │ all affected focused suites green; no authority weakening
            ▼
Wave 3 — enforce the evidence in CI (BA-07)
            │
            ├───────────────────────────────┐
            ▼                               ▼
Wave 4A — staged consumer/infra proof      Wave 4B — production data/DR preparation
(BA-08)                                    (BA-09, BA-10, BA-11)
            └───────────────┬───────────────┘
                            ▼
Wave 5 — integrated release-candidate verification and signed gate
                            │
                            ▼
             FINAL FREEZE + production migration decision

Parallel, separately owned: P2 test hygiene/scalability and conditional policy
(BA-12 through BA-22), never used to bypass a P1 gate.
```

## 3. Wave 1 — production-integrity repairs (3 Backend coding items)

These three fixes should be small, independently reviewable, and free of new business modules. They may be separate commits in one reviewed hotfix CR only if their verification remains distinct; no new PR is opened by this audit.

| ID | Implementation plan | Primary files / contract | Acceptance evidence | Dependencies |
|---|---|---|---|---|
| **BA-01** | Make native push tokens write-only. Remove `pushToken` from public registration/list/deactivation mappers and response types; preserve internal full-record accessors for delivery. Add no-secret response assertions and an evidence/log sweep. | `src/modules/push-tokens/push-token.service.ts`, `push-token.types.ts`, native routes/controllers, `docs/api/openapi.yaml`, `tests/mobile-push-token.test.ts`, push contract/OpenAPI tests | Register, rotate, list, deactivate and re-register pass; no response contains the raw token; request still validates it; browser/native secret sweeps pass; typecheck and OpenAPI 28/28 pass. | Android consumer must stop reading the response token. Required before BA-09 real-device P-6.5. |
| **BA-02** | Replace the raw currency guard call with the existing typed command guard; preserve historical reads and valid currency behavior. | `src/modules/price-catalog-entries/price-catalog-entry.service.ts`, `src/modules/client-monetary-contexts/index.ts`, price-catalog HTTP/OpenAPI tests | ACTIVE but disallowed currency returns 400 `CLIENT_CURRENCY_NOT_ALLOWED`; inactive/unknown currency uses its governed 400; valid price creation and idempotent replay still pass; failed request writes no row/event/outbox. | Required before BA-10 production price population. |
| **BA-03** | Open a migration-owner-reviewed integrity change for 0478 down/recovery. Preserve concurrent tier facts. Either repair the down behavior where policy permits or install an explicit preflight/forward recovery path that stops before mutation when lossless automatic reversal is impossible. | `src/database/migrations/0478_service_price_tier_key.ts` and/or an approved new migration/runbook; migration runner tests; deployment migration record | Fresh upgrade, populated two-tier down/up rehearsal, failure atomicity, migration-head/schema assertions and staging-copy output all pass. No silent deletion/collapse of price facts and no blind rewrite of applied up history. | Must close before production migration sign-off and before BA-08 rollback rehearsal. |

**Wave 1 exit:** three defects have focused green evidence, no consumer secret dependency remains undocumented, and the exact release-candidate migration strategy is approved.

## 4. Wave 2 — restore core safety evidence (3 Backend coding items)

These are test-harness repairs, not license to relax production guards.

| ID | Implementation plan | Primary tests | Acceptance evidence |
|---|---|---|---|
| **BA-04** | Replace stale admin quotation decisions with decisions by the active PIC-linked session/user created by each fixture. Keep explicit non-PIC 403 cases. Repair quotation, nine work-session suites, building-scope part02, and the BAST/chargeable/customer-transaction scope fixtures identified in the audit. | `tests/handyman-quotations-api.test.ts`; `tests/handyman-work-session*.test.ts`; `tests/handyman-building-scope-guard-part02.test.ts`; `tests/handyman-bast-signoff-scope-guard.test.ts`; `tests/handyman-chargeable-additional-work-scope-guard.test.ts`; `tests/handyman-customer-transaction-scope-guard.test.ts` | Every affected suite executes its actual guard assertion on disposable PostgreSQL; zero skips concealed as passes; approval succeeds only for the PIC and forbidden actors remain denied; record per-file pass/fail counts. |
| **BA-05** | Bring the crew-admission TEMP harness to the current assignment-response contract, or run it against a migrated isolated schema. Do not mock away `ensurePendingForAssignment` or the production eligibility chain. | `tests/handyman-crew-worker-admission.test.ts`; current assignment-response migration/schema as reference | **26/26 PASS**, including the eight currently aborted cases; existing 18 negative checks remain meaningful; cross-Client/provider and prior-allocation assertions execute. |
| **BA-06** | Remove random UUID tie dependence from journal assertions. Assert event set/count and atomic rollback content, or use a real deterministic sequence only if ordering is a domain requirement. | `tests/handyman-permit-readiness.test.ts`, `tests/handyman-scheduling-readiness.test.ts`, `tests/handyman-unit-access-readiness.test.ts` | Mutation+journal and failure-injection cases pass repeatedly with no order flake; event counts/content still prove zero partial commit; production event semantics unchanged. |

**Wave 2 exit:** the release evidence no longer depends on stale actors, missing TEMP tables, or random ordering. BA-14/BA-15 residual legacy-contract hygiene may be repaired in the same test-maintenance CR only if independently reported; it is not required to make the core P1 fixes larger.

## 5. Wave 3 — make the evidence enforceable (1 Backend coding item)

### BA-07 — CI and required checks

Add a least-privilege `.github/workflows/ci.yml` and configure branch protection in GitHub. The workflow must use isolated/disposable PostgreSQL profiles rather than depending on a developer’s shared database.

Minimum required lanes:

1. `npm run typecheck`.
2. OpenAPI operational parity, structural closure, and Handyman freeze guards.
3. Catalog parts 01–03, including starter import and quotation decisions.
4. Finance close, financial reconciliation/PAID, and arrival configuration.
5. Field-feed, crew-admission, quotation, work-session, readiness, variation, Care, and BM-fee focused lanes after Wave 2 repairs.
6. Notification producer/certification, browser push, native token lifecycle and post-BA-01 secret scans.
7. Migration fresh apply, idempotent status/up behavior, and populated 0478 rollback/recovery rehearsal.

Rules:

- No `continue-on-error`, skipped-test promotion, assertion deletion, or hidden shared-DB dependency for a required lane.
- Publish per-suite counts and migration logs as artifacts without secrets or production dumps.
- Require the workflow on the protected main branch only after the current P1 reds are repaired; otherwise the pipeline would institutionalize existing failures rather than fix them.
- Keep the audit’s “no full-suite run” result honest. A future decision to require all 874 test files is separate and makes every remaining red test a mechanical gate.

**Exit:** a test change that breaks one of these lanes cannot merge silently, and PR #58 B-03/G-6 has concrete CI evidence.

## 6. Wave 4 — environment, consumer, data, and recovery (4 blocking non-code items)

These workstreams can prepare in parallel after the release-candidate image is known, but activation must remain fenced until the final gate.

### 6.1 BA-08 — staging, consumer compatibility, and production-like infrastructure

**Owner:** Platform + QA + each consumer owner.
**Backend coding:** NO.

1. Build and record the exact release SHA/image digest.
2. On isolated staging, run read-only migration status first; apply pending IDs through one reviewed migration job. Never auto-migrate/seed from the API container.
3. Verify least-privilege runtime/migration roles, required extensions, canonical history, HTTPS/CORS, trusted proxy behavior, persistent evidence mount, log collection, resource limits, health/readiness, and one writer/scheduler.
4. Execute compatibility in order: **Customer Care Frontend → Operations/Manager → field PWA → native Android**. Include positive journeys and explicit cross-Client, sibling-Building, inactive session, non-PIC, superseded Lead, Finance-only, and Manager-close denials.
5. Run populated migration/rollback rehearsal after BA-03, evidence persistence across restart/redeploy, notification/device cases under BA-09, and a bounded load/smoke test for catalog reads, request lists, evidence, and finance reads.
6. Attach consumer-owned reports with path + `error.code` for defects. Do not treat “consumer PR reported merged” as integration evidence.

**Exit:** FG-03/FG-04-equivalent evidence is attached and all four consumers accept the exact release candidate.

### 6.2 BA-09 — notification activation and physical-device proof

**Owner:** Platform + Operations + Web/Android + QA.
**Backend coding:** NO after BA-01/BA-07.

- Generate/custody VAPID and FCM credentials in the secret manager; never place them in Git, logs, chat, response payloads, or backup manifests.
- Set `PUSH_BROWSER_PROVIDER=webpush` and `PUSH_PROVIDER=fcm` only in the intended environment; keep test-only noop/capture out of production.
- Create ACTIVE `HANDYMAN_<EVENT>` templates and per-tenant subscription rules before the first real event. Verify one tenant cannot consume another tenant’s rule.
- Prove one IN_APP row per intended subscription semantics, one PUSH attempt per target, outbound dedupe, bounded retry, provider outcome evidence, token/endpoint rotation, and invalid-token revocation.
- Use at least one physical Android device with Google Play Services and physical phone browsers. Repeat P-6.5 secret sweeps after BA-01.

**Exit:** real ledger/attempt evidence and client sign-off exist for IN_APP, Web Push, and FCM; no real provider activation is inferred from unit tests.

### 6.3 BA-10 — per-Client catalog and commercial population

**Owner:** Operations + Finance/Catalog administrator.
**Backend coding:** NO.

1. Configure each Client’s approved monetary context/allowed currencies.
2. Run the explicit idempotent starter import per Client; record 8 categories/24 services, stable codes, variants/attributes/UOMs, and a replay showing no duplicates or rewrites.
3. Author real SERVICE tier price facts and resolve representative quotation variants. The starter intentionally supplies no amount.
4. Configure and approve commercial agreements, labor/material bases, BM terms, and version-bound beneficiaries; verify fail-closed behavior before configuration and correct readback afterward.
5. Run one prepare → revise → ISSUED → PIC APPROVE/REJECT smoke per representative Client and a BM entitlement/settlement readback where configured.

**Exit:** operational data readback—not source definitions—is attached for every launch Client.

### 6.4 BA-11 — backup automation and paired restore

**Owner:** Platform/DBA + Security.
**Backend coding:** NO.

- Schedule paired PostgreSQL + `evidence/` + `reports/` captures with stopped-writer or otherwise approved consistency handling.
- Encrypt and move artifacts off-host under separate access, retention, and alerting policies; protect recovery secrets separately.
- Restore into an empty isolated DB/storage pair using the documented safe commands; verify hashes, references, row counts, migration IDs/timestamps, functions/triggers/indexes/sequences, grants, startup readiness, and representative Care/evidence journeys.
- Measure and approve RPO/RTO; repeat after migration/storage changes and at the approved cadence.

**Exit:** a named backup pair is marked validated only after the actual restore succeeds.

## 7. P2 engineering hygiene track (7 non-blocking Backend coding items)

These should be small test/contract maintenance tasks, not hidden inside an authority or finance CR.

| Order | IDs | Work | Done when |
|---:|---|---|---|
| H-1 | **BA-12** | Update notification exact-record expectation for `navigationTarget`. | Record/write/read tests pass and navigation behavior is explicitly asserted. |
| H-2 | **BA-13** | Rebaseline/scoped PR-local push migration closure guards. | No assertion demands global head 0336; current registry uniqueness/order remains guarded. |
| H-3 | **BA-14** | Repair quotation session fixture and narrow schema scanning to quotation-reachable refs. | Quotation suite no longer has stale 401 or false assignment-`crewId` failure; anti-smuggling assertions remain. |
| H-4 | **BA-15** | Repair Care route-family and BM migration closure pins. | Care 29/29 and BM 6/6 pass with phantom/duplicate negative controls intact. |
| H-5 | **BA-16** | Make native token test bootstrap hermetic by default in CI. | Repeated isolated runs pass without shared-DB 401s; BA-01 secrecy is enforced. |
| H-6 | **BA-17** | Register or explicitly localize the two WhatsApp webhook error codes. | OpenAPI/error-catalog parity passes without changing Handyman behavior. |
| H-7 | **BA-19** | Add bounded cursor pagination when QR/geofence volume requires it. | Backward-compatible reads, stable ordering, exact-Building isolation, and no QR secret projection are tested. |

H-1 through H-6 are current test/documentation hygiene. H-7 is accepted current-volume scalability debt and should be scheduled by measured fleet size rather than treated as an incident.

## 8. Consumer and conditional-policy dependencies (4 non-code P2 items)

| ID | Owner | Required decision / dependency | Scope effect |
|---|---|---|---|
| **BA-18** | Operations Frontend + Operations owner | Build QR/geofence `/admin` screens **or** formally approve the existing API-tooling runbook, including one-time QR printing and deactivation. | No Backend coding and no independent blocker if the runbook is accepted. |
| **BA-20** | Notification contract owner | Ratify GD-5 unwired families and GD-7 IN_APP per-subscription/no-dedupe semantics, or approve a separately estimated change. | Current recommended acceptance needs no code. Optional producer/dedupe work is excluded from the 14-item count until approved. |
| **BA-21** | Product + Finance | Explicitly defer/close PR #47 or require bank-receipt attestation. If required, rebase the conflicting PR, renumber after the then-current migration head, review authority, and rerun tests. | Not merged authority and not a current blocker. Mandatory attestation would become a new P1 scope decision. |
| **BA-22** | Product + Legal + Security | Accept internal BAST signatureDigest/evidence or mandate external PSrE/ECDSA through a new reviewed provider/security CR. | No external-signature claim today; no code before decision. Mandatory PSrE would change release scope explicitly. |

## 9. PR and frontend dependency register

- **PR #58 / #59 / #60:** merged and included in the audited baseline; do not duplicate them.
- **PR #47:** open, conflicting, and excluded. It is not a dependency unless Product/Finance makes bank attestation mandatory.
- **Consumer PRs mentioned by older freeze records:** Frontend #33, Operations #22/#23, and Mobile #14 were only *reported* merged in historical documentation. They were not accessed or verified here. BA-08 requires their actual integration reports against this Backend baseline.
- **No new Backend PR before FINAL REVIEW:** this audit creates documentation only. Future hotfix/test/CI changes require explicit review and must stay on the approved branch/PR workflow.
- **No other repository changes:** Android/PWA/admin work is handed off through OpenAPI and consumer-signed integration evidence, not performed from this checkout.

## 10. FINAL FREEZE exit checklist

A future reviewer may change the verdict only when all are true:

- [ ] BA-01/02/03 implementation evidence is merged and focused tests are green.
- [ ] BA-04/05/06 affected suites are green with zero hidden skips and unchanged production authority.
- [ ] BA-07 CI and required branch checks are observable on the release candidate.
- [ ] BA-08 consumer, staging, migration, IAM, persistence, and load evidence is attached.
- [ ] BA-09 real IN_APP/Web Push/FCM evidence and no-secret sweeps are attached.
- [ ] BA-10 per-Client 8/24 import, real prices, monetary and BM commercial readbacks are attached.
- [ ] BA-11 automated backup and a measured paired restore are attached.
- [ ] P2 items are either closed or explicitly accepted with owners; no conditional item has silently become mandatory.
- [ ] Final OpenAPI/typecheck/focused regression rerun passes on the exact release SHA.
- [ ] Production migration and rollback/cutover decisions are signed using `BIZNET_COOLIFY_RELEASE_GATE.md`.

Until then: **14 Backend repository items remain (7 release-blocking), 22 total audit items remain, and production migration remains NO-GO.**
