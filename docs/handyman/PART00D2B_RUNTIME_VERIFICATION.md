# CR-HM-OPS-CONFIG-01 PART 00D-2B — Handyman Runtime Verification

Scope: **Request → Quotation → Issue → Decision → Assignment** (Handyman-Backend only).
Status of this document: verification record. No production code, route, schema, or
OpenAPI change was made. One new focused integration test file was added.

## 0. Preflight (STOP-gate)

| Check | Expected | Observed | Result |
| --- | --- | --- | --- |
| Assigned branch | `arena/ed9f4841-handyman-backend` | `arena/ed9f4841-handyman-backend` | PASS |
| HEAD | `2cca96e4e7a0b7090882be0778f9d341b734fb42` | `2cca96e4e7a0b7090882be0778f9d341b734fb42` | PASS |
| Tracked tree clean | no tracked modifications | `git status --porcelain --untracked-files=no` empty | PASS |

No branch was created, switched, or pushed to other than the assigned branch.

## 1. Environment

| Item | Value |
| --- | --- |
| Node | v22.22.3 |
| npm | 10.9.8 (`npm ci` from `package-lock.json`, exit 0) |
| Docker | **not available** in the sandbox |
| PostgreSQL | **PostgreSQL 18.4 started locally** from the `embedded-postgres` linux-x64 binaries already in `node_modules` (npm registry is on the allowed list). Data dir `/tmp/asentra-00d2b-pg` (outside the repo), `127.0.0.1:5432`, `trust` auth, test DB `asentra_test` |
| Repo compose target | `postgres:16` (`docker-compose.yml:19`). Local engine is 18.4 — a version difference, see Caveats |
| `ENV_BLOCKED` | **Not triggered.** A real PostgreSQL answered every affected test; `skipped 0` in all runs |

Test env used for every run:
`NODE_ENV=test LOG_LEVEL=error DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres DB_PASSWORD= DB_NAME=asentra_test DB_SSL=false`,
command `npx tsx --test --test-concurrency=1 <file>`.

Note on the test harness: `tests/helpers/postgres.ts` returns `null` when the DB is unreachable and the
suites then `t.skip(...)`. A run with skips is therefore **not** a PASS. All reported PASS results
below have `# skipped 0`.

## 2. Route → controller → service → repository → SQL/migration trace

Paths are relative to `src/`. Line numbers are from the checked-out HEAD.

### 2.1 Request (intake, triage, diagnosis)

| Step | Route | Controller | Service | Repository / SQL |
| --- | --- | --- | --- | --- |
| Intake `POST /api/v1/handyman/requests` | `modules/handyman-api/handyman-api.routes.ts:74-79` (`auth`, `tenant_company.manage`) | `handyman-api.controller.ts:166-179` | `handyman-requests/handyman-service-request.service.ts:231-247` (`canAccessClient` at 244-246); Client equality with catalogue `:156`; buildingId/spaceId copied from attribution `:200-215` | `handyman-service-request.repository.ts:79` `insertRequest`; `:121` `findByChannelAttribution`; `:138` `lockById` |
| Triage `POST …/triage` | `handyman-lifecycle-api/handyman-lifecycle-api.routes.ts:46-51` | `handyman-lifecycle-api.controller.ts:32-49` | `handyman-requests/handyman-request-triage.service.ts:73` (lock `:115`, `canAccessClient` `:129-134`, INTAKE gate `:122`) | `handyman-service-request.repository.ts:156` `updateStatus` |
| Diagnosis `POST …/diagnosis` | `handyman-lifecycle-api.routes.ts:70-75` | `handyman-lifecycle-api.controller.ts:116-…` | `handyman-requests/handyman-request-diagnosis.service.ts:59` (lock `:106`, DIAGNOSIS gate `:113`, `canAccessClient` `:120`) | diagnosis repository (same module) |

### 2.2 Quotation (create, lines, totals)

| Step | Route | Controller | Service | Repository / SQL |
| --- | --- | --- | --- | --- |
| Create v1 `POST /handyman/requests/:id/quotation` | `handyman-quotations-api/handyman-quotations-api.routes.ts:71-76` (`manage`) | `handyman-quotations-api.controller.ts:46-68` | `handyman-quotations/handyman-quotation.service.ts:86-165` `createHandymanQuotation`: request lock `:96`; **`canAccessClient` `:104-111`**; diagnosis-required `:117`; quotable scope class `:118-120`; one-per-request `:123-127`; insert root+v1 `:130-141`; journal `:142-159` | `handyman-quotation.repository.ts:72` `insertQuotation`, `:92` `insertVersion`, `:126` `findQuotationByRequest`. SQL `0391_create_handyman_quotations.ts`: `UNIQUE (handyman_request_id)` `:44`; composite FK `(handyman_request_id, client_id)` `:46-47`; `UNIQUE (quotation_id, version_number)` `:68`; immutability triggers (root/version no-write) |
| Lines `POST …/lines` | `routes.ts:95` | `controller.ts:134-155` | `handyman-quotations/handyman-quotation-line.service.ts` | `handyman-quotation-line.repository.ts`; SQL `0392_create_handyman_quotation_lines.ts` |

### 2.3 Issue (DRAFT → ISSUED)

| Step | Route | Controller | Service | Repository / SQL |
| --- | --- | --- | --- | --- |
| `POST /handyman/quotation-versions/:id/issue` | `handyman-quotations-api.routes.ts:98` (`manage`) | `controller.ts:199-219` | `handyman-quotations/handyman-quotation-lifecycle.service.ts:91-188` `issueHandymanQuotationVersion`: version lock `:104`; `requireAccessibleQuotation` `:109-113` (helper `:65-84`, **`canAccessClient` `:75-82`**); DRAFT-only `:114-116`; ≥1 line `:121`; future validity `:122-124`; supersede prior ISSUED `:129-158`; ISSUED projection `:160-167`; journal `:168-185` | `handyman-quotation.repository.ts:164` `lockVersionById`, `:176` `findCurrentIssued`, `:195` `updateVersionLifecycle`. SQL `0393_handyman_quotation_issued_uniqueness.ts:18`: partial unique index `… WHERE status='ISSUED'` (≤1 ISSUED per thread) |

### 2.4 Decision (APPROVE / REJECT)

| Step | Route | Controller | Service | Repository / SQL |
| --- | --- | --- | --- | --- |
| `POST …/decision` (+ `Idempotency-Key`) | `handyman-quotations-api.routes.ts:101` (`manage`) | `controller.ts:263-287` (key from header `:278`) | `handyman-quotations/handyman-quotation-decision.service.ts:120-323`: version lock `:155`; **`canAccessClient` `:165-172`**; one-decision-per-version lock `:176`; idempotent replay `:177-192`; conflict `:193`; ISSUED + server-time validity `:197-202`; request lookup `:205-209`; immutable insert `:215-226`, `23505`→conflict `:230-232`; projection `:236-238`; **APPROVE-only scope insert `:245-294`**; journal `:297-320` | `handyman-quotation-decision.repository.ts:55` `insertDecision`, `:86` `lockDecisionByVersion`. SQL `0394_create_handyman_quotation_decisions.ts`: `CHECK (decision IN ('APPROVE','REJECT'))` `:42`; `UNIQUE (quotation_version_id)` `:44`; `UNIQUE (idempotency_key)` `:46`; fingerprint check `:50`; no-write trigger `:58-70` |
| Execution Scope read `GET …/execution-scope` | `routes.ts:103` | `controller.ts:310-328` | `handyman-quotations/handyman-execution-scope.service.ts:160-175` | `handyman-execution-scope.repository.ts:107`. SQL `0395_create_handyman_execution_scopes.ts`: `UNIQUE (approved_quotation_version_id)` `:55`; `CHECK (status IN ('AUTHORIZED'))` `:53` |

Scope location (created inside the APPROVE transaction) is derived fail-closed:
`handyman-execution-scope.service.ts:69-100` — space required `:79-81`; **floor must belong to the request building `:90-92`** (`LOCATION_INCONSISTENT`).

### 2.5 Assignment (crew to Execution Scope)

| Step | Route | Controller | Service | Repository / SQL |
| --- | --- | --- | --- | --- |
| `POST /api/v1/handyman/execution-scopes/:id/assignment` | `handyman-scope-assignments-api/handyman-scope-assignments-api.routes.ts:31` (`manage`, declared `:28`) | `handyman-scope-assignments-api.controller.ts:35-55` (actor `:48`) | `handyman-scope-assignments/handyman-scope-assignment.service.ts:210-257` `assignHandymanExecutionScopeCrew`: scope lock + AUTHORIZED `requireAssignableScope :77-90` (status `:86`); **`assertRealm` `:67-74` (`canAccessClient` `:71`)**; active-row lock `:228-232`; duplicate → 409 `:233`; `validateTarget` `:109-176` (Client equality `:120`; crew/provider ACTIVE; Lead chain; `userId` non-null `:166`); insert `:239-248`; journal `:249-254` | `handyman-scope-assignment.repository.ts:46-59` `lockScopeById` (`FOR UPDATE` `:52`); `:77-102` `insertAssignment`; `:118-129` `lockActiveAssignmentByScope` (`FOR UPDATE` `:125`). SQL `0396_create_handyman_execution_scope_assignments.ts`: partial unique index `handyman_es_assignments_one_active_idx … WHERE status='ACTIVE'` `:68-70`; client-consistency trigger `:112`; no-write trigger `:149` |

RBAC gate for all of the above: `modules/auth/rbac.middleware.ts:14-48` (`requirePermission`, 403 at `:40` via
`permissionDeniedError`, `auth.errors.ts:23`). Reads use `tenant_company.read`, mutations `tenant_company.manage`.

## 3. Actor and property guard findings

| Guard | Where | What it actually checks | Finding |
| --- | --- | --- | --- |
| RBAC permission | `rbac.middleware.ts:14-48` | session has `tenant_company.read` / `.manage` | Declared on every chain route (static, §2). Exercised at runtime for one mutation only (quotation create, read-only session → 403) by test case 2; other routes are not runtime-tested for RBAC here. |
| Client realm (`canAccessClient`) | `context-access/context-access.service.ts:60-65` | user has **any ACTIVE building assignment** whose building belongs to the target Client (`resolveBuildingsForUser`) | Used by intake (`handyman-service-request.service.ts:244`), triage, diagnosis, quotation create/read/revise, issue, expire, supersede, decision, decision read, scope read, and assignment (`assertRealm`). Denial → 403 `BUILDING_ACCESS_DENIED` (`context-access.errors.ts:11-16`). |
| Property / building realm (`canAccessProperty`, `canAccessBuilding`, `assertBuildingAccess`) | `context-access/context-access.service.ts:27-56` | exact property / building membership | **Not called by any chain module** (grep of `handyman-quotations*`, `handyman-scope-assignments*`, `handyman-requests`, `handyman-api`, `handyman-lifecycle-api` returns zero matches). |
| Property/building lineage at intake | `handyman-channel-attributions/handyman-channel-attribution.service.ts:225-240` (building's Property must belong to the tenant's Client; active tenant-building context) and `:255-266` (space must have an active tenant relationship in that building → `HANDYMAN_CHANNEL_ATTRIBUTION_SPACE_MISMATCH`) | the **only** place where a building/space is bound to a Request | Runs at attribution creation, before the chain. Covered by test case 3 (sibling-building space is rejected). |
| Execution-scope location | `handyman-execution-scope.service.ts:90-92` | floor's building == request building | Defence-in-depth; not reachable through the public intake path because attribution already enforces it. |

### 3.1 P0 SECURITY GAP — same-Client cross-building quotation authorization (confirmed)

**Severity: P0.** Confirmed at runtime for quotation creation. Other chain steps are confirmed in
source only (see 3.2). Scope of impact: intra-Client. A user of Client A is blocked from Client B
(tests 2 and 3 pass), but a user of Client A who is assigned to building B2 can act on Client A's
requests and Execution Scopes in building B1, where they hold no building assignment.

Because the chain guards are Client-scoped, an actor who holds `tenant_company.manage` and an
ACTIVE assignment to **any** building of the same Client can create the quotation for a Request in a
different Property/building of that Client. This is consistent with the frozen wording in
`docs/handyman/CR-HM-06_DECISION_FREEZE.md` F6 ("Client/RBAC authority"), but it does **not**
meet a property-level isolation expectation. It was **not** changed here (out of scope; no production edits).

Runtime evidence — temporary probe (copy of the test file plus one appended case, executed once, then
deleted; not committed):

```
PROBE_QUOTATION_STATUS 201 ok      # same-Client actor, assigned only to sibling Property/Building
```

(The probe's intake call returned 409 `HANDYMAN_SERVICE_REQUEST_ALREADY_EXISTS` only because the
attribution already had a Request; that line is not evidence either way.)

### 3.2 Reproduction

Preconditions (one Client `C`, two Properties/Buildings):
- Property `P1` / Building `B1`: a Request `R1` exists (intake → triage DIAGNOSIS → diagnosis).
- Property `P2` / Building `B2`: same Client `C`.
- User `U` holds `tenant_company.manage`; `U` has an ACTIVE `user_building_assignments` row for `B2` only.

Steps (HTTP, Bearer = `U`):
1. `POST /api/v1/handyman/requests/{R1}/quotation`

| Observed | Expected under building-level realm | Control (same user, no assignment in `C`) |
| --- | --- | --- |
| **201** — quotation v1 DRAFT created for `R1` in `B1` | 403 `BUILDING_ACCESS_DENIED` | 403 `BUILDING_ACCESS_DENIED` (test case 2, PASS) |

The control shows that the only grant in this path is the same-Client assignment in `B2`.
Runtime probe: copy of the chain test file with one appended case (`PROBE_QUOTATION_STATUS 201 ok`),
run once, then deleted; not committed. Per the PART scope, no regression test that asserts the
vulnerable behavior was added, and no authorization semantics were changed.

### 3.3 Source-line evidence (HEAD `2cca96e` src = `152ee5d` src)

Root grant (Client-level only):
- `src/modules/context-access/context-access.service.ts:60-65` — `canAccessClient` returns true if any
  ACTIVE building context of the user has `client.id === clientId`. No building comparison.

Building/property primitives that exist but are NOT called by the chain:
- `context-access.service.ts:27-30` `canAccessBuilding`; `:41-47` `assertBuildingAccess`; `:51-56` `canAccessProperty`.
- Within Handyman modules, building/property guards appear only at `handyman-care-actors/handyman-care-property-scope.service.ts:56`
  and `handyman-sla-status-api/handyman-sla-status-api.service.ts:485`. None are in the chain.

Chain call sites that use the Client-level check (all runtime-reachable by a same-Client user):

| Step | File:line |
| --- | --- |
| Intake | `handyman-requests/handyman-service-request.service.ts:244` (create), `:312` (list), `:338` (detail) |
| Triage | `handyman-requests/handyman-request-triage.service.ts:129` (write), `:225` (read) |
| Diagnosis | `handyman-requests/handyman-request-diagnosis.service.ts:120` (write), `:260` (read) |
| Quotation create / read / revise | `handyman-quotations/handyman-quotation.service.ts:105`, `:187`, `:240` |
| Issue / expire / supersede (`requireAccessibleQuotation`) | `handyman-quotations/handyman-quotation-lifecycle.service.ts:76`, `:301` |
| Decision (write) / decision read | `handyman-quotations/handyman-quotation-decision.service.ts:166`, `:336` |
| Scope read | `handyman-quotations/handyman-execution-scope.service.ts:170` (via `canAccessClient(actorUserId, scope.clientId)`) |
| Assignment create / reassign / read / resolver (`assertRealm`) | `handyman-scope-assignments/handyman-scope-assignment.service.ts:71` |

Route guards in the chain are authentication + permission only, with no building check:
- `handyman-quotations-api/handyman-quotations-api.routes.ts:71-76` (quotation create, `manage`).
- `handyman-scope-assignments-api/handyman-scope-assignments-api.routes.ts:31` (assignment create, `manage`).

Building is available and well defined on the chain objects, so a building check is feasible:
- Request building: `handyman-service-request.service.ts` `insertRequest` copies `attribution.buildingId`.
- Scope building: `handyman-execution-scope.service.ts:69-100` derives `buildingId` and checks floor/building consistency (`:90-92`).

Comparison: 248 non-Handyman module files call `assertBuildingAccess(`. The Handyman chain does not.

### 3.4 Other steps (source-inferred, NOT runtime-confirmed)

The same Client-level check governs decision (`decision.service.ts:166`), issue (`lifecycle.service.ts:76`),
triage, diagnosis, intake, and assignment (`scope-assignment.service.ts:71`). A same-Client sibling-building user
would reach those writes by the same grant. Only quotation creation was probed at runtime. The CR below must
include a negative test for each step.

### 3.5 Proposed separate backend CR (not implemented in this PART)

**Proposed:** `CR-HM-SEC-01 — Handyman chain building-scoped authorization` (separate CR, separate branch and PR).

Scope:
1. Add a chain helper that checks the building of the target object: Request building for intake/triage/diagnosis/quotation/decision/issue; Execution Scope building for scope read and assignment. Use the existing `contextAccessService.assertBuildingAccess`. Keep the Client check as well (both must pass).
2. Apply it to every write and read listed in 3.3, including `expire`, `supersede`, `reassign`, and assignment read.
3. Decide platform-admin and historical-read semantics. The care workspace already has a property-scope pattern (`handyman-care-property-scope.service.ts`); reuse it if it fits.
4. Tests: extend the chain suite with a sibling-building negative for every mutation and read, and a same-building positive. Review existing fixtures that use users with building assignments outside the request building.
5. No schema migration expected.
6. Acceptance: the 3.2 reproduction returns 403 `BUILDING_ACCESS_DENIED`; the affected suite is green; the pre-existing failure in §5.3 is either fixed in the same CR or tracked separately.

Owner decision required before implementation: confirm the business rule (Client-wide access for multi-building staff,
or building-scoped access per request). Option A (building-scoped, recommended by this report) changes behavior for any user
who currently relies on Client-wide access.

### 3.6 Non-goals of PART 00D-2B

No production authorization change. No fix to `canAccessClient`. No new permission. No schema change. No PR and no merge.

## 4. Tests added

File: `tests/handyman-request-to-assignment-chain.test.ts` (659 lines, no production import changes).
Each case builds its own fixture. All cases drive real HTTP routes through `api()` and check DB state
where relevant.

| # | Case | Line | Assertions (summary) | Result |
| --- | --- | --- | --- | --- |
| 1 | Happy path — full chain | `:403` | intake 201 → triage 201 → diagnosis 201 → quotation 201 → line 201 → issue 200 (ISSUED) → APPROVE 201 with AUTHORIZED scope (request/quotation/version/building/space lineage) → assignment 201 ACTIVE; DB: version statuses `[APPROVED]`, one ACTIVE row | PASS |
| 2 | Forbidden actor | `:449` | read-only session → quotation 403; manage session with **no building assignment** → intake, quotation, decision all 403 `BUILDING_ACCESS_DENIED`; DB: zero decisions, zero scopes | PASS |
| 3 | Cross-property / cross-tenant | `:492` | other-Client actor (manage + assignment in another Client) → intake 403, decision 403 `BUILDING_ACCESS_DENIED`; attribution claiming building A with a space tenant-linked only in sibling building B → rejects `HANDYMAN_CHANNEL_ATTRIBUTION_SPACE_MISMATCH` | PASS |
| 4 | Invalid state | `:554` | APPROVE on DRAFT → 400 `HANDYMAN_QUOTATION_INVALID_TRANSITION`; assignment before any scope → 404 `HANDYMAN_EXECUTION_SCOPE_NOT_FOUND`; DB: zero decisions | PASS |
| 5 | Duplicate decision | `:583` | same-key replay → 201 with the **same** decision id and scope id; REJECT with same key → 409 `HANDYMAN_QUOTATION_DECISION_CONFLICT`; APPROVE with new key → 409; DB: 1 decision, 1 scope | PASS |
| 6 | Duplicate assignment | `:623` | second POST assignment → 409 `HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONFLICT`; DB: total 1, ACTIVE 1 | PASS |

Helper note: case 3's sibling building needs `buildingAssignmentService.createAssignment(admin, …)`
before `assignSpaceToTenant` (its realm check). This was a fixture fix made during the first run.

## 5. Results

### 5.1 New file

```
tests/handyman-request-to-assignment-chain.test.ts
# tests 6  # pass 6  # fail 0  # cancelled 0  # skipped 0  # todo 0   (exit 0, ~13 s)
```

Type check (strict, `tests/` is outside `tsconfig.json`, so checked with a temporary config in
`/tmp` that includes this file): `tsc exit=0`, 0 errors.

### 5.2 Affected-test regression set (run one file at a time)

| File | Result |
| --- | --- |
| `handyman-request-to-assignment-chain.test.ts` (new) | 6/6 pass, 0 skipped |
| `handyman-quotations-api.test.ts` | 10/10 pass |
| `handyman-quotation.test.ts` | 10/10 pass |
| `handyman-quotation-line.test.ts` | 10/10 pass |
| `handyman-quotation-lifecycle.test.ts` | 10/10 pass |
| `handyman-quotation-decision.test.ts` | 10/10 pass |
| `handyman-execution-scope.test.ts` | 10/10 pass |
| `handyman-execution-scope-assignments.test.ts` | 10/10 pass |
| `handyman-execution-scope-assignment-service.test.ts` | 10/10 pass |
| `handyman-scope-assignments-api.test.ts` | **9/10 — 1 fail (pre-existing, see 5.3)** |
| `handyman-service-requests.test.ts` | 8/8 pass |
| `handyman-request-triage.test.ts` | 10/10 pass |
| `handyman-request-diagnosis.test.ts` | 10/10 pass |
| `handyman-channel-attributions.test.ts` | 13/13 pass |

Totals: 13 of 14 files fully green; 1 file with a single failing case; `skipped 0` everywhere.
Full suite was **not** run (out of scope).

### 5.3 Pre-existing failure (not caused by this change)

`handyman-scope-assignments-api.test.ts` case 10 "OpenAPI/runtime parity; ZERO downstream/FM APIs"
(`:757`, assertion at `:806-810`) requires the `execution-scopes` path set to be exactly the two PART C
assignment paths. Later modules now register `/handyman/execution-scopes/{executionScopeId}/…` routes
(arrival-verification, BAST, customer-ledger, customer-payments, material-execution, evidence-qc,
service-warranty, work-sessions — see `src/modules/*-api/*.routes.ts`). The assertion is stale.
This change adds only a new test file: no `src/`, route, or OpenAPI file was modified, so the failure
predates this work. Not fixed here (unrelated to this part's scope). Recommended follow-up: update that
case to the current surface or scope it to the PART C paths.

## 6. Git hygiene

- `git diff --check`: clean (run after `git add -N` on the new file).
- Changed files: `tests/handyman-request-to-assignment-chain.test.ts` (new), `docs/handyman/PART00D2B_RUNTIME_VERIFICATION.md` (new).
- `node_modules/` is excluded locally via `.git/info/exclude` (the repo has no `.gitignore`); it is not committed.
- No PR opened. Commit and push only to `arena/ed9f4841-handyman-backend`.

## 7. Caveats

1. PASS here means: passed against a local **PostgreSQL 18.4** (embedded binaries), not Docker and not the
   compose target `postgres:16`. Re-run against the compose engine before relying on it for a release gate.
2. The local database is an ephemeral sandbox cluster in `/tmp`; it is not persisted or shared.
3. The test 10 failure in 5.3 is open (pre-existing, not fixed). The P0 same-Client cross-building gap in 3.1 is open and is NOT fixed in this PART; it is referred to the separate CR-HM-SEC-01 proposal in 3.5.
4. Production code was not modified. Test-helper and fixture code is local to the new test file.

## 8. Close-out summary (PART 00D-2B)

| Item | Result |
| --- | --- |
| Focused integration tests (`tests/handyman-request-to-assignment-chain.test.ts`) | **6 PASS, 0 FAIL, 0 skipped** (last run on the same src as HEAD) |
| Strict typecheck of the new test file (temporary config outside the repo, `tests/` is excluded by `tsconfig.json`) | `tsc exit=0`, **0 errors** |
| Affected regression set (14 files, run one at a time) | 13 files fully green; `handyman-scope-assignments-api.test.ts` 9/10 (pre-existing, §5.3). Run completed; no test process left active |
| Broad / full suite | **Not run** (out of scope) |
| Temporary probe files | **None remain** (probe copy and its appended case were deleted; `tests/` contains no probe or `zz-` files) |
| `git diff --check` | Clean (see the commit step) |
| Production authorization change | **None** |
| P0 security gap (§3.1) | **Open.** Confirmed for quotation creation at runtime; other steps source-inferred (§3.4). Referred to proposed CR-HM-SEC-01 (§3.5) |
| Branch / PR / merge | Work stays on `arena/ed9f4841-handyman-backend`. No PR, no merge, no branch change |

### Remaining gaps (not closed by this PART)

1. **P0** same-Client cross-building authorization on the Request → Quotation → Issue → Decision → Assignment chain (§3.1–3.5). Only quotation creation is runtime-confirmed.
2. Runtime confirmation is missing for issue, decision, triage, diagnosis, intake, and assignment in the same-Client cross-building case. These need a negative test in CR-HM-SEC-01.
3. Pre-existing failing case: `handyman-scope-assignments-api.test.ts` test 10 (stale OpenAPI/runtime path-set assertion, §5.3).
4. Local PostgreSQL 18.4 was used, not the compose target PostgreSQL 16, and not Docker (§1, §7).
5. The gap probe is not committed as a regression test. A committed negative test should land with the CR-HM-SEC-01 fix, not before, so the suite does not lock in the vulnerable behavior.
