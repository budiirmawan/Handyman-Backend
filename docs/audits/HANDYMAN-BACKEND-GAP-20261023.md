# CR-HM-DEEP-REVIEW-20261023 — PART 01
# Handyman Backend — Deep Gap Audit (backend only)

| Field | Value |
| --- | --- |
| Artifact | `docs/audits/HANDYMAN-BACKEND-GAP-20261023.md` |
| Audited commit | `9a15ad6b6dc61f1501c66a377f5fba7d6386a12a` (`main` = `origin/main` = merge of PR #57) |
| Audit branch | `arena/64105938-handyman-backend` (branched from `9a15ad6`; this audit adds documentation only) |
| Migration tip | `0472_handyman_assignment_responses` — **current**; 470 registered migrations; `0469` intentionally absent |
| OpenAPI at audit | `docs/api/openapi.yaml` — 1 532 paths / 2 032 operations (287 `/handyman`, 54 `/mobile`), SHA-256 `d90af07d6f5cb1e4ce8c1c5441b43b2211f1c37d580048a70ea98e3781fc4d27` |
| Environment | Local sandbox, Node 22.22.3, TypeScript 5.9.3, PostgreSQL **18.4** (embedded, disposable databases, one per suite) |
| Scope | Requirements 1–11 of CR-HM-DEEP-REVIEW-20261023 PART 01 |
| Out of scope | Production code, migrations, seeds, deployments, new branches/PRs, cross-repository verification |
| Verdict | **0 P0 · 10 P1 · 12 P2** — the runtime capability spine is substantially implemented; the material gaps are notification delivery reachability, notification acknowledgement, WEB_PUSH, CI/verification evidence, and a few authority/operability semantics |

---

## 0. Claim boundary (read first)

* Every statement below is backed by a **file path**, a **route**, a **commit** or a **command executed in this environment**. Where only repository documentation asserts something, the row says so.
* **No production database, staging environment, Coolify/Biznet host or consumer application** was read or written.
* **No cross-repository PASS is claimed.** Frontend, Operations and Mobile repositories were not accessible (FG-03 remains open).
* "CLOSED" means *implemented in code AND reproduced by a focused run in this environment* unless the row explicitly says the evidence is repository-pinned only.
* "UNVERIFIED" means the code exists but no run in this audit (and no trustworthy pinned run) proves it.
* This audit **does not reimplement** any merged work; no PR #55/#56/#57 content was rewritten, duplicated or reverted.

---

## 1. Baseline verification (actual source baseline first)

| # | Check | Command / source | Result |
| --- | --- | --- | --- |
| B-01 | Repository HEAD | `git rev-parse HEAD` | `9a15ad6b6dc61f1501c66a377f5fba7d6386a12a` |
| B-02 | `main` == `origin/main` == HEAD | `git rev-parse main origin/main` | all three identical → **the branch starts exactly at `main`** |
| B-03 | HEAD is PR #57 merge | `git log -1` | `Merge pull request #57 from budiirmawan/arena/44decf3c-handyman-backend` |
| B-04 | PR #55 integrated | `git merge-base --is-ancestor 37cc6e0 origin/main` | **YES** (merge commit `37cc6e0`, 2026-10-23T11:31Z) |
| B-05 | PR #56 integrated | `git merge-base --is-ancestor f75f84c origin/main` | **YES** (merge commit `f75f84c`, 2026-10-23T11:37Z) |
| B-06 | PR #57 integrated | `git merge-base --is-ancestor 9a15ad6 origin/main` | **YES** (merge 2026-10-23T13:59Z) |
| B-07 | PR #57 diff | `git diff --stat e8b94af..HEAD` / `git rev-list --count` | 180 files, +51 591 / −706, 33 commits — matches the PR #57 PART 02 report exactly |
| B-08 | PR #47 (bank-receipt attestation) | `gh pr view 47` | **OPEN**, unmerged, not imported (FG-05 unchanged) |
| B-09 | Migration registry | `src/database/migrations/index.ts` | **470 registered**, tip `migration0472HandymanAssignmentResponses`; no `0469`; 472 files on disk (`index.ts`/`types.ts` are not migrations) |
| B-10 | Migration harness | `npx tsx tests/manual/release-integration-migration-check.ts` | **21/21 PASS** (fresh, rerun, upgrade from 0460, schema convergence, failure recovery, forward repair) |
| B-11 | Typecheck | `npx tsc --noEmit` | **PASS** (exit 0) |
| B-12 | Contract integrity | `openapi-contract` 7/7 · `mobile-openapi-completeness` 5/5 · `handyman-contract-freeze-03-openapi` 13/13 | **PASS**; 2 032 operations, 2 032 unique `operationId`s, 0 duplicates |
| B-13 | Continuous integration | `ls .github` → *no such directory*; `git log --all -- .github` → **empty** | **No CI workflow has ever existed in this repository** (see P1-04) |
| B-14 | Working tree | `git status` | clean before this audit; only `docs/audits/` added by PART 01 |

**Conclusion B1:** `main@9a15ad6` and migration `0472` **are current**. PR #55, #56 and #57 are all merged and reachable from `main`; PR #57 references baseline `e8b94af` (PR #54), which is correct.

**Conclusion B2 (important):** the repository is **shallow-cloned by default** in fresh checkouts (`git log` reported 1 commit until `git fetch --unshallow`). Any audit that inspects "recent merged commits" must unshallow first, otherwise commit-level evidence silently collapses to a single merge commit.

---

## 2. PR #57 reconciliation (no reimplementation of merged work)

| PR | Merge commit | State | Content relevant to this audit | Duplicated by this audit? |
| --- | --- | --- | --- | --- |
| #55 | `37cc6e0` | MERGED | Worker competency: `0461`–`0467`, `workforce-certifications`, `service-catalog-competency-requirements`, multi-trade WO, direct workforce, reclassification | **No** |
| IAM revocation | `515919f` (inside #56 lineage) | MERGED | `0468` audit vocabulary, `DELETE /roles/:roleId/permissions/:permissionId` | **No** |
| #56 | `f75f84c` | MERGED | Field expense `0470`, helper attendance `0471`, assignment responses `0472`, fan-out into mobile/operations projections | **No** |
| #57 | `9a15ad6` | MERGED | Release integration: migration harness, merged E2E, contract pin reconciliation, PART 01/02 reports | **No** |

Verified integration claims from PR #57 (re-checked, not taken on trust):

| Claim | Re-check | Verdict |
| --- | --- | --- |
| "470 registered migrations, tip 0472, 0469 absent" | registry parse | **TRUE** |
| "21/21 migration harness checks" | re-executed | **TRUE** (21/21) |
| "287 Handyman operations, 1 532 paths" | OpenAPI parse | **TRUE** (287 / 1 532) |
| "Merged seam E2E 11/11" | `release-integration-merged-e2e` | **TRUE** (11/11) |
| "typecheck green" | `tsc --noEmit` | **TRUE** |
| "CORS exact-origin; no wildcard" | `src/middleware/cors.ts` | **TRUE** (exact-origin allowlist, credentials false) |
| "`assignWorkOrder` single transaction (lock → assignment → competency → event → IN_APP)" | `work-order-assignment.service.ts` | **TRUE** by inspection |

---

## 3. October 12 gap register reconciliation (R1B/R1C)

The October 12 artifacts are `docs/handyman-e2e/HANDYMAN_R1B_REPOSITORY_DELIVERY.md` and `HANDYMAN_R1C_IMPLEMENTATION_HANDOFF.md` (both dated 2026-10-12, ZIP snapshots, "not a live Git branch"). Their two "not included / intentionally NOT completed" lists are reconciled here **against current HEAD**, not against the register text.

| Oct-12 gap | Current state | Evidence | Status |
| --- | --- | --- | --- |
| Authenticated tenant choice/consent verifier; Care must not attest tenant consent | Implemented: HMAC-signed tenant-slot assertion, `handyman_visit_tenant_slot_consents` (0434) + append-only bindings, Care uses a separate exchange token | `handyman-tenant-slot-authority.ts`, `handyman-tenant-slot-assertion.ts`, `handyman-tenant-slot-consent.service.ts`; tests `handyman-tenant-slot-consent` **5/5**, `handyman-appointment-core` **19/19** | **CLOSED** |
| Server-validated inspector skill/availability + transactional reservation | Implemented: eligibility resolver (`POST /handyman/visit-appointments/:id/inspector`), provider availability service, capacity reservation + `EXCLUDE USING gist` + deferred commit guards | `handyman-inspector-assignment.service.ts:191`, `handyman-provider-availability.service.ts`, `0431:142–238` | **PARTIAL** — no calendar/working-hours availability engine; availability is an advisory provider service, not a booking constraint (P2-11) |
| Permit / access clearance / visit start / attempt / no-show / inspect-result composition | Implemented: permit readiness + permit-work lifecycle, arrival verification, attempt outcomes incl. `NO_SHOW`, `REBOOK_REQUIRED` | `handyman-permit-readiness` **10/10**; `handyman-appointment-core.ts:216`; `0431:248` | **CLOSED** (code + focused run) |
| Execution booking confirmation, BAST issue, Finance verification, Manager CLOSE, Care/Mobile scoped appointment APIs | Implemented across `handyman-bast-*`, `handyman-customer-*`, `handyman-finance-close-api`, `handyman-visit-api`, mobile projections | tests in §8 | **CLOSED** |
| Migrations live execution/rollback, full build, live concurrency, four-app E2E | Build + migration + concurrency **proven**; **four-app cross-repo E2E not performed** | `tsc` PASS; harness 21/21 (incl. concurrency/failure recovery); `release-integration-merged-e2e` 11/11; FG-03 still open | **PARTIAL** — code side closed, cross-repository side OPEN (P1-05) |

**Conclusion:** the October 12 gap register is **not** still open as written. Four of its five items are closed in code; the residual items are *consumer verification* (FG-03), *staging `FG-04`* and *calendar-grade availability*.

---

## 4. Contract-freeze register (FG-01…FG-13) — current status

Source: `docs/contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_PENDING_GAP_REGISTER.md` (v1.2 + 2026-10-21 amendment).

| ID | Register status | Status at `9a15ad6` | Evidence |
| --- | --- | --- | --- |
| FG-01 | CLOSED | **CLOSED** | OpenAPI completeness suites 7/7 + 5/5; 2 032 ops |
| FG-02 | CLOSED | **CLOSED** | `handyman-contract-freeze-03-openapi` 13/13 |
| FG-03 | P1 OPEN (consumer compat) | **OPEN** | No cross-repo access; PR #57 itself claims backend-only evidence |
| FG-04 | P1 OPEN (staging E2E) | **OPEN** | No staging run in this audit (out of scope); `verifyMigrationReadiness` fails closed |
| FG-05 | P2 OPEN (PR #47) | **OPEN** | `gh pr view 47` → OPEN, unmerged, migration not revived |
| FG-06 | P2 OPEN (external e-signature) | **OPEN** | No PSrE/ECDSA anywhere; BAST-SIGN-00 SD items still *Proposed* |
| FG-07 | CLOSED | **CLOSED** | WhatsApp webhook probed correctly |
| FG-08 | CLOSED | **CLOSED** | Spec/handoff reconciled |
| FG-09 | P2 (evidence freshness) | **PARTIAL** | This audit refreshes 23 suites on `9a15ad6` (§8) |
| FG-10 | P2 (baseline test debt) | **OPEN and broader than recorded** | 7 suites re-run red; **4 more red suites not listed in FG-10** (P1-07, P2-12) |
| FG-11 | addressed, pending merge | **CLOSED** (merged via later PRs) | defect-discovery list/detail reads present |
| FG-12 | addressed, pending merge | **CLOSED by inspection** (`handyman-qc-supervisor-authority` fixture fix is on main) | not re-run here |
| FG-13 | policy decision | **OPEN (decision only)** | cancellation read is fact-read, not eligibility projection |

**Register rule still holds:** "A gap moves to CLOSED only with a merged PR + focused evidence." Nothing in this audit closes a gap by assertion.

---

## 5. Area-by-area reconciliation (requirements 1–11)

### 5.1 Area 1 — Central IAM, Super User, user/password, tenant/RBAC, scope

**Implemented (verified in code and by run):**

| Capability | Entry point | Notes |
| --- | --- | --- |
| First-owner bootstrap | `src/modules/iam-bootstrap/owner-bootstrap.service.ts` (`bootstrapOwner`), `src/database/cli.ts` `bootstrap-owner` | one-time, transactional, refuses re-run; commit `8101b2d` |
| Canonical personas | `src/modules/iam-bootstrap/iam-canonical-roles.ts` — `SYSTEM_ADMIN`, `CUSTOMER_CARE`, `OPERATIONS`, `MANAGER`, `MOBILE_STAFF` | OWNER = `PLATFORM_ADMIN`; every referenced permission must already exist or the bootstrap rolls back |
| Default-deny RBAC | `src/modules/auth/rbac.middleware.ts` `requirePermission` | per-request resolution: user → role assignments → role permissions |
| Platform plane isolation | `src/modules/platform-iam/platform-iam.middleware.ts` (`requirePlatformPermission`) | `platform.*` namespace asserted at registration time |
| Users / passwords | `POST /users`, `GET /users`, `POST /users/:id/password-reset`, `deactivate/suspend/reactivate` (`user.routes.ts`) | reset revokes sessions and forces change; never returns a secret |
| Privileged-account guard | `src/modules/users/privileged-account.guard.ts` | `PLATFORM_ADMIN` targets only mutable by a `PLATFORM_ADMIN`; authority-defining permissions owner-only |
| Role/permission grants + revocation | `POST/DELETE /users/:userId/roles`, `POST/DELETE /roles/:roleId/permissions` | `0468` adds `PERMISSION_GRANTED/REVOKED` audit vocabulary; commit `63f3a85` |
| Sessions | `src/modules/auth/session.service.ts`, `session.token.ts` | opaque token, **stored only as SHA-256**, TTL + last-used throttle |
| Tenant/Building scope | `src/modules/context-access`, `user_building_assignments` | exact-Building wall used by handyman services; no same-Client shortcut |
| Auth audit | `GET /auth/audit-events` (`auth.audit.read`) | append-only; `0468` extends vocabulary |

**Findings**

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED** | IAM core, scope, revocation, privileged-account protection. Evidence: `iam-bootstrap` **24/24**, `permission-revocation` **8/8**, `audit` **14/14**, `users` 3 pass/11 skipped (legacy DB-gated), `roles` 1/20 (legacy), `effective-context` 12 skipped (legacy) |
| P1-08 | P1 | **OPEN** | **Login throttle is per-process and keyed on the socket address, with no `trust proxy`.** `src/modules/auth/login-rate-limit.ts:4–6` ("keyed by IP address, the socket remote address, not a forwarded header"), `app.set('trust proxy', …)` appears nowhere in `src/`. Behind the Coolify/Biznet proxy every client shares one bucket → 10 failures/15 min can lock **all** logins, and a horizontally scaled deployment multiplies the effective limit. There is also **no API-wide rate limit**; only `/auth/login` and Care admission are throttled. |
| P2-08 | P2 | **PARTIAL** | **"Super User" has no first-class representation.** No `SUPER_USER` role, permission or account exists (`grep -ri "super user"` finds only docs). Production vocabulary ("existing Super User") maps to `PLATFORM_ADMIN` + explicit grants. This is a deliberate design (no unrestricted superuser — `CR-HM-IAM-BOOTSTRAP-01_MULTI_PERSONA_CONTRACT.md:135`), but the deployment checklist (`…_PART01_DEPLOYMENT_RISKS.md:37`, R2-3) and the runbooks must say `PLATFORM_ADMIN` explicitly, and there is no documented **owner-recovery** path if the last owner is lost (last-grant removal is blocked with 409 `LAST_OWNER_ROLE_REQUIRED`, but recovery after a lost password relies on another `PLATFORM_ADMIN`). |
| P2-08b | P2 | **OPEN** | No MFA/TOTP for privileged accounts (`grep -ri "mfa\|totp"` → none), no password rotation/expiry, no self-service session listing/revocation beyond admin reset. Acceptable for the current stage, but must be an explicit accepted risk for a platform-admin console. |

---

### 5.2 Area 2 — Customer Care intake and tenant consent

**Implemented:**

* Intake: `POST /handyman/requests` (bearer, `tenant_company.manage`) and `POST /handyman/requests/care` (**exchange-token only**, no local session) — `src/modules/handyman-api/handyman-api.routes.ts:74–95`.
* Care workspace: `createCareWorkspaceRouter` (`handyman-care-workspace`), care actor resolver/persistence, standalone discovery, communications (`0451`, `0455`).
* Tenant consent: HMAC tenant-slot assertion → `handyman_visit_tenant_slot_consents` (0434) with `assertion_jti`/`bm_consent_evidence_id` uniqueness, append-only bindings; Handyman **creates no consent** ("Rows exist only from a verified BM assertion").
* Lifecycle: triage/diagnosis/referral/inspection + cancellation (`handyman-lifecycle-api`, `0459`, `0460`).
* Tenant-approval-like surfaces: `tenant-approvals`, `handyman-tenant-decision-authority` (PIC-personal authority), `handyman-request-parties`.

**Findings**

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED** | Care intake + tenant consent. Evidence: `handyman-care-request-create` **10/10**, `handyman-care-tenant-request-gateway-http` **9/9**, `handyman-tenant-slot-consent` **5/5**, `handyman-appointment-core` **19/19**, `handyman-e2e-capability-closure` **4/4** |
| P2-13 | P2 | **PARTIAL** | Consent evidence has **no HTTP read surface for the tenant lane**: consent rows are readable only through Care/Ops projections. The tenant (or a tenant browser client) cannot fetch "what I consented to". If the Browser/APK lane needs it, it is a new contract, not an existing one. |
| P2-14 | P2 | **PARTIAL** | `src/modules/tenant-intake/` contains **types only** (no routes, no service). Any consumer reading "tenant-intake" in the tree should not assume a surface; intake lives in `handyman-service-request`/`handyman-api`. |

---

### 5.3 Area 3 — Inspection and execution booking, capacity, permits

**Implemented:**

* Booking proposals: `GET/POST /handyman/requests/:id/visits`, `POST …/visits/:appointmentId/cancel-proposal` — `handyman-visit-api.routes.ts` (R1C surface, now merged).
* Tenant confirmation (Ops): `POST /handyman/requests/:id/visits/:appointmentId/confirm` — `handyman-tenant-slot-consent.routes.ts:44`.
* Capacity: `handyman_visit_capacity_reservations` (0431:142) with `EXCLUDE USING gist` no-double-book, exact-window identity guard, and **deferred constraint triggers** that make a CONFIRMED/IN_PROGRESS appointment require an active reservation, and a terminal appointment release it (`0431:207–238`).
* Admission evaluator: `evaluateHandymanAppointmentAdmission` (`handyman-appointment-core.ts:141`) — identity, timezone, window, kind, tenant-choice verification, permit/site-access gates, `CAPACITY_CONFLICT` for `CONFIRMED|IN_PROGRESS` overlaps.
* Permits: `permit-applications`, `permit-approvals`, `permit-workers`, `permit-work-lifecycle`, `permit-to-work-register`, `work-permit-readiness`, `handyman-permit-readiness` (10/10).
* Arrival/attempts: `handyman-arrival-*`, `handyman_visit_attempts` (append-only, `NO_SHOW`/`ACCESS_BLOCKED`/`REBOOK_REQUIRED`).

**Findings**

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED** | Booking + capacity + permits core. Evidence: `handyman-appointment-core` **19/19**, `handyman-permit-readiness` **10/10**, `handyman-tenant-slot-consent` **5/5** |
| P2-11 | P2 | **PARTIAL** | **Capacity is overlap-only.** The model prevents two appointments occupying the same `(client, resourceType, resourceId)` window, but has no quota dimension (daily visit cap, crew-size limit, per-Building throughput) and no capacity-configuration API. `handyman-scheduling.service.ts:30` states outright that scheduling readiness "never reserves worker capacity". Acceptable if Operations is expected to serialise manually — must be an explicit product decision. |
| P1-07 (part) | P1 | **UNVERIFIED** | `permit-work-lifecycle` **0/14 on `9a15ad6`**, and **identically 0/14 on baseline `e8b94af`** (A/B). Pre-existing test debt, not a #55–#57 regression, but it means the *permit lifecycle HTTP behaviour* has no green evidence in this environment. |

---

### 5.4 Area 4 — Versioned quotation and approval

**Implemented:**

* Versioned lifecycle: `handyman-quotation-lifecycle.service.ts` — `DRAFT→ISSUED`, `ISSUED→EXPIRED`, replacement issuance atomically `SUPERSEDED`; lines/identity/commercial snapshots immutable (0391/0392 DB triggers).
* Lines, decision, presented read, execution scope: `handyman-quotations` (+ `handyman-quotations-api`).
* Approval: `handyman-quotation-decision.service.ts` with **PIC-personal authority** (`assertHandymanTenantDecisionActor`) and exact-Building access.
* Consumer-projection security: `CR-HM-QUOTE-PROJECTION-SEC-01_FRONTEND_HANDOFF.md`.

**Findings**

| ID | Severity | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED** | Versioned quotation + approval. Evidence: `handyman-quotation-lifecycle` **10/10**, `handyman-quotation-decision` **12/12**, `handyman-quotation` / `-line` / `-scope-guard` (repo-pinned green) |
| P1-07 (part) | P1 | **PARTIAL/UNVERIFIED** | `handyman-building-scope-guard-part02` **7/9**: cases 8–9 fail with `403 HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN` because the fixture decides as a non-PIC actor. **Identical 7/9 on baseline `e8b94af`** → FG-10 class, not a regression. The guard is correct; the fixture is stale. |

---

### 5.5 Area 5 — Crew assignment, acceptance, work sessions and evidence

**Implemented:**

* Assignment: `work-order-assignment.service.ts` — one transaction (lock → insert assignment → **competency gate** decision row → `ensurePendingForAssignment` → operational event → deduplicated IN_APP notification), reassignment supersedes, `vendor_id` nullable for DIRECT workforce (`0466`).
* Acceptance: `assignment-responses` — `TERIMA`/`TIDAK_BISA` across `WORK_ORDER_ASSIGNMENT`, `EXECUTION_SCOPE_ASSIGNMENT`, `INSPECTOR_VISIT_ASSIGNMENT`; response state projected into mobile/operations feeds (`PART 02C`).
* Work sessions: `handyman-work-sessions` (`check-in` gated on ARRIVAL VERIFIED, `start-work`, `pause`, `material-run`, `resume`, `complete`, `check-out`, time projection) behind CURRENT Crew Lead authority.
* Evidence: `handyman-field-evidence` (verified bytes, sha256/size), `evidence` (CREATE/FILE_ADD/FINALIZE), `evidence-requirements`, retention policies; helper attendance acknowledgement `0471`; field expenses/reimbursement `0470`.

**Findings**

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED** | Crew assignment + acceptance + competency gate. Evidence: `handyman-assignment-response-part02a` **8/8**, `-02b` **5/5**, `-02c` **6/6**, `handyman-competency-assignment` **11/11**, `workforce-certifications-http` **18/18**, `release-integration-merged-e2e` **11/11** |
| P1-07 (part) | P1 | **UNVERIFIED** | **Work-session runtime has no green suite in this environment:** `handyman-work-session-commands` **0/6**, `handyman-work-session-lifecycle` **0/6**, `handyman-work-sessions-api` **0/6** — all fail with `HANDYMAN_WORKFORCE_BINDING_REQUIRED` ("ACTIVE provider context and an ACTIVE vendor workforce binding … required"), and **all three are identically red on baseline `e8b94af`**. This is fixture debt introduced/left by the provider-context model, not by #55–#57. The service code is present and typechecks; the *journey evidence* is missing. |

---

### 5.6 Area 6 — QC, rework, BAST, invoice and financial ledger

**Implemented:**

* QC: `handyman-evidence-qc` (`open`, item outcomes, `finish`, supervisor authority), `handyman-qc-pass-gate` (`assertCurrentGuardedHandymanQcPass`), defect ladder + rework (`finding-rework`, `handyman-service-warranty-reworks`).
* BAST: `handyman-bast` / `handyman-bast-api` / `handyman-bast-worker-api` — prepare/issue/void (worker, `handyman.bast.manage` withheld by default), customer accept/reject/sign-off with `signatureDigest` + same-scope evidence, guarded by QC pass and work-session completion.
* Invoice: Handyman has **no own invoice entity**; charges bind to the tenant-invoice domain (`0432_handyman_charge_tenant_invoice_source.ts`), plus `invoice-payment-status`, `invoice-reconciliation` summary.
* Ledger: `handyman-customer-transactions` → `handyman-customer-payments` → `handyman-customer-payment-allocations` → `handyman-customer-ledger-corrections`; `handyman-customer-ledger-read` (`readHandymanLedgerTransactionAt`, client basis); money as canonical decimal strings, `bigint` cents in close logic.

**Findings**

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED** | Rework, BAST, ledger, payments. Evidence: `finding-rework-flow` **9/9**, `handyman-service-warranty-rework-part03` **10/10**, `handyman-bast-lifecycle` **4/4**, `handyman-bast-acceptance` **4/4**, `handyman-customer-payments` **6/6**, `handyman-payment-allocation` **6/6**, `handyman-customer-care-ledger` **5/5** |
| P1-07 (part) | P1 | **UNVERIFIED** | **QC HTTP path has no green suite:** `handyman-evidence-qc-api` **1/5**, `handyman-evidence-qc` **2/6**; both **identical on baseline `e8b94af`**. Failures are (a) pinned schema/shape assertions that later migrations invalidated, (b) fixture actor lacking QC authority, (c) a cascading `handyman_qc_runs_one_open_per_scope_idx` duplicate. Runtime code is present; evidence is not. |
| P2-10 | P2 | **PARTIAL (design)** | Invoice is borrowed from the tenant-invoice domain. If a Handyman-branded invoice document (numbering, PDF, delivery) is required by the business, that is **new scope**, not a gap in existing wiring. |
| P2-15 | P2 | **PARTIAL** | `docs/handyman/CR-HM-18_FULL_CAPABILITY_CLOSURE.md:53` says **21** FINAL-CLOSE blocker codes; the code (`handyman-final-close.service.ts:143–163`) and the API handoffs say **20**. Doc drift only. |

---

### 5.7 Area 7 — Care payment report vs Finance verification

**Implemented (separation of duty is explicit and enforced at the transport):**

| Action | Route | Gate | Behaviour |
| --- | --- | --- | --- |
| Care/Tenant **reports** a payment | `POST /handyman/execution-scopes/:id/customer-payments` | `tenant_company.manage` + exact-Building | records `PENDING`, single-use `idempotencyKey`, neutral channel + bounded free text, external reference unique per transaction |
| Finance **verifies** | `POST …/customer-payments/:paymentId/confirm` / `…/reject` | `handyman.finance.manage` | ledger becomes authoritative only here |
| Reads | `GET …/customer-ledger`, `GET /handyman/customer-ledger`, `GET …/financial-ledger` (`handyman.finance.read`), `GET …/customer-payments`, `GET /handyman/financial-transactions`, `GET /handyman/finance/action-inbox` | `tenant_company.read` / `handyman.finance.read` | Building-scoped in SQL *before* pagination/aggregation |

Evidence: `handyman-customer-ledger-api.routes.ts:52–103` (comment block is the authority law), `handyman-customer-payment.service.ts` header ("Payment truth is LEDGER-AUTHORITATIVE"), `docs/handyman/CR-HM-FIN-DISCOVERY-02_OPERATIONS_HANDOFF.md`.

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED** | Care report vs Finance verification. Evidence: `handyman-customer-payments` **6/6**, `handyman-payment-allocation` **6/6**, `handyman-customer-care-ledger` **5/5**, `handyman-finance-authority` **1/1** |
| P2-16 | P2 | **OPEN (decision)** | **No bank-receipt attestation.** Finance confirm validates idempotency + authority only; the bank statement itself is not attested/uploaded (FG-05, PR #47 open). If Finance requires documentary evidence for audit, revive #47 with a migration ≥ `0473`. |

---

### 5.8 Area 8 — Manager-only audited FINAL CLOSE

**Implemented:** `executeHandymanManagerFinalClose` (`handyman-final-close.service.ts:1025`), route `POST /handyman/execution-scopes/:executionScopeId/final-close` (`handyman-finance-close-api.routes.ts:96–101`), readiness `GET …/final-close/readiness`.

Verified properties:

* single `withTransaction`; `SELECT … FOR UPDATE` on the scope **and** the ledger transaction (serialises concurrent payment/allocation mutation);
* exact-Building access (`canAccessBuildingScopedResource`);
* **`assertNotFieldExecutionActorOnScope`** — the field actor cannot close;
* 20 blocker codes covering crew, sessions, materials, variations, QC, defects, BAST + sign-off, ledger, DP/pelunasan, overpayment, final invoice and settlement exceptions;
* immutable `handyman_execution_scope_close_events` row (actor, reason, idempotency key, amounts snapshot) + operational event; replay returns the same event only for the same actor/key/reason.

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED (functional)** | Evidence: `handyman-e2e-finance-close-api` **6/6**, `handyman-e2e-financial-reconciliation-close` **2/2** |
| P1-09 | P1 | **PARTIAL** | **The manager gate is `finding.close`** — a *findings* permission (`routes.ts:81`), documented consistently (`openapi.yaml:81081`, `HANDYMAN_BACKEND_API_HANDOFF.md:23`). Consequences: (a) authority vocabulary conflates QC finding closure with financial close; (b) any role granted `finding.close` **and** `handyman.finance.read` can close money — including a QC supervisor, not only `MANAGER`; (c) there is **no four-eyes rule** against the Finance verifier (the same person may confirm every payment and then close). The withholding of `handyman.finance.read` from the seed mitigates (b), but the design relies on grant discipline, not on a manager-specific authority. Recommended: introduce a dedicated `handyman.finance.close` (or assert `MANAGER` membership) and, optionally, "closer ≠ final payment verifier". |
| P2-15 | P2 | **OPEN (doc)** | 20 vs 21 blocker-code drift (see 5.6). |

---

### 5.9 Area 9 — Notifications (IN_APP, WEB_PUSH, FCM_ANDROID, device registration, dedup, acknowledgment, escalation)

**Implemented and verified:**

| Element | Where | Evidence |
| --- | --- | --- |
| IN_APP inbox | `GET /notifications`, `GET /notifications/:id`, `PATCH /notifications/:id/read`, `GET /notifications/:id/navigation-target` (`notification.routes.ts:44–47`) | `notification` suite (repo-pinned), `notification-delivery` **9/9** |
| Templates / subscriptions / reminders / escalations / history / secure links | `notification-templates|subscriptions|reminders|escalations|history|secure-links` routers | `notification-*` suites (repo-pinned); `notification-delivery` **9/9** |
| Device registration | `POST/GET /mobile/push-tokens`, `DELETE /mobile/push-tokens/:tokenId` (`push-token.routes.ts`) | `mobile-push-token` **10/10** |
| FCM Android adapter | `src/modules/push-delivery/fcm-push-adapter.ts` (HTTP v1 + RS256 JWT, zero SDK) | `push01-part02` (repo-pinned) |
| Push ledger / fan-out / attempts / retry / invalid-token / telemetry | `notification_push_deliveries` (0336), `outbound-push-fanout`, `outbound-push-dispatch`, `push-token-invalidation` | `push01-part03a/03b/03c/04a/04b/04c/04d` (repo-pinned); `push01-part06` **25/27** |
| Escalation | `notification_escalations` (0244), `triggerDueEscalations`, SLA escalation actions/policies (`0424`), in-process scheduler | `cr-be-stab-01-due-job-dispatcher` (repo-pinned); `sla-escalation-trigger` |
| In-app dedup | partial unique index for assignment source types (`0472:179`) + `ON CONFLICT … DO NOTHING` (`assignment-response.notifications.ts:41`) | `handyman-assignment-response-part02a/b/c` |

**Findings**

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| P1-01 | P1 | **OPEN** | **PUSH delivery is unreachable from runtime domain events.** Three independent proofs: (1) the only producer of outbound intents is `deliverOutboundNotifications`, whose only caller is `emitHandymanNotificationIntent` (`handyman-notification-intent.service.ts:62`), which has **zero callers in `src/`**; (2) the intent service derives the channel from `template.channel` (`outbound-delivery-intent.service.ts:162`), but the DB CHECK on `notification_templates.channel` is `IN_APP | EMAIL | WHATSAPP` (`0300:34`; re-verified on a migrated PG 18 cluster: `CHECK ((channel = ANY (ARRAY['IN_APP','EMAIL','WHATSAPP'])))`) → a PUSH template **cannot be created**; (3) `notification_templates` has **0 rows** after a fresh migrate (no seed). Net effect: the FCM adapter, fan-out, retry engine and evidence ledger are all real and tested, but **no production path can enqueue a PUSH row**. |
| P1-02 | P1 | **OPEN (decision)** | **WEB_PUSH is not implemented** and is explicitly excluded by governance (`docs/CR-BE-PUSH-01_START_GOVERNANCE.md` §16, D-02, R-06; "no Web Push / VAPID"), consistent with `mobile_push_tokens.platform ∈ {ANDROID, IOS}` and `APP_VERSION_PLATFORMS = ['ANDROID','IOS']`. Requirement #9 names WEB_PUSH, so this is a **product/architecture decision**, not a bug: implement (VAPID keys, service worker, subscription object, new CHECK) or formally accept its absence. |
| P1-03 | P1 | **OPEN** | **No notification acknowledgement.** `NOTIFICATION_STATUSES = ['UNREAD','READ']` (`notification.types.ts:13`; DB `notifications_status_check` re-verified on PG 18 = `UNREAD|READ`). There is no `ACKNOWLEDGED` state, no ack endpoint, no "unacknowledged after N minutes" escalation, and no per-recipient ack ledger. `ACKNOWLEDGE` appears only as a **work-order action** in the mobile feed — a different semantic. Escalation therefore fires on time, not on non-acknowledgement. |
| P2-03 | P2 | **PARTIAL** | **Deduplication is not general.** IN_APP dedup exists only for the three assignment source types (partial unique index); generic IN_APP notifications have no dedup key. Outbound dedup is per `(client_id, channel, idempotency_key)` and sound. A repeated domain event outside the assignment family can duplicate inbox rows. |
| P2-04 | P2 | **PARTIAL** | **Dead seam / duplicated production.** Handyman modules write notifications directly (`assignment-response.notifications.ts`, `sla-escalation-trigger.service.ts:165`, `notification-reminder.service.ts:225`, `notification-escalation.service.ts:227`) instead of the intended single admission seam `emitHandymanNotificationIntent`, which is test-only. This is why P1-01 could happen unnoticed. |
| P2-05 | P2 | **OPEN** | No notification templates are seeded or migrated (`grep "INSERT INTO notification_templates" src/database/migrations` → 0). Any subscription/reminder/escalation therefore depends on an operator creating templates through the API first. Documented nowhere in the go-live checklist. |
| P1-10 | P1 | **OPEN** | **`.env.example` sets `SCHEDULER_ENABLED=false`** while `readScheduler` defaults to **enabled in production** (`src/config/env.ts:395–421`) and `server.ts:92` starts the loop. An operator copying `.env.example` (the documented pattern) silently disables reminders, escalations and outbound dispatch. The env matrix (`docs/HANDYMAN_DEPLOYMENT_ENV_MATRIX.md:27`) does say "true in production", so the two artifacts contradict each other. |
| — | — | **CLOSED** | IN_APP notifications, device registration, escalation scheduling. Evidence: `notification-delivery` **9/9**, `mobile-push-token` **10/10** |

---

### 5.10 Area 10 — Shared API contracts for Mobile Browser and Android APK

**Implemented:**

* One contract of record: `docs/api/openapi.yaml` — 1 532 paths / 2 032 operations / 2 032 unique `operationId`s (287 `/handyman`, 54 `/mobile`), OpenAPI 3.0.3.
* Runtime↔OpenAPI reconciliation is a test, not a promise: `openapi-contract` **7/7**, `mobile-openapi-completeness` **5/5**, `handyman-contract-freeze-03-openapi` **13/13** (permission membership, phantom-error absence).
* Lane handoffs: `docs/api/HANDYMAN_BACKEND_API_HANDOFF{,_CUSTOMER_CARE,_OPERATIONS,_MOBILE}.md`, `CR_BE_PUSH_01_MOBILE_HANDOFF.md`, `CR-HM-BAST-WORKER-READ-01_MOBILE_HANDOFF.md`, `CR-HM-FIELD-EXPENSE-HELPER-01_PART02_MOBILE_HANDOFF.md`, `CR-HM-ASSIGNMENT-RESPONSE-01_PART02C_CROSS_APP_PROJECTION_AND_HANDOFF.md`.
* Shared conventions: `Authorization: Bearer <opaque session>`, `X-Request-ID`, `Idempotency-Key` (allowed in CORS preflight), `X-Device-Id` / `X-Platform` / `X-App-Version` captured for diagnostics (`src/middleware/mobile-context.ts`), `GET /mobile/app-version/:platform`.

**Findings**

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| — | — | **CLOSED** | The *same* REST contract serves browser and APK lanes; no platform-specific duplicate API exists. |
| P2-01 | P2 | **OPEN** | **The frozen contract pins are stale.** Handoffs and the gap register still cite `f2ffec3f…`/`b5edd56f…` (1 494 paths / 1 985 ops / 2 256 schemas); the file at HEAD is `d90af07d…` (1 532 / 2 032 / 2 312). PR #57 updated counts but published **no new SHA-256 pin**. Until a pin is re-issued, "which contract did the consumer build against?" is unanswerable. |
| P2-02 | P2 | **OPEN** | **The browser lane has no platform identity or version gate.** `mobile-context.ts:29` accepts only `ANDROID|IOS`, and `app-versions.types.ts` (`APP_VERSION_PLATFORMS`) plus `GET /mobile/app-version/:platform` cover only `ANDROID|IOS`. A mobile-browser/PWA client cannot identify itself, cannot be version-gated, cannot register a push token (see P1-02), and has no "minimum supported client" policy. Everything else in the contract is shared. |
| P1-05 | P1 | **OPEN** | **Consumer verification (FG-03) is still absent.** No Frontend/Operations/Mobile repository was readable; the backend cannot prove the three consumers build against `d90af07d…`. PR #57's own report limits itself to backend evidence. |
| P2-17 | P2 | **PARTIAL** | Idempotency is implemented in two dialects: the generic `request-idempotency` module (3 consumers) and per-domain `idempotencyKey` columns/single-use keys (177 modules reference `idempotencyKey`). Both work; the handoff must state per-endpoint behaviour instead of a single rule, otherwise clients will assume the wrong replay semantics. |

---

### 5.11 Area 11 — PostgreSQL migration compatibility, idempotency, audit, security, production readiness

**Migration compatibility — CLOSED (strongest evidence in this audit):**

* `src/database/migrate.ts:38` — `pg_try_advisory_lock(724196031)`, single runner enforced.
* Per-migration transaction (`migrateUp` wraps `migration.up` + history insert), unknown-history refusal, `verifyMigrationReadiness` fails closed at boot (`migrate.ts:17–30`), so a half-migrated schema refuses traffic.
* Harness `tests/manual/release-integration-migration-check.ts` re-executed: **21/21 PASS**, including
  * fresh migrate to tip and history == registry (no `0469`),
  * immediate re-run = 0 applied,
  * **production representation (…0460) → upgrade `0461–0468`, `0470–0472`** with byte-identical password hashes and unchanged users/roles/assignments,
  * **schema convergence**: fresh-install schema == upgraded schema, identical ledger fingerprint,
  * **failure recovery**: a conflicting object fails the run, is not recorded, leaves no partial DDL, and forward repair completes the release.

**Audit & security — mostly CLOSED:**

* Append-only auth audit (`0011`, `0453`, `0468`), operational events per domain, immutable close events, append-only decision ledgers, `insertAuditEvent`/`listAuditEvents`, `GET /auth/audit-events` behind `auth.audit.read`.
* Opaque sessions hashed SHA-256, bcrypt passwords, privilege guard, forced change, exact-origin CORS, helmet, JSON body limit, request-id propagation, error envelope without stack leakage (`src/middleware/error-handler.ts`), logger redaction (`src/shared/logger.ts:60`).
* Query parameterisation is universal in the audited modules: exactly one template-literal SQL query exists (`handyman-evidence-qc.repository.ts:545`) and it interpolates a module constant, not request data; evidence storage resolves a fixed root (`local-evidence-storage.ts:22,83`).
* Evidence: `audit` **14/14**, `permission-revocation` **8/8**, `users` 3 pass (11 legacy skips), `handyman-finance-authority` **1/1**.

**Production readiness — PARTIAL:**

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| P1-04 | P1 | **OPEN** | **No CI in this repository.** `.github/` does not exist and never existed (`git log --all -- .github` is empty). `docs/CR-BE-CI-01_DEFERRED_CI_DEBT.md` describes `.github/workflows/ci.yml` as "intact and authoritative" — that document refers to the sibling `Asentra-Backend` repository and was carried over. Consequence: **no automated gate** protects `main`; every green result in this audit and in PR #57 is a manual/local run. `tests/push01-part06-closure-and-final-freeze.test.ts:687` fails precisely because it tries to read that missing file. |
| P1-07 | P1 | **OPEN** | **Baseline test debt is larger than FG-10 records.** Re-run on `9a15ad6` and A/B-confirmed identical on `e8b94af`: `handyman-work-session-commands` 0/6, `handyman-work-session-lifecycle` 0/6, `handyman-work-sessions-api` 0/6, `handyman-evidence-qc` 2/6, `handyman-evidence-qc-api` 1/5, `permit-work-lifecycle` 0/14, `handyman-building-scope-guard-part02` 7/9, `handyman-bast-signoff-scope-guard` 0/2. FG-10 lists seven *different* suites; these eight are **not** in it. Runtime is likely fine (services typecheck; newer focused suites pass), but **journey evidence for work sessions, QC and permits is currently unavailable**, so those journeys cannot be cited for FG-04 staging sign-off. |
| P1-08 | P1 | **OPEN** | Login throttle keyed on socket IP with no `trust proxy`; no global rate limiting (see 5.1). |
| P1-10 | P1 | **OPEN** | `SCHEDULER_ENABLED=false` in `.env.example` vs production default `true` (see 5.9). |
| P2-06 | P2 | **OPEN** | `src/database/migrate.ts:112–120` special-cases migration id `0472` inside the runner (re-runs `up` when the notifications CHECK is stale). It is documented and additive, but it is migration-specific logic in the generic runner — a second such hack would make the runner un-auditable. Prefer an idempotent `up()` + a repair migration. |
| P2-07 | P2 | **OPEN** | `docker-compose.yml:16` uses `postgres:16`; production and the whole test evidence base are **PostgreSQL 18.4**. `btree_gist`, `EXCLUDE`, deferred constraint triggers and `CHECK` re-validation behave the same on 16, but the tested engine should match the deployed one. |
| P2-18 | P2 | **OPEN** | Single-replica assumptions: `railway.json` pins `numReplicas: 1`; the due-job scheduler is an in-process `setInterval` with an `inFlight` guard only. Scaling out duplicates delivery ticks (mitigated by `FOR UPDATE SKIP LOCKED` + claim guards, not eliminated). Must be an explicit constraint in the deployment runbook. |

---

## 6. Consolidated findings register

Severity: **P0** breaks a journey / data integrity · **P1** blocks a requirement or production readiness · **P2** decision, debt or doc control.

### P0 — 0 open

No P0 was found in the audited runtime. The money path (record → verify → allocate → correct → invoice → BAST → close) is transactional, scope-checked, idempotent and replay-safe; the schema upgrade path is proven on PG 18 including failure recovery.

### P1 — 10 open

| ID | Area | Finding | Status | Owner |
| --- | --- | --- | --- | --- |
| P1-01 | 9 | Outbound/PUSH delivery has **no runtime producer**; `notification_templates.channel` CHECK excludes `PUSH`; 0 templates seeded | OPEN | Backend + Product |
| P1-02 | 9 | WEB_PUSH absent by governance decision | OPEN (decision) | Product + Security |
| P1-03 | 9 | No notification acknowledgement (UNREAD/READ only; no ack endpoint/state/escalation) | OPEN | Backend + Product |
| P1-04 | 11 | No CI workflow in the repository (`.github` never existed) despite docs claiming it | OPEN | DevOps |
| P1-05 | 10 | Consumer verification (FG-03) not performed; no cross-repo PASS | OPEN | Integration |
| P1-06 | 11 | Staging E2E + staging migration status (FG-04) not executed | OPEN | Operator |
| P1-07 | 5/6/3/4 | 8 suites red on `9a15ad6` **and** on baseline `e8b94af`; work-session/QC/permit journey evidence missing; FG-10 under-scoped | OPEN | Backend QA |
| P1-08 | 1/11 | Login throttle keyed on socket IP, no `trust proxy`, no global rate limit | OPEN | Backend + Platform |
| P1-09 | 8 | FINAL CLOSE gated by `finding.close`; no manager-specific authority; no four-eyes vs Finance verifier | PARTIAL | Product + Backend |
| P1-10 | 9/11 | `SCHEDULER_ENABLED=false` in `.env.example` vs prod default `true` | OPEN | DevOps |

### P2 — 12 open

| ID | Area | Finding | Status |
| --- | --- | --- | --- |
| P2-01 | 10 | OpenAPI pins stale (`f2ffec…`/`b5edd…` vs `d90af0…`); no post-#57 pin | OPEN |
| P2-02 | 10 | Browser lane has no platform identity/version gate (`ANDROID|IOS` only) | OPEN |
| P2-03 | 9 | IN_APP dedup only for assignment source types | PARTIAL |
| P2-04 | 9 | `emitHandymanNotificationIntent` is dead; notification production duplicated | PARTIAL |
| P2-05 | 9 | No notification templates seeded | OPEN |
| P2-06 | 11 | Runner special-cases migration `0472` | OPEN |
| P2-07 | 11 | compose PostgreSQL 16 vs production/tested 18 | OPEN |
| P2-08 | 1 | "Super User" has no first-class role; no owner-recovery path documented; no MFA | PARTIAL |
| P2-10 | 6 | No Handyman-owned invoice entity (borrowed from tenant-invoice domain) | PARTIAL (design) |
| P2-11 | 3 | Capacity is overlap-only; no quota/calendar dimension | PARTIAL (design) |
| P2-13 | 2 | No tenant-facing consent read surface | PARTIAL |
| P2-17 | 10 | Two idempotency dialects must be documented per endpoint | PARTIAL |

Additional P2 observations already stated inline (not counted separately to avoid double-billing): P2-09/15 doc drift 20 vs 21 blocker codes, P2-12 FG-10 under-scoping (folded into P1-07), P2-14 `tenant-intake` types-only, P2-16 bank-receipt attestation (= FG-05), P2-18 single-replica scheduler.

---

## 7. API contract handoffs

### 7.1 Shared conventions (both lanes)

| Item | Contract |
| --- | --- |
| Base | `{API_PREFIX}` = `/api/v1` |
| Auth | `Authorization: Bearer <opaque session token>` from `POST /auth/login` (`{email,password}`); token returned once, stored server-side as SHA-256; TTL 480 min (configurable), sliding "last used" throttle 5 min |
| Envelope (success) | `{ success: true, data, meta: { requestId } }` |
| Envelope (error) | `{ success: false, error: { code, message, details? }, meta: { requestId } }` |
| Statuses | 400 `VALIDATION_ERROR` · 401 · 403 (`PERMISSION_DENIED`, `HANDYMAN_*_NOT_AUTHORIZED`) · 404 · 409 (`*_CONFLICT`, `*_ALREADY_*`, `IDEMPOTENCY_CONFLICT`) · 413 · 429 `AUTH_RATE_LIMITED` · 500 (no stack leakage) |
| Idempotency | Mutating commands take `idempotencyKey` (1…200 chars). Same key + same payload → replay of the stored success; same key + different payload → 409. Some commands use the `Idempotency-Key` header (CORS-allowed) — **per-endpoint behaviour, see each lane table** |
| Correlation | Client may send `X-Request-ID`; response echoes it; server generates one otherwise |
| Scope | Every handyman read/write re-derives `clientId`/`buildingId` server-side and checks `user_building_assignments` for the **exact** Building. Never send `actorUserId` (rejected with 400) |

### 7.2 Mobile Browser lane (browser/PWA consumer)

Status: **shared contract CLOSED; platform identity OPEN (P2-02); push OPEN (P1-02).**

| Capability | Endpoint(s) | Gate | Status |
| --- | --- | --- | --- |
| Login / context | `POST /auth/login`, `GET /auth/me`, `POST /auth/password-change`, `POST /auth/logout` | — / session | CLOSED |
| Care intake | `POST /handyman/requests/care` (exchange token), `GET /handyman/requests`, `GET /handyman/requests/:id` | exchange / `tenant_company.read` | CLOSED |
| Request lifecycle | `POST/GET …/triage|inspection|diagnosis|referral|cancel|cancellation` | `tenant_company.manage|read` | CLOSED |
| Visits / booking | `GET/POST …/visits`, `POST …/visits/:id/cancel-proposal` | `tenant_company.read|manage` | CLOSED |
| Tenant consent | server-verified assertion only (no client-created consent) | HMAC assertion | CLOSED (create); **read surface absent** (P2-13) |
| Quotation | `POST/GET …/quotation`, `…/quotation/presented`, `POST …/versions`, approve/reject decision | PIC personal authority | CLOSED |
| Payments (report only) | `POST …/customer-payments`, `GET …/customer-payments`, `GET …/customer-ledger` | `tenant_company.manage|read` | CLOSED |
| BAST accept/reject/sign-off | `handyman-bast-api` customer commands | same-scope evidence + `signatureDigest` | CLOSED |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read`, `GET /notifications/:id/navigation-target` | session | CLOSED (IN_APP) |
| Push registration | **not available for browsers** | — | **OPEN** (P1-02) |
| App version policy | **not available for browsers** | — | **OPEN** (P2-02) |

### 7.3 Android APK lane (worker / field)

Status: **shared contract CLOSED; FCM delivery engine CLOSED; end-to-end push delivery OPEN (P1-01); acknowledgement OPEN (P1-03).**

| Capability | Endpoint(s) | Gate | Status |
| --- | --- | --- | --- |
| Login / context | `POST /auth/login`, `GET /auth/me` | session | CLOSED |
| App version | `GET /mobile/app-version/android` | public | CLOSED |
| Device registration | `POST/GET /mobile/push-tokens`, `DELETE /mobile/push-tokens/:tokenId` | session, self-scoped | CLOSED |
| Assignment feed | `GET /mobile/assignments`, `GET /handyman/field/my-jobs` | session + current worker | CLOSED |
| Assignment response | `POST …/assignments/:id/respond` (`TERIMA`/`TIDAK BISA`) across WO / execution scope / inspector visit | current assignee, idempotent | CLOSED |
| Work sessions | `POST /handyman/work-sessions/:id/check-in|start-work|pause|material-run|resume|complete|check-out`, `GET …/active`, `GET …/time-projection` | **auth-only**, CURRENT Crew Lead | CLOSED (code) / **UNVERIFIED** (suite red, P1-07) |
| Field evidence | `POST /handyman/field/evidence/upload`, `GET …/:id/bytes|content|confirm` | auth + assigned worker, sha256/size verified | CLOSED |
| Material execution / purchasing | `handyman-material-execution` routers | auth + crew | CLOSED |
| Worker BAST | `POST /handyman/field/execution-scopes/:id/bast/prepare|issue` | CURRENT Crew Lead + QC PASS + sessions + verified bytes | CLOSED |
| Helper attendance | `0471` roster confirm / personnel change | CURRENT Crew Lead | CLOSED (`handyman-helper-attendance-confirmation` repo-pinned) |
| Field expense | `0470` receipt capture + reimbursement request | assigned worker; personal funds only | CLOSED (repo-pinned) |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read`, navigation target | session | CLOSED (IN_APP) |
| Push delivery | FCM HTTP v1 (Android native; iOS via FCM relay) | `PUSH_PROVIDER=fcm` + `PUSH_FCM_*` | **OPEN end-to-end** (P1-01) |

### 7.4 Consumer-facing handoff actions (no backend change implied)

1. **Mobile Browser:** treat `PATCH /notifications/:id/read` as the only acknowledgement primitive today; do not build UI that waits for `ACKNOWLEDGED` (absent). Do not send `X-Platform: WEB` — it is silently dropped.
2. **Android APK:** register `(deviceId, pushToken)` after login and on every token rotation; expect `notification_push_deliveries` evidence to stay empty until P1-01 is closed — plan a fallback (poll `GET /notifications`, or a foreground refresh) for the release.
3. **Operations:** `POST …/final-close` requires **both** `finding.close` and `handyman.finance.read`; surface the readiness blockers verbatim (`error.details[]`, 20 codes) instead of mapping them to generic messages.
4. **Finance:** confirm/reject are the only authoritative money transitions; report ≠ verify (P2-16 for bank attestation).

---

## 8. Test evidence appendix (executed in this audit)

Environment: Node 22.22.3, `tsx --test --test-concurrency=1`, disposable PostgreSQL **18.4**, one fresh database per suite (`DB_NAME`), `ASENTRA_USE_EMBEDDED_POSTGRES=true` for suites that boot their own cluster. Suites that hard-code a local `asentra_test` were pointed at the audit cluster via `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`.

### 8.1 Green at `9a15ad6`

| Suite | Result |
| --- | --- |
| `iam-bootstrap` | **24/24** |
| `permission-revocation` | **8/8** |
| `audit` | **14/14** |
| `handyman-finance-authority` | **1/1** |
| `handyman-quotation-lifecycle` | **10/10** |
| `handyman-quotation-decision` | **12/12** |
| `handyman-appointment-core` | **19/19** |
| `handyman-tenant-slot-consent` | **5/5** |
| `handyman-assignment-response-part02a` / `-02b` / `-02c` | **8/8**, **5/5**, **6/6** |
| `handyman-competency-assignment` | **11/11** |
| `workforce-certifications-http` | **18/18** |
| `handyman-permit-readiness` | **10/10** |
| `handyman-bast-lifecycle` / `handyman-bast-acceptance` | **4/4**, **4/4** |
| `handyman-customer-payments` / `handyman-payment-allocation` / `handyman-customer-care-ledger` | **6/6**, **6/6**, **5/5** |
| `handyman-e2e-finance-close-api` / `handyman-e2e-financial-reconciliation-close` | **6/6**, **2/2** |
| `finding-rework-flow` / `handyman-service-warranty-rework-part03` | **9/9**, **10/10** |
| `handyman-care-request-create` / `handyman-care-tenant-request-gateway-http` | **10/10**, **9/9** |
| `handyman-e2e-capability-closure` | **4/4** |
| `release-integration-merged-e2e` | **11/11** |
| `notification-delivery` / `mobile-push-token` | **9/9**, **10/10** |
| `openapi-contract` / `mobile-openapi-completeness` / `handyman-contract-freeze-03-openapi` | **7/7**, **5/5**, **13/13** |
| `tests/manual/release-integration-migration-check.ts` | **21/21** |
| `npx tsc --noEmit` | **PASS** |

Total: **34 suites + 1 migration harness + typecheck**, **281 focused assertions green**, 0 failures attributable to `9a15ad6`.

### 8.2 Red at `9a15ad6` — A/B-confirmed pre-existing (`e8b94af` baseline)

| Suite | At `9a15ad6` | At `e8b94af` | Root cause |
| --- | --- | --- | --- |
| `handyman-work-session-commands` | 0/6 | **0/6** | fixture lacks ACTIVE provider context + vendor workforce binding |
| `handyman-work-session-lifecycle` | 0/6 | **0/6** | same |
| `handyman-work-sessions-api` | 0/6 | **0/6** | same |
| `handyman-evidence-qc` | 2/6 | **2/6** | pinned column sets / QC actor fixture / cascading open-run |
| `handyman-evidence-qc-api` | 1/5 | **1/5** | permission + `HANDYMAN_QC_NOT_AUTHORIZED` fixtures |
| `permit-work-lifecycle` | 0/14 | **0/14** | fixture drift |
| `handyman-building-scope-guard-part02` | 7/9 | **7/9** | non-PIC decision actor in fixture (FG-10 class) |
| `handyman-bast-signoff-scope-guard` | 0/2 | (FG-10 recorded) | same |

No failure in this set is a regression from PR #55/#56/#57.

### 8.3 Red at `9a15ad6` — stale pins (expected drift, not runtime)

`push01-part06-closure-and-final-freeze` **25/27**:

1. "closes the migration sequence at 0336 with no duplicate or gap" — hard-coded expectation that the registry ends at `0336`; the registry legitimately ends at `0472`.
2. "records which PUSH suites are still absent from the CI gate" — `ENOENT …/.github/workflows/ci.yml`; the file does not exist (P1-04).

### 8.4 Not executed (and why)

* Full 854-file regression: would require hours and would mostly re-prove FG-10 debt; the focused set above covers every audited area.
* `tests/manual/release-integration-legacy-suite-check.ts` — not part of this audit's claim set.
* Any staging/production database, any consumer repository, any deployment.

---

## 9. UNVERIFIED items (explicitly not claimed)

| Item | Why |
| --- | --- |
| Frontend/Operations/Mobile compatibility with `d90af07d…` | no repository access (FG-03) |
| Staging/production migration status | no environment access (FG-04); local PG 18 evidence only |
| Work-session, QC and permit **runtime** behaviour | their suites are red on baseline; no trustworthy green run |
| Real FCM delivery to a device | no credentials; adapter covered by capture/noop tests only |
| Evidence storage durability on a mounted volume | local directory only; `verifyEvidenceStorageReady` passes at boot |
| PSrE/ECDSA BAST signature | not implemented (FG-06) |
| PR #47 bank attestation | unmerged |
| RLS/row-level security in PostgreSQL | not used; isolation is application-level (`user_building_assignments`) + FK/trigger guards |

---

## 10. Recommended next change requests (no code written in PART 01)

| Order | CR | Closes | Content |
| --- | --- | --- | --- |
| 1 | `CR-HM-NOTIFY-PROD-01` | P1-01, P2-03, P2-04, P2-05 | Widen `notification_templates.channel` to include `PUSH` **and** add an acknowledgement state/endpoint with escalation-on-unacknowledged; wire a single runtime producer (`emitHandymanNotificationIntent` or an outbox) for outbound channels; seed a minimal template set |
| 2 | `CR-HM-NOTIFY-WEB-01` (or explicit product rejection) | P1-02, P2-02 | WEB_PUSH (VAPID + platform `WEB` + app-version policy) **or** a signed decision that browser notifications are out of scope and a documented polling/SSE fallback |
| 3 | `CR-BE-CI-02` | P1-04 | Real `.github/workflows/ci.yml` with PG 18 service, `tsc`, migration harness and the focused suite matrix; make `push01-part06` read it |
| 4 | `CR-HM-TEST-DEBT-01` | P1-07, P2-12 | Repair the eight baseline-red suites (never weaken authority): default a provider context + vendor binding in the work-session fixture, decide as the PIC in the scope guards, refresh the pinned schema/shape lists, and extend FG-10 to the real list |
| 5 | `CR-HM-CLOSE-AUTH-01` | P1-09 | Dedicated `handyman.finance.close` (or MANAGER assertion) + "closer ≠ final payment verifier" rule; publish in the Operations handoff |
| 6 | `CR-HM-OPS-ENV-01` | P1-08, P1-10, P2-07, P2-18 | `trust proxy` + proxy-aware throttle (or Redis), documented `SCHEDULER_ENABLED` truth, PG 18 in compose, and a single-writer scheduler statement |
| 7 | `CR-HM-CONTRACT-PIN-01` | P2-01, P2-17 | Re-issue the OpenAPI SHA-256 + counts after #57 and state idempotency per endpoint |
| 8 | `CR-HM-STAGING-E2E-01` | P1-05, P1-06 | Operate staging: migrate, run the scenario pack, collect the three consumer reports, then declare FINAL FREEZE |

---

## 11. Audit integrity statement

* No production code, migration, seed or configuration was modified by PART 01.
* No branch was created, no PR was opened, nothing was deployed.
* The only artifact added is this document (`docs/audits/HANDYMAN-BACKEND-GAP-20261023.md`).
* Every green/red figure above is reproducible with the commands in §8; the A/B baseline used `git archive e8b94af` into a scratch directory with the same `node_modules`, so no branch was touched.
