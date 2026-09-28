# CR-HM-07 PART 04 — ARRIVAL VERIFICATION RESULT GOVERNANCE

**Status:** FROZEN (decision-level governance ONLY — no runtime, no
migration, no tests, no HTTP/OpenAPI in this PART).
**Depends on:** CR-HM-07 PART 01 (challenges, landed), PART 02
(expected-location snapshot + registry, landed), PART 03A/03A1
(signal governance + geospatial authority decision, landed), PART 03B
(per-Building geospatial policy + internal geofence signal, landed),
PART 03C (API.CO.ID optional-corroboration adapter, landed).
**Scope anchor:** the existing TRI/QR handyman scope setup (fixed
start location, real-time arrival validation, QR, server-side
verification without implying work sessions) — this document freezes
the TERMINAL ARRIVAL RESULT rules that the future implementation must
follow.

This document is the sole authority for terminal arrival-verification
result composition. Where a provider signal, device signal, or module
disagrees with this document, this document wins; conflicts must be
escalated, never resolved by inventing behavior at runtime.

---

## 1. TARGET

- Authoritative target: `HANDYMAN_EXECUTION_SCOPE` ONLY.
- The scope must exist and remain `AUTHORIZED` at evaluation time.
- Terminal evaluation is scoped: exactly one execution scope per
  evaluation.
- `ARRIVAL_RESULT_AUTHORITY=HANDYMAN_BACKEND`
- `ARRIVAL_RESULT_TARGET=HANDYMAN_EXECUTION_SCOPE`

## 2. ACTOR

- The ONLY actor that may obtain a terminal evaluation: the
  authoritative CURRENT assigned Crew Lead.
- The actor is resolved SERVER-SIDE from the ACTIVE scope assignment
  at evaluation time.
- Caller-supplied `workerId` / `crewId` are never trusted; actor
  identity comes from the authenticated session + authoritative
  assignment lookup only.
- If the actor is no longer the authoritative active assigned Crew
  Lead at evaluation time, that is deterministic negative evidence.
- `ARRIVAL_ACTOR=AUTHORITATIVE_ACTIVE_CREW_LEAD`

## 3. CHALLENGE

- A valid server-issued challenge is REQUIRED for every terminal
  evaluation.
- The challenge must be: bound to `executionScopeId`, bound to the
  authoritative Lead `actorUserId`, `PENDING`, unexpired, and
  token-valid.
- A successful terminal evaluation consumes the challenge EXACTLY ONCE
  (PART 01 consumption semantics).
- An expired, invalid, or replayed challenge must NEVER produce
  `VERIFIED`.
- Challenge expiry observed at evaluation time yields the terminal
  status `EXPIRED`.
- `CHALLENGE_REQUIRED=YES`

## 4. EXPECTED LOCATION

- The Execution Scope immutable snapshot remains the SOLE expected-
  location authority (PART 02). No device GPS, QR content, provider
  output, or reverse-geocoded address may substitute for it.

## 5. QR

- A QR location signal is REQUIRED for terminal verification.
- The QR must resolve `MATCH` against the expected authoritative
  location (PART 02 registry resolution).
- `UNKNOWN`, `INACTIVE`, or `MISMATCH` signals cannot produce
  `VERIFIED`; `MISMATCH` is deterministic negative evidence.
- QR alone is never sufficient for `VERIFIED`.
- `QR_MATCH_REQUIRED_FOR_VERIFIED=YES`

## 6. DEVICE / GEOFENCE

- Device location input is REQUIRED when an ACTIVE building
  geospatial policy exists (PART 03B).
- Geofence signal interpretation:
  - `INSIDE` = positive corroboration.
  - `OUTSIDE` = terminal verification failure (deterministic negative
    evidence).
  - `LOW_ACCURACY` = cannot produce `VERIFIED`.
  - `UNAVAILABLE` with an ACTIVE policy = cannot produce `VERIFIED`.
- `ACTIVE_GEOFENCE_POLICY_REQUIRED_FOR_VERIFIED=YES`
- `GEOFENCE_INSIDE_REQUIRED_FOR_VERIFIED=YES`

## 7. NO-ACTIVE-POLICY RULE

- If NO ACTIVE building geospatial policy exists for the expected
  building, the geofence signal is `UNAVAILABLE`.
- This governance intentionally does NOT invent automatic PASS or FAIL:
  the frozen result is `MANUAL_REVIEW_REQUIRED` (never `VERIFIED`,
  never automatically `FAILED` on this absence alone).

## 8. API.CO.ID

- Reverse geocoding (PART 03C) is OPTIONAL_CORROBORATION only.
- Provider unavailable / auth failure / malformed response must NEVER
  by itself cause `FAILED`.
- Regional Indonesia is REFERENCE_NORMALIZATION only.
- NEITHER API.CO.ID result is required for `VERIFIED`.
- `API_CO_ID_REQUIRED_FOR_VERIFIED=NO`
- `PROVIDER_OUTAGE_CAUSES_FAILED=NO`

## 9. TERMINAL RESULT STATUSES

Terminal result status is EXACTLY one of:

- `VERIFIED`
- `FAILED`
- `MANUAL_REVIEW_REQUIRED`
- `EXPIRED`

`ARRIVAL_RESULT_STATUSES=VERIFIED|FAILED|MANUAL_REVIEW_REQUIRED|EXPIRED`

## 10. VERIFIED RULE

`VERIFIED` requires ALL simultaneously at evaluation time:

1. scope exists and is `AUTHORIZED`,
2. actor is the authoritative ACTIVE assigned Crew Lead,
3. challenge valid (bound/PENDING/unexpired/token-valid) and consumed
   exactly once by this evaluation,
4. QR signal resolves `MATCH` against the expected location snapshot,
5. an ACTIVE building geospatial policy exists for the expected
   building,
6. device location observation is usable, fresh (per policy), and
   accurate (per policy),
7. geofence signal is `INSIDE`.

API.CO.ID outcomes are never part of this conjunction.

## 11. FAILED RULE

`FAILED` only for deterministic negative evidence, exactly one of:

- QR `MISMATCH` against the expected location snapshot,
- geofence `OUTSIDE` (with usable/fresh/accurate observation),
- actor/assignment no longer authoritative at evaluation
  (actor is not the active assigned Crew Lead, or the assignment is
  invalid/inactive).

If the scope is no longer `AUTHORIZED` at evaluation time, terminal
evaluation does NOT PROCEED: no terminal result is created and the
challenge is NOT consumed (the scope state itself is the authority —
parallel to the ^2 TARGET precondition).

`FAILED` is NEVER produced by: provider outage/auth/malformed
response, missing enrichment, or inability to establish positive
proof without deterministic negative evidence.

## 12. MANUAL_REVIEW_REQUIRED RULE

`MANUAL_REVIEW_REQUIRED` for inability to establish positive proof
WITHOUT deterministic negative evidence, exactly one of:

- QR registry signal `UNKNOWN`,
- QR registry signal `INACTIVE`,
- no ACTIVE building geospatial policy (§7),
- `LOW_ACCURACY` device observation,
- geofence `UNAVAILABLE` (stale/unusable/missing observation).

## 13. EXPIRED RULE

`EXPIRED`: the bound challenge expired before terminal evaluation.

## 14. REASON CODES

Bounded primary reason codes, exactly one per terminal result:

| Status | Reason codes |
| --- | --- |
| `VERIFIED` | `ALL_POSITIVE_EVIDENCE` |
| `FAILED` | `QR_MISMATCH`, `GEOFENCE_OUTSIDE`, `ACTOR_ASSIGNMENT_INVALID` |
| `MANUAL_REVIEW_REQUIRED` | `QR_UNKNOWN`, `QR_INACTIVE`, `NO_GEOSPATIAL_POLICY`, `LOW_ACCURACY`, `GEOFENCE_UNAVAILABLE` |
| `EXPIRED` | `CHALLENGE_EXPIRED` |

- Exactly ONE primary terminal reason is required per result.
- Optional corroboration metadata (geofence distance/policyId,
  normalized reverse-geocode outcome, QR identifier reference) may be
  recorded separately from the primary reason.

## 15. IDEMPOTENCY / REPLAY

- Exactly ONE authoritative terminal result per challenge.
- Replaying the same terminal evaluation for the same challenge
  returns the EXISTING recorded result (no new result, no duplicate
  consumption).
- A consumed challenge can never create another result.
- After `FAILED`, `MANUAL_REVIEW_REQUIRED`, or `EXPIRED`, any new
  attempt requires a NEW server-issued challenge (new challenge
  issuance remains governed by PART 01 active-limit rules).

## 16. AUDIT SNAPSHOT

Persist an immutable snapshot sufficient to explain the decision:

- scopeId
- assignmentId
- actorUserId
- challengeId
- expected location snapshot (building/floor/area/room/space at
  evaluation from the authoritative snapshot source)
- QR signal (raw signal value + registry identifier reference)
- device observation (latitude/longitude/accuracyMeters/capturedAt as
  validated input)
- geofence signal + distanceMeters + policyId
- optional normalized reverse-geocode outcome (bounded DTO fields only)
- terminal status
- primary reason code
- evaluatedAt (server time)

Never persist: provider API keys, raw provider payloads, or any
secret material.

## 17. CR-HM-08 FIREWALL

`VERIFIED` means ARRIVAL VERIFIED ONLY. It does NOT mean: CHECK-IN,
START WORK, attendance, presence time, actual work time, or billable
time. CR-HM-08 may consume `VERIFIED` as a prerequisite LATER; no such
semantics are created by this document. NO FM work_order.

`ARRIVAL_VERIFIED_EQUALS_WORK_STARTED=NO`

## 18. PART-04 SCOPE TOKEN REGISTER

```
ARRIVAL_RESULT_AUTHORITY=HANDYMAN_BACKEND
ARRIVAL_RESULT_TARGET=HANDYMAN_EXECUTION_SCOPE
ARRIVAL_ACTOR=AUTHORITATIVE_ACTIVE_CREW_LEAD
CHALLENGE_REQUIRED=YES
QR_MATCH_REQUIRED_FOR_VERIFIED=YES
ACTIVE_GEOFENCE_POLICY_REQUIRED_FOR_VERIFIED=YES
GEOFENCE_INSIDE_REQUIRED_FOR_VERIFIED=YES
API_CO_ID_REQUIRED_FOR_VERIFIED=NO
PROVIDER_OUTAGE_CAUSES_FAILED=NO
ARRIVAL_RESULT_STATUSES=VERIFIED|FAILED|MANUAL_REVIEW_REQUIRED|EXPIRED
ARRIVAL_VERIFIED_EQUALS_WORK_STARTED=NO
```
