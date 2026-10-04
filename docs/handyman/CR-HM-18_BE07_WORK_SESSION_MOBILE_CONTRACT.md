# CR-HM-18 BE07 — Work Session Mobile Contract & Gap Gate

Date: 2026-10-04 (Asia/Jakarta)
Branch: `arena/01a10470-handyman-backend`
Reviewed Backend baseline: `f6beec7` (BE06)
Status: **CONTRACT/GAP REVIEW ONLY — no runtime, migration, API, OpenAPI,
test, or Mobile changes are authorized by BE07.**

```text
CR_HM_18_BE07=CONTRACT_GAP_REVIEW_COMPLETE
CR_HM_08_WORK_SESSION_RUNTIME=EXISTS
MOBILE_COMMAND_ROLLOUT=BLOCKED_PENDING_SESSION_IDENTITY_AND_REPLAY_GAPS
BILLABLE_TIME_AUTHORITY=NO
MATERIAL_EXECUTION=NO
QC_BAST=NO
```

## 1. Gate decision

CR-HM-08 already owns the Backend work-session lifecycle, server timestamps,
read projections, and current-Lead authorization. Its seven scope-addressed
commands are present. The Backend must remain the sole lifecycle and time
authority; Lead Mobile may display and request transitions only.

The existing active-session read is suitable for refreshing the current
session. The session-addressed time-projection read does **not** guarantee
that it returns the requested session, and the mutation paths do not bind a
command to the session displayed by Mobile. Terminal retries also cease to be
idempotent after `CHECKED_OUT`. Consequently, this review freezes the DTO and
state contract but **does not clear the full Mobile command/offline-retry
integration gate**. The gaps in §§8–10 must be closed in a separately
authorized Backend runtime part before stale-session-safe Mobile command
consumption.

## 2. Existing Lead-facing surface

All paths below are under `/api/v1`.

| Method | Existing path | Existing purpose / Mobile disposition |
| --- | --- | --- |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/check-in` | Create the session and record `CHECK_IN`; requires an `AUTHORIZED` scope and a `VERIFIED` arrival result. |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/start-work` | `CHECKED_IN` → `IN_PROGRESS`. |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/pause` | `IN_PROGRESS` → `PAUSED`. |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/resume` | `PAUSED` or `MATERIAL_RUN` → `IN_PROGRESS`. |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/material-run` | `IN_PROGRESS` → `MATERIAL_RUN`; work-clock state only. |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/complete` | Declare field work complete. |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/check-out` | Close presence; may abandon directly from `CHECKED_IN`. |
| GET | `/handyman/execution-scopes/{executionScopeId}/work-sessions/active` | Read the one current non-`CHECKED_OUT` session and its helper-presence snapshot; `404` when none exists. This is the Lead-safe current-session read. |
| GET | `/handyman/work-sessions/{sessionId}/time-projection` | Intended session-addressed presence/actual-work read; **identity defect**, see §8. Do not rely on it for a particular session until repaired. |
| GET | `/handyman/execution-scopes/{executionScopeId}/work-sessions` | Customer Care projection guarded by `tenant_company.read`; not a Lead Mobile read. It is not a substitute for a Lead-safe session history API. |

The seven POST commands accept the execution-scope identifier in the path and
`{ "idempotencyKey": "..." }` in the body. They do not accept a session ID,
actor/worker/crew/assignment ID, arrival result ID, status, helper list, or
client timestamp. Unknown authority-shaped body properties are ignored.

## 3. Frozen lifecycle and result semantics

The requested shorthand `Arrival VERIFIED → START` omits the required
`CHECK_IN` boundary. The actual frozen sequence is:

```text
CR-HM-07 VERIFIED (same scope; read-only gate)
  → CHECK_IN       → CHECKED_IN
  → START_WORK     → IN_PROGRESS
  → PAUSE          → PAUSED
  → RESUME         → IN_PROGRESS
  → MATERIAL_RUN   → MATERIAL_RUN
  → RESUME         → IN_PROGRESS
  → COMPLETE       → COMPLETED
  → CHECK_OUT      → CHECKED_OUT
```

| Action | Legal source | Result | Backend meaning |
| --- | --- | --- | --- |
| `CHECK_IN` | No active session | `CHECKED_IN` | Opens presence; requires `AUTHORIZED` scope and a `VERIFIED` arrival result. It does not start work. |
| `START_WORK` | `CHECKED_IN` | `IN_PROGRESS` | Opens actual-work time. |
| `PAUSE` | `IN_PROGRESS` | `PAUSED` | Halts actual-work time; presence remains open. |
| `MATERIAL_RUN` | `IN_PROGRESS` only | `MATERIAL_RUN` | Halts actual-work time; session identity and presence remain open. It is not material execution. |
| `RESUME` | `PAUSED` or `MATERIAL_RUN` | `IN_PROGRESS` | Reopens actual-work time; it does not reset `startedWorkAt`. |
| `COMPLETE` | `IN_PROGRESS`, `PAUSED`, or `MATERIAL_RUN` | `COMPLETED` | Lead-declared field-work completion only; actual-work clock closes. |
| `CHECK_OUT` | `CHECKED_IN` or `COMPLETED` | `CHECKED_OUT` | Closes presence. `CHECKED_IN` → `CHECKED_OUT` is the abandon path. |

`MATERIAL_RUN` cannot be entered directly from `PAUSED`; resume first. There
is no resume after `COMPLETED`, and no transition out of `CHECKED_OUT`.
`CHECKED_OUT` is the sole terminal session status. Invalid current-state
actions produce a bounded `409` and do not append a transition event.

Arrival verification is consumed read-only: it does not create a session,
check the Lead in, start work, or mutate the arrival result. A non-`VERIFIED`
arrival result does not satisfy the check-in gate. `CHECK_IN != START_WORK`.

### Time and downstream boundaries

- **Presence time** is the server-timestamped interval from `CHECK_IN` to
  `CHECK_OUT`; an open session projects its tail to Backend `projectedAt`.
- **Actual-work time** is the sum of `IN_PROGRESS` intervals only. `PAUSED`
  and `MATERIAL_RUN` intervals are excluded; an open work interval projects
  to Backend `projectedAt`.
- **Billable time is not computed, stored, or implied.**
  `Presence Time != Actual Work Time != Billable Time`.
- `COMPLETE` is not QC completion, BAST acceptance, payment, or warranty
  closure. `CHECK_OUT` is not customer acceptance.
- `MATERIAL_RUN` changes only the work-clock state. No material quantity,
  issue/use truth, evidence, QC, or BAST behavior is part of this contract.

## 4. Mobile-safe response allowlist

The HTTP handlers use the standard Backend success envelope. Mobile consumes
`data`; it must not infer authority from a client-side status or timestamp.

### Command result `data`

```json
{
  "session": {
    "id": "<session UUID>",
    "executionScopeId": "<scope UUID>",
    "status": "<frozen session status>",
    "checkedInAt": "<server date-time>",
    "startedWorkAt": "<server date-time or null>",
    "completedAt": "<server date-time or null>",
    "checkedOutAt": "<server date-time or null>"
  },
  "event": {
    "id": "<event UUID>",
    "eventType": "<frozen event type>",
    "occurredAt": "<server date-time>",
    "idempotencyKey": "<submitted key>"
  },
  "replayed": false
}
```

`replayed: true` means the stored event was found and returned. The session
object is the current session projection at replay time; after later
transitions it need not be a historical snapshot of the state immediately
following that event. The command DTO deliberately omits `clientId`,
`assignmentId`, Lead/actor identifiers, token material, and helper snapshots.

### Active-session `data`

```text
{ session: <SessionPayload>, helperPresence: <HelperPresencePayload[]> }
```

Each helper-presence item is limited to `id`, `eventId`, `helperWorkerId`,
nullable `helperUserId`, and `createdAt`. These are presence references only;
they are not a billable-headcount or attendance result. The read contains no
helper names, assignment/actor authority fields, billing fields, or material
truth.

### Time-projection `data` (intended exact-session contract)

```text
{
  sessionId, executionScopeId, status,
  presenceSeconds, actualWorkSeconds, sessionClosed, projectedAt
}
```

Durations are Backend-derived seconds; `projectedAt` is the server clock used
for open tails. No rate, charge, or billable duration exists. Runtime sends
`projectedAt`, but the current OpenAPI component omits it; see §8.

## 5. Authentication and authority

- The commands, active-session read, and time-projection read require an
  authenticated Backend bearer session. They do not require
  `tenant_company.read`.
- The CR-HM-08 service checks `canAccessClient` for the Client derived from
  the scope and resolves the current active assignment/current Crew Lead on
  each command/read. The authenticated user must equal that resolved Lead;
  caller-supplied identity is ignored. Client-access or current-Lead failures
  are `403`; missing authentication is `401`.
- `CHECK_IN` additionally requires an existing `AUTHORIZED` scope and an
  arrival `VERIFIED` result. The current service reports a non-authorized
  scope and missing verified arrival as `409` precondition conflicts.
- The scope-wide session-history GET is a Customer Care operation guarded by
  `tenant_company.read` plus Client access. It is not authorized as a Lead
  Mobile read merely because the caller can address an execution scope.

**Arrival binding gap:** the current check-in lookup selects any
`VERIFIED` arrival-result row for the execution scope. It does not compare
that result's bound actor/assignment with the current Lead resolution, and it
does not impose freshness or one-use semantics. A prior verified result can
therefore remain a scope-level gate after a later arrival result or
assignment/Lead change. The intended Mobile contract is a verified result
bound to the current scope/assignment/Lead; BE07 does not change this
runtime behavior.

**Session assignment binding gap:** transitions re-resolve the current Lead,
then select the active session by scope. They do not compare the current
assignment resolution to the assignment/Lead snapshot stored on that session.
The required policy for an active session after assignment replacement must
be enforced or explicitly resolved before Mobile relies on the snapshot as a
stale-session guard.

## 6. Idempotency and stale/conflict handling

### Existing Backend behavior

- Every POST requires a trimmed `idempotencyKey` of 1–200 characters; the
  caller cannot supply event time or transition status. Persisted event times
  are Backend timestamps.
- The database uniqueness boundary is
  `(session_id, event_type, idempotency_key)`. Transition code locks the
  active session, checks for the event before its state transition, and writes
  the status projection and append-only event in one transaction.
- An exact key/action match on the session currently selected as active
  returns `replayed: true` and the stored event. Reusing a key for a different
  action is a new action, not a replay; Mobile should nevertheless generate a
  fresh key for every action.
- `CHECK_IN` with the same key replays while that session is still active. A
  different key while a session is active returns
  `409 HANDYMAN_WORK_SESSION_ACTIVE_CONFLICT`.
- No active session returns `404 HANDYMAN_WORK_SESSION_NOT_FOUND`; a new key
  for an action illegal in the current status returns
  `409 HANDYMAN_WORK_SESSION_ILLEGAL_TRANSITION`. Missing/invalid input is
  `400`; unauthenticated is `401`; Client/current-Lead denial is `403`;
  `CHECK_IN` precondition conflicts are `409`.
- A row lock serializes competing transitions; the one-active-per-scope
  partial unique index prevents two non-`CHECKED_OUT` sessions.

### Mobile handling frozen by BE07

- Treat Backend status, event, and server time as authoritative. Do not
  optimistically advance a durable lifecycle state or derive a timestamp.
- Persist one stable key for each pending action and reuse that exact key for
  a retry of that same action. Do not mint a replacement key just because a
  response is delayed; do not reuse a key across actions or sessions.
- Treat `409` as a state-reconciliation boundary: refresh the active session
  and present the Backend result; never force the requested transition.
  Treat `404` as “no readable active session / resource,” not proof that a
  particular pending terminal request succeeded.
- **Do not enable queued/offline mutation replay or claim terminal
  idempotency in Mobile against the current scope-addressed routes.** The
  Backend cannot reliably bind such a stale request to the session shown by
  Mobile or replay it after that session has checked out. This is a gate,
  not an invitation for Mobile to simulate the missing guarantee.

## 7. Existing transition order expected by Lead Mobile

For the requested flow, Mobile must include the explicit `CHECK_IN` and use
Backend-returned state after each success:

```text
Arrival VERIFIED
  → POST check-in       (CHECKED_IN)
  → POST start-work     (IN_PROGRESS)
  → POST pause          (PAUSED)
  → POST resume         (IN_PROGRESS)
  → POST material-run   (MATERIAL_RUN; no material transaction)
  → POST resume         (IN_PROGRESS)
  → POST complete       (COMPLETED; field work only)
  → POST check-out      (CHECKED_OUT; presence closed)
```

The legal alternate abandon path is `CHECKED_IN → CHECK_OUT`. No client may
skip a Backend transition or supply a desired status.

## 8. Gaps verified in the existing CR-HM-08 authority

### READ_GAP

1. `GET /handyman/work-sessions/{sessionId}/time-projection` parses and loads
   the requested session, but then passes only its `executionScopeId` to a
   service that selects the **latest** session for that scope. With a checked-out
   historical session and a newer session, the response can contain the newer
   `sessionId`, not the requested path ID. The current API test exercises only a
   single session and does not catch this. Until fixed, Mobile must not use this
   route as an exact-session read.
2. The runtime time-projection DTO includes `projectedAt`; the OpenAPI
   `HandymanWorkSessionTimeProjection` schema omits it. The work-session command,
   active, and time-projection OpenAPI response schemas also point at raw result
   components while the controllers serialize through the standard success
   envelope. OpenAPI/runtime parity must be corrected before a generated Mobile
   client is treated as the contract.
3. The only scope-wide session history route is the Customer Care read
   requiring `tenant_company.read`; there is no Lead-safe exact-session detail
   or event-history read. Do not substitute the Customer Care route for Lead
   Mobile.

### COMMAND_GAP

1. Every mutation is addressed by `executionScopeId`, not the session ID held
   by Mobile. The service locks whichever non-`CHECKED_OUT` session is active
   for that scope. A delayed action from a previous session can therefore
   operate on a newer session if that action is legal in the newer session's
   state; there is no stale-session ID precondition or dedicated stale-session
   conflict.
2. After `CHECK_OUT`, the session is excluded from the command lookup. A
   retry of the same `CHECK_OUT` key (or another terminal-session command) sees
   no active session and returns `404`, rather than replaying the recorded
   terminal event. Since idempotency is per session, action, and key, a
   `CHECK_IN` retry with no active session can create another session instead
   of finding the old event. This does not satisfy a robust offline/ambiguous
   terminal retry contract.
3. A current Lead is re-resolved for each action, but the action does not
   compare the resolved assignment to the session's stored assignment/Lead
   snapshot. The assignment-replacement behavior for an open session is not
   session-bound by the current CR-HM-08 command code.
4. `CHECK_IN`'s arrival gate is scope/status-only as described in §5; it does
   not prove that the `VERIFIED` row belongs to the current assignment/Lead or
   is fresh for this check-in.

## 9. Recommended next parts (not authorized by BE07)

1. **BE08 — exact-session reads and OpenAPI parity:** make the time-projection
   service operate on the requested `sessionId`, prove the returned ID equals
   it, preserve current Lead/Client checks via the session's scope, add a
   multi-session regression test, and align the OpenAPI response envelope plus
   `projectedAt`.
2. **BE09 — session-bound command/replay contract:** bind every transition
   (except creation `CHECK_IN`) to the expected `sessionId` under the row lock;
   return a bounded stale-session conflict without mutating a newer session;
   make same-key terminal retries resolve to their recorded event after
   `CHECKED_OUT`; give `CHECK_IN` a replay boundary that survives session
   closure; and explicitly decide how a current Lead/assignment change affects
   an already-open session. Test stale request, checkout replay, concurrent
   retry, and new-session isolation.
3. **BE10 — arrival-gate binding:** require the verified arrival evidence to
   match the current assignment/Lead and freeze any freshness/single-use rule
   before check-in. Keep CR-HM-07 arrival evaluation as the sole arrival
   authority.
4. **Later Lead Mobile part:** consume the frozen DTO, use the active read to
   reconcile, and enable offline/queued command retries only after BE08–BE10
   close the identity and replay gaps.

Material execution/evidence, QC, BAST, billing, attendance, and FM behavior
remain outside BE07 and must not be added to these parts.

## 10. Sources reviewed (CR-HM-08 only)

- `docs/handyman/CR-HM-08_START_GOVERNANCE.md`
- `docs/handyman/CR-HM-08_FINAL_CERTIFICATION.md`
- `src/database/migrations/0401_create_handyman_work_sessions.ts`
- `src/modules/handyman-work-sessions/handyman-work-session.service.ts`
- `src/modules/handyman-work-sessions/handyman-work-session.repository.ts`
- `src/modules/handyman-work-sessions/handyman-work-session.types.ts`
- `src/modules/handyman-work-sessions/handyman-work-session.errors.ts`
- `src/modules/handyman-work-sessions-api/handyman-work-sessions-api.routes.ts`
- `src/modules/handyman-work-sessions-api/handyman-work-sessions-api.controller.ts`
- `src/modules/handyman-work-sessions-api/handyman-work-sessions-api.validation.ts`
- `tests/handyman-work-session-commands.test.ts`
- `tests/handyman-work-session-workclock.test.ts`
- `tests/handyman-work-session-lifecycle.test.ts`
- `tests/handyman-work-sessions-api.test.ts`
- `docs/api/openapi.yaml` (CR-HM-08 work-session paths/schemas only)
