# CR-BE-MOB-02 — Gap Matrix

> **Recovery scope note:** recovered into `arena/01a01f3d-asentra-backend` from
> remote branch `arena/01a01efa-asentra-backend` (commits `4c96f8a`, `c399e37`,
> `988fa02`). Only the PART 07B–07D sections below were recovered; the PART 01–07A
> records were not part of this recovery and are intentionally absent in this branch.

---

## PART 07B — Security Handover Contract Publication (this PART)

> **Scope freeze:** PART 01–05, PART 06A–06D and PART 07A are **frozen —
> not modified** (the 07A rows above stay as the frozen audit record). This
> PART executes the `PUBLISH_OPENAPI` action already recommended for SH-01
> and SH-02 — documentation only. No runtime code, no migration, no duplicate
> mobile endpoint; Engineering Handover, Current Shift and My Team are
> untouched.

| ID | Capability | Status (07A frozen) | Status after 07B | Change this PART |
|---|---|---|---|---|
| SH-01 | Security handover — binding | **PARTIAL** | **EXISTING** | Published 4 existing BE-12G ops (`createSecurityShiftHandoverBinding`, `listBuildingSecurityShiftHandoverBindings`, `getSecurityShiftHandoverBinding`, `updateSecurityShiftHandoverBinding`) — `security_shift_handover.read/manage`, `x-building-scoped: true` |
| SH-02 | Security handover — reporting dataset | **PARTIAL** | **EXISTING** | Published 1 existing BE-12M op (`listSecurityShiftHandoverDataset`) — `security_report.read`, `x-building-scoped: true` |

### PART 07B summary counts (Security Handover only)

| Status | Rows | IDs |
|---|---:|---|
| **EXISTING** | 2 | SH-01, SH-02 |
| **PARTIAL** | 0 | — |
| **MISSING** | 0 | — |
| **NOT_REQUIRED** | 0 | — |
| **Total** | **2** | The two Security Handover rows from the PART 07A audit |

The remaining PART 07A rows are unchanged: EH-01 EXISTING; SC-01, TC-01,
TC-02 PARTIAL; SC-02, TC-03 MISSING (Current Shift and My Team remain
unimplemented — by rule, not fabricated).

### PART 07B OpenAPI delta (documentation only)

* 3 paths / 5 operations added under `tags: [Security]`; path count
  448 → 451, operation count 597 → 602.
* 1 parameter (`SecurityShiftHandoverBindingIdPath`) and 5 schemas
  (`SecurityShiftHandoverBindingStatus`, `SecurityShiftHandoverBinding`,
  `CreateSecurityShiftHandoverBindingRequest`,
  `UpdateSecurityShiftHandoverBindingRequest`,
  `SecurityShiftHandoverDatasetRow`) added.
* Regression-guard reconciliation: `tests/mobile-cr-regression-contract.test.ts`
  `PUBLISHED_TAGS.Security` 41 → 46 (only the Security size; the other frozen
  tag sizes are unchanged).

### PART 07B validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| YAML well-formed, 451 paths / 602 ops, unique operationIds, all `$ref`s resolve, all tags declared | PASS |
| `openapi-contract` · `mobile-security-contract` · `mobile-openapi-completeness` · `mobile-cr-regression-contract` · `r2p-openapi-contract` | PASS (56 tests) |
| `git diff --check` | CLEAN |

Authoritative narrative: [`CR-BE-MOB-02-GOVERNANCE.md`](./CR-BE-MOB-02-GOVERNANCE.md)
(§5 + §12 + §14 + §15 + §16 frozen; §17 PART 07B publication).
PART 07B is contract publication only — no runtime change by rule.

---

## PART 07C — Current Shift Effective Context (this PART)

> **Scope freeze:** PART 01–05, PART 06A–06D, PART 07A and PART 07B are
> **frozen — not modified** (the 07A/07B rows above stay as the frozen
> record). This PART implements the small authoritative effective-context
> endpoint that PART 07A recorded as MISSING (SC-02), and nothing else. No
> generic Shift CRUD is exposed for mobile; no caller-supplied identity.

| ID | Capability | Status before 07C | Status after 07C | Change this PART |
|---|---|---|---|---|
| SC-02 | **Current shift context** — "which shift is live now" derivation | **MISSING** | **EXISTING** | Implemented `GET /mobile/current-shift` (BE-25M, authentication-only self-service): derives the caller's current shift(s) from the linked BE-03C Workforce Profile + BE-03E roster + BE-02F/G Building access + Building timezone + current instant (overnight-aware). Published in OpenAPI. |
| SC-01 | Current shift — Shift definition & workforce roster CRUD | **PARTIAL** | **PARTIAL** | Unchanged — the generic BE-03E Shift/roster CRUD stays on its administration surface and is deliberately **not** exposed here (per rule). |
| SC-03 | Current shift — shift context in published read models | **EXISTING** | **EXISTING** | Unchanged — `getEngineeringDailyOperations` / `getEngineeringOverview` / `getSecurityDailyActivity` keep their caller-supplied `shiftId` context. |

### PART 07C summary counts (Current Shift only)

| Status | Rows | IDs |
|---|---:|---|
| **EXISTING** | 2 | SC-02, SC-03 |
| **PARTIAL** | 1 | SC-01 |
| **MISSING** | 0 | — |
| **NOT_REQUIRED** | 0 | — |
| **Total** | **3** | The three Current Shift rows from the PART 07A audit |

The remaining PART 07A/07B rows are unchanged: EH-01, SH-01, SH-02 EXISTING;
TC-01, TC-02 PARTIAL; TC-03 MISSING (My Team remains unimplemented — by rule).

### PART 07C delta

* **Runtime (new, minimal):** `src/modules/mobile-current-shift/`
  (types · service · controller · routes · index) + registration in
  `src/routes/index.ts`. One route: `GET /mobile/current-shift`
  (`authenticationMiddleware` only). No migration, no table, no new
  permission.
* **OpenAPI:** 1 path / 1 operation (`getMobileCurrentShift`,
  `tags: [Mobile Execution]`, bearer-only — same posture as `GET /auth/me`)
  + 2 schemas (`MobileCurrentShift`, `MobileCurrentShiftContext`). Path count
  451 → 452; operation count 602 → 603.
* **Isolation:** profile resolved from `req.auth.userId` (never the body);
  shifts filtered to `getAccessibleBuildingIds(userId)` in SQL; `clientId` /
  `buildingId` / ids are the authoritative BE-03E/BE-03C values. A Building
  without an IANA `timezone` cannot affirm "current" and is excluded (never
  guessed).

### PART 07C validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| YAML well-formed, 452 paths / 603 ops, unique operationIds, all `$ref`s resolve, all tags declared | PASS |
| `openapi-contract` · `mobile-cr-regression-contract` · `mobile-openapi-completeness` · `mobile-security-contract` · `mobile-engineering-contract` · `mobile-housekeeping-contract` · `r2p-openapi-contract` · `error-contract` | PASS (79 tests) |
| `mobile-current-shift` focused suite | 401-unauth case PASS; 8 derivation cases SKIP (no live PostgreSQL — environment limitation) |
| Derivation logic (window/overnight/timezone) | Verified by standalone script against the same helper code |
| `git diff --check` | CLEAN |

Authoritative narrative: [`CR-BE-MOB-02-GOVERNANCE.md`](./CR-BE-MOB-02-GOVERNANCE.md)
(§5 + §12 + §14 + §15 + §16 + §17 frozen; §18 PART 07C).
PART 07C implements the minimum authoritative current-shift contract; the
Shift CRUD surface remains on BE-03E administration.

---

## PART 07D — My Team Effective Context (this PART)

> **Scope freeze:** PART 01–05, PART 06A–06D, PART 07A, PART 07B and
> PART 07C are **frozen — not modified** (the 07A–07C rows above stay as the
> frozen record). This PART implements the small authoritative
> effective-context endpoint that PART 07A recorded as MISSING (TC-03), and
> nothing else. No generic Team CRUD is exposed for mobile; no
> caller-supplied identity.

| ID | Capability | Status before 07D | Status after 07D | Change this PART |
|---|---|---|---|---|
| TC-03 | **Team context** — "my team" in effective context | **MISSING** | **EXISTING** | Implemented `GET /mobile/my-team` (BE-25N, authentication-only self-service): derives the caller's own team + ACTIVE members from the linked BE-03C Workforce Profile (`team_id`), the BE-03B Team hierarchy and the BE-02F/G accessible-Client scope. Published in OpenAPI. |
| TC-01 | Team context — Team definition CRUD | **PARTIAL** | **PARTIAL** | Unchanged — the generic BE-03B Team CRUD stays on its administration surface and is deliberately **not** exposed here (per rule). |
| TC-02 | Team context — membership + team-scoped resolution | **PARTIAL** | **PARTIAL** | Unchanged — membership (`workforce_profiles.team_id`) is reused by the new endpoint; team-scoped task/daily-cleaning reads and the mobile feed remain as before. |

### PART 07D summary counts (Team context only)

| Status | Rows | IDs |
|---|---:|---|
| **EXISTING** | 1 | TC-03 |
| **PARTIAL** | 2 | TC-01, TC-02 |
| **MISSING** | 0 | — |
| **NOT_REQUIRED** | 0 | — |
| **Total** | **3** | The three Team context rows from the PART 07A audit |

The remaining PART 07A–07C rows are unchanged: EH-01, SH-01, SH-02, SC-02,
SC-03 EXISTING; SC-01 PARTIAL.

### PART 07D delta

* **Runtime (new, minimal):** `src/modules/mobile-my-team/`
  (types · service · controller · routes · index) + registration in
  `src/routes/index.ts`. One route: `GET /mobile/my-team`
  (`authenticationMiddleware` only). No migration, no table, no new
  permission.
* **OpenAPI:** 1 path / 1 operation (`getMobileMyTeam`,
  `tags: [Mobile Execution]`, bearer-only) + 4 schemas (`MobileTeamRef`,
  `MobileMyTeam`, `MobileTeamMember`, `MobileMyTeamContext`). Path count
  452 → 453; operation count 603 → 604.
* **Isolation:** profile + team resolved from `req.auth.userId` (never the
  body); team hierarchy exposed only when the profile's Client is inside the
  accessible Client set (BE-02F/G); members are ACTIVE profiles of that team
  (Client-scoped org construct — no building assignment data exposed).

### PART 07D validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| YAML well-formed, 453 paths / 604 ops, unique operationIds, all `$ref`s resolve, all tags declared | PASS |
| `openapi-contract` · `mobile-cr-regression-contract` · `mobile-openapi-completeness` · `mobile-security-contract` · `mobile-engineering-contract` · `mobile-housekeeping-contract` · `r2p-openapi-contract` · `error-contract` | PASS (81 tests; 12 DB-backed cases skip for lack of a live PostgreSQL) |
| `mobile-my-team` focused suite | 401-unauth case PASS; 4 derivation cases SKIP (no live PostgreSQL — environment limitation) |
| `git diff --check` | CLEAN |

Authoritative narrative: [`CR-BE-MOB-02-GOVERNANCE.md`](./CR-BE-MOB-02-GOVERNANCE.md)
(§5 + §12 + §14 + §15 + §16 + §17 + §18 frozen; §19 PART 07D).
PART 07D implements the minimum authoritative my-team contract; the Team CRUD
surface remains on BE-03B administration.

---

## FINAL REVIEW — CR-BE-MOB-02 (PART 01–08 complete)

> **Scope freeze:** all completed PARTs are frozen — not modified. This
> section records the final integration review only; no capability change.

### Capability confirmation (10/10)

| # | Capability | Runtime | OpenAPI | RBAC / auth | Isolation | Authoritative IDs |
|---|---|---|---|---|---|---|
| 1 | Security Post | `/buildings/:id/security-posts`, `/security/posts/:id` | ✓ | `security_post.read/manage` | BE-02G | BE-12A ids |
| 2 | Patrol Route / Point | `/security/patrol-routes…` + point ops | ✓ | `patrol_route.read/manage` | BE-02G | BE-12B ids |
| 3 | Patrol Visit / Evidence | `…/points/:pointId/visit` | ✓ | `patrol_execution.read/manage` | BE-02G | `patrolRoutePointId` etc. |
| 4 | Security Incident | `/incidents` (BE-21A) + `/security/findings` (BE-12H) | ✓ | `security_finding.read/manage` | building-scoped | BE-09 `findingId` |
| 5 | Standalone Meter Reading | `/engineering/meter-reading-*` | ✓ | `meter_reading_binding.read/manage` | BE-02G | BE-10C ids |
| 6 | Log Sheet | `/engineering/log-sheet-*` | ✓ | `log_sheet_binding.read/manage` | BE-02G | BE-10 ids |
| 7 | Engineering Handover | `/engineering/shift-handovers…` | ✓ | `shift_handover.read/manage` | BE-02G | BE-10J ids |
| 8 | Security Handover | `/security/shift-handovers…` | ✓ | `security_shift_handover.read/manage` | BE-02G | binding id ≠ BE-10J id; `shiftHandoverId` |
| 9 | Current Shift | `GET /mobile/current-shift` | ✓ | auth-only self-service | BE-02F/G buildings | BE-03E/BE-03C ids |
| 10 | My Team | `GET /mobile/my-team` | ✓ | auth-only self-service | BE-02F/G clients | BE-03B/BE-03C ids |

### Final validation

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| Focused contract suites (`openapi-contract` · `mobile-cr-regression-contract` · `mobile-openapi-completeness` · `mobile-security-contract` · `mobile-engineering-contract` · `mobile-housekeeping-contract` · `r2p-openapi-contract` · `error-contract` · `mobile-current-shift` · `mobile-my-team`) | PASS (81 tests; 12 DB-backed skips — no live PostgreSQL in the Arena sandbox, environment limitation not a defect) |
| OpenAPI structural (YAML well-formed, unique operationIds, all `$ref`s/tags resolve, documented↔registered parity; Security tag 46 = regression guard) | PASS |
| Duplicate mobile domain endpoints (`/mobile/(security|patrol|incident|engineering|…)`) | NONE |
| Regression defects found | 0 — no fixes required |

### Handoff

* PR to `main`: **#39 — CR-BE-MOB-02 — Mobile Operational Backend Contract Completion** (created, not merged).
* Branch: `arena/01a01f3d-asentra-backend`.
* PART 01–07D capabilities unchanged by the final review.

