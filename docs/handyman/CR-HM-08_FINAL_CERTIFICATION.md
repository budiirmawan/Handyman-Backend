# CR-HM-08 — Work Session & Field Execution — FINAL CERTIFICATION

Date: 2026-09-29 (Asia/Jakarta)
Branch: `arena/01a0e01e-handyman-backend`
Base commit: `2c42803` (CR-HM-08 PART 05)

Governance reference: `CR-HM-08_START_GOVERNANCE.md` (FROZEN,
6fd9e09-line: `684baf1`).

## Certification record

```text
CR_HM_08_STATUS=COMPLETE
CR_HM_08_BLOCKERS=0
CR_HM_08_IMPLEMENTATION_DEFECTS=0
CR_HM_09_PREREQUISITE=WORK_SESSION_EXECUTION_COMPLETE
BILLABLE_TIME_AUTHORITY=NO
FM_COUPLING=NO
```

## Delivered parts

| Part | Commit | Deliverable |
| --- | --- | --- |
| Governance | `684baf1` | start governance (FROZEN decisions §1–§14) |
| PART 01 | `dc6cf5e` | work-session persistence foundation (migration 0401: 3 tables, one-active partial unique index, idempotency unique boundary, immutability triggers) |
| PART 02 | `1bbc844` | CHECK_IN (ARRIVAL_VERIFIED gate) + START_WORK commands |
| PART 03 | `9e08fda` | PAUSE / RESUME / MATERIAL_RUN work-clock commands |
| PART 04 | `fb41ab6` | COMPLETE / CHECK_OUT + presence/actual-work read projection |
| PART 05 | `2c42803` | thin HTTP/OpenAPI surface (9 endpoints) |
| PART 06 | this commit | final certification |

## Focused certification suites — 34/34 PASS

| Suite | Part | Tests |
| --- | --- | --- |
| `tests/handyman-work-sessions.test.ts` | 01 | 10 |
| `tests/handyman-work-session-commands.test.ts` | 02 | 6 |
| `tests/handyman-work-session-workclock.test.ts` | 03 | 6 |
| `tests/handyman-work-session-lifecycle.test.ts` | 04 | 6 |
| `tests/handyman-work-sessions-api.test.ts` | 05 | 6 |

5 suites, 34 tests, 0 failures (real migrated PostgreSQL 18.4,
`node --test` concurrency 1). During certification, the PART 01 t10
scan was found to over-scope two invariants into PART 02's lawful
evolution: (a) the forbidden token list matched the FROZEN §3
ARRIVAL-gate identifier surface added by PART 02
(`handymanWorkSessionArrivalRequiredError` / service re-export);
(b) the "persistence-only file count" assertion rejected the lawful
PART 02–04 command service in the domain module. Both were
test-precision flaws, NOT runtime defects; the assertions were
narrowed to the true invariants — zero arrival-MODULE imports and
zero HTTP controller/routes inside the domain module (the PART 05
`-api` module owns the HTTP layer). No runtime code was changed.

## Frozen invariants verified at certification

1. **ARRIVAL_GATE** — an immutable CR-HM-07 `VERIFIED` result for the
   SAME execution scope is required before CHECK_IN (absence and
   non-VERIFIED terminals both boundedly rejected); arrival state is
   never mutated (read-only prerequisite).
2. **ACTOR_AUTHORITY** — every command/read requires the CURRENT
   authoritative assigned Crew Lead via `resolveHandymanAssignmentLead`;
   outsiders get 403; no client access gets 403.
3. **STATE_LADDER** — exactly CHECKED_IN / IN_PROGRESS / PAUSED /
   MATERIAL_RUN / COMPLETED / CHECKED_OUT with the 8 frozen legal
   transitions; anything else is bounded 409; CHECKED_OUT is the sole
   terminal; CHECK_IN != START_WORK.
4. **MATERIAL_RUN** — first-class bounded work-clock state (from
   IN_PROGRESS only): halts actual-work time while session identity
   and presence are preserved; zero material truth (CR-HM-09).
5. **BOUNDARIES** — COMPLETE is field-work-complete ONLY (never QC,
   BAST, payment, warranty, billing); CHECK_OUT closes presence ONLY
   (never customer acceptance).
6. **TIME_SEMANTICS** — presenceTime (CHECK_IN → CHECK_OUT/server-now
   open tail) vs actualWorkTime (sum of IN_PROGRESS intervals only —
   PAUSED/MATERIAL_RUN excluded), both READ-ONLY projections over the
   append-only event stream; NOTHING fabricated or persisted for open
   sessions; BILLABLE_TIME does not exist (no flag/rate/charge
   anywhere: information_schema sweeps + source scans).
7. **HELPER_SNAPSHOT** — server-derived CURRENT crew membership
   minus Lead at CHECK_IN (open) and CHECK_OUT (close), append-only,
   session/event bound, login-optional; presence evidence ONLY, never
   billable manpower.
8. **IDEMPOTENCY** — `(session, event_type, idempotency_key)` unique
   boundary; replay returns the SAME recorded event (pre-transition
   check inside the row lock); new key in wrong state = bounded 409.
9. **ONE_ACTIVE** — at most one non-CHECKED_OUT session per execution
   scope (partial unique index; 23505 → bounded 409); CHECKED_OUT
   frees the scope.
10. **SERVER_TIMESTAMPS** — all persisted times are DB-server clock
    (NOW()); callers cannot supply any timestamp.
11. **HTTP_OPENAPI** — 9 endpoints under `/api/v1` with exact
    schema/status parity; mutation request = `idempotencyKey` ONLY;
    forbidden authority-shaped inputs are structurally absent from the
    OpenAPI surface and structurally ignored at runtime (smuggle-tested).
12. **FM_COUPLING=NO** — zero work_order/BAST/payment/pricing/QC/
    warranty/material charging surface in module or migration; zero
    effect on any downstream table.

## Boundary handoff

- ARRIVAL_VERIFIED (CR-HM-07, certified COMPLETE) is the CHECK_IN
  gate — consumed read-only.
- CR-HM-09 consumes WORK_SESSION_EXECUTION_COMPLETE MATERIAL_RUN
  context for material truth (not stored here).
- QC/rectification (CR-HM-10), BAST/customer acceptance (CR-HM-11),
  pricing (CR-HM-12), payment ledger (CR-HM-13), settlement
  (CR-HM-14), warranty (CR-HM-15) are downstream authorities — zero
  coupling here.
