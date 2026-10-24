# BIZNET / COOLIFY RELEASE GATE

**Release candidate audited:** `fb65c17e7f48f4896df2104256aa5d25f6fd07b4` (`origin/main` after PR #60)
**Gate date:** 2026-10-24 (UTC)
**Environment accessed:** none; no staging/Biznet/Coolify deployment, migration, seed, backup, restore, or production-provider activation was performed.

> # CURRENT GATE: NO-GO
>
> - **Backend FINAL FREEZE:** **NOT READY**
> - **Biznet/Coolify production deployment:** **NO-GO**
> - **Production database migration:** **NO-GO**
> - **Production writes / scheduler / push activation:** **KEEP FENCED**
> - **Permitted next activity:** remediation and isolated/disposable verification; staging rehearsal only under an approved release plan after the code/migration blockers are addressed.

## 1. Why the gate is closed

Part 01 found **11 unconditional P1 blockers**. Parts 02, 03, and 04 closed BA-01, BA-02, and BA-03 at their documented local evidence boundaries. Part 05 newly registered and closed P1 BA-23 with net-zero historical open-count effect. Part 06 closed BA-04 locally. Part 07 closed BA-05 locally. Part 08 closed BA-06 locally. Part 09 closed BA-07 at the CR Owner-approved manual source-certification boundary, leaving **4 blockers: the BA-08 through BA-11 environment/consumer/data/recovery workstreams**, plus named release approval in Final Review. BA-01 evidence: `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_FCM_RESPONSE_SECURITY_REMEDIATION.md`. BA-02 evidence: `FINAL_BACKEND_GAP_AUDIT.md` §3.4 (post-fix 6/6, acceptance 65/65, shared currency 8/8, final OpenAPI 34/34, zero skips). BA-03 evidence: `FINAL_BACKEND_GAP_AUDIT.md` §3.5 (pre-DDL runner/CLI refusal, 6/6 focused recovery tests, disposable isolated restore and forward recovery); staging/target and native paired recovery remain BA-08/BA-11. BA-23 evidence: `FINAL_BACKEND_GAP_AUDIT.md` §3.6 (all 11 original failures now pass; focused 38/38, complementary 71/71 executed, variants 6/6, typecheck PASS); local tests do not close BA-08/BA-10/BA-11. BA-04 evidence: `FINAL_BACKEND_GAP_AUDIT.md` §3.7 (fresh 23/45/0 baseline; final affected 67/1/0 with only BA-14's independent schema-selector red; dedicated authority 28/28 and zero skips); live consumer proof remains BA-08. BA-05 evidence: `FINAL_BACKEND_GAP_AUDIT.md` §3.8 (fresh 18/8/0 reproduction; final admission 26/26, migration-backed assignment-response 5/5, competency 11/11, OpenAPI 28/28, typecheck PASS, zero skips); live consumer proof remains BA-08. BA-06 evidence: `FINAL_BACKEND_GAP_AUDIT.md` §3.9 (fresh 29/1/0 reproduction; five repeated readiness-service rounds 150/150, readiness HTTP 10/10, OpenAPI 28/28, typecheck PASS, zero skips); production event semantics are unchanged and live consumer proof remains BA-08.

| Blocker | Gate meaning | Current evidence |
|---|---|---|
| **BA-08** | Real consumer/staging/Coolify proof | No consumer verification, staging migration status/E2E, live IAM matrix, persistence/load proof, or deployment evidence. |
| **BA-09** | Notification production activation | No VAPID/FCM live delivery, per-tenant activation, physical-device, rotation/retry, or no-secret proof. |
| **BA-10** | Actual per-Client operational data | Engine/import tests exist; no launch-Client 8/24 population, real prices, monetary or BM commercial readback. |
| **BA-11** | Backup and disaster recovery | No automatic backup/retention or executed paired DB+evidence restore; RPO/RTO unproven. |

Part 03's broader bounded Price Catalog preservation run disclosed 12 pre-existing residual reds (11 replacement/correction SQL failures and one stale direct-insert guard) among 107 tests; they were not counted as BA-02 evidence. Part 05 resolved all 12 under BA-23 and its test-only fixture correction: the original three files now pass 38/38 including two new guards, and the disjoint final coverage is 115/115 after an explicit disposable-DB variant rerun. One complementary invocation still recorded six explicit database-unavailable skips before that rerun; they are not counted as passes. Part 04's auxiliary mixed run remains historical (26 PASS / 1 FAIL / 6 SKIPPED), and its stale-fixture red is now corrected. The separate pre-existing whole-history down-test failure at intentionally irreversible 0369 remains disclosed. No legacy assertion was weakened and no full-suite PASS is claimed; see `FINAL_BACKEND_GAP_AUDIT.md` §3.4–3.9.

Part 06 did not change runtime code, OpenAPI, migrations, or production data. Its final disjoint bounded evidence is **123 PASS / 1 FAIL / 0 SKIPPED out of 124**: 68 tests in 14 affected BA-04 files, 28 dedicated PIC/scope authority tests, and 28 current OpenAPI checks. The one red is the non-blocking BA-14 quotation schema selector.

Part 07 also changed no runtime code, OpenAPI, migrations, or production data. Its final disjoint bounded evidence is **70 PASS / 0 FAIL / 0 SKIPPED out of 70**: 26 crew-admission, five migration-backed assignment-response, 11 competency-assignment, and 28 OpenAPI checks. BA-05 is closed locally; BA-06 through BA-11 remain release-blocking, and BA-14 remains separately visible.

Part 08 also changed no runtime code, OpenAPI, migrations, or production data. Its bounded execution total is **188 PASS / 0 FAIL / 0 SKIPPED out of 188 executed results**: 150 repeated readiness-service results (30 distinct cases × five rounds), ten readiness HTTP/history/contract cases, and 28 OpenAPI checks. These are 68 distinct cases plus repetitions, not 188 unique tests. BA-06 is closed locally; BA-07 through BA-11 remain release-blocking, and BA-14 remains separately visible.

Part 09 finalized manual source certification under the CR Owner policy and added no GitHub Actions workflow. Five previously executed local bounded lanes retain **621 PASS / 0 FAIL / 0 SKIPPED across 58 files**: static 28, catalog 123, core 254, notification 210, and migration recovery 6. Typecheck, 478/478 registry validation, fresh CLI apply/status 478, second-apply NO_OP, and deliberate failure/skip rejection were also recorded locally. The 621 tests were not repeated during clean-history reconstruction; these are local results, not hosted evidence or a new execution on the replacement SHA. Three explicit P2 selections exclude only the registered BA-13/BA-14/BA-15 stale structural cases; those items remain open and BA-14 remains separate P2. BA-07 is closed at the manual implementation/evidence boundary. Named approval before merging remains pending Final Review, and BA-08 through BA-11 keep the overall gate NO-GO.

No P0 issue is claimed. The gate is NO-GO because these P1 release controls are open, not because a cross-tenant or financial-authority exploit was found.

## 2. Release-gate scorecard

| Gate | Required evidence | Current status | Release effect |
|---|---|---|---|
| **RG-01 — Baseline identity** | PRs #58/#59/#60 merged; exact SHA/image recorded; no unreviewed open PR included | **PASS for source identity** at `fb65c17…`; release image not built/deployed | Source baseline known; image identity still required under BA-08 |
| **RG-02 — Implementation integrity** | BA-01/02/03/23 fixed with focused HTTP/secret/migration/Price Catalog evidence | **PASS locally:** BA-01 CLOSED in Part 02; BA-02 CLOSED in Part 03; BA-03 CLOSED in Part 04 with 6/6 focused recovery evidence; BA-23 CLOSED in Part 05 with all 11 original cases passing and 115/115 disjoint final coverage after the explicit variant rerun | Local implementation gate closed for these rows; overall release remains NO-GO for BA-08 through BA-11 and final approval |
| **RG-03 — Core lifecycle evidence** | BA-04/05/06 affected safety evidence executes green with zero hidden skips | **PASS locally:** BA-04 CLOSED in Part 06, BA-05 CLOSED in Part 07, and BA-06 CLOSED in Part 08 with repeated zero-skip evidence. BA-14's separate P2 schema-selector red stays disclosed | Local core-evidence gate closed; integrated consumer/staging proof remains BA-08 and overall release remains NO-GO for BA-08 through BA-11 and final approval |
| **RG-04 — Static API contract** | OpenAPI parity, unique IDs, refs, auth/permission metadata | **PASS locally after Part 09:** current operational/structural/freeze trio 28/28; Part 03 Price Catalog lane 6/6 and Part 05 complementary preservation remain supplied; 2,065 normalized operations, 301 Handyman operations | Static evidence only; actual consumer compatibility remains BA-08 |
| **RG-05 — Type safety** | Typecheck on exact release SHA | **PASS locally after Part 09:** `npm run typecheck` on the local CI implementation tree | Re-run in hosted CI and on the final release SHA; no build PASS claimed |
| **RG-06 — Manual source certification** | Fail-closed local runner, exact TAP/counts, migration and notification lanes, retained SHA/timestamped evidence | **PASS AT OWNER-APPROVED LOCAL BOUNDARY (BA-07 CLOSED):** 621/0/0 previously recorded local product results, 478/478 registry and CLI lifecycle evidence, five lanes and self-tests retained. Paid GitHub Actions/required hosted checks deliberately not adopted; no hosted or branch-protection claim | Named manual approval before merging remains required; production NO-GO for BA-08 through BA-11 |
| **RG-07 — Consumer compatibility** | Care → Operations/Manager → PWA → Android signed integration reports | **OPEN — BLOCKER (BA-08)**; historical consumer PR claims are unverified | NO-GO |
| **RG-08 — Migration up/status** | Target status, expected pending IDs, no unknown/newer history, one-shot apply log | **NOT RUN on target**; only disposable fresh apply succeeded | Production migration NO-GO |
| **RG-09 — Migration down/recovery** | Populated 0478 pre-DDL refusal plus approved forward-fix/paired recovery on staging copy | **PASS locally for BA-03:** populated runner/CLI refusal, schema/data/ledger preservation, disposable isolated restore and forward recovery; **NOT RUN on staging/target** | Target evidence remains under BA-08; production migration NO-GO |
| **RG-10 — IAM and tenant isolation** | Live role/permission/Building census and positive/negative journeys | **Local source/focused evidence PASS; live census OPEN (BA-08)** | NO-GO until live proof; no new bypass found |
| **RG-11 — Finance/Manager authority** | Finance verification/reconciliation/PAID and Manager-only close evidence | **PASS locally:** finance/arrival 32/32; canonical permission model traced | Re-verify on target; PR #47 remains excluded unless separately mandated |
| **RG-12 — Notification activation** | Credentials, rules/templates, physical IN_APP/Web Push/FCM delivery, retry/dedupe/rotation/no-secret | **OPEN — BLOCKER (BA-09):** BA-01 response defect is closed; physical production P-6.5 evidence remains open | NO-GO for production notification activation |
| **RG-13 — Catalog/commercial data** | Per-Client 8/24 import replay, real prices, monetary and BM configuration/readback | **OPEN — BLOCKER (BA-10)**; engine 37/37 and BA-23 local lifecycle evidence are not population evidence | NO-GO for launch Client |
| **RG-14 — Evidence persistence** | Durable mount, restart/redeploy persistence, DB/file reference verification | **OPEN under BA-08/BA-11** | NO-GO |
| **RG-15 — Backup/restore** | Automated encrypted off-host pair, retention/alerting, measured paired restore | **OPEN — BLOCKER (BA-11)** | NO-GO |
| **RG-16 — Cutover/rollback operations** | One writer/scheduler, fenced old environment, monitored activation and recovery decision | **Procedure exists; not executed (BA-08/BA-11)** | Keep production fenced |
| **RG-17 — P2 debt/policy disposition** | P2 items fixed or explicitly accepted; conditional scope recorded | **OPEN but not independently blocking** | Cannot be used to hide mandatory scope; see §7 |

**Manual approval before merging:** follow `docs/HANDYMAN_CI_SOURCE_CERTIFICATION.md` §§5–6. Verify the clean candidate SHA, Node 22/PostgreSQL 18 prerequisites, all five lane summaries, exact 621/0/0 expected results, typecheck/registry/CLI lifecycle logs, and zero unexpected skips. Retain TAP/JSON/Markdown artifacts with UTC start/finish timestamps, source SHA, archive SHA-256, reviewer identity, review time, and decision. A named reviewer must approve the exact source SHA before any merge; there is no automatic merge, hosted-check substitute, or production auto-deployment. Previous 621/621 evidence is Owner-accepted local BA-07 evidence, not a substitute for approval of a changed release candidate.

## 3. Production migration decision

### 3.1 What is proven

- **478** migration files and **478** unique registry IDs; no duplicate file numbers.
- Current head **0480**; 0449 and 0469 are documented intentional/reserved gaps.
- A disposable fresh apply reached the complete registry.
- Down 0480 and 0479 succeeded in the focused reproduction.
- The migration runner’s per-ID transaction preserved head 0478 and the `service_price_key` column when the raw 0478 down failed; no partial schema corruption was observed.
- Part 04 now refuses populated 0478 down **before** its DDL, including a single non-conflicting keyed tier; CLI exits non-zero without a rollback-success message. Empty-data 0478 down/up still passes.
- A disposable stopped-writer physical database restore preserved all 478 ledger IDs/timestamps, public tables, every price-table column/constraint, representative catalog data and both tiers; readiness and authenticated price reads passed. A synthetic failed migration recovered by forward fix without down.
- Historical 0478 and the registry are unchanged. Application-image rollback is not certified: old exact-history readiness rejects newer IDs and old SERVICE writes omit the required key.

### 3.2 What is not proven

- Pending/status state of staging, Biznet, Railway, or any real target.
- Upgrade from the actual production/Railway schema and data volume.
- Execution of the approved 0478 forward-fix/paired-recovery strategy on a staging or actual target copy, with production-shaped volume and native `pg_dump`/`pg_restore`; the Part 04 physical disposable proof does not fill this gate.
- Target roles/extensions/index/constraint fingerprints, production locks, or application-image compatibility after rollback.
- A validated pre-migration backup pair and its restore.
- Live post-migration consumer and scheduler behavior.

### 3.3 Migration NO-GO rule

Do not run a production migration while any P1 release gate or BA-08 target evidence is open. BA-03's local closure does not authorize target migration. A later GO requires all of the following:

- [ ] Release SHA and canonical expected migration head are recorded after all approved repairs.
- [ ] `db:migrate:status` on the actual target shows only expected pending IDs and no unknown/newer history.
- [ ] A named, encrypted, off-host DB+evidence backup pair exists and its restore has been validated.
- [ ] The populated 0478 pre-DDL refusal and approved forward-fix/paired-restore strategy pass on a staging copy without silently deleting/collapsing tiers; no historical down is forced.
- [ ] Writers/API/scheduler/external producers are fenced according to the cutover plan; exactly one authorized migration job runs.
- [ ] Migration-owner and runtime roles are separate and least-privilege; the API container does not auto-migrate, seed, or reset.
- [ ] The new schema is applied before the compatible application image starts; health/readiness, constraints, indexes, history, grants and representative reads are checked.
- [ ] Application rollback compatibility is explicit. Coolify image rollback is not treated as a database rollback.
- [ ] A post-write recovery owner understands that DNS-only rollback is unsafe after Biznet accepts writes.

**Current production-migration verdict: NO-GO.** This is not a request to run `down` in production; the preferred recovery may be forward repair or paired restore after explicit data-loss/reconciliation decisions.

## 4. Coolify/Biznet activation checklist

The repository’s `docs/HANDYMAN_BIZNET_COOLIFY_DEPLOYMENT.md`, `docs/HANDYMAN_RAILWAY_TO_BIZNET_MIGRATION.md`, and `docs/HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md` are procedural inputs, not execution evidence.

### Infrastructure and network

- [ ] Supported Biznet host, Docker/Coolify versions, SSD capacity, RAM/headroom, DNS and static networking are recorded.
- [ ] Stable HTTPS API domain and valid certificate work; production browser origins are explicitly in `CORS_ORIGINS`.
- [ ] Coolify/admin ports and PostgreSQL are private/restricted; no public 5432 exposure.
- [ ] Proxy body-size, timeouts, forwarded-IP trust, JSON limits, health checks and termination grace are verified with the real consumers.

### Runtime and data

- [ ] Runtime uses least-privilege DB credentials; migrations use a separate owner role and one-shot job.
- [ ] API replica count and scheduler ownership enforce one writer during cutover; old Railway API/jobs are fenced before Biznet accepts writes.
- [ ] `/app/.data/evidence` is a verified persistent mount with correct non-root ownership and both `evidence/` and `reports/`; actual restart/redeploy persistence is tested.
- [ ] Logs are collected/rotated off-host without secrets; alerts cover 5xx/readiness, DB pool, scheduler, disk/inodes/WAL, evidence, backup age, certificate and container restarts.
- [ ] Load/smoke results support the chosen capacity for catalog, request, evidence, notification, and finance workloads; documentation sizing is not treated as a benchmark.

### Launch data and provider activation

- [ ] BA-10 per-Client import/pricing/monetary/BM readbacks are complete; no automatic starter seed is assumed.
- [ ] BA-09 VAPID/FCM credentials, ACTIVE rules/templates and physical-device evidence are complete before push fan-out.
- [ ] QR/geofence operations have either approved `/admin` screens or the formally accepted API-tooling runbook (BA-18); opaque QR values are printed once and never expected back from inventory.
- [ ] Production role/permission grants implement canonical persona separation. Canonical MANAGER alone is the approved close persona unless a custom grant is explicitly reviewed; every actor also needs exact-Building scope.

## 5. Required live E2E evidence pack

The final release record must identify the exact release SHA and include:

1. **Care request journey:** intake evidence, triage, inspection/scheduling/permit/access, diagnosis, quotation presentation, PIC decision and progress/history.
2. **Operations journey:** parameterized catalog/variant/price setup, scope assignment, readiness/dispatch, worker response/reassignment, materials/variations, QC and operational reads.
3. **Field PWA + Android:** current-Lead/Inspector denial and acceptance, raw QR + deviceLocation verification, check-in/start/pause/resume/material-run/complete/check-out, evidence upload/download, variation finding/proposal and BAST facilitation.
4. **Tenant:** unexpired ISSUED quotation APPROVE/REJECT by the active PIC; expired/non-PIC denials; BAST acceptance distinct from quote approval; warranty claim intake where applicable.
5. **Finance:** payment proof, Finance confirm/reject, allocation/correction/reconciliation, invoice PAID readback, entitlement and BM settlement readback; no client-side financial authority.
6. **Manager:** readiness and successful close only with the permission pair and exact Building; Care/Ops/Lead/Finance-only and foreign-Building denials.
7. **Recovery/additive history:** failed QC → new run/defect rectification/reinspection; ACCEPTED BAST → warranty/claim/rework; no destructive history rewrite.
8. **Notifications:** per-tenant IN_APP/Web Push/FCM delivery, no cross-tenant rule match, dedupe/retry, endpoint/token rotation, invalid-token revocation, and no credentials in responses/evidence/events/logs.
9. **Isolation/concurrency:** cross-Client, sibling-Building, inactive assignment, superseded actor/challenge, idempotent replay/conflict, and concurrent decision/close checks.
10. **Infrastructure:** migration status/up/recovery logs, evidence restart persistence, paired restore result, load smoke, monitoring and one-writer cutover record.

A unit test, OpenAPI document, reported consumer merge, or procedure alone does not close any item in this pack.

## 6. Approved authority boundaries that must not change during release

- No payment gateway/bank callback can self-confirm a payment or mark an invoice PAID; Finance decides.
- No Care, Operations, Crew Lead, or Finance-only actor can execute Manager CLOSE without the required permission pair and readiness.
- No client computes authoritative price, geofence, payment, entitlement, settlement, QC, or close state.
- No BM settlement record is presented as proof of an external payout, and no SaaS subscription entitlement is reused as BM/provider financial entitlement.
- No generic reopen rewrites QC/BAST/warranty/service history; use the additive governed facts.
- No new push-send route or second notification/outbound ledger is introduced.
- No automatic production seed creates fictional prices or commercial terms.

## 7. P2 and conditional items at the gate

The following do **not** independently hold the current NO-GO open, but must have an owner/disposition and cannot be silently converted into release scope:

| ID | Gate disposition |
|---|---|
| **BA-12** | Repair the stale notification exact-record expectation; non-blocking test hygiene. |
| **BA-13** | Rebaseline/scope legacy push migration closure guards; non-blocking test hygiene. Part 09's explicit filter excludes only the stale global 0336-cap case and requires the other 17 cases green; it does not close this item. |
| **BA-14** | Part 06 repaired the live PIC session; narrow the remaining over-broad schema selector. Non-blocking residual test debt and the sole red in the Part 06 bounded set. Part 09 explicitly selects cases 1–9 and 11 (10 green) while case 10 remains independently open P2. |
| **BA-15** | Repair the Care route-family and BM migration-list pins; non-blocking structural-test debt. Part 09 selects only green BM-fee t2–t6 (5 green); stale t1 and the separate Care route pin remain open. |
| **BA-16** | Make the native-token invocation hermetic by default; Part 09's isolated CI invocation passes its 10 lifecycle cases with zero skips, but this independent P2 harness-debt item is not reclassified. |
| **BA-17** | Register or explicitly localize the two WhatsApp webhook literals; non-blocking contract hygiene. |
| **BA-18** | Choose optional admin UI or the approved QR/geofence API runbook; no Backend coding required. |
| **BA-19** | Current-volume accepted pagination debt; schedule by measured growth. |
| **BA-20** | GD-5 unwired notification families and GD-7 IN_APP dedupe exception require recorded acceptance or a separate approved CR. |
| **BA-21** | PR #47 is OPEN/CONFLICTING and excluded. Mandatory bank attestation would require a new P1 review, rebase and migration renumbering; do not merge as-is. |
| **BA-22** | External PSrE/ECDSA is not approved runtime scope. Mandatory external signing would require a separate Legal/Security/provider review. |

If CI policy later requires a fully green repository-wide suite, BA-12 through BA-17 also become mechanical pipeline blockers; that does not change their current runtime severity.

## 8. Sign-off record required to change the verdict

| Sign-off | Required named evidence | Current |
|---|---|---|
| Backend code owner | BA-01/02/03/23 committed fixes + focused results | **BA-01 PART 02, BA-02 PART 03, BA-03 PART 04, AND BA-23 PART 05 LOCAL EVIDENCE SUPPLIED** |
| Backend test owner | BA-04/05/06 green affected safety evidence; P2 disposition | **BA-04 PART 06, BA-05 PART 07, AND BA-06 PART 08 LOCAL EVIDENCE SUPPLIED; P2 DISPOSITION NOT SUPPLIED** |
| Source-certification owner + release reviewer | BA-07 manual runner/evidence; exact-SHA approval before merge | **MANUAL IMPLEMENTATION AND 621/0/0 LOCAL EVIDENCE SUPPLIED; NAMED FINAL REVIEW/MERGE APPROVAL PENDING** |
| Platform/DBA | Target migration/up/recovery, infrastructure, persistence and monitoring | **NOT SUPPLIED** |
| Operations/Catalog + Finance | BA-10 launch-Client data readbacks | **NOT SUPPLIED** |
| Notification/Web/Android owners | BA-09 provider/device/rotation/no-secret evidence | **NOT SUPPLIED** |
| QA + four consumer owners | BA-08 exact-SHA integration and denial matrix | **NOT SUPPLIED** |
| Platform/Security/DR owner | BA-11 automated backup and measured paired restore | **NOT SUPPLIED** |
| Product/Finance/Legal as applicable | BA-20/21/22 explicit decisions | **CONDITIONAL / NOT SUPPLIED** |

## 9. Final release statement

The Part 01 baseline was **0 / 11 / 11** across 22 items. Current status after Part 09:

- **P0/P1/P2:** **0 / 4 / 11** across **15 open items**; **BA-01, BA-02, BA-03, BA-23, BA-04, BA-05, BA-06, and BA-07 are closed**. BA-23 has net-zero historical open-item effect; BA-04/BA-05/BA-06 closed locally in Parts 06/07/08; BA-07 closed in Part 09 at the Owner-approved manual source-certification boundary.
- **Remaining Backend coding items:** **7** total, **0 release-blocking**. Named manual release approval before merging remains pending Final Review.
- **Backend FINAL FREEZE:** **NOT READY**.
- **Production migration readiness:** **NO-GO**.
- **Biznet/Coolify production readiness:** **NO-GO**.

Re-evaluate only on a new exact release SHA with every P1 gate closed by evidence. No production go-live, migration, push activation, or scheduler enablement is approved by this document.
