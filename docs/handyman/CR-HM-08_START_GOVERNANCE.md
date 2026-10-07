# CR-HM-08 — Work Session & Field Execution — START GOVERNANCE

Date: 2026-09-29 (Asia/Jakarta)
Branch: `arena/01a0e01e-handyman-backend`
Base commit: `e76599e` (CR-HM-07 certified COMPLETE)

Governance ONLY. NO migration, NO runtime/API/OpenAPI/tests. This
document freezes the authority and lifecycle decisions for CR-HM-08.
Does not invent runtime.

## §1 Position in the frozen roadmap

`HANDYMAN_CR_CODING_ROADMAP_v1.0.md`: CR-HM-08 — Work Session &
Field Execution (CHECK-IN, START WORK, PAUSE, RESUME, MATERIAL RUN,
COMPLETE, CHECK-OUT, presence/work/billable-time separation).
Primary authority: Handyman-Backend. Depends on CR-HM-07; consumed
by CR-HM-11, CR-HM-13, CR-HM-18. Preserved invariants: Presence
Time != Actual Work Time != Billable Time; CHECK-IN != START WORK;
Generic attendance != Handyman Work Session; Generic task/WO !=
Handyman Work Session.

## §2 TARGET

`HANDYMAN_EXECUTION_SCOPE` only. Every session/action binds one
execution scope authoritative in Handyman-Backend (CR-HM-06
AUTHORIZED gate precedent: `handymanScopeAssignmentRepository.
findScopeById` + `scope.status === 'AUTHORIZED'`). No work_order,
task, request, or building may own a session.

## §3 PREREQUISITE

`ARRIVAL_VERIFIED` (CR-HM-07) — an immutable
`handyman_arrival_verification_results` row with status `VERIFIED`
for this execution scope, bound to the current authoritative Crew
Lead's assignment chain. CR-HM-08 consumes the published CR-HM-07
result contract read-only; it never re-runs geofence/QR/challenge
logic and never mutates CR-HM-07 state.

FROZEN: arrival verification does NOT itself create, check in, or
start a session. `FAILED` / `MANUAL_REVIEW_REQUIRED` / `EXPIRED`
arrival = no `CHECK_IN` gate.

## §4 ACTOR

Current authoritative assigned Crew Lead/PIC ONLY, resolved
server-side per transition via the FROZEN CR-HM-07 consumer contract
`resolveHandymanAssignmentLead` (scopeId → ACTIVE assignment → crew →
current CR-HM-04 Lead → ACTIVE worker context → non-NULL userId).
Caller-supplied worker/crew/assignment ids are NEVER trusted; a
missing/invalid Lead fails closed. Helpers need no login and perform
no authoritative action.

## §5 CORE SESSION LIFECYCLE — frozen state machine

Field-work session states (single authoritative column, bounded):

```text
CHECKED_IN      — presence window open; work clock closed
IN_PROGRESS     — actual-work clock running
PAUSED          — actual-work clock halted (non-material reason); session/presence live
MATERIAL_RUN    — actual-work clock halted (material acquisition); session/presence live
COMPLETED       — Lead-declared work complete; no work-clock resume possible
CHECKED_OUT     — terminal; presence window closed
```

NOT_STARTED is implicit (no row exists). CHECKED_OUT is the ONLY
terminal state. Do NOT reuse FM `work_order` lifecycle as authority —
zero status reuse or mapping.

Legal transitions (each recorded as an append-only session event):

| # | Action | From | To |
| - | --- | --- | --- |
| 1 | CHECK_IN     | (none) | CHECKED_IN |
| 2 | START_WORK   | CHECKED_IN | IN_PROGRESS |
| 3 | PAUSE        | IN_PROGRESS | PAUSED |
| 4 | MATERIAL_RUN | IN_PROGRESS | MATERIAL_RUN |
| 5 | RESUME       | PAUSED | IN_PROGRESS |
| 6 | RESUME       | MATERIAL_RUN | IN_PROGRESS |
| 7 | COMPLETE     | IN_PROGRESS / PAUSED / MATERIAL_RUN | COMPLETED |
| 8 | CHECK_OUT    | CHECKED_IN (abandon) / COMPLETED | CHECKED_OUT |

MATERIAL_RUN is entered from IN_PROGRESS only (a PAUSED crew resumes
first — one bounded reason surface). No other transition is legal;
anything else is a bounded `409` conflict.

## §6 TIME SEMANTICS — frozen, never synonymous

- **PRESENCE_TIME** — server-timestamped segments from CHECK_IN to
  CHECK_OUT. Arrival verification is NOT presence.
- **ACTUAL_WORK_TIME** — sum of IN_PROGRESS segments
  (START_WORK/RESUME → PAUSE/MATERIAL_RUN/COMPLETE boundaries).
  PAUSED and MATERIAL_RUN halt the work clock.
- **BILLABLE_TIME** — NOT computed, stored, or implied by CR-HM-08.
  Downstream concern (CR-HM-12 pricing / CR-HM-13 ledger). CR-HM-08
  publishes raw presence/work timelines only; no billable flag,
  amount, rate, or duration-basis exists in the session model.

All three are distinct derived projections of the append-only event
stream; events carry server-authoritative timestamps only.

## §7 CREW

Lead/PIC action authority per §4. Helper PRESENCE SNAPSHOT: at
CHECK_IN (closure at CHECK_OUT) the server snapshots the CURRENT
`handyman_crew_memberships` roster of the ACTIVE assignment's crew
(CR-HM-04, migration 0386) — append-only, server-derived, never
caller-supplied. Helper presence is presence evidence ONLY; it MUST
NOT automatically become billable manpower (§6). Helpers require no
login (§4).

## §8 ARRIVAL BOUNDARY

```text
ARRIVAL_VERIFIED != CHECK_IN
CHECK_IN        != START_WORK
START_WORK      != BILLABLE_TIME
```

Verified arrival only opens the CHECK_IN gate; presence opens only
work eligibility; work time never implies billing.

## §9 MATERIAL_RUN

MATERIAL_RUN pauses the ACTUAL_WORK clock while PRESERVING session
identity and presence. It is a first-class bounded work-clock state
(§5), NOT a new session and NOT an absence. Material acquisition
truth (estimated/approved/issued/used) is CR-HM-09 — zero coupling
here.

## §10 COMPLETE / CHECK_OUT boundary

```text
work complete != QC complete        (CR-HM-10)
work complete != BAST accepted      (CR-HM-11)
work complete != payment settled    (CR-HM-13/14)
check-out     != customer acceptance
```

COMPLETE = Lead-declared work-finished timestamp only. CHECK_OUT =
presence closure only. Neither emits, triggers, or implies any
downstream acceptance/financial state.

## §11 CONCURRENCY

- At most ONE active (non-CHECKED_OUT) field session per execution
  scope — partial unique index precedent (as
  `handyman_arrival_challenges_one_pending_idx`).
- Idempotency/replay: every transition command carries a
  client-supplied idempotency key bounded to (session, action);
  replay returns the SAME recorded transition, never a second event.
  Offline capture semantics for the mobile client preserved via
  client event id + server projection ordering.
- Server timestamps are authoritative; client timestamps are
  informational snapshot only.
- Transition locking: row lock on the session + conditional
  status transitions inside ONE transaction (append-only event insert
  + session projection update atomic); concurrent illegal transitions
  fail with a bounded `409`.

## §12 DOWNSTREAM FIREWALL

CR-HM-08 must NOT own:

| Concern | Owner |
| --- | --- |
| QC / rectification / reinspection | CR-HM-10 |
| BAST / customer acceptance | CR-HM-11 |
| Pricing | CR-HM-12 |
| Payment ledger | CR-HM-13 |
| Entitlement / settlement | CR-HM-14 |
| Warranty | CR-HM-15 |

```text
FM_COUPLING=NO
```

No FM `work_order` reads/writes/state reuse, no FM lifecycle mapping.
Generic workforce attendance (CR-BE-MOB-05 `attendance` module:
profile×building×shift clock-in/out) is NOT Handyman Work Session
authority — reused zero.

## §13 BLOCKERS

```text
CR_HM_08_BLOCKERS=0
```

All dependencies verified present in workspace: AUTHORIZED scope gate
seam (`findScopeById`), Lead authority (`resolveHandymanAssignmentLead`,
FROZEN §5 consumer contract), crew roster authority
(`handyman_work_crews` / `handyman_crew_memberships` /
`handyman_crew_leads`, migration 0386), arrival prerequisite contract
(`handyman_arrival_verification_results`, CR-HM-07 certified,
`CR_HM_08_PREREQUISITE=ARRIVAL_VERIFIED`).

## §14 PART SPLIT — smallest implementation split

| Part | Delivers |
| --- | --- |
| PART 01 | Work-session foundation: ONE migration (sessions + append-only transition events + crew presence snapshots + one-active index), bounded states/actions/errors/repository. |
| PART 02 | Gate + session open: ARRIVAL_VERIFIED prerequisite check, Lead resolution, CHECK_IN / START_WORK with presence snapshot. |
| PART 03 | Work-clock transitions: PAUSE / RESUME / MATERIAL_RUN with segment semantics. |
| PART 04 | COMPLETE / CHECK_OUT, time-semantics projections (PRESENCE/ACTUAL_WORK), one-active + idempotency/replay + concurrency hardening. |
| PART 05 | Thin HTTP/OpenAPI exposure (no decision logic in route). |
| PART 06 | Final certification (incl. boundary + firewall re-verification). |

Each part: migrations/commits only after focused tests pass; no
frozen-module reopening; per-part diff check + keyed report.
