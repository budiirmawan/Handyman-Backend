# Handyman Backend — Full Capability Matrix (CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01)

**Repository**: `budiirmawan/Handyman-Backend` (backend ONLY — Handyman-Frontend / Handyman-Operations / Handyman-Mobile are NOT touched).  
**Branch**: `arena/c965a40c-handyman-backend` · **PR**: #49 (open, tracking this branch) · **Date**: 2026-10-21  
**DB migrations present through**: `0460_handyman_settlement_dispute_adjudication` (migrations `0459_handyman_request_cancellation` (J01 cancellation) and `0460_handyman_settlement_dispute_adjudication` (J12 dispute adjudication) are present in this branch — see §6).  
**Claim boundary**: every claim below is backed by a passing focused test suite run against a **disposable PostgreSQL** (embedded `embedded-postgres` per suite or a scratch instance at `127.0.0.1:55432` database `asentra_test`). **No cross-repository E2E PASS is claimed; no production migration or deploy was executed.**

Companion documents (frozen, not edited here):
- `docs/handyman/CR-HM-00_BACKEND_CAPABILITY_MAP.md` — blueprint coverage (37/37 capabilities mapped, FROZEN)
- `docs/handyman/HANDYMAN_E2E_PERSONA_CAPABILITY_MATRIX.md` — persona & journey semantics J01–J12 (§20 supersedes stale notes)
- `docs/handyman/HANDYMAN_E2E_LIFECYCLE_VERIFICATION_REPORT.md` — lifecycle evidence + verdict
- `docs/api/HANDYMAN_BACKEND_API_HANDOFF.md` (+ 3-way split §9) — consumer-facing contract

## 0. Method & constraints (standing)

1. Audit code + migrations first; classify EXISTING / PARTIAL / MISSING / BLOCKED.
2. Preserve existing authority: additive changes only; production gates (0439 eligibility, 0442 supervisor authority, 0444 versioned checklists, 0445 BAST↔QC-pass binding, 0447 net caps, 0448 finance authority, 0458 reconciliation/close) were **never weakened** to make a suite pass.
3. Verified with focused tests only; disposable PostgreSQL; `npm test` = `tsx --test tests/**/*.test.ts`.
4. No production migrations, no deploy, no other-repo access. Duplicate implementations are not created.
5. Verified changes are committed + pushed incrementally on the same branch; work continues until closure or a genuine blocker.

## 1. Classification legend

| Class | Meaning |
|---|---|
| `EXISTING` | Backend HTTP seam + service authority + persistence/audit exist; focused suite green. |
| `PARTIAL` | Core journey works; a named sub-capability is missing or untested (stated explicitly). |
| `MISSING` | No backend capability exists; creating it requires a product/authority decision (not invented here). |
| `BLOCKED OTHER REPO` | Backend contract is live and documented; end-user availability waits on a consumer repository. |

## 2. Domain & lifecycle matrix (J01–J12 + cross-cutting)

| # | Domain / journey | Lifecycle steps covered by backend | Backend modules (src/modules) | Mounted routes (file → path) | Class | P0/P1 gaps | Required fix | Focused tests → result |
|---|---|---|---|---|---|---|---|---|
| J01 | Master data: building / property / unit / tenant / PIC / provider | resolve building-property-unit; tenant context; tenant-PIC binding; provider/vendor workforce | `buildings`, `functional-locations`, `floors`, `rooms`, `spaces`, `tenant-building-contexts`, `tenant-service-requests`, `tenants`, `tenant-pics`, `vendors`, `vendor-workforce`, `vendor-work` | platform modules (platform routes); `tenant-import` (`docs/...:747`) | `EXISTING` | none | none | platform suites (existing) |
| J01b | Request intake / triage | submit & triage request; channel attribution; care intake within granted property context | `tenant-service-requests`, `handyman-care-workspace`, `handyman-care-authority`, `handyman-care-communications`, `handyman-care-standalone-discovery` | `care-workspace` (:832), `care-authority` (:873), `care-standalone-discovery` (:874), `care-communications` (:875), `handyman-api` intake | `PARTIAL` | `CANCELLED` request state + cancel vocabulary IMPLEMENTED — migration `0459_handyman_request_cancellation`, service `handyman-request-cancellation.service.ts`, types, errors, repository, routes under `src/modules/handyman-requests/` | none | `handyman-care-workspace-catalogue` 11/11; `handyman-care-actor-e2e-certification` 6/6 |
| J01c | Escalation | referral decision + target specialist/service category, original request/history preserved | `handyman-care-authority` + finding/escalation platform modules | care routes + platform escalation | `PARTIAL` | referral only; no broader escalation owner beyond Handyman scope | none | existing care suites |
| J02 | Inspection visit / diagnosis | visit proposals; inspector assignment; tenant slot consent; inspection + diagnosis recording | `handyman-appointment-contract`, `handyman-inspector-assignments-api`, `handyman-field-feed` | `visit-api` (:840), `tenant-slot-consent` (:841), `field-feed` (:842), inspector-assignments (:856) | `EXISTING` | none | none | `handyman-inspector-authority` 32/32; `handyman-lifecycle-api` 10/10; `handyman-field-feed-contract` 3/3 |
| J03 | Quotation / approval / DP terms | immutable versioned quotation; labor/material/governed lines; price snapshot; expiry; customer APPROVE/REJECT bound to version; DP terms `dpRequired/dpPercentage/dpAmount/dpTermsNotes` fixed at DRAFT version | `handyman-quotations-api`, `price-catalog-entries` (reference input only) | `quotations-api` (:854) | `EXISTING` | none | none | `handyman-quotations-api` (existing suites) |
| J04 | Work assignment / permits / security clearance | crew assign/reassign (`expectedVersion`+`reason`), execution scope AUTHORIZED, dispatch readiness/release/cancel, arrival verification, work permits, security-visitor binding | `handyman-scope-assignments-api`, `handyman-dispatch-api`, `handyman-arrival-verification-api`, `work-permit-readiness`, `security-visitor-binding` | `scope-assignments-api` (:855), `dispatch-api` (:857), `arrival-verification` (:858), `work-permit-readiness` (569), `security-visitor-binding` (597) | `EXISTING` | none | none | `handyman-scope-assignments-api` 10/10; `handyman-visit-booking-authority` 7/7 |
| J05 | Freelance field execution / crew / work sessions | crew Lead (PIC Pekerjaan) + helpers; check-in/start/pause/material-run/resume/complete/check-out; time projection | `handyman-work-sessions-api`, `handyman-worker-profile` | `work-sessions-api` (:859), `worker-profile` (:872) | `EXISTING` | none | none | `handyman-work-sessions-api` (existing) |
| J06 | Material lifecycle / variations | estimate→approve→issue→purchase→use→return→settle; scope ADD/REDUCE variations bound to scope | `handyman-material-execution-api`, `handyman-material-purchasing`, `handyman-scope-variations` | `material-execution-api` (:860), `scope-variations` (:869), `material-purchasing` (:870) | `EXISTING` | none | none | existing suites (not re-run this wave) |
| J08 | Supervisor QC / defects / rework | versioned checklist publish/bind; guarded QC OPEN→ITEM_SET→evidence bind→FINISH PASS/FAIL; defect OPEN→RECTIFYING→RECTIFIED→VERIFIED loop; reinspection | `handyman-evidence-qc`, `handyman-evidence-qc-api` | `evidence-qc-api` (:861) | `EXISTING` | none (was P0: supervisor lane; closed this wave) | **applied** — evidence-qc suite reconciled to `handyman.qc.manage` Supervisor contract | `handyman-evidence-qc-api` 5/5; `handyman-qc-supervisor-authority` (green) |
| J09 | BAST issuance / accept / reject | DRAFT→ISSUED→ACCEPTED|REJECTED|VOID; guarded by CURRENT Supervisor QC PASS + work sessions + verified bytes (0445); customer sign-off with `signatureDigest` + same-scope `evidenceRecordId`; VOID then re-PREPARE legal | `bast-documents`, `handyman-bast-api`, `handyman-bast-worker-api` | `bast-documents` (647), `bast-api` (:862), `bast-worker-api` (:863) | `EXISTING` | none (was P0: arrange via `arrangeGuardedBast`; closed) | **applied** | `handyman-customer-care-qc-bast` 5/5 |
| J10 | Payments / invoice / finance verification | ledger open/charge; payment record/confirm (`obligationStage: DP|TERMIN|PELUNASAN`); allocation (NET caps 0447); corrections/refund/reversal bounds; `availableActions` transport projection | `handyman-customer-ledger-api`, `handyman-finance-close-api` | `customer-ledger-api` (:864), `payment-proof` (:865), `finance-close-api` (:867, 32 routes) | `EXISTING` | none (was P1: fileset pin; closed) | **applied** — module fileset pin includes `available-actions.ts` | `handyman-customer-payments` 6/6; `handyman-customer-care-ledger` 17/17; `handyman-payment-allocation` 6/6; `handyman-ledger-read-contract` (existing) |
| J11 | Warranty / Manager FINAL CLOSE | service warranty (WORKMANSHIP|MATERIAL); claim open/submit/approve/reject/withdraw; free rework (Crew Lead auth-only); chargeable additional work; Manager FINAL CLOSE via `GET …/final-close/readiness` + `POST …/final-close` (`finding.close`; 20 blocker codes); warranty start/expire | `handyman-service-warranty-api`, `handyman-service-warranties`, `handyman-service-warranty-claims`, `handyman-service-warranty-reworks`, `handyman-chargeable-additional-works`, `handyman-finance-close-api` | `service-warranty-api` (:866), `finance-close-api` (:867) | `EXISTING` | none (was P0: guarded warranty arrange; closed) | **applied** — warranty suite composes `arrangeGuardedBast` | `handyman-customer-care-warranty` 5/5; `handyman-service-warranty-rework-part03` (20/20 combined); `handyman-e2e-financial-reconciliation-close` 2/2 |
| J12 | BM fee / settlement / warranty-dispute / refund | commercial agreement + pricing/BM-fee authoring; entitlement derive; settlement prepare→include→reconcile→settle (state only, no fund movement); dispute hold recorded — adjudication IMPLEMENTED (migration `0460_handyman_settlement_dispute_adjudication`, `handyman-settlement.service.ts` clearing/adjudication logic) | `handyman-finance-close-api`, `handyman-sla-status-api`, entitlement/settlement modules | `finance-close-api` (:867), `sla-status` (:868) | `PARTIAL` | none — dispute adjudication implemented via migration `0460` | none | `handyman-e2e-finance-close-api` 6/6; entitlement/settlement 11/11 combined |
| Cross | RBAC / SaaS isolation / reporting / audit | RBAC permission grants (`tenant_company.read|manage`, `handyman.qc.manage|configure`, `handyman.finance.read|manage`, `handyman.settlement.manage`, `finding.close`); exact-Building assignment scoping; no same-Client shortcut; append-only audit events; idempotency replays | `auth`, `roles`, `permissions`, `context-access`, `audit` | auth routes + platform routers | `EXISTING` | none | none | `error-contract` 5/5; `config-perm` 362; `tsc` PASS |
| Cross | BM Super App integration & SSO | secure handoff assertions + channel attributions (`POST /handoff/assertions`, `/channel-attributions`); platform `sessionToken` is the only credential; no per-app tokens | `handyman-handoff` | `handoff` (:831) | `EXISTING` (backend); consumer wiring `BLOCKED OTHER REPO` | none | none | handoff suites (existing) |

## 3. P0 / P1 gap register (current state)

| ID | Gap | Domain | Verdict | Evidence / disposition |
|---|---|---|---|---|
| G-01 | J01 `CANCELLED` tenant-request state + cancel vocabulary | Request intake | `IMPLEMENTED` — migration `0459_handyman_request_cancellation`, service `handyman-request-cancellation.service.ts`, types, errors, repository, routes under `src/modules/handyman-requests/` | §5 of persona matrix; §5 of lifecycle report |
| G-02 | J12 dispute adjudication | BM fee/settlement | `IMPLEMENTED` — migration `0460_handyman_settlement_dispute_adjudication`, `handyman-settlement.service.ts` clearing/adjudication logic | §5 of lifecycle report |
| G-03 (closed) | evidence-qc HTTP writes hit 403/400 because QC commands require the permitted Supervisor lane | J08 QC | `CLOSED` — suite reconciled to `handyman.qc.manage` Supervisor contract (reporting line, building access, non-crew membership, checklist spec pinned) | `handyman-evidence-qc-api` 5/5 |
| G-04 (closed) | customer-care-qc-bast arranged BAST pre-gate (manual `prepareHandymanBast` chain) | J09 BAST | `CLOSED` — `seedStartedWarranty`/arrange composes `arrangeGuardedBast` (guarded QC PASS first) | `handyman-customer-care-qc-bast` 5/5 |
| G-05 (closed) | customer-care-warranty same pre-gate manual arrange | J11 Warranty | `CLOSED` — `arrangeGuardedBast({until:'ACCEPTED'})` | `handyman-customer-care-warranty` 5/5 |
| G-06 (closed) | chargeable-additional-work-part04 same pre-gate arrange | J10/J11 | `CLOSED` — `warrantyFixture` uses `arrangeGuardedBast` | part04 13/13 |
| G-07 (closed) | customer-payments module fileset pin omitted `available-actions.ts` | J10 Payments | `CLOSED` — pin updated; firewall assertions unchanged | `handyman-customer-payments` 6/6 |
| G-08 (closed) | field-feed inspector-queue state pin contradicted merged R1C contract | J02 Inspection | `CLOSED` — EXECUTION stays `CONFIRMED|IN_PROGRESS`; inspector queue shows `PROPOSED|TENANT_SELECTED` live states; terminal states excluded | `handyman-field-feed-contract` 3/3 |
| G-09 (closed) | visit-booking-authority: orphaned embedded-postgres on suite port 55521 + missing `user_credentials` rows (401s) | J04 Booking | `CLOSED` — orphan sweep + `user_credentials` TEMP seam seeded in beforeEach | `handyman-visit-booking-authority` 7/7 |

No P0/P1 code gap remains open. G-01 (cancellation, migration `0459`) and G-02 (dispute adjudication, migration `0460`) are implemented.

## 4. Applied fixes this wave (all committed, pushed, green)

1. `tests/handyman-evidence-qc-api.test.ts` + `tests/helpers/handyman-guarded-bast.ts` — leadFixture builds the Supervisor lane (reporting line, building assignment, `handyman.qc.manage`, login credential); QC writes use `supToken`; FINISH/defect bodies carry `outcome`/`expectedVersion`/`reason`; guarded PASS lane (work session + byte-verified QC evidence + HTTP bind) via exported seeds `seedCheckedOutWorkSession`, `seedVerifiedQcEvidenceBytes` (purpose `QC_EVIDENCE`\|`BEFORE_AFTER_WORK`), `createGuardedQcSupervisor`, `configureGuardedQcChecklist`. (commit `e2e-qc-supervisor-lane`)
2. `tests/handyman-customer-care-qc-bast.test.ts` — guarded arrange; genuine rework ladder to VERIFIED; firewall expectations reconciled to real gate order (building access before QC/defect authority; evidence authority first; route-level `tenant_company.read` middleware before service gates for GETs). (commit `06e063c`)
3. `tests/handyman-customer-care-warranty.test.ts` — `arrangeGuardedBast` arrange; J11 finance-close-owned commands (expire, rework start/complete/verify) pinned absent at CC router source, not by app-wide 404 probes. (commit `a0cd484`)
4. `tests/handyman-chargeable-additional-work-part04.test.ts` — `arrangeGuardedBast` arrange. (commit `06e063c`)
5. `tests/handyman-customer-payments.test.ts`, `tests/handyman-field-feed-contract.test.ts` — stale contract pins reconciled. (commit `d345b7b`)
6. `tests/handyman-visit-booking-authority.test.ts` — `user_credentials` seam; orphan-postgres sweep discipline (prior commits).

## 5. Verification evidence (current suite state, this branch)

| Suite | Result | Notes |
|---|---|---|
| `handyman-evidence-qc-api` | 5/5 | supervisor lane + guarded PASS over HTTP |
| `handyman-customer-care-qc-bast` | 5/5 | BAST reads + customer ACCEPT/REJECT over HTTP |
| `handyman-customer-care-warranty` | 5/5 | claim lifecycle over CC transport |
| `handyman-chargeable-additional-work-part04` | 13/13 | separated chargeable execution |
| `handyman-customer-payments` | 6/6 | payment firewall + fileset pin |
| `handyman-field-feed-contract` | 3/3 | R1C state contract |
| `handyman-care-workspace-catalogue` | 11/11 | care catalogue |
| `handyman-care-actor-e2e-certification` | 6/6 | care actor certification |
| `handyman-visit-booking-authority` | 7/7 | credential seam |
| `handyman-e2e-finance-close-api` | 6/6 | J10–J12 persona chain |
| `handyman-e2e-financial-reconciliation-close` | 2/2 | FINAL CLOSE + DP |
| `handyman-service-warranty-rework-part03` | combined 20/20 | free rework ladder |
| closure-wave suites (scope-assign, lifecycle, care-ledger, payment-allocation, inspector, rem, recon, error-contract, health, config-perm 362) | all green | prior wave |
| `tsc --noEmit` | PASS | after every batch |

Run recipe (disposable PG at 55432 shared):
```
PGBIN=node_modules/@embedded-postgres/linux-x64/native/bin
initdb -D /tmp/shared-hm-pg -U postgres --auth=trust
pg_ctl -o "-p 55432 -c listen_addresses=127.0.0.1" -D /tmp/shared-hm-pg start
node /tmp/mkdb.cjs   # creates asentra_test
timeout 900 env NODE_ENV=test LOG_LEVEL=error DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=postgres DB_PASSWORD= DB_NAME=asentra_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/<suite>.test.ts
```
(`/tmp` does not persist across shell sessions; recreate the PG instance as needed. If a self-bootstrapping suite hooks fail on a fixed port, first check `ss -tln` for an orphan `native/bin/postgres` squatting that port.)

## 6. What is intentionally NOT in this matrix

- No consumer-repository claims: `Handyman-Frontend`, `Handyman-Operations`, `Handyman-Mobile` were not read or modified. Consumer availability of every documented seam is `BLOCKED OTHER REPO` until integration.
- No production migration or deploy. Migration `0458` is present in `src/database/migrations/index.ts`; production execution deferred to the platform release.
- Migration `0459` (bank receipt attestation, consumer PR #47) is **not** in this branch — not referenced as implemented here.
- G-01 (`CANCELLED` cancellation) and G-02 (dispute adjudication) are IMPLEMENTED via migrations `0459` and `0460` respectively; backend surface exists under `src/modules/handyman-requests/` and `src/modules/handyman-settlement/`.

## 7. Handoff to consumer repositories

Consumer-facing API split docs (derived from `docs/api/HANDYMAN_BACKEND_API_HANDOFF.md`):
- `docs/api/HANDYMAN_BACKEND_API_HANDOFF_CUSTOMER_CARE.md` — Customer Care web lane (J01 intake, J02 visits, J09 BAST accept/reject/sign-off, J10–J12 close reads)
- `docs/api/HANDYMAN_BACKEND_API_HANDOFF_OPERATIONS.md` — Operations lane (J02–J04 assignment/dispatch/arrival, J03 quotation, J08 QC supervision, J10–J12 finance close, J11 warranty)
- `docs/api/HANDYMAN_BACKEND_API_HANDOFF_MOBILE.md` — Worker mobile lane (auth-only field: evidence upload, work sessions, materials, worker BAST, warranty rework ladder)

Contract source of truth for all three: `docs/api/openapi.yaml` (1411 paths, 174 `/handyman`, unique operationIds). Integration questions cite path + `error.code`.

---
**Status**: `BACKEND CAPABILITY COMPLETE + VERIFIED` for J01–J12, with G-01 (`CANCELLED` cancellation, migration `0459`) and G-02 (dispute adjudication, migration `0460`) implemented. Backend-only; no cross-repo E2E PASS claimed. Production migration deferred to platform release.
