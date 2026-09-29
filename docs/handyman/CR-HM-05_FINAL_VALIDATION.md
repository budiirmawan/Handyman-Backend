# CR-HM-05 — FINAL VALIDATION & CERTIFICATION (PART 06B)

Date: 2026-09-27 Base: `39a768b` (PART 06A) Scope: certification
only — zero feature, runtime, migration, route, OpenAPI, roadmap or
test changes inside this certification. One new document (this file).

## 1. Decision Freeze F1–F10 compliance (frozen `4e6f479`)

| Gate | Status | Evidence |
|---|---|---|
| F1 Scheduled window/repeat fields forbidden in CR-HM-05 | PASS | 0387–0390 create `preferred_window_start/end` only; no `scheduled_*`, no repeat; API t8/t10 prove no scheduled-window fields |
| F2 Booking window/repeat semantics untouched | PASS | No booking-window code touched; readiness windows are request-derived, not bookings |
| F3 Execution time-window remains CR-003/WO-owned | PASS | Zero references to WO runtime windows in readiness modules |
| F4 Immutable lifecycle tables authority; journal history-only | PASS | Rows + supersession links are the single truth; `operational_events` used audit-only |
| F5 Supervisor handoff (ticket) deferred | PASS | No handoff surface exists anywhere in CR-HM-05 |
| F6 Hard delete forbidden; rows never rewritten on reschedule | PASS | Supersede inserts new ACTIVE row; old row → INACTIVE |
| F7 Frozen CR-HM-03 request/referral/contracts untouched | PASS | Zero schema/type changes; readiness derives FROM request chain |
| F8 Live/public booking requests excluded from scope | PASS | Surfaces are `handyman/...` internal IDs only |
| F9 CR-HM-06 remains single execution-scope authority | PASS | PART 05 contract re-affirms CR-HM-06 ownership; readiness carries no target binding |
| F10 FM perm module: pattern-only reuse, never domain mutation | PASS | `permits` table never touched; permit readiness stores bounded facts only |

## 2. Containment

CR-HM-05 owns readiness semantics only (scheduling preference,
unit-access authorization facts, permit validity facts + supersession
history/time-window/timezone). CR-HM-06 remains execution-scope
authority; target-bound scheduling is DEFERRED to post-CR-HM-06
activation per the frozen PART 05 contract; NO placeholder
target/job/WO exists (firewall greps = narration-only; API t10 =
zero forbidden paths/schemas).

## 3. Scheduling readiness authority

`ACTIVE|INACTIVE` only (CHECK, 0387); request-bound; client/building
server-derived; timezone from `buildings.timezone` (service line 84);
valid preferred window (start < end); supersede/history via 0390 links
+ optional bounded changeReason ≤ 500 (CHECK + `…REASON_INVALID` 400);
preferred window explicitly ≠ future scheduled execution window.

## 4. Unit-access readiness authority

Request + authoritative location chain (building/floor/area/room/space
server-derived, 0388 + derivation); valid access window;
supersede/history preserved; access readiness is an authorization
FACT — never arrival/presence proof (CR-HM-07 firewall).

## 5. Permit readiness authority

`permit_type` bounded exactly `UNIT | BUILDING_COMMON_AREA` (CHECK,
0389 + parser enum reject `VALIDATION_ERROR` 400); `ACTIVE|INACTIVE`;
`valid_from < valid_until`; authoritative location; supersede/history;
FM Permit-to-Work = pattern-only (never its state machine, approval
chain, free-form types, or `permits` table).

## 6. History semantics

Explicit bidirectional supersession links across all 3 surfaces (0390
nullable `supersedes_readiness_id` + history services). Lifecycle rows
remain current-state authority; operational events remain audit/history
ONLY; current = ACTIVE tail of the supersession chain (verified over
HTTP with a 3-link chain: `[INACTIVE, INACTIVE, ACTIVE]`).

## 7. Actor / RBAC

Reads (get + history): `tenant_company.read`. Mutations (create +
supersede): `tenant_company.manage`. Mutation actor = authenticated
session user only; client/location/timezone/actor fields in request
bodies are structurally ignored (whitelist parsers) — proven by t8.

## 8. HTTP / OpenAPI

Exactly 12 operations / 9 paths (4 per surface: create, read-bundle,
history, supersede). Runtime/OpenAPI parity PASSES (t10 + YAML parse
clean; 9 schemas present). PART 05 target-binding contract remains
docs-only — no future contract documented as live runtime.

## 9. Interlocks & firewalls

- CR-HM-04 assignment interlock: crew/provider assignment untouched;
  readiness never assigns; binding deferred.
- CR-HM-07 firewall: ZERO QR/challenge, geofence/risk, check-in,
  verified-arrival anywhere in code, paths, or schemas.
- FM firewall: ZERO dependency on FM work-order lifecycle or FM PTW
  runtime; zero mutation of FM permit/work-order domain.

## 10. Migrations

Ordered & additive: 0387 scheduling, 0388 unit-access, 0389 permit,
0390 history/supersession links (+ scheduling changeReason CHECK).
No unrelated schema mutation (tree diff scope = handyman-only).

## 11. Focused validation result

Command: `npx tsx --test --test-concurrency=1` over the 5 focused
files (real migrated PostgreSQL, single worker).

- Runs: initial 49/50 → unit-access t9 flake; second 48/50 →
  unit-access t9 + permit t9 flake; certification run **50/50 PASS**
  (suites 5/5).
- OpenAPI YAML parse: clean; 9 paths / 12 ops match runtime; zero
  forbidden fields.
- `git diff --check`: clean.

## 12. Defects

- Implementation defects: **NONE found** — no fix performed inside
  certification.
- Test-fragility observation (pre-existing, PART 02/03 era): the
  unit-access/permit t9 journal-order assertions rely on
  `ORDER BY created_at, id` over `operational_events` whose rows share
  a transaction timestamp (UUID id tie-break = nondeterministic).
  Semantically inert (journal is audit-only; deterministic PART 04
  history suite proves authority semantics). Recommendation for a
  future hardening CR: resolve journal rows by `event_type/entity_id`
  instead of timestamp ordering.

## 13. Final status

All certification gates PASS (F1–F10, containment, per-surface
authority, history, RBAC/actor, HTTP/OpenAPI parity, interlocks,
firewalls, migrations, focused validation 50/50).

**CR_HM_05_STATUS=COMPLETE**
