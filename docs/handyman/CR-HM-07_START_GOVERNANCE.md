# CR-HM-07 — START GOVERNANCE (Arrival & Location Verification)

**Status: DRAFT GOVERNANCE, base `5404505`, 2026-09-28.** Docs-only:
NO code, NO migration, NO tests, NO OpenAPI, NO roadmap change.
Sources read (exclusive list, no broad repo scan):

1. frozen roadmap CR-HM-07 row + dependency matrix row (verbatim);
2. `CR-HM-06_PART06_DOWNSTREAM_BINDING_CONTRACT.md` (FROZEN §1–§12);
3. CR-HM-06 Execution Scope public model (`handyman-execution-scope.types.ts`,
   bounded read `getHandymanExecutionScopeByQuotationVersion`);
4. `CR-HM-05_PART05_TARGET_BINDING_CONTRACT.md` (FROZEN §7/§8/§10);
5. `CR-HM-04_PART04_ASSIGNMENT_BOUNDARY.md` (FROZEN §0–§10) +
   CR-HM-04 worker-context public shape (F5 helper/userId semantics);
6. Directly relevant existing patterns only: unit-access readiness F6
   (explicitly NOT QR/geofence/arrival proof), attendance QR exclusions,
   and the CMMS `mobile-qr-resolution` read-model contract (BE-25F).

## Frozen tokens

| Token | Value |
|---|---|
| ARRIVAL_TARGET_TYPE | HANDYMAN_EXECUTION_SCOPE |
| ARRIVAL_TARGET_ID | executionScopeId |
| SCOPE_STATE_REQUIRED | AUTHORIZED |
| EXPECTED_LOCATION_AUTHORITY | EXECUTION_SCOPE_SNAPSHOT |
| QR_ROLE | LOCATION_SIGNAL |
| GPS_ROLE | RISK_SIGNAL_NOT_PROOF |
| CHALLENGE_AUTHORITY | SERVER |
| VERIFIED_REQUIRES_ACTOR | CR_HM_04_ASSIGNED_LEAD |
| IMPLEMENTABILITY | BLOCKED_ON_CR_HM_04_ASSIGNMENT |
| CR_HM_05_SCHEDULING_REQUIRED | NO |
| ARRIVAL_VERIFIED_IMPLIES | NOT_CHECK_IN_NOT_WORK |

## A. TARGET

Arrival verification targets exactly one **CR-HM-06 Execution Scope**:
`targetType=HANDYMAN_EXECUTION_SCOPE`, `targetId=executionScopeId`
(PART 06 §1/§11 `CR_HM_07_ARRIVAL_TARGET=DEFINED_NOT_IMPLEMENTED` —
this CR implements it). Preconditions: the scope row EXISTS and
`scope.status='AUTHORIZED'`; the binding caller belongs to the same
Client; lineage intact (PART 06 §2). **NO FM work_order target ever**
(PART 06 §10; CR-HM-04 PART 04 §10; roadmap matrix).

## B. PURPOSE

Verification proves an **authorized field actor** presented at the
**expected execution location** for the **authorized scope**. Three
independent authorities must agree: identity (who), place (where),
entitlement (which scope). **Execution Scope existence alone !=
verified arrival** (PART 06 §5 verbatim); AUTHORIZED != scheduled !=
assigned != arrived != started.

## C. EXPECTED LOCATION AUTHORITY

Expected location is resolved **server-side only** from the immutable
Execution Scope authority snapshot + request lineage (0395 trigger;
PART 06 §5/§8): `buildingId` + nullable `floorId`/`areaId`/`roomId`/
`spaceId`. Caller-supplied location values, QR claims, GPS, crew,
provider, or FM data can never replace expected location; they may
only be evaluated AGAINST it.

## D. ACTOR AUTHORITY

Existing CR-HM-04 model provides: provider context (ACTIVE), workers
(worker contexts over `workforce_profiles`; `userId` NULLABLE —
helpers need no individual login, F5), crews, memberships, and the
append-only Lead history (exactly one current Lead = ACTIVE member
with ACTIVE worker context + non-null `userId`; PART 04 §4). A Lead
therefore has a login-capable authenticated-user identity for backend
actor authority; helpers DO NOT.

**Expected model (frozen):** verification is authored by the
**assigned crew's current Lead** — the single login-capable field
actor bound to the scope by CR-HM-04's assignment binding once
activated; helpers appear only as crew context, never as
verification-authors. Caller workerId/crewId is NEVER trusted (same
rule as CR-HM-04 F9: the actor is an authenticated local session
user; server resolves Lead-of-assigned-crew from that session's
`userId`).

**Blocker (explicit):** ZERO assignment runtime exists today
(CR-HM-04 PART 04 STOP RULE froze contract-shape-only; PART 06 §11
marks `CR_HM_04_ASSIGNMENT_TARGET=ACTIVATABLE` — not implemented).
No server authority can currently answer "which crew/Lead is bound
to this executionScopeId". Inventing a substitute actor path
(any client-authenticated user / BM actor / caller-declared crew)
would violate §B entitlement authority. See §N.

## E. LOCATION PROOF MODEL (layered)

Frozen layered semantics, in authority order:

1. **Target authority**: exact `executionScopeId` exists, AUTHORIZED,
   same-Client (server).
2. **Actor authority**: session user resolves to the authorized field
   actor for that scope (server; §D).
3. **Expected location**: immutable scope snapshot (server; §C).
4. **Challenge**: server-issued short-lived single-use challenge
   (§F) proving fresh presence, not replayed history.
5. **Location signal**: QR/location identifier resolution (§G) —
   corroborating matches to expected chain links (building; finest
   granularity available), never standalone proof.
6. **Risk signals**: geofence/device-signal evaluation (§H) — can
   downgrade confidence or fail verification, never substitute for
   expected location.

A result is VERIFIED only when 1–4 hold and the location signal set
is consistent with the expected chain; risk signals shape
confidence/flags. **Raw GPS coordinates are NEVER sole proof.**

## F. CHALLENGE

Server-authoritative consumption model (existing repository
conventions only: handoff exchange-token pattern in CR-HM-01 —
single-use, TTL, hashed-at-rest):

- **Creation authority**: backend only, bound at issue time to
  `(clientId, executionScopeId, actorUserId)`; the raw value is
  returned exactly once to the actor's channel; only its HASH is
  stored (precedent: CR-HM-01 handoff exchange tokens).
- **TTL**: short-lived (bounded minutes, e.g. the 120s-class
  precedent); expiry is server-clock evaluated.
- **Replay protection**: strictly single-use (consumed once per
  challenge); a consumed/expired challenge can never verify.
- **Scope binding**: challenge is for exactly one
  `(executionScopeId, actorUserId)`; cross-scope or cross-actor use
  fails closed to the same generic failure (non-enumerating).
- **Semantics**: `PENDING` (issued) → `CONSUMED` (verified/failed
  against) or `EXPIRED` (server TLL pass); no partial credit.

## G. QR

No Handyman location-QR runtime exists today: unit-access readiness is
explicitly NOT QR/geofence/arrival proof (CR-HM-05 F6); attendance
modules exclude QR attendance; the CMMS `mobile-qr-resolution`
(BE-25F) is an **asset-identifier read-model resolver** (ASSET targets
+ building/functional-location context, no workflow authority), and
FM patrol/checkpoint modules are FM security semantics.

Frozen ruling:

- QR = **opaque location identifier / presence signal** whose scan
  value is never trusted verbatim: the server resolves the scanned
  identifier to an authoritative location identity (pattern: the
  existing identifier → location-context resolution seam, consumed
  identifier-only) and compares it against the expected snapshot chain.
- **No static QR alone may mark arrival VERIFIED** (roadmap:
  QR != proof). A QR match without challenge/actor/scope agreement
  yields nothing (enqueued signal at most).
- **Never** adopt FM patrol/checkpoint semantics, FM patrol routes,
  FM security checklists, or FM QR attendances flows as Handyman
  arrival authority (roadmap + PART 06 firewalls).

## H. GEOFENCE / RISK

Geofence is a **verification-confidence/risk signal only**. Frozen
behavior:

- GPS unavailable / permission denied → geofence signal ABSENT; the
  geofence does NOT fabricate coordinates (NO silent fabrication ever);
  verification may still proceed on challenge + QR + authority layers,
  with risk flag `GEOFENCE_UNAVAILABLE` recorded.
- Outside threshold → contributes `GEOFENCE_OUTSIDE_THRESHOLD` flag;
  policy may downgrade or fail the verification (bounded, documented
  threshold), never silently ignore.
- Low accuracy → `GEOFENCE_LOW_ACCURACY` flag; accuracy metadata is
  persisted verbatim with the device-supplied reading.
- Raw coordinates are stored as observed-signal evidence only; they
  define nothing about expected location.

## I. RESULT MODEL

Bounded evidence-backed lifecycle, no work semantics:

```
PENDING  → challenge issued / verification awaited (transient)
VERIFIED → all authority layers + fresh challenge + consistent
           location signal (terminal per attempt; append-only fact)
FAILED   → authority failure / signal contradiction / threshold
           rejection (terminal per attempt; reason-coded)
EXPIRED  → challenge TTL elapsed without submission (terminal)
```

No CHECK-IN / START WORK / PAUSE / COMPLETE semantics — those belong
exclusively to CR-HM-08 (roadmap CR-HM-08 row; PART 06 §6). Retry is a
NEW attempt (new challenge), never mutation of a terminal result.

## J. IDEMPOTENCY / REPLAY

- Exactly **one authoritative result row per attempt** (challenge);
  concurrent verification of the same challenge fails closed (lock +
  unique result key per challenge id).
- Duplicate submission of the same challenge after consumption returns
  the existing terminal result (replay-shaped), never a second fact.
- MERE technical retry (header idempotency key, existing convention)
  is honored at the HTTP layer like CR-HM-06 decision; challenge
  single-use remains authoritative underneath.
- Multiple sequential attempts (new challenges) are independent;
  "current arrival state" of a scope equals its LATEST terminal VERified
  fact — only if §L handoff later defines one.

## K. AUDIT / EVIDENCE

Authoritative persisted verification facts (bounded): scope id;
actor (session user + resolved Lead binding); expected location
snapshot chain (verbatim); observed signals (QR identifier
reference, geofence reading + accuracy metadata, absence flags);
challenge id (hash only); result + reason/risk metadata; server
timestamps; consuming request lineage. `operational_events` remains
**audit-only journal** (never state authority; deterministic
`event_type`/`entity_id` resolution per the carried observation in
CR-HM-06 §15).

## L. DOWNSTREAM (CR-HM-08 HANDOFF)

A VERIFIED arrival fact MAY become prerequisite/input for CR-HM-08's
presence model (policy choice owned by CR-HM-08, not decided here):
**Arrival VERIFIED != work started; Arrival VERIFIED != attendance;
Arrival VERIFIED != billable time** (roadmap: Presence != Work !=
Billable; Arrival Verification != CHECK-IN). No hand-off runtime is
implemented in CR-HM-07 beyond publishing immutable result facts.

## M. FIREWALLS (frozen for CR-HM-07)

NO: FM work order/reuse/conversion; FM patrol/checkpoint semantics;
work session / CHECK-IN / START WORK (CR-HM-08); attendance/payroll;
billing/payment/settlement (CR-HM-13); BAST (CR-HM-11); crew
assignment implementation (CR-HM-04); scheduling implementation
(CR-HM-05); biometric or face-recognition proof; caller-authoritative
worker/crew/location/coordinates.

## N. DEPENDENCY DECISIONS (explicit answers)

**N1 — Can CR-HM-07 be implemented NOW using existing authoritative
assignment/actor data?**
**NO.** Actor data exists (Lead userId semantics, F5 helper rule) but
the **scope-binding does not**: zero assignment runtime/data ties any
crew/Lead to any `executionScopeId` (CR-HM-04 PART 04 STOP RULE;
PART 06 §11 ACTIVATABLE ≠ implemented). §D's actor gate therefore has
no lawful source today.

**N2 — Must CR-HM-04 Execution Scope crew-assignment binding be
activated first?**
**YES — structural blocker.** Only CR-HM-04 may implement assignment
(provider-authored; PART 06 §3). The smallest lawful activation is
CR-HM-04's own contract §3/§4 against
`targetType=HANDYMAN_EXECUTION_SCOPE` + §2 eligibility; CR-HM-07 must
NOT invent a crew-assignment runtime (mandate D; PART 06 §4).

**N3 — Does CR-HM-05 scheduling binding need activation before
arrival?**
**NO.** Expected location + target authority + actor entitlement are
fully derivable from scope + assignment; arrival asserts
place/identity/entitlement, not time. A CR-HM-05 schedule binding MAY
later feed CR-HM-07's risk/confidence layer (arrival-time vs scheduled
window) when activated — optional corroboration, never a precondition
(PART 06 §4/§5; CR-HM-05 PART 05 §8 keeps arrival exclusively
CR-HM-07's).

**OUTCOME: IMPLEMENTATION_BLOCKED=YES** (sole blocker: CR-HM-04
assignment-binding activation against `HANDYMAN_EXECUTION_SCOPE`).
Lawful takeover order: CR-HM-04 binding PART → CR-HM-07 PART 01.
No workaround is invented.

## O. PART PLAN

None proposed — conditional on implementation being unblocked
(mandate O), and §N resolves BLOCKED. On CR-HM-04 activation, the
smallest CR-HM-06-era-style internal sequence (advisory, subject to a
Decision Freeze): 01 challenge issuance semantics + expected-location
resolver; 02 layered verification + result model; 03 idempotency/audit
+ OpenAPI exposure. No top-level roadmap change is made or implied.

## Questions (governance status)

No unresolved authority. The only open item is the activation
dependency (§N2), which is an explicit roadmap-order decision, not an
authority conflict. This governance is **not BLOCKED_FOR_DECISION**
as a document; the CR-HM-07 **implementation** is blocked until
CR-HM-04's assignment binding lands.

---
*This document freezes governance mapping only. Any runtime/migration/
test/OpenAPI work requires explicit subsequent PARTs and a prior
CR-HM-04 assignment-binding activation.*
