# BACKEND REMAINING WORK ROADMAP

**Audit baseline:** `fb65c17e7f48f4896df2104256aa5d25f6fd07b4`
**Current decision:** Backend FINAL FREEZE **NOT READY**; Biznet release and production migration **NO-GO**.
**Scope discipline:** Part 02 explicitly authorized and completed BA-01 only; Part 03 explicitly authorized and completed BA-02 only; Part 04 explicitly authorized and completed BA-03 only; Part 05 explicitly authorized and completed the newly registered BA-23 Price Catalog repair only. The remaining roadmap is not authorization to implement, merge, deploy, open a duplicate PR, revive PR #47, change another repository, or start Part 06 without explicit approval.
**Part 02 evidence:** `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_FCM_RESPONSE_SECURITY_REMEDIATION.md`.
**Part 03 evidence:** `FINAL_BACKEND_GAP_AUDIT.md` §3.4 and `tests/price-catalog-currency-validation.test.ts`; no production migration or deployment was performed.
**Part 04 evidence:** `FINAL_BACKEND_GAP_AUDIT.md` §3.5, `tests/migration-0478-recovery.test.ts`, and the updated recovery runbooks; all database proof was disposable and no production downgrade/migration/deployment occurred.
**Part 05 evidence:** `FINAL_BACKEND_GAP_AUDIT.md` §3.6, `src/modules/price-catalog-entries/price-catalog-entry.repository.ts`, and the focused Price Catalog tests; all 11 original failures pass, final disjoint coverage is 115/115 after the explicit variant rerun, typecheck passes, and no migration or production action occurred.

## 1. Work totals and execution rule

Current totals are recalculated from the register rows. BA-01, BA-02, and BA-03 remain closed against the Part 01 baseline (22 items, 14 Backend coding items); BA-23 was newly registered and closed in Part 05, so it has net-zero effect on open counts and is not subtracted from that historical baseline.

| Work class | Release-blocking | Non-blocking / conditional | Total |
|---|---:|---:|---:|
| Backend repository coding/test/OpenAPI/migration/CI items | **4** | **7** | **11** |
| Environment, operations, consumer, or policy items | **4** | **4** | **8** |
| **Total open audit items** | **8** | **11** | **19** |
| Severity | **P1 = 8** | **P2 = 11** | **P0 = 0** |

Execution rule: close **BA-04 through BA-11** with evidence before declaring FINAL FREEZE or production GO. BA-01, BA-02, BA-03, and BA-23 are closed at their documented implementation/contract/focused-test or disposable-recovery boundaries; BA-01 production device/provider follow-through remains within BA-09, BA-02 production data population remains within BA-10, BA-23 exact-release consumer verification remains within BA-08 with real-price population still under BA-10, and BA-03 target/native paired recovery remains within BA-08/BA-11. P2 hygiene may proceed in separate small CRs but must not expand the approved business authority or be hidden by disabling tests.

## 2. Required execution order

```text
FINAL REVIEW / owner approval
            │
            ▼
Wave 1 — production-integrity repairs CLOSED (BA-01/02/03/23)
            │ focused tests + OpenAPI + disposable migration/recovery proof supplied
            ▼
Wave 2 — three remaining core evidence repairs (BA-04, BA-05, BA-06)
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

## 3. Wave 1 — production-integrity repairs (CLOSED)

BA-01, BA-02, BA-03, and BA-23 are complete at their documented local evidence boundaries. BA-03 and BA-23 remained small and independently reviewable; BA-23 added no migration or business module, and no new PR was opened.

| ID | Implementation plan | Primary files / contract | Acceptance evidence | Dependencies |
|---|---|---|---|---|
| **BA-01 — CLOSED (PART 02)** | Native push tokens are write-only in public responses; internal full-record delivery access is preserved. | `src/modules/push-tokens/push-token.service.ts`, `push-token.types.ts`, `docs/api/openapi.yaml`, native HTTP/foundation/OpenAPI tests | **Evidence supplied:** typecheck PASS; native HTTP/foundation 34/34; fan-out/provider 50/50; browser 36/36; current OpenAPI 28/28; zero skips. See `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_FCM_RESPONSE_SECURITY_REMEDIATION.md`. | Android must not read response tokens. Production physical-device P-6.5 and provider activation remain BA-09. |
| **BA-02 — CLOSED (PART 03)** | Price Catalog create now uses the existing typed command guard; the wrapper translates only the two known currency domain errors and rethrows infrastructure failures. Historical reads and the raw internal authority are unchanged. | `src/modules/price-catalog-entries/price-catalog-entry.service.ts`, `src/modules/client-monetary-contexts/index.ts`, `tests/price-catalog-currency-validation.test.ts`, Price Catalog fixtures/OpenAPI | **Evidence supplied:** failing-first 500 reproduced with rollback; post-fix 6/6; focused acceptance 65/65; shared currency consumers 8/8; final OpenAPI 34/34; typecheck PASS; zero skips. Disallowed ACTIVE USD is 400 `CLIENT_CURRENCY_NOT_ALLOWED`, no price/event/outbox is written, genuine DB failure stays 500. Existing valid create/idempotent replay passed in the broader run. | Closed before BA-10 production price population. Its broader-run residual replacement/correction SQL and stale direct-insert failures were separately disclosed in `FINAL_BACKEND_GAP_AUDIT.md` §3.4, not hidden or attributed to BA-02; Part 05 resolved them under BA-23 and §3.6. |
| **BA-03 — CLOSED (PART 04)** | Installed A+B forward-only safety: the existing runner refuses populated 0478 SERVICE-price down before DDL and directs forward fix or paired restore. No historical migration edit, renumbering, second registry, or application-image rollback is used. | `src/database/migrate.ts`, `tests/migration-0478-recovery.test.ts`, `docs/HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md`, deployment/migration runbooks | **Evidence supplied:** raw 23P01 + atomicity; runner/CLI pre-DDL refusal; single-tier loss prevention; empty-data round-trip; 6/6 focused; 43/43 catalog/BA-02; 6/6 variants; isolated stopped-writer restore with ledger/schema/tier/read checks; controlled forward recovery; typecheck PASS. | Local implementation/disposable recovery closed. Actual staging/target execution remains BA-08; native automated paired DB+evidence restore and RPO/RTO approval remain BA-11. |

| **BA-23 — CLOSED (PART 05)** | Added the missing `$25` to the shared replacement/correction successor INSERT. The existing 25-column order and 25 bound values, including final `created_by_user_id`, are unchanged; no migration or contract change. | `src/modules/price-catalog-entries/price-catalog-entry.repository.ts`; `tests/price-catalog-entries.test.ts`; `tests/price-catalog-override.test.ts`; `tests/price-catalog-vendor-tier.test.ts`; `tests/service-reference-price.test.ts` | **Evidence supplied:** original 25 PASS / 11 FAIL / 0 SKIPPED reproduction; direct failed-command rollback probe; final focused 38/38, complementary 71/71 executed, explicit variants 6/6, and typecheck PASS. All 11 original cases pass; invalid replacement rolls back and concurrent replacement returns one 201/one 409. The stale direct-insert fixture now reaches its unchanged subject-shape assertion. | Local implementation/focused-test closure only. Exact-release consumer/staging verification remains BA-08, real per-Client pricing BA-10, and paired recovery BA-11. |

**Wave 1 exit:** BA-01/BA-02/BA-03/BA-23 local evidence is supplied. The Android response-token handoff must still be acknowledged during BA-08/BA-09, the exact release-candidate Price Catalog behavior must be included in BA-08/BA-10 verification, and the forward/recovery strategy must still be approved and rehearsed on the target copy under BA-08/BA-11.

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
7. Migration fresh apply, idempotent status/up behavior, populated 0478 down refusal, empty-data round-trip, and isolated forward/restore recovery rehearsal.

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
5. Run the approved populated 0478 forward-fix/paired-restore rehearsal on the staging copy (never force historical down), evidence persistence across restart/redeploy, notification/device cases under BA-09, and a bounded load/smoke test for catalog reads, request lists, evidence, and finance reads.
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
| **BA-20** | Notification contract owner | Ratify GD-5 unwired families and GD-7 IN_APP per-subscription/no-dedupe semantics, or approve a separately estimated change. | Current recommended acceptance needs no code. Optional producer/dedupe work is excluded from the current 11-item Backend coding count until approved. |
| **BA-21** | Product + Finance | Explicitly defer/close PR #47 or require bank-receipt attestation. If required, rebase the conflicting PR, renumber after the then-current migration head, review authority, and rerun tests. | Not merged authority and not a current blocker. Mandatory attestation would become a new P1 scope decision. |
| **BA-22** | Product + Legal + Security | Accept internal BAST signatureDigest/evidence or mandate external PSrE/ECDSA through a new reviewed provider/security CR. | No external-signature claim today; no code before decision. Mandatory PSrE would change release scope explicitly. |

## 9. PR and frontend dependency register

- **PR #58 / #59 / #60:** merged and included in the audited baseline; do not duplicate them.
- **PR #47:** open, conflicting, and excluded. It is not a dependency unless Product/Finance makes bank attestation mandatory.
- **Consumer PRs mentioned by older freeze records:** Frontend #33, Operations #22/#23, and Mobile #14 were only *reported* merged in historical documentation. They were not accessed or verified here. BA-08 requires their actual integration reports against this Backend baseline.
- **No new Backend PR before FINAL REVIEW:** Part 01 created documentation only; Parts 02–05 stayed on the approved working branch and opened no PR. Future hotfix/test/CI changes require explicit review and must stay on the approved branch/PR workflow.
- **No other repository changes:** Android/PWA/admin work is handed off through OpenAPI and consumer-signed integration evidence, not performed from this checkout.

## 10. FINAL FREEZE exit checklist

A future reviewer may change the verdict only when all are true:

- [x] BA-01 implementation evidence is committed and its focused response-security tests are green (Part 02).
- [x] BA-02 implementation evidence is committed and its focused currency/rollback tests are green (Part 03).
- [x] BA-03 implementation/disposable-recovery evidence is committed and focused migration tests are green (Part 04); target rehearsal remains under BA-08/BA-11.
- [x] BA-23 implementation evidence is committed and all 11 original replacement/correction failures plus focused rollback/concurrency/contract preservation checks are green (Part 05); exact-release consumer and real-price verification remain under BA-08/BA-10.
- [ ] BA-04/05/06 affected suites are green with zero hidden skips and unchanged production authority.
- [ ] BA-07 CI and required branch checks are observable on the release candidate.
- [ ] BA-08 consumer, staging, migration, IAM, persistence, and load evidence is attached.
- [ ] BA-09 real IN_APP/Web Push/FCM evidence and no-secret sweeps are attached.
- [ ] BA-10 per-Client 8/24 import, real prices, monetary and BM commercial readbacks are attached.
- [ ] BA-11 automated backup and a measured paired restore are attached.
- [ ] P2 items are either closed or explicitly accepted with owners; no conditional item has silently become mandatory.
- [ ] Final OpenAPI/typecheck/focused regression rerun passes on the exact release SHA.
- [ ] Production migration and rollback/cutover decisions are signed using `BIZNET_COOLIFY_RELEASE_GATE.md`.

Until then: **11 Backend repository items remain (4 release-blocking), 19 total audit items remain, and production migration remains NO-GO. BA-01, BA-02, BA-03, and BA-23 are closed; BA-23 was newly registered and closed by Part 05 with net-zero open-count effect, and no other registered gap is reclassified.**
