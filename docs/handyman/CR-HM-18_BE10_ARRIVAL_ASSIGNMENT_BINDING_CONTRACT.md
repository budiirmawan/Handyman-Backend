# CR-HM-18 BE10 — Arrival Assignment Binding

Date: 2026-10-04 (Asia/Jakarta)
Branch: `arena/01a10470-handyman-backend`
Status: **Backend CHECK_IN admission contract and runtime binding**

```text
CR_HM_18_BE10=ARRIVAL_ASSIGNMENT_BINDING
CHECK_IN_ARRIVAL_FRESHNESS_SECONDS=900
ARRIVAL_AUTHORITY=BACKEND_ONLY
BE09_IDEMPOTENCY_REPLAY=PRESERVED
```

## 1. Frozen admission rule

A **new** `CHECK_IN` is admitted only when all of the following are true at
the transaction boundary:

1. The Execution Scope exists and is `AUTHORIZED`.
2. The caller has Client access and is the current authoritative Lead for
   the scope's active assignment.
3. The latest terminal arrival-verification result for that **exact
   Execution Scope** is `VERIFIED`.
4. The result's `assignmentId` is the still-current active assignment ID,
   and its `actorUserId` is the still-current Lead user ID.
5. The result's `evaluatedAt` is no more than **900 seconds (15 minutes)**
   before the Backend application clock. The inclusive age range is
   `0..900` seconds; future-dated results are rejected.

The Backend selects the latest result by `evaluatedAt`, with stable stored-row
tie-breaks. A later terminal result supersedes an earlier one: a latest
`FAILED`, `EXPIRED`, `MANUAL_REVIEW_REQUIRED`, or other non-`VERIFIED` result
does not fall back to an older `VERIFIED` result. The freshness window is
fixed—not caller-supplied, per-scope, or inherited from the separate
arrival-challenge TTL.

Any missing, stale, future-dated, cross-scope, assignment-mismatched,
Lead-mismatched, or superseded result rejects the new check-in with
`409 HANDYMAN_WORK_SESSION_ARRIVAL_REQUIRED`. The Lead must perform a fresh
arrival verification under the current assignment and Lead before attempting
another new CHECK_IN.

## 2. Reassignment, Lead change, and race boundary

CHECK_IN locks the Execution Scope before reading its active assignment, then
locks that assignment's crew before resolving the current Lead. Reassignment
serializes on the scope; Lead designation serializes on the crew. The
assignment and Lead used to validate the latest result are therefore the same
snapshots used to create the work session and its helper-presence snapshot.

- Reassignment invalidates an arrival result bound to the previous
  `assignmentId`.
- Lead change invalidates a result whose `actorUserId` is the former Lead.
- A scope-A result cannot authorize scope B, even when both scopes share a
  Client, crew, and Lead.
- A result older than 900 seconds or dated after the Backend clock cannot
  authorize a new check-in.

The arrival result remains immutable and is consumed read-only. BE10 adds no
arrival mutation, new client authority field, or downstream work/material/QC/
BAST behavior.

## 3. BE09 idempotency boundary

The Backend retains the existing exact
`(executionScopeId, idempotencyKey)` CHECK_IN event replay behavior. After current Client/Lead
authority is revalidated under the locks, a matching stored CHECK_IN event is
returned before checking arrival freshness, scope eligibility, or active
session state. Replays—including retries after `CHECKED_OUT` or a later
non-VERIFIED arrival result—return the original session/event and do not
create another session. A new key is a new CHECK_IN and must satisfy every
BE10 admission condition above.

## 4. Public contract and error behavior

The CHECK_IN request remains `{ "idempotencyKey": "..." }` at the existing
Execution-Scope path. The Backend does not accept an arrival-result ID,
assignment ID, Lead ID, status, timestamp, or freshness value from the
caller. `docs/api/openapi.yaml` freezes the 900-second rule and the existing
`HANDYMAN_WORK_SESSION_ARRIVAL_REQUIRED` conflict behavior.

Focused service coverage includes same-assignment success, reassignment,
Lead change, stale result, cross-scope isolation, and BE09 replay safety.
