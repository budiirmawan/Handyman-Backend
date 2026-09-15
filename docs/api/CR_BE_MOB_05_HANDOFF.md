# CR-BE-MOB-05 — Mobile Workforce & Supervisor Backend Handoff

> **Status:** PART 01–03 implemented and validated; PART 04 (validation &
> integration verification) complete.
> **Authoritative machine-readable contract:** `docs/api/openapi.yaml`
> (now **494 paths / 653 operations / 698 schemas**).
> When this document and the spec disagree, **the backend router and
> `openapi.yaml` win.**
> **Companions:** [`CR-BE-MOB-03-SUPERVISOR-HANDOFF`](./CR_BE_MOB_03_SUPERVISOR_HANDOFF.md)
> (supervisor read/verification surface — still valid) ·
> [`CR_BE_MOB_01_MOBILE_HANDOFF.md`](./CR_BE_MOB_01_MOBILE_HANDOFF.md)
> (field-operations surface — still valid).
> **Date:** 2026-08-21
> **Commits:** `c5e854b` (PART 01) · `daa40fa` (PART 02) · `10169a0` (PART 03) ·
> (PART 04).

---

## 1. What CR-BE-MOB-05 delivered

Three additive backend capabilities, each an authoritative domain contract
(**no new mobile facade, no Management Read Model, no mock fallback, no
client-side authority**):

| PART | Capability | Runtime | Migration | Permissions |
|---|---|---|---|---|
| 01 | Mobile Upcoming Shifts (`GET /mobile/upcoming-shifts`) | extends BE-25M `mobile-current-shift` | none | none (auth-only self-service) |
| 02 | Workforce Attendance (clock-in / clock-out / current) | new `attendance` module | `0275_create_attendance_records` | `attendance.read`, `attendance.manage` |
| 03 | Security Operational Logbook (create / list / detail / update) | new `security-logbook` module | `0276_create_security_logbook_entries` | `security_logbook.read`, `security_logbook.manage` |

All three reuse the existing authorities — BE-01 authentication/RBAC,
BE-02F/G Building access (`contextAccessService` /
`requireBuildingAccess`), BE-03C Workforce Profile resolution
(`workforce_profiles.user_id`), BE-03E roster (`workforce_shift_assignments`
/ `shifts`), BE-10J shift handovers (`shift_handovers`) — and reuse the
BE-25M timezone helpers (`localTimeOfDay` / `isWithinWindow`) instead of
duplicating the wall-clock engine.

---

## 2. Endpoint inventory

### PART 01 — Upcoming Shifts (tag `Mobile Execution`)

| Method & Path | operationId | Permission | Scope annotation |
|---|---|---|---|
| `GET /mobile/upcoming-shifts` | `getMobileUpcomingShifts` | auth-only (none) | `x-building-scoped` absent (self-service, same as `getMobileCurrentShift`) |

Optional query: `dateFrom`, `dateTo` (ISO-8601 date `YYYY-MM-DD` treated as
a UTC day, or datetime; date-only `dateTo` inclusive of the whole UTC day;
`dateFrom ≤ dateTo`; range capped at 366 days; invalid → 400
`VALIDATION_ERROR`).

### PART 02 — Workforce Attendance (tag `Attendance`)

| Method & Path | operationId | Permission | Scope annotation |
|---|---|---|---|
| `POST /attendance/clock-in` | `clockInAttendance` | `attendance.manage` | self-service (no `x-building-scoped` claim) |
| `POST /attendance/clock-out` | `clockOutAttendance` | `attendance.manage` | self-service |
| `GET /attendance/current` | `getCurrentAttendance` | `attendance.read` | self-service |

Clock-in body: `{ "buildingId": "<uuid>" }` (required). Clock-out: **no
body**. Current: no parameters; response `data` is the open record or
`null`.

### PART 03 — Security Logbook (tag `Security Logbook`)

| Method & Path | operationId | Permission | Scope annotation |
|---|---|---|---|
| `POST /buildings/{buildingId}/security/logbook` | `createSecurityLogbookEntry` | `security_logbook.manage` | `x-building-scoped: true` |
| `GET /buildings/{buildingId}/security/logbook` | `listSecurityLogbookEntries` | `security_logbook.read` | `x-building-scoped: true` |
| `GET /security/logbook/{id}` | `getSecurityLogbookEntry` | `security_logbook.read` | `x-building-scoped: true` |
| `PATCH /security/logbook/{id}` | `updateSecurityLogbookEntry` | `security_logbook.manage` | `x-building-scoped: true` |

List query (all optional): `status` (`OPEN`/`CLOSED`), `category`
(`GENERAL`/`INCIDENT`/`PATROL`/`HANDOVER`/`FINDING`), `dateFrom`, `dateTo`
(same window rules as PART 01).

---

## 3. Authoritative identity rules

- **Identity is always session-derived.** Every endpoint resolves the
  caller's linked Workforce Profile via
  `workforce_profiles.user_id` (BE-03C, unique) from `req.auth.userId` —
  never from a request body/query field. No CR-BE-MOB-05 request schema
  accepts `workforceProfileId` / `userId` / `employeeCode` (pinned by the
  PART 04 regression suite).
- **No client-supplied timestamps.** `clockInAt` / `clockOutAt`
  (attendance) and `recordedAt` (logbook) are set only by the database
  clock (`NOW()`). A client-supplied timestamp is ignored (pinned by the
  DB-backed suites).
- **No client-generated IDs.** All ids are backend-generated UUIDs;
  response schemas carry only authoritative ids (pinned by the PART 04
  regression suite — no `localId` / `tempId` / `clientGeneratedId`).

## 4. Building isolation rules

- **Attendance:** clock-in asserts the Building via
  `contextAccessService.assertBuildingAccess` (BE-02F/G) → 403
  `BUILDING_ACCESS_DENIED` when outside the accessible set; the Building
  must also resolve to the profile's own Client (Profile → Organization →
  Client vs Building → Property → Client; mismatch → 400
  `ATTENDANCE_BUILDING_CLIENT_MISMATCH`). Clock-out / current resolve only
  the caller's own record — no cross-Building dimension exists by
  construction. An INACTIVE Building is never in the accessible set → 403.
- **Logbook:** Building-nested routes pass `requireBuildingAccess` and the
  service re-asserts; single-record read/update assert the entry's Building
  → an entry in an inaccessible Building is **403**, an unknown id is
  **404** (no existence leak, no cross-Building read/write).
- **Upcoming shifts:** accessible-Building set is enforced in SQL
  (`building_id = ANY($accessibleIds)`); Buildings without a valid IANA
  timezone are excluded rather than guessed.

## 5. Lifecycle rules

| Surface | Lifecycle | Enforcement |
|---|---|---|
| Attendance | `CLOCKED_IN → CLOCKED_OUT` (terminal) | partial unique index = **one open clock-in per workforce profile**; duplicate → 409 `ATTENDANCE_ACTIVE_ALREADY_EXISTS`; clock-out without open record → 409 `ATTENDANCE_NOT_ACTIVE` |
| Logbook | `OPEN → CLOSED` (terminal) | update allowed only while OPEN; CLOSED → 400 `SECURITY_LOGBOOK_ENTRY_IMMUTABLE` |
| Upcoming shifts | read-only projection of the BE-03E roster | no state written; `getMobileCurrentShift` remains the single authority for "what is live right now" (the daily wall-clock window is deliberately **not** evaluated here) |

## 6. Optional authoritative bindings

- **Attendance → roster (when available):** clock-in binds the applicable
  ACTIVE `workforce_shift_assignments.id` + `shifts.id` when the profile has
  a roster row at that Building whose effective window contains now (the
  wall-clock current shift is preferred among several; remaining ambiguity
  → no binding rather than a guess). Both fields set together or both null.
  Never derived from Current Shift / tasks / handover / Team.
- **Logbook → handover (optional):** a supplied `shiftHandoverId` must
  reference an existing authoritative `shift_handovers.id` — unknown → 404
  `SHIFT_HANDOVER_NOT_FOUND`; **cross-Building → 400
  `SECURITY_LOGBOOK_HANDOVER_BUILDING_MISMATCH`**. Handover linkage is
  optional; **outgoing/incoming Shift IDs are never invented**.

## 7. Migrations

| Migration | Table | Key constraints |
|---|---|---|
| `0275_create_attendance_records` | `attendance_records` | FKs → `clients` / `buildings` / `workforce_profiles` / optional `workforce_shift_assignments` + `shifts` (both-or-neither CHECK); `clock_out_at >= clock_in_at` CHECK; `status` CHECK `CLOCKED_IN`/`CLOCKED_OUT`; partial unique index `attendance_records_active_unique` (one open per profile) |
| `0276_create_security_logbook_entries` | `security_logbook_entries` | FKs → `clients` / `buildings` / `workforce_profiles` / optional `shift_handovers`; `status` CHECK `OPEN`/`CLOSED`; `category` CHECK `GENERAL`/`INCIDENT`/`PATROL`/`HANDOVER`/`FINDING`; index `(building_id, recorded_at DESC)` |

Both are additive (`ADD TABLE` only; no existing table altered, no
destructive change). `db:migrate` / `db:seed` are required before the new
surface is usable (seeds register the four new permission codes and grant
them to `PLATFORM_ADMIN`).

## 8. Permissions

| Code | Grants |
|---|---|
| `attendance.read` | `GET /attendance/current` (own record) |
| `attendance.manage` | `POST /attendance/clock-in`, `POST /attendance/clock-out` (own record) |
| `security_logbook.read` | logbook list + detail |
| `security_logbook.manage` | logbook create + update (OPEN only) |

All four are seeded in `foundation-access.seed.ts` and
`tests/helpers/access.ts`; `PLATFORM_ADMIN` receives them automatically via
the bootstrap role. **No attendance/logbook administration surface exists**
— these are self-service/field codes only. Upcoming shifts requires no
permission (auth-only, same posture as `getMobileCurrentShift`).

## 9. Deferred / out-of-scope capabilities

Deliberately **not** implemented by CR-BE-MOB-05 (approved governance
exclusions):

- Attendance: payroll, timesheets, overtime, leave, absence management,
  supervisor attendance administration, GPS/geofence, biometrics, QR
  attendance, offline attendance, mock fallback.
- Logbook: security patrol, checkpoint, incident management, visitor
  management, push notifications, supervisor dashboard, Management Read
  Model substitution.
- Upcoming shifts: no new shift domain, no generic Shift CRUD on the
  mobile surface (SC-01/TC-01 rule), no roster redesign.
- Everything else: no new endpoints beyond the 8 published operations, no
  new domain modules beyond the two, no further migrations/permissions.

## 10. Mobile integration prerequisites

1. **Run migrations + seeds** (`npm run db:migrate && npm run db:seed`) —
   creates `attendance_records` / `security_logbook_entries` and registers
   the four new permission codes.
2. **Grant permissions** to the mobile roles: `attendance.*` to workforce
   roles, `security_logbook.*` to Security officer/supervisor roles.
3. **Capability checks before use** — there is no "is clocked in" flag on
   the profile: mobile should call `GET /attendance/current` (null = not
   clocked in) and `GET /mobile/current-shift` (empty `shifts` = not on
   shift) and render state from those, never from local cache.
4. **Error handling** — treat `409 ATTENDANCE_ACTIVE_ALREADY_EXISTS` /
   `409 ATTENDANCE_NOT_ACTIVE` as lifecycle-state (re-sync current first);
   `403 BUILDING_ACCESS_DENIED` as scope (re-resolve `/auth/me/buildings`);
   `401` as re-authenticate.
5. **Self-service only** — the client never sends `workforceProfileId` /
   `userId` / timestamps; the backend derives them.
6. **Release prerequisite** — the DB-backed suites
   (`tests/attendance.test.ts`, `tests/mobile-upcoming-shifts.test.ts`,
   `tests/security-logbook.test.ts`) must run against a project-standard
   `asentra_test` PostgreSQL before production (they pass against embedded
   PostgreSQL in this CR's validation; the pre-existing fixture defects in
   `mobile-current-shift.test.ts`, `mobile-team-work-orders.test.ts` and
   `mobile-work-order-verification-target.test.ts` are documented
   separately and are NOT CR-BE-MOB-05 regressions).

## 11. Validation summary (PART 04 + FINAL REVIEW)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| `git diff --check` | ✅ CLEAN |
| OpenAPI structure (494 paths / 653 ops / 698 schemas; unique operationIds; all `$ref`s resolve; all tags declared) | ✅ PASS |
| New PART 04 regression suite `tests/mobile-cr-mob-05-regression-contract.test.ts` (10 subtests, DB-free) | ✅ PASS |
| Focused contract suites (upcoming-shifts-contract, attendance-contract, security-logbook-contract) | ✅ PASS |
| DB-free CR regression (all CR-BE-MOB-01/02/03 + CR-BE-MOB-05 contract suites, 26 files) | ✅ 234 pass / 0 fail / 22 pre-existing DB skips |
| DB-backed PART 01–03 suites against embedded PostgreSQL (`attendance` 13, `mobile-upcoming-shifts` 11, `security-logbook` 14, `mobile-effective-context` 7, `mobile-my-team` 5) | ✅ 50/50 PASS |
| Relevant existing backend suites against embedded PostgreSQL (migrate, database, rbac, permissions, roles, workforce-reporting, security-shift-handovers, operational-permission-contract, data-isolation, shift-handovers) | ✅ 102 pass / 9 fail — the 9 failures are `shift-handovers.test.ts`, **verified pre-existing** (identical on clean base `59d126a` against a pristine database) |
| Pre-existing failures (documented separately, §12) | ⚠️ identical on the clean base — not CR regressions |

## 12. Pre-existing failures (documented separately, NOT fixed here)

| Suite | Symptom | Root cause (pre-existing) |
|---|---|---|
| `mobile-app-version.test.ts`, `mobile-observability.test.ts` (DB-free env) | `Database pool has not been initialized` → 500 | Requires PostgreSQL; pre-existing environment limitation |
| `mobile-effective-context.test.ts` (DB-free env) | 7 subtests fail | DB-backed suite; passes with a real DB (✅ 7/7 embedded) |
| `mobile-current-shift.test.ts` (with DB) | 7/9 fail | Pre-existing fixture defects: repeated `seed()` reuses one user (violates `workforce_profiles.user_id` unique) and assigns an INACTIVE Shift (service refuses) — same defect class fixed in the PART 01 suite |
| `mobile-team-work-orders.test.ts`, `mobile-work-order-verification-target.test.ts` (with DB) | 5 subtests fail | Pre-existing fixture defects, verified identical on the clean base commit |
| `shift-handovers.test.ts` (BE-10J, with DB) | 9/9 fail (`BUILDING_ACCESS_DENIED` inside the suite's own HTTP `seed()`) | **Verified pre-existing in FINAL REVIEW**: fails identically on the clean base commit `59d126a` against a PRISTINE database (no CR-BE-MOB-05 tables) — the suite's seed flow depends on state this sandbox does not provide; unrelated to the CR (the `security-logbook` and `security-shift-handovers` suites that exercise `shift_handovers` pass ✅) |
| `tests/security-shift-handovers.test.ts` etc. (DB-free env) | DB skips | Pre-existing skip-without-DB convention |
| KI-002 (`docs/known-issues.md`) | BAST creation `document_number` NOT NULL | Pre-existing, tracked separately |

STOP.
