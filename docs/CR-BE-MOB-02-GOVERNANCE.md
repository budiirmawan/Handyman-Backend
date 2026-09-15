# CR-BE-MOB-02 — Governance

> **Recovery scope note:** recovered into `arena/01a01f3d-asentra-backend` from
> remote branch `arena/01a01efa-asentra-backend` (commits `4c96f8a`, `c399e37`,
> `988fa02`). Only the PART 07B–07D sections below were recovered; the PART 01–07A
> records were not part of this recovery and are intentionally absent in this branch.

## 17. PART 07B — Security Handover Contract Publication (this PART)

> **Scope freeze:** PART 01–05, PART 06A–06D and PART 07A are **frozen —
> not modified**. This PART publishes **only** the existing authoritative
> Security Handover operations (BE-12G binding + BE-12M reporting dataset)
> into `docs/api/openapi.yaml` — documentation only. No runtime code, no
> table, no migration, no duplicate mobile endpoint. Engineering Handover,
> Current Shift and My Team are explicitly untouched.

### 17.1 What was published (documentation only)

All five operations were already registered handlers; this PART added their
OpenAPI publication under the existing `Security` tag:

| Method & Path | operationId | Permission | Building isolation | Lifecycle / domain rule reused |
|---|---|---|---|---|
| `POST /buildings/{buildingId}/security/shift-handovers` | `createSecurityShiftHandoverBinding` | `security_shift_handover.manage` | `requireBuildingAccess('buildingId')` + cross-Building/Client checks | BE-10J handover must exist; start post / patrol route must be ACTIVE and same-Building; one ACTIVE binding per handover |
| `GET /buildings/{buildingId}/security/shift-handovers` | `listBuildingSecurityShiftHandoverBindings` | `security_shift_handover.read` | `requireBuildingAccess('buildingId')` | optional `shiftHandoverId` / `startSecurityPostId` / `patrolRouteId` / `status` filters |
| `GET /security/shift-handovers/{id}` | `getSecurityShiftHandoverBinding` | `security_shift_handover.read` | service `assertBuildingAccess(binding.buildingId)` | `{id}` is the binding id, never the BE-10J handover id |
| `PATCH /security/shift-handovers/{id}` | `updateSecurityShiftHandoverBinding` | `security_shift_handover.manage` | service `assertBuildingAccess(binding.buildingId)` | only `startSecurityPostId` / `patrolRouteId` / `status` mutable; deactivate ≠ delete; re-activate guarded by the active-unique index |
| `GET /security/reports/shift-handovers` | `listSecurityShiftHandoverDataset` | `security_report.read` | accessible-Buildings scope; optional `buildingId` | joins `security_shift_handover_bindings` → `shift_handovers` (+ post/route codes); `handoverStatus` is the authoritative BE-10J status |

**Authoritative IDs preserved:** binding `id` = `security_shift_handover_bindings.id`;
`shiftHandoverId` = `shift_handovers.id`; `startSecurityPostId` =
`security_posts.id`; `patrolRouteId` = `patrol_routes.id`. `clientId` /
`buildingId` are derived, never accepted from the caller.

### 17.2 OpenAPI freeze — what changed

`docs/api/openapi.yaml` changed **only** by adding published documentation for
the five already-registered routes (incremental rule §1–3):

* **Paths added:** `/buildings/{buildingId}/security/shift-handovers`
  (post, get), `/security/shift-handovers/{id}` (get, patch),
  `/security/reports/shift-handovers` (get) — **3 paths, 5 operations**.
  Path count goes **448 → 451**; operation count **597 → 602**.
* **Parameter added:** `SecurityShiftHandoverBindingIdPath` (reuses `Uuid`).
* **Schemas added (5, mirroring implemented DTOs):**
  `SecurityShiftHandoverBindingStatus` (ACTIVE/INACTIVE),
  `SecurityShiftHandoverBinding`, `CreateSecurityShiftHandoverBindingRequest`,
  `UpdateSecurityShiftHandoverBindingRequest`,
  `SecurityShiftHandoverDatasetRow`.
* **Reused (not redefined):** `SuccessEnvelope`, `ErrorEnvelope`, `Uuid`,
  `BuildingIdPath`, `BadRequest` / `Unauthorized` / `Forbidden` / `NotFound` /
  `Conflict` responses, and the existing `Security` tag.
* Every operation carries `tags: [Security]`, `security: bearerAuth`,
  `x-required-permission` (seeded code) and `x-building-scoped: true`.

**Regression-guard reconciliation:** `tests/mobile-cr-regression-contract.test.ts`
pins the CR-BE-MOB-01 tag sizes. Publishing 5 existing `Security` operations
changes the `Security` tag size, so its frozen count is reconciled
**41 → 46** (Housekeeping / Engineering / Inventory Master sizes untouched).
This is the only non-documentation change, and it is a direct, minimal
consequence of this PART's legitimate publication — not an unrelated-domain
edit.

### 17.3 What was explicitly **not** done (by rule)

* No `src/**/*.ts` was added or edited; no migration was added.
* No duplicate `POST /mobile/security-shift-handover/*` endpoint was created.
* Engineering Handover (BE-10J `/engineering/shift-handovers`) was **not**
  modified — its 6 published operations are untouched.
* Current Shift and My Team were **not** implemented (still MISSING as
  recorded in PART 07A — no fabrication).
* No other domain was modified; no PR was opened; no merge occurred.

### 17.4 Evidence anchors (07B)

* Binding router: `src/modules/security-shift-handovers/security-shift-handover.routes.ts`
  (4 routes); service: `security-shift-handover.service.ts` (validation order
  pinned by tests); repository: `security-shift-handover.repository.ts`.
* Reporting dataset: `src/modules/security-reports/security-report.routes.ts`
  (`GET /security/reports/shift-handovers`), `security-report.controller.ts`
  (`shiftHandoverDatasetHandler`), `security-report.service.ts`
  (`getShiftHandoverDataset`), `security-report.repository.ts`
  (`getShiftHandoverDataset` — binding × handover join).
* Seeded permissions: `src/database/seeds/foundation-access.seed.ts:192-193`
  (`security_shift_handover.*`), `213` (`security_report.read`).
* Migration: `0127_create_security_shift_handover_bindings`.
* OpenAPI additions: paths after `/engineering/shift-handovers/{id}/acknowledge`
  (PART 07B marker), `components.parameters.SecurityShiftHandoverBindingIdPath`,
  `components.schemas.SecurityShiftHandoverBinding*` + `SecurityShiftHandoverDatasetRow`.

### 17.5 Validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| YAML well-formed + 451 paths / 602 operations, unique operationIds, all `$ref`s resolve, all used tags declared | **PASS** (scripted) |
| `tests/openapi-contract.test.ts` (all documented paths registered) | **PASS** |
| `tests/mobile-security-contract.test.ts` | **PASS** |
| `tests/mobile-openapi-completeness.test.ts` | **PASS** |
| `tests/mobile-cr-regression-contract.test.ts` (Security 46 reconciled) | **PASS** |
| `tests/r2p-openapi-contract.test.ts` | **PASS** |
| `git diff --check` | **CLEAN** |

---

*PART 07B is **contract publication only**: it added OpenAPI documentation
for the five existing BE-12G Security Shift Handover binding + BE-12M
reporting dataset operations (3 paths, 5 ops, 1 param, 5 schemas — no runtime
code, no migration, no duplicate mobile endpoint) and reconciled the
CR-BE-MOB-01 regression-guard Security tag size 41 → 46. Engineering
Handover, Current Shift and My Team were not modified or implemented.*

## 18. PART 07C — Current Shift Effective Context (this PART)

> **Scope freeze:** PART 01–05, PART 06A–06D, PART 07A and PART 07B are
> **frozen — not modified**. This PART implements the single small
> authoritative effective-context endpoint that PART 07A recorded as
> `MISSING` (SC-02 — "which shift is live now"), and nothing else. No generic
> Shift CRUD is exposed for mobile; no caller-supplied identity; Security
> Handover, Engineering Handover and My Team are untouched.

### 18.1 Objective

A safe, authoritative way for the authenticated mobile user to resolve their
effective current shift. The answer is derived entirely from existing data:

| Input | Authority | How it is used |
|---|---|---|
| authenticated user | `req.auth.userId` (session) | resolves the linked `workforce_profiles` row — never accepted from the caller |
| workforce profile | `workforce_profiles.user_id` (BE-03C, unique) | the profile the user acts under; must be ACTIVE |
| building assignment | `contextAccessService.getAccessibleBuildingIds` (BE-02F/G) | shifts are filtered to the accessible set in SQL |
| shift roster/assignment | `workforce_shift_assignments` (BE-03E) | ACTIVE assignments + optional `effective_from`/`effective_until` window |
| current date/time | the current instant | window check (below); injectable `now` only for tests |
| Client/Building isolation | BE-02G + `shifts.client_id` | no cross-Client/Building shift is ever returned |

### 18.2 Endpoint (minimum authoritative contract)

`GET /mobile/current-shift` — authentication-only (self-service; the same
posture as `GET /auth/me`). No path/query/body parameters; identity is the
session. Response:

```json
{
  "success": true,
  "data": {
    "asOf": "2026-08-20T09:00:00.000Z",
    "shifts": [
      {
        "assignmentId": "<workforce_shift_assignments.id>",
        "shiftId": "<shifts.id>",
        "workforceProfileId": "<workforce_profiles.id>",
        "employeeCode": "WF-0001",
        "clientId": "<clients.id>",
        "buildingId": "<buildings.id>",
        "buildingCode": "B-001",
        "buildingName": "Building A",
        "code": "MORNING",
        "name": "Morning shift",
        "startTime": "07:00:00",
        "endTime": "15:00:00",
        "status": "ACTIVE",
        "effectiveFrom": null,
        "effectiveUntil": null
      }
    ]
  }
}
```

An empty `shifts` array means the caller is not on shift at `asOf`.

### 18.3 Derivation rule (safe by construction)

A Shift is "current" only when **all** hold:

1. the caller has a linked **ACTIVE** Workforce Profile;
2. that profile has an **ACTIVE** roster assignment whose absolute
   `effective_from`/`effective_until` window (when set) contains `now`;
3. the Shift is **ACTIVE** and its Building is inside the caller's accessible
   set (BE-02G — enforced in the SQL `building_id = ANY(...)`);
4. the Building carries a valid IANA `timezone` — otherwise the local
   wall-clock cannot be determined and "current" is **not affirmed** (the row
   is excluded, never guessed);
5. the current time-of-day in that timezone falls inside the Shift's
   `start_time`/`end_time` window, **overnight-aware** (`end < start` ⇒
   `now >= start || now < end`).

### 18.4 What was implemented

* New module `src/modules/mobile-current-shift/` — `types.ts`, `service.ts`
  (derivation + pure window helpers), `controller.ts`, `routes.ts`, `index.ts`.
* Registration in `src/routes/index.ts` (`createMobileCurrentShiftRouter`).
* OpenAPI: `GET /mobile/current-shift` → `getMobileCurrentShift`
  (`tags: [Mobile Execution]`, bearer-only) + schemas `MobileCurrentShift`,
  `MobileCurrentShiftContext`. Path count **451 → 452**; operations
  **602 → 603**.
* Focused test `tests/mobile-current-shift.test.ts`.

**No** migration, table, permission, Shift CRUD surface, or caller-supplied
identity was introduced. The generic BE-03E Shift/roster administration
surface stays unpublished for mobile by rule (SC-01 remains PARTIAL by
design).

### 18.5 What was explicitly **not** done (by rule)

* No `/auth/me` change — the effective-context shape is frozen; shift context
  is delivered via the dedicated endpoint instead.
* No Shift CRUD, no `GET /shifts` / `GET /workforce/:id/shifts` exposure for
  mobile.
* No Security Handover / Engineering Handover change.
* No My Team implementation.
* No attendance, clock-in/out, timesheet, or roster-generation behaviour.
* No PR; no merge.

### 18.6 Validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| YAML well-formed + 452 paths / 603 ops, unique operationIds, all `$ref`s resolve, all tags declared | **PASS** (scripted) |
| `openapi-contract` · `mobile-cr-regression-contract` · `mobile-openapi-completeness` · `mobile-security-contract` · `mobile-engineering-contract` · `mobile-housekeeping-contract` · `r2p-openapi-contract` · `error-contract` | **PASS** (79 tests) |
| `tests/mobile-current-shift.test.ts` | 401-unauth **PASS**; 8 derivation cases **SKIP** (no live PostgreSQL in this environment — recorded, not a code defect) |
| Derivation logic (same-day / overnight / timezone-null / out-of-window) | verified by a standalone script over the same helper code |
| `git diff --check` | **CLEAN** |

### 18.7 Evidence anchors (07C)

* Module: `src/modules/mobile-current-shift/{types,service,controller,routes,index}.ts`.
* Route registration: `src/routes/index.ts` → `createMobileCurrentShiftRouter`.
* Authorities reused: `workforceRepository.findByUserId`,
  `contextAccessService.getAccessibleBuildingIds`, `workforce_shift_assignments`
  + `shifts` + `buildings` (single SQL join).
* OpenAPI: `paths./mobile/current-shift.get`,
  `components.schemas.MobileCurrentShift`,
  `components.schemas.MobileCurrentShiftContext`.
* Test: `tests/mobile-current-shift.test.ts`.

---

*PART 07C implements **only** the minimum authoritative current-shift
effective-context endpoint (`GET /mobile/current-shift`, BE-25M) — one new
self-service module + one OpenAPI path + 2 schemas, no migration, no new
table, no new permission. Shift CRUD is not exposed for mobile; identity is
resolved from the authenticated session, never the caller. Security Handover,
Engineering Handover and My Team were not modified or implemented.*

## 19. PART 07D — My Team Effective Context (this PART)

> **Scope freeze:** PART 01–05, PART 06A–06D, PART 07A, PART 07B and
> PART 07C are **frozen — not modified**. This PART implements the single
> small authoritative effective-context endpoint that PART 07A recorded as
> `MISSING` (TC-03 — "my team"), and nothing else. No generic Team CRUD is
> exposed for mobile; no caller-supplied identity; Current Shift, Security
> Handover and Engineering Handover are untouched.

### 19.1 Objective

A safe, authoritative way for an authenticated mobile user (supervisor) to
retrieve their own team context and team members. The answer is derived
entirely from existing data:

| Input | Authority | How it is used |
|---|---|---|
| authenticated user | `req.auth.userId` (session) | resolves the linked `workforce_profiles` row — never accepted from the caller |
| workforce profile | `workforce_profiles.user_id` (BE-03C, unique) | the profile the user acts under; must be ACTIVE |
| team membership | `workforce_profiles.team_id` (BE-03C) | the caller's team (nullable) |
| team hierarchy | `teams` → `departments` → `organizations` → `clients` (BE-03B/BE-03A/BE-02A) | resolved ids/codes/names |
| Client isolation | BE-02F/G accessible Client set | the team is exposed only when the profile's Client is inside the accessible scope |
| Building assignment | **not** used for membership | a Team is a Client-scoped org construct, not a Building construct; no building assignment data is exposed |

### 19.2 Endpoint (minimum authoritative contract)

`GET /mobile/my-team` — authentication-only (self-service; the same posture
as `GET /auth/me` and `GET /mobile/current-shift`). No path/query/body
parameters; identity is the session. Response:

```json
{
  "success": true,
  "data": {
    "workforceProfile": { "id": "<workforce_profiles.id>", "employeeCode": "WF-0001", "fullName": "Supervisor One" },
    "team": {
      "id": "<teams.id>",
      "code": "ENG",
      "name": "Engineering Team",
      "description": null,
      "status": "ACTIVE",
      "department": { "id": "<departments.id>", "code": "ENGD", "name": "Engineering Department" },
      "organization": { "id": "<organizations.id>", "code": "ORG1", "name": "Organization A" },
      "client": { "id": "<clients.id>", "code": "C-001", "name": "Client A" }
    },
    "members": [
      {
        "id": "<workforce_profiles.id>",
        "employeeCode": "WF-0001",
        "fullName": "Supervisor One",
        "workforceType": "INTERNAL",
        "status": "ACTIVE",
        "positionId": "<positions.id>",
        "userId": "<users.id|null>"
      }
    ]
  }
}
```

`team` is `null` when the caller has no linked ACTIVE profile, no team, or a
profile whose Client is outside the accessible scope; `members` lists ACTIVE
profiles in that team (the caller included).

### 19.3 Derivation rule (safe by construction)

The team context is returned only when **all** hold:

1. the caller has a linked **ACTIVE** Workforce Profile;
2. the profile's Organization resolves to a Client inside the caller's
   accessible Client set (BE-02F/G — the same authority `/auth/me` uses);
3. the profile has a `team_id`, and that Team (and its Department and
   Organization and Client) all resolve.

Members are the **ACTIVE** workforce profiles in that team (the caller
included); INACTIVE profiles are excluded. Team / Department / Organization /
Client statuses are surfaced on the resolved nodes and are never fabricated.

### 19.4 What was implemented

* New module `src/modules/mobile-my-team/` — `types.ts`, `service.ts`
  (derivation), `controller.ts`, `routes.ts`, `index.ts`.
* Registration in `src/routes/index.ts` (`createMobileMyTeamRouter`).
* OpenAPI: `GET /mobile/my-team` → `getMobileMyTeam`
  (`tags: [Mobile Execution]`, bearer-only) + schemas `MobileTeamRef`,
  `MobileMyTeam`, `MobileTeamMember`, `MobileMyTeamContext`. Path count
  **452 → 453**; operations **603 → 604**.
* Focused test `tests/mobile-my-team.test.ts`.

**No** migration, table, permission, Team CRUD surface, or caller-supplied
`workforceProfileId` / `teamId` was introduced. The generic BE-03B Team
administration surface stays unpublished for mobile by rule (TC-01 remains
PARTIAL by design).

### 19.5 What was explicitly **not** done (by rule)

* No `/auth/me` change — the effective-context shape is frozen; team context
  is delivered via the dedicated endpoint instead.
* No Team CRUD, no `GET /departments/:id/teams` / `GET /teams/:id` exposure
  for mobile.
* No reporting-line / "who reports to me" surface (`workforce_reporting_lines`
  stays out of scope — this PART resolves the caller's own team only).
* No Current Shift / Security Handover / Engineering Handover change.
* No PR; no merge.

### 19.6 Validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| YAML well-formed + 453 paths / 604 ops, unique operationIds, all `$ref`s resolve, all tags declared | **PASS** (scripted) |
| `openapi-contract` · `mobile-cr-regression-contract` · `mobile-openapi-completeness` · `mobile-security-contract` · `mobile-engineering-contract` · `mobile-housekeeping-contract` · `r2p-openapi-contract` · `error-contract` | **PASS** (81 tests; 12 DB-backed cases skip for lack of a live PostgreSQL) |
| `tests/mobile-my-team.test.ts` | 401-unauth **PASS**; 4 derivation cases **SKIP** (no live PostgreSQL — recorded, not a code defect) |
| `git diff --check` | **CLEAN** |

### 19.7 Evidence anchors (07D)

* Module: `src/modules/mobile-my-team/{types,service,controller,routes,index}.ts`.
* Route registration: `src/routes/index.ts` → `createMobileMyTeamRouter`.
* Authorities reused: `workforceRepository.findByUserId` /
  `workforceRepository.listByTeamId`, `teamRepository.findById`,
  `departmentRepository.findById`, `organizationRepository.findById`,
  `clientRepository.findById`, `contextAccessService.getAccessibleClientIds`.
* OpenAPI: `paths./mobile/my-team.get`,
  `components.schemas.MobileTeamRef` / `MobileMyTeam` / `MobileTeamMember` /
  `MobileMyTeamContext`.
* Test: `tests/mobile-my-team.test.ts`.

---

*PART 07D implements **only** the minimum authoritative my-team
effective-context endpoint (`GET /mobile/my-team`, BE-25N) — one new
self-service module + one OpenAPI path + 4 schemas, no migration, no new
table, no new permission. Team CRUD is not exposed for mobile; identity and
team are resolved from the authenticated session (profile → team), never the
caller. Current Shift, Security Handover and Engineering Handover were not
modified or implemented.*

---

## 20. FINAL REVIEW (PART 08 + final validation)

**Review scope:** regression defects; OpenAPI/runtime mismatch; RBAC/auth
regression; Client/Building isolation regression; authoritative ID
regression; duplicate mobile domain endpoints. No redesign, no new
capabilities, no change to completed PART 01–07D.

**Capability confirmation — 10/10 PRESENT** (runtime + OpenAPI + RBAC +
isolation + authoritative IDs): Security Post; Patrol Route/Point; Patrol
Visit/Evidence; Security Incident (BE-21A incidents + BE-12H findings);
Standalone Meter Reading; Log Sheet; Engineering Handover; Security
Handover; Current Shift; My Team.

**Validation:**

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| Focused contract suites | PASS — 81 tests, 0 failures (12 DB-backed skips: no live PostgreSQL in the Arena sandbox — environment limitation, not a defect) |
| OpenAPI structural (YAML, unique operationIds, `$ref`/tag resolution, documented↔registered parity, Security tag = 46) | PASS |
| Duplicate mobile domain endpoints | NONE |

**Defects:** 0 found — no fixes.

**Handoff:** PR #39 (`CR-BE-MOB-02 — Mobile Operational Backend Contract
Completion`) created from `arena/01a01f3d-asentra-backend` to `main`; not
merged.

