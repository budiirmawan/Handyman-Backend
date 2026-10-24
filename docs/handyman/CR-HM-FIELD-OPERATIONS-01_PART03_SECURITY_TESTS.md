# CR-HM-FIELD-OPERATIONS-01 — PART 03: PROPOSED SECURITY TESTS

- Status: **APPROVED BY CR OWNER 2026-10-24 — still a TEST PLAN, NOT IMPLEMENTED.**
  This document adds no test file and executes nothing; the cases below are the
  PART 04 acceptance contract (gate §8 approval, §9 conditions AC-1…AC-10).
- To be implemented as `tests/handyman-arrival-configuration-part04.test.ts`
  (G-2 + G-3, new file) and as **additive cases** inside the existing
  `tests/handyman-arrival-verification-api.test.ts` / `-evaluation.test.ts`
  (G-4 — no duplicate suite).
- Harness rules (mandatory, same as PART 02): own disposable embedded
  PostgreSQL cluster, real migrations `0396`–`0400` + `0398`/`0399`, no
  external database, **zero silent skips** — a case that cannot run FAILS, it
  does not `t.skip()`. `NODE_ENV=test`, `--test-concurrency=1`.

Legend: **A** = authenticated, **P** = permission held, **B** = ACTIVE
exact-Building assignment, **C** = same Client, **S** = same-Client sibling
Building, **X** = cross Client.

---

## 1. G-2 — QR registration / list / deactivation

### 1.1 Positive authority

| # | Case | Setup | Expected |
| --- | --- | --- | --- |
| G2-01 | Register at Building level | A P B, chain `{}` | `201`; `opaqueCode` present once; row `ACTIVE`; `opaque_code_hash = sha256(value)`; **no row** stores the raw value |
| G2-02 | Register at the deepest level | chain floor→area→room→space of the Building | `201`; persisted chain equals the submitted chain exactly |
| G2-03 | List omits secrets | after G2-01 | `200`; every item has **no** `opaqueCode` and **no** hash key (assert `Object.keys`) ; `status`/chain visible |
| G2-04 | Deactivate | after G2-01 | `200`, `status = 'INACTIVE'`; re-list shows INACTIVE; later scan resolves `INACTIVE` (→ `MANUAL_REVIEW_REQUIRED`), never `VERIFIED` |
| G2-05 | Deactivate is idempotent | repeat G2-04 | `200` with the same INACTIVE projection (no second row, no error) |
| G2-06 | Operator can configure a Building it does not work in | A P B, no crew assignment at all | `201` — configuration is NOT a field capability |

### 1.2 Denial matrix

| # | Case | Expected |
| --- | --- | --- |
| G2-10 | No session | `401` (before any DB read) |
| G2-11 | A, **no** `building_configuration.manage` | `403` permission denial; zero rows created |
| G2-12 | A P, **same-Client sibling** Building (S) | `403 BUILDING_ACCESS_DENIED`; zero rows created |
| G2-13 | A P, **cross-Client** Building (X) | `403 BUILDING_ACCESS_DENIED` |
| G2-14 | A P, no Building assignment at all | `403 BUILDING_ACCESS_DENIED` |
| G2-15 | A with **`building_configuration.read` only** | `403` on register and deactivate; `200` on list |
| G2-16 | **Worker self-authorization** — the scope's CURRENT Crew Lead (happy assignment, no privileged permission) registers a QR for its own Building | `403`; **no** identifier exists afterwards; assert the worker still cannot influence its own arrival evidence |
| G2-17 | Inspector / helper / Tenant PIC attempt | `403` (helper: `401` — no login) |
| G2-18 | Corrupt chain: `roomId` without `areaId`; `areaId` without `floorId`; `spaceId` without `roomId` | `400 HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_VALIDATION` with the exact field detail |
| G2-19 | Foreign-link chain: floor of **another** Building; area/room/space from a sibling Building | `400` validation; zero rows |
| G2-20 | Inactive building / unknown building / malformed UUID | `400`; zero rows |
| G2-21 | Deactivate a foreign or unknown `identifierId` | `404 HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_NOT_FOUND` (non-enumerating shape identical for both) |
| G2-22 | Authority smuggling: send `id`, `clientId`, `status:'INACTIVE'`, `opaqueCode`, `opaqueCodeHash` | `201` for the valid chain; stored row ignores every smuggled key (server-derived id/client/status/hash, `ACTIVE`) |
| G2-23 | Delete/immutability | no handler exposes DELETE; assert DELETE attempt on a live identifier is refused by the existing 0398 trigger path (no new requirement) and that the HTTP surface has no such route |

### 1.3 Firewall

| # | Case | Expected |
| --- | --- | --- |
| G2-30 | Register then immediately evaluate an arrival | registration created **no** result row, consumed **no** challenge, emitted only `HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_CREATED` |
| G2-31 | Deactivate during a live PENDING challenge | challenge untouched (`PENDING`, `consumed_at IS NULL`); a later scan yields `INACTIVE` |
| G2-32 | No cross-domain writes | `work_orders`, `bast_documents`, `payments`, work-session and attendance row counts unchanged across G-2 operations |

---

## 2. G-3 — Building geofence policy configure / read / history

### 2.1 Positive authority + bounds

| # | Case | Expected |
| --- | --- | --- |
| G3-01 | First `PUT` | `200`; one `ACTIVE` row; `HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED` journalled; `effectiveFrom` defaults to server time |
| G3-02 | Replace | `200`; **exactly one** `ACTIVE` (0399 index); old row `INACTIVE`; `REPLACED` + `CREATED` journalled; total rows = 2 |
| G3-03 | History read | `200`; both rows, newest-first; retired row retains its original values (never overwritten) |
| G3-04 | `GET` active | `200`; equals the newest row; no `clientId`/`createdByUserId` leakage beyond the proposed schema |
| G3-05 | Unconfigured Building | `404 HANDYMAN_BUILDING_GEOSPATIAL_POLICY_NOT_FOUND` — and this 404 is returned **before** row-based authorization so a foreign caller cannot distinguish states |
| G3-06 | Boundary values accepted | lat ±90, lng ±180, radius/accuracy just above 0, freshness `1` |
| G3-07 | Re-validation after replacement | the evaluator uses the NEW policy immediately; an old `effectiveFrom` does not resurrect the retired row |

### 2.2 Denial matrix (bounds + RBAC + scope)

| # | Case | Expected |
| --- | --- | --- |
| G3-10 | lat `91`/`-91`, lng `181`, radius `0`/`-5`, accuracy `0`, freshness `0`/`1.5`/`'x'`, `effectiveFrom:'nope'` | `400 HANDYMAN_BUILDING_GEOSPATIAL_POLICY_VALIDATION`, one detail per offending field; **no mutation** |
| G3-11 | Validation **and** authorization both fail (foreign Building + bad radius) | `400` first — proves ordering is preserved (documented behaviour, unchanged) |
| G3-12 | No session | `401` |
| G3-13 | A, no `building_configuration.manage` | `403`; no policy row created or retired |
| G3-14 | Same-Client sibling Building (S) | `403 BUILDING_ACCESS_DENIED`; **the victim Building's ACTIVE policy is byte-for-byte unchanged** (regression case for the SEC-02 PART 05 finding E-latent) |
| G3-15 | Cross-Client (X) | `403 BUILDING_ACCESS_DENIED` |
| G3-16 | `read`-only caller attempts `PUT` | `403`; `GET`/history still `200` |
| G3-17 | **Worker self-authorization** — CURRENT Crew Lead sets the geofence for its own Building | `403`; prior policy (or absence) unchanged; then assert the Lead still cannot achieve `VERIFIED` by any configuration route |
| G3-18 | Authority smuggling: `buildingId` in body ≠ URL, `clientId`, `status:'ACTIVE'`, `createdByUserId`, `policyId`, `distanceMeters`, `geofenceSignal` | `200` for the URL Building; every smuggled key ignored; stored `client_id` is the Building's real client |

### 2.3 Firewall

| # | Case | Expected |
| --- | --- | --- |
| G3-30 | `PUT` policy | no arrival result row, no challenge consume, no work session, no `CHECK_IN`, no payment/BAST/FM row |
| G3-31 | Provider isolation | zero network/API.CO.ID calls during configure/read (evaluator writes enrichment `NULL`; unchanged) |
| G3-32 | Signal-only proof | with a fresh policy but **no** VERIFIED evaluation, `arrivalVerified` remains `false` and the GET projection shows no result |

---

## 3. G-4 — Superseded challenge refusal

Implemented as extra cases on the existing terminal-command suites.

| # | Case | Expected |
| --- | --- | --- |
| G4-01 | Lead issues challenge → Operations reassigns → **superseded Lead** submits the old token | `409 HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED`; **no** result row; challenge still `PENDING` with `consumed_at IS NULL` |
| G4-02 | The **replacement** Lead submits the superseded token | `409` (same code — the token is dead regardless of who holds it); no result row |
| G4-03 | Replacement Lead issues its own challenge | `201`; evaluates to a normal terminal outcome (`VERIFIED` when QR+geofence positive) |
| G4-04 | Replay after a recorded result | replay still returns the **existing** result unchanged (`200`, same `id`/`status`), i.e. the guard never breaks idempotency |
| G4-05 | Different actor, **still-ACTIVE** assignment (no reassignment) | unchanged certified behaviour: `200 FAILED / ACTOR_ASSIGNMENT_INVALID` — proves D-7 (guard is not a blanket replacement) |
| G4-06 | Expired token on a superseded assignment | whichever precedence is approved at the gate is pinned explicitly (proposal: `409 SUPERSEDED` wins, since binding death precedes TTL); assert **exactly one** of the two and no result row |
| G4-07 | Scope with **no** ACTIVE assignment (e.g. all superseded) | `409 SUPERSEDED`; no result row |
| G4-08 | Concurrent double-submit of the superseded token | one `409`, one deterministic outcome, **zero** result rows, **zero** consumes (no partial state) |
| G4-09 | Post-refusal TTL | the untouched challenge later projects `EXPIRED`; a retry after TTL is still refused identically (no resurrection) |
| G4-10 | Cross-scope token reuse | superseded check cannot be bypassed by pointing the URL at another scope (`404`/`409` per existing binding rules; never a result row) |

---

## 4. Contract & regression gates (apply at implementation)

| # | Gate | Expected |
| --- | --- | --- |
| CT-01 | Runtime ↔ OpenAPI parity | `294/294` Handyman operations, zero undocumented, zero phantom |
| CT-02 | Operation ids | unique, no duplicate; `x-required-permission` present on all six new operations |
| CT-03 | Error vocabulary | the six new operations declare only codes that exist in `ERROR_CODES`; G-4's new code is declared on the terminal command |
| CT-04 | Frozen-surface guard | `handyman-arrival-verification-api` still imports no challenge/geofence/QR authority (PART 04C invariant) — the new module owns configuration |
| CT-05 | Zero migration | `src/database/migrations/` diff is empty for this PART |
| CT-06 | PR #58 firewall | `handyman-notification-producer-part01` + `-certification` remain green (3/3, 7/7) |
| CT-07 | PART 02 regression | `handyman-field-ops-ack-part02` 9/9 green; challenge issuance unchanged |

---

## 5. Acceptance criteria for "implemented"

1. All 25 primary cases (G2-01…G2-32, G3-01…G3-32, G4-01…G4-10 — 41 assertions
   across 25 numbered groups) pass with **0 failures and 0 skips**.
2. `npx tsc --noEmit` clean.
3. CT-01…CT-07 green.
4. No migration, no permission seed change (Option A), no Notification Engine
   change, and an empty diff under `src/modules/handyman-arrival-{challenges,
   locations,results}/**` except the single G-4 guard file.
