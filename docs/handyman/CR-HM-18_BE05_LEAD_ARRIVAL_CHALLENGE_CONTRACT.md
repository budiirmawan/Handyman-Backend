# CR-HM-18 BE05 — Lead Arrival Challenge Transport Contract

**Status: FROZEN CONTRACT ONLY — no runtime route, migration, published
OpenAPI change, tests, or client implementation is authorized by this
part.** This is the minimum transport for the existing CR-HM-07 arrival
authorities, entered from a current CR-HM-18 assigned scope. It does not
change BE02's two GET contracts or any CR-HM-04 assignment authority.

## 1. Existing authority and transport gap

The following Backend authorities already exist:

- **Assigned Scope:** BE03 exposes the authenticated Lead's current
  assigned-scope list and detail. The scope ID is a locator, not proof of
  current assignment; every following operation must re-resolve authority.
- **Arrival Challenge (CR-HM-07 PART 01):**
  `createHandymanArrivalChallenge` verifies an `AUTHORIZED` scope,
  `canAccessClient`, the active assignment, and the CR-HM-04 current Lead.
  It generates a random token, stores only its hash, and uses a DB-clock
  120-second expiry. It permits one pending challenge per
  `(executionScopeId, actorUserId)` and returns a live-challenge conflict
  rather than creating a duplicate.
- **Expected Location / QR (PART 02):** the immutable Execution Scope
  location snapshot is authoritative. The QR registry resolves an opaque
  scanned code to `MATCH`, `MISMATCH`, `UNKNOWN`, or `INACTIVE`; that result
  is a location signal, not an arrival verdict.
- **Device / Geofence (PART 03):** device values are observations. The
  Backend evaluates geofence status against its per-Building policy and
  expected-location authority. Neither device input nor geofence output
  replaces that authority.
- **Evaluation / Result (PART 04):** an authenticated `POST
  /api/v1/handyman/execution-scopes/{executionScopeId}/arrival-verification`
  passes the allowlisted challenge, QR, and optional device-location input
  to the Backend evaluator. The evaluator composes the signals and atomically
  records the terminal challenge transition and result; replay of the same
  completed evaluation returns its existing result.

**Gaps:**

1. The challenge creator is currently a domain service only. There is no
   registered Lead HTTP route that transports its one-time raw token to Lead
   Mobile. The existing evaluation POST cannot start the flow by itself
   because it requires that token. BE05 freezes one issuance transport and
   reuses the existing evaluation route; it does not implement either route.
2. **Expiry edge mismatch:** the challenge-issue service may already project
   an overdue `PENDING` row to `EXPIRED` while preparing a replacement. If the
   old token is then submitted with no stored result, the evaluator attempts
   another `PENDING → EXPIRED` update; the update returns no row and the
   evaluator raises a result conflict instead of persisting/returning the
   PART 04 `EXPIRED / CHALLENGE_EXPIRED` result. BE05 records the frozen
   result rule but does not repair this runtime edge; a separate runtime part
   must reconcile it before treating all expiry retries as terminal-result
   idempotent.

## 2. Frozen flow

```text
BE03 current assigned scope
  → Lead requests a one-time arrival challenge
  → Lead captures QR and, when available, device-location signals
  → existing Backend arrival-evaluation POST
  → Backend-owned terminal result
```

| Step | Transport / authority | Contract meaning |
|---|---|---|
| Assigned Scope | Existing BE03 authenticated GETs | Lead selects an already assigned scope. No browse, claim, or self-assignment. |
| Arrival Challenge | New contract-only POST below | Backend creates a short-lived challenge bound to its resolved scope, assignment, and current Lead. |
| Location Signals | Inputs to existing evaluation POST | QR and device readings are untrusted observations for server-side comparison. |
| Backend Evaluation | Existing arrival-evaluation POST | Backend rechecks authority and composes challenge, expected location, QR, and applicable geofence evidence. |
| Result | Existing evaluation response | Only Backend-composed statuses/reasons are authoritative. A signal or challenge alone is not arrival truth. |

## 3. Minimum Lead-safe transport

### 3.1 Issue challenge — contract-only, not runtime-registered

```http
POST /api/v1/handyman/lead/assigned-scopes/{executionScopeId}/arrival-challenge
Authorization: Bearer <Backend session>
```

- The path contains only the existing `executionScopeId`; the request has no
  body. No caller-supplied `clientId`, `assignmentId`, actor/worker/crew IDs,
  expected location, TTL, or status is accepted or used.
- The route uses the authenticated session identity and the server-side
  assignment/Lead and `canAccessClient` checks in §4. It is not a new
  assignment command.
- On creation, return `201` with this allowlisted response only:

```json
{
  "challengeId": "<uuid>",
  "executionScopeId": "<uuid>",
  "challengeToken": "<opaque one-time value>",
  "expiresAt": "<server-issued date-time>"
}
```

- `challengeToken` is the raw server-generated token and is returned once.
  The HTTP layer must project the domain result; it must not serialize
  `clientId`, `assignmentId`, `actorUserId`, `tokenHash`, or other internal
  challenge fields. Use `Cache-Control: no-store`; never put the token in a
  URL, QR payload, log, operational event, analytics payload, or error.
- Expected failures retain the bounded Backend error envelope: invalid scope
  identifier `400`, unauthenticated `401`, missing scope `404`, not-current
  Lead or Client-access denial `403`, non-`AUTHORIZED` scope `409`, and a
  live challenge `409 HANDYMAN_ARRIVAL_CHALLENGE_LIVE_CONFLICT`.
- There is no challenge read/recovery endpoint. The token is single-purpose:
  it can be submitted only for arrival evaluation of its bound scope and
  authenticated actor. It is not a session, assignment credential, QR code,
  or work/check-in token.

### 3.2 Submit signals — existing runtime endpoint

```http
POST /api/v1/handyman/execution-scopes/{executionScopeId}/arrival-verification
Authorization: Bearer <Backend session>
Content-Type: application/json
```

Consumed request fields remain the existing whitelist:

```json
{
  "challengeToken": "<challengeToken from issue response>",
  "qrOpaqueCode": "<scanned registered opaque location code>",
  "deviceLocation": {
    "latitude": 0,
    "longitude": 0,
    "accuracyMeters": 0,
    "capturedAt": "<device observation time>"
  }
}
```

`qrOpaqueCode` and `challengeToken` are required. `deviceLocation` may be
omitted or `null`; when present it contains only those four observation
fields. The evaluator applies the existing physical-range, server-time, and
per-Building policy checks. Callers cannot provide expected coordinates,
distance, geofence result, policy ID, QR signal, actor/assignment identity,
arrival status, or reason. Those values are resolved or computed by Backend.

No new result route or client-authored result field is introduced. The
existing response is bounded to `id`, `executionScopeId`, `challengeId`,
`status`, `primaryReason`, `qrSignal`, `geofenceSignal`, `distanceMeters`,
and `evaluatedAt`.

## 4. Authorization and assignment boundary

For issuance, and for every new terminal evaluation, the Backend must derive
the actor only from the authenticated Backend session and verify, server-side:

1. the requested scope exists and is `AUTHORIZED`;
2. the scope has a current ACTIVE CR-HM-04 assignment;
3. that assignment resolves to the current valid Lead through its current
   crew designation, active membership, active worker context, and linked
   user identity;
4. the authenticated user is that current Lead; and
5. `contextAccessService.canAccessClient` succeeds for the Client resolved
   from the scope.

The challenge record binds the resolved Client, scope, assignment, and actor.
A stale BE03 list entry, UI label, caller-supplied identity, or previously
issued token cannot substitute for reauthorization. If the assignment or
Lead changes before evaluation, the old challenge cannot produce `VERIFIED`;
the existing PART 04 assignment-invalid result rule applies. A newly current
Lead must obtain a challenge bound to the new current assignment.

CR-HM-04 remains the sole assignment/reassignment authority. BE05 adds no
assignment write, crew selection, Lead designation, or self-claim capability.
No `tenant_company.read` permission is introduced for the Lead challenge or
evaluation flow.

## 5. Signals and Backend result authority

- **QR:** the raw scan is resolved against the registered opaque location
  identifier and immutable Execution Scope snapshot. `MATCH` is necessary
  but not sufficient; a copied/static QR is not proof of presence.
- **Device location:** latitude, longitude, accuracy, and capture time are
  caller-observed evidence only. Backend validates the observation and
  computes distance/geofence against the active per-Building policy. GPS is
  not an expected-location source; no indoor floor/room coordinates are
  inferred.
- **Geofence:** `INSIDE`, `OUTSIDE`, `LOW_ACCURACY`, or `UNAVAILABLE` is a
  Backend-computed signal. Neither a client geofence boolean nor a client
  assertion of `VERIFIED` is accepted. QR, GPS, and geofence are never
  independent proof or arrival decision authority.
- **`VERIFIED`:** only the Backend may return it, and only when the scope and
  current Lead/assignment are valid, the bound challenge is pending,
  unexpired, and token-valid, the QR signal is `MATCH`, an active Building
  geospatial policy exists, and a fresh/usable/accurate device observation
  produces `INSIDE`.
- **Terminal result vocabulary** remains CR-HM-07 PART 04, with one primary
  reason:

| Status | Reasons |
|---|---|
| `VERIFIED` | `ALL_POSITIVE_EVIDENCE` |
| `FAILED` | `QR_MISMATCH`, `GEOFENCE_OUTSIDE`, `ACTOR_ASSIGNMENT_INVALID` |
| `MANUAL_REVIEW_REQUIRED` | `QR_UNKNOWN`, `QR_INACTIVE`, `NO_GEOSPATIAL_POLICY`, `LOW_ACCURACY`, `GEOFENCE_UNAVAILABLE` |
| `EXPIRED` | `CHALLENGE_EXPIRED` |

The existing evaluation POST returns a successful `200` result envelope for
these terminal statuses. Authentication, authorization, malformed input,
unknown challenge, and non-`AUTHORIZED` scope failures remain errors, not
client-selected terminal results. `ARRIVAL VERIFIED` is only an arrival fact;
it does not check in a worker, start work, record attendance or billable time,
or create a work session.

## 6. Expiry, replay, and idempotency

- Challenge TTL is the existing fixed **120 seconds**, set from the database
  server clock. Caller-supplied TTL and client clocks never extend it.
  `expiresAt` is authoritative; a stale pending row is projected to `EXPIRED`
  by Backend before a replacement is issued.
- Frozen PART 04 semantics require an expired challenge submitted for
  evaluation to produce `EXPIRED / CHALLENGE_EXPIRED` once, then replay that
  stored result. The pre-projected-expiry runtime mismatch in §1 is a known
  gap; the next runtime part must close it without permitting a second result
  or any `VERIFIED` outcome.
- At most one `PENDING` challenge exists for each
  `(executionScopeId, actorUserId)`. A repeated issue request while one is
  live returns `409 HANDYMAN_ARRIVAL_CHALLENGE_LIVE_CONFLICT`; it must not
  create another challenge or return the existing token again.
- Issuance has **no idempotency key** in this minimum contract. Because raw
  token material is not persisted, a caller that loses the `201` response
  cannot recover that token. It must not automatically retry issuance; wait
  until the 120-second TTL (plus transport safety margin) and request a new
  challenge. Reusing the same token is not a renewal.
- Evaluation is idempotent by the binding `(executionScopeId, authenticated
  actor, challengeToken)`, not by a caller-supplied idempotency header. The
  first terminal evaluation atomically consumes or expires the challenge and
  writes one immutable result. A retry by that same challenge actor returns
  the exact stored result; it is a replay of the Backend result, not a new
  arrival decision. It does not re-read signals, change the decision, consume
  again, or create another result. A different actor or token cannot replay it.
- A terminal `FAILED`, `MANUAL_REVIEW_REQUIRED`, or `EXPIRED` result cannot
  be overwritten or upgraded by retrying with different QR/GPS signals. A
  new attempt requires a new server-issued challenge. Invalid, wrong-scope,
  wrong-actor, or unissued tokens never produce `VERIFIED`.

## 7. Scope firewall and implementation gate

This contract introduces no Customer Care, Admin, FM, SaaS, payment,
attendance, work-session, or arrival-location registry surface. It does not
change the existing QR registry, geospatial-policy authority, immutable
expected-location snapshot, Dispatcher/CR-HM-04 assignment boundary, or
BE02/BE03 Lead-read DTOs. `docs/api/openapi.yaml` is not amended until the
challenge route is separately implemented and registered; this file is a
governance/contract artifact only.

## 8. Next parts

A separately authorized runtime part may add only the thin challenge-issue
route and safe response projection over the existing challenge service, with
focused auth/expiry/live-conflict/response-leakage tests. Existing arrival
evaluation remains the sole decision path. Publish the new OpenAPI operation
only when that runtime route is registered. Lead Mobile consumption is a
separate client part; it may display Backend results but may not author them.

## Sources reviewed

- `docs/handyman/CR-HM-07_FINAL_CERTIFICATION.md`
- `docs/handyman/CR-HM-07_PART03_LOCATION_SIGNAL_GOVERNANCE.md`
- `docs/handyman/CR-HM-07_PART04_ARRIVAL_RESULT_GOVERNANCE.md`
- `src/modules/handyman-arrival-challenges/handyman-arrival-challenge.service.ts`
- `src/modules/handyman-arrival-challenges/handyman-arrival-challenge.repository.ts`
- `src/modules/handyman-arrival-locations/handyman-arrival-location.service.ts`
- `src/modules/handyman-geospatial-policies/handyman-geospatial-policy.service.ts`
- `src/modules/handyman-arrival-results/handyman-arrival-result.service.ts`
- `src/modules/handyman-arrival-verification-api/handyman-arrival-verification-api.routes.ts`
- `src/modules/handyman-arrival-verification-api/handyman-arrival-verification-api.controller.ts`
- `src/modules/handyman-arrival-verification-api/handyman-arrival-verification-api.validation.ts`
- `docs/api/openapi.yaml` (registered arrival-evaluation operation only)
