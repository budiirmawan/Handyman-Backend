# CR-HM-FIELD-OPERATIONS-01 — PART 04: IMPLEMENTATION GOVERNANCE RECORD

- **Status: IMPLEMENTED — FINAL REVIEW PASSED (source certification).**
  See `CR-HM-FIELD-OPERATIONS-01_FINAL_REVIEW.md` for the PART 01–04
  certification, the reconciliation record and the GO/NO-GO position.
- Baseline: `eed1225` (PART 03 sign-off gate, SIGNED). Branch:
  `arena/a61abf59-handyman-backend`.
- Authority to implement: `CR-HM-FIELD-OPERATIONS-01_PART03_SIGNOFF_GATE.md` §8
  (SG-1 APPROVED, SG-2 OPTION A, SG-3 OPTION A, SG-4 OPTION A, SG-5 APPROVED,
  SG-6 APPROVED) and §9 (binding conditions AC-1…AC-10). **No further approval
  was requested or required for this PART.**
- Scope actually implemented: **G-2** QR registry (3 operations), **G-3**
  per-Building geofence policy (3 operations), **G-4** superseded-challenge
  refusal (0 new operations, 1 new bounded refusal).
- Date: 2026-10-24 (Asia/Jakarta).
- Migrations: **ZERO**. New permission codes: **ZERO**. New roles/personas:
  **ZERO**. Notification Engine (PR #58) / migration `0476`: **untouched**.

---

## 1. Delivered surface

| # | Operation | Permission (`x-required-permission`) | Success | Journal |
| --- | --- | --- | --- | --- |
| 1 | `POST /handyman/buildings/{buildingId}/arrival-location-identifiers` | `building_configuration.manage` | `201` (opaque value returned **once**) | `HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_CREATED` |
| 2 | `GET /handyman/buildings/{buildingId}/arrival-location-identifiers` (`?status=ACTIVE\|INACTIVE`) | `building_configuration.read` | `200` (no value, no hash) | none (read) |
| 3 | `POST /handyman/buildings/{buildingId}/arrival-location-identifiers/{identifierId}/deactivate` | `building_configuration.manage` | `200` (`INACTIVE`, idempotent replay) | `HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_DEACTIVATED` |
| 4 | `PUT /handyman/buildings/{buildingId}/geofence-policy` | `building_configuration.manage` | `200` | `…_POLICY_CREATED` / `…_POLICY_REPLACED` |
| 5 | `GET /handyman/buildings/{buildingId}/geofence-policy` | `building_configuration.read` | `200` / `404` when unconfigured | none (read) |
| 6 | `GET /handyman/buildings/{buildingId}/geofence-policy/history` | `building_configuration.read` | `200` (newest first, retired rows unchanged) | none (read) |

G-4 modifies **no** route: the existing
`POST /handyman/execution-scopes/{executionScopeId}/arrival-verification` gains
one refusal, documented in its description and `x-error-codes`.

### 1.1 Contract arithmetic

| Metric | Baseline `eed1225` | After PART 04 |
| --- | --- | --- |
| OpenAPI operations (total) | 2037 | **2043** |
| Handyman operations | 288 | **294** |
| Runtime routes | 2037 | **2043** |
| Undocumented runtime operations | 0 | **0** |
| Phantom documented operations | 0 | **0** |
| Broken local `$ref`s | 0 | **0** |

Verified by the shared census helper
(`tests/helpers/openapi-census.ts`) — the same extractor the freeze-03 guard
uses, so documentation and runtime cannot drift.

### 1.2 Error vocabulary added (2 codes, both required by the approval)

| Code | Status | Why it exists | Frozen text |
| --- | --- | --- | --- |
| `HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED` | `409` | SG-3 **Option A** — the approved refusal for a new attempt against a challenge bound to an assignment Operations has since superseded | narrows `CR-HM-07_FINAL_CERTIFICATION` RESULT invariant (§8) — see §4 annex |
| `HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CONFLICT` | `409` | Defensive backstop only: the per-Building `FOR UPDATE` lock makes a concurrent double-ACTIVE write impossible in normal operation, so the unique-violation mapping exists so a race can never surface as `500` or as a second ACTIVE policy | none (new surface, G-3) |

No other code was introduced. The G-2/G-3 validation/not-found/forbidden
refusals reuse `VALIDATION_ERROR`, `HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_VALIDATION`,
`HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_NOT_FOUND`,
`HANDYMAN_BUILDING_GEOSPATIAL_POLICY_VALIDATION`,
`HANDYMAN_BUILDING_GEOSPATIAL_POLICY_NOT_FOUND` and `BUILDING_ACCESS_DENIED`.

---

## 2. Where the authority lives (no duplication)

| Concern | Authority | HTTP layer role |
| --- | --- | --- |
| Building hierarchy chain validation | `handyman-arrival-locations` (`createHandymanArrivalLocationIdentifier`) | whitelist parse only |
| Opaque value generation + hash at rest | `handyman-arrival-locations` (`generateSessionToken` / `hashSessionToken`) | forwards nothing secret |
| Policy bounds (`lat/lng/radius/accuracy/freshness`) | `handyman-geospatial-policies` (`validatePolicyValues`) | type check only |
| History-preserving replacement | `handyman-geospatial-policies` (retire → insert in one transaction) | none |
| Exact-Building authorization (BE-02G) | `assertBuildingScopedResourceAccess` inside the services | **none** — no RBAC-as-scope shortcut |
| Verdict / consume / TTL | `handyman-arrival-results` + `handyman-arrival-challenges` | none |

`src/modules/handyman-arrival-configuration/` is a **thin HTTP shell**
(validation + controller + routes + types). `CT-04` asserts mechanically that the
controller contains no policy maths, no hashing, no verdict/geofence token, no
SQL transaction and only delegates to the pre-existing service functions. No
second authority, no duplicated module.

---

## 3. Acceptance-criteria evidence (AC-1…AC-10)

`tests/handyman-arrival-configuration-part04.test.ts` — **24 tests, 0 failures,
0 skips**, real migrated PostgreSQL, `--test-concurrency=1`.

| AC | Condition | Cases | Result |
| --- | --- | --- | --- |
| AC-1 | Exact-Building RBAC on every G-2/G-3 operation; sibling-Building manager refused | G2-12, G2-13, G2-14, G3-14, G3-15 | PASS — `403 BUILDING_ACCESS_DENIED`, and G3-14 additionally proves the victim Building's ACTIVE policy and its history row count are byte-identical after the attempt |
| AC-2 | Audit preserved; history readable and never overwritten; DELETE blocked | G2-04, G2-05, G3-01, G3-02, G3-03, G2-23 | PASS — journal deltas asserted per operation; retired policy keeps its original radius; `DELETE` on the registry is a `404` |
| AC-3 | No field worker can manage configuration (self-evidence prohibition) | G2-16, G2-17, G3-17 | PASS — the scope's **current Crew Lead** is refused `403` and creates zero identifiers/policies; a read-only caller is refused every write |
| AC-4 | Secret handling: opaque value once; list/deactivate never leak value or hash | G2-01, G2-03, G2-21, G2-22 | PASS — only `sha256(value)` at rest, the raw value matches no stored column, the list response contains neither value nor hash nor `clientId` |
| AC-5 | G-4 before TTL, no consume, no result row | G4-01, G4-02, G4-06, G4-07 | PASS — `409 HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED`; challenge stays `PENDING`, `consumed_at` stays `NULL`, zero result rows; a pre-expired PENDING challenge still returns SUPERSEDED (SG-4 Option A ordering) |
| AC-6 | Idempotent replay preserved | G4-04, G2-05 | PASS — replay returns the same immutable result (same `id`, `status`, `evaluatedAt`), exactly one row; repeated deactivation is the same `INACTIVE` projection with one journal entry |
| AC-7 | Still-ACTIVE assignment keeps certified `FAILED / ACTOR_ASSIGNMENT_INVALID` | G4-05 | PASS — proven with a **Lead transfer inside the same ACTIVE assignment** (the only remaining path to that verdict after G-4), plus the unchanged generic refusal for a token bound to another actor |
| AC-8 | Dated certification annex for `CR-HM-07_FINAL_CERTIFICATION` §8 | §4 below + `CR-HM-07_FINAL_CERTIFICATION.md` appendix | PASS |
| AC-9 | No new role/persona/permission code/seed change; no migration | CT-05, CT-06, CT-07, CT-01 | PASS — `git diff eed1225 -- src/database/migrations` is empty; the two permission codes named are pre-existing seed entries; notification modules untouched |
| AC-10 | CR-HM-07 firewall intact | G2-30, G2-31, G2-32, G3-30, G3-31, G3-32 | PASS — configuration creates no verdict, consumes no challenge, starts no work, writes no enrichment, and leaves `work_orders` unchanged |

### 3.1 Security-matrix coverage

| Group | Cases | Summary |
| --- | --- | --- |
| G2-01…G2-06 | registration, deactivation, non-field capability | value once, hash at rest, deepest chain, audited one-way deactivation |
| G2-10…G2-17 | authentication, RBAC, exact-Building, cross-Client, sibling, bystander, worker | every denial is bounded and mutation-free |
| G2-18…G2-23 | chain/hierarchy validation, foreign links, unknown/malformed Building, non-enumerating 404, no DELETE | no row on rejection; mismatched identifier shares the unknown-identifier shape |
| G2-30…G2-32 | firewall | zero verdict, zero consume, no cross-domain writes |
| G3-01…G3-07 | create, replace, history, active read, boundaries, evaluator freshness | one ACTIVE row, history preserved, new policy effective immediately |
| G3-10…G3-18 | bounds, ordering (validation → authorization), RBAC/sibling/cross-Client/worker, smuggling | `400` before `403` exactly as documented; smuggled `buildingId`/`status`/`geofenceSignal` ignored |
| G3-concurrency | 5 simultaneous `PUT`s | exactly one ACTIVE, 5 rows retained, 5 CREATED + 4 REPLACED journal entries |
| G3-30…G3-32 | firewall | no verdict, no consume, no enrichment, no provider involvement |
| G4-01…G4-10 | superseded refusal | ordering, no consume, no row, replay, still-ACTIVE behaviour, lead transfer, race determinism, scope-swap attempt |

---

## 4. ANNEX — certification amendment for `CR-HM-07_FINAL_CERTIFICATION` §8 (AC-8)

> **Dated annex. 2026-10-24 (Asia/Jakarta). Baseline `eed1225`.
> Authority: `CR-HM-FIELD-OPERATIONS-01_PART03_SIGNOFF_GATE.md` §8 SG-3/SG-5
> (APPROVED, OPTION A). This annex is additive: the frozen certification text is
> **not** rewritten, reworded or deleted — this section is the record of the
> narrowing, and the appendix in `CR-HM-07_FINAL_CERTIFICATION.md` points here.**

**Frozen statement being narrowed.** `CR-HM-07_FINAL_CERTIFICATION` →
*Frozen invariants verified at certification*, invariant **8 (RESULT)**: every
terminal arrival evaluation yields exactly one of the four result statuses
`VERIFIED` / `FAILED` / `MANUAL_REVIEW_REQUIRED` / `EXPIRED` with the exact 04A
reason pairing.

**Narrowing (one case only).** A **new attempt** — that is, an attempt for which
no immutable result exists yet — whose `challengeToken` resolves to a challenge
bound to an assignment that is **no longer the Execution Scope's ACTIVE
assignment** is now refused **before** any TTL/actor/QR/geofence evaluation:

- HTTP `409`, error code `HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED`;
- the challenge is **not** consumed (stays `PENDING`, `consumed_at` `NULL`);
- **no** result row is written, therefore **no** result status is produced;
- the challenge simply expires at its own server TTL;
- the operational remedy is reassignment plus a freshly issued challenge.

**Precedence (SG-4 Option A).** The superseded refusal outranks expiry: a
challenge that is both superseded and past its TTL is refused as SUPERSEDED and
is **not** projected to `EXPIRED`.

**Explicitly unchanged.** Everything else in invariant 8 and in the certified
contract stands:

1. An **already-recorded** result is still returned unchanged on replay
   (idempotency, invariant 9) — replay is evaluated *before* the new refusal.
2. A **still-ACTIVE** assignment keeps the certified decision path, including
   `FAILED / ACTOR_ASSIGNMENT_INVALID` for an actor who is not the current
   authoritative Lead (evidence: Lead transfer within the same active
   assignment).
3. The four statuses and the reason pairing are unchanged for every evaluation
   that actually runs.
4. Invariant 9 (atomicity: row lock → post-lock replay → consume/expire
   projection → insert, one immutable row) is unchanged.
5. No challenge status was added: the vocabulary stays
   `PENDING` / `CONSUMED` / `EXPIRED`, and the one-live-PENDING and
   one-ACTIVE-per-Building indexes are untouched.
6. Permit, work-start, attendance, billing and every other downstream guard is
   untouched — this annex adds no permission, no route and no migration.

**Deliberate reconciliation of previously-certified tests (not a weakening).**
Two certified assertions encoded the *old* projection for a superseded binding;
they were reconciled to the approved refusal while keeping their original
security intent:

| Test | Before | After | Preserved evidence |
| --- | --- | --- | --- |
| `tests/handyman-arrival-evaluation.test.ts` case 6 | reassignment → `200 FAILED / ACTOR_ASSIGNMENT_INVALID` | Lead **transfer** on a still-ACTIVE assignment → `200 FAILED / ACTOR_ASSIGNMENT_INVALID` (original assertions kept verbatim) | the certified verdict still has a live path |
| `tests/handyman-arrival-evaluation.test.ts` new case 6b | — | reassignment → `409 SUPERSEDED`, challenge `PENDING`, `consumed_at NULL`, no result | the new refusal with zero side effects |
| `tests/handyman-field-ops-ack-part02.test.ts` case 5(a) | stale token → `200` non-`VERIFIED` (`ACTOR_ASSIGNMENT_INVALID`) | stale token → `409 SUPERSEDED`, challenge untouched, no result | SUPERSEDED never reaches `VERIFIED`; cases 5(b)/5(c) unchanged |

No assertion was deleted to obtain a pass, and no test was skipped.

---

## 5. Test evidence

All runs: `NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1`,
real disposable PostgreSQL cluster, migrations applied by `migrateUp`, **zero
skips, zero failures**.

| Suite | pass | fail | skip |
| --- | --- | --- | --- |
| `tests/handyman-arrival-configuration-part04.test.ts` (**new**) | 24 | 0 | 0 |
| `tests/handyman-arrival-locations.test.ts` | 10 | 0 | 0 |
| `tests/handyman-arrival-location-scope-guard.test.ts` | 2 | 0 | 0 |
| `tests/handyman-arrival-scope-guard.test.ts` | 2 | 0 | 0 |
| `tests/handyman-arrival-challenges.test.ts` | 10 | 0 | 0 |
| `tests/handyman-arrival-results.test.ts` | 10 | 0 | 0 |
| `tests/handyman-arrival-evaluation.test.ts` (case 6 reconciled + 6b added) | 11 | 0 | 0 |
| `tests/handyman-arrival-verification-api.test.ts` | 10 | 0 | 0 |
| `tests/handyman-geospatial-policies.test.ts` | 10 | 0 | 0 |
| `tests/handyman-geospatial-policy-scope-guard.test.ts` | 9 | 0 | 0 |
| `tests/handyman-field-ops-ack-part01.test.ts` | 5 | 0 | 0 |
| `tests/handyman-field-ops-ack-part02.test.ts` (case 5(a) reconciled) | 9 | 0 | 0 |
| `tests/handyman-contract-freeze-03-openapi.test.ts` (re-pinned 288→294, 190→196) | 13 | 0 | 0 |
| `tests/handyman-p0-contract.test.ts` (`ASENTRA_USE_EMBEDDED_POSTGRES=true`) | 3 | 0 | 0 |
| `tests/building-configurations.test.ts` + `tests/config-perm-01-permission-registry.test.ts` | 21 | 0 | 0 |
| Combined focused run, 12 suites incl. the new one | 112 | 0 | 0 |

`npx tsc --noEmit`: clean.

Not re-pinned, deliberately: `tests/openapi-operational-final-parity.test.ts` and
`tests/openapi-operational-structural-closure.test.ts` are **baseline-red**
(stale pins `2034` / `1964` / `1963` from INT-LC-19) and were already red before
PART 04; re-pinning them is out of this PART's scope (they are not a Handyman
surface guard).

---

## 6. Blast radius (reviewed)

| Area | Change | Risk assessment |
| --- | --- | --- |
| `handyman-arrival-locations` (service/repo/index) | **additive** list service + optional `expectedBuildingId` on deactivate + idempotent replay | existing callers unaffected (parameter optional); 5 certified suites green |
| `handyman-geospatial-policies` (service/repo/errors/index) | **additive** history read, per-Building `FOR UPDATE` lock, `23505`→`409` mapping | single-ACTIVE invariant unchanged; concurrency case proves ordering |
| `handyman-arrival-results` | one guard inserted between replay and TTL | covered by G4-01…G4-10 + reconciled certified suites |
| `handyman-arrival-challenges` | one error factory + export | no vocabulary/DDL change |
| `src/shared/errors.ts` | 2 codes | additive |
| `src/routes/index.ts` | one router mount | ordering: before the challenge-api router; no path overlap |
| `docs/api/openapi.yaml` | 6 operations, 5+ schemas, 1 parameter, 1 G-4 description/error | census proves 0 phantom / 0 undocumented |
| Migrations / seeds / auth / notifications | **none** | `git diff eed1225` empty for those paths |

---

## 7. Remaining gaps (reported, not silently closed)

1. **No UI** — operator consoles for QR registration and geofence configuration
   are out of scope for PART 04 (backend authority only).
2. **No migration** — `0398`/`0399` were already sufficient; nothing was added
   "just in case".
3. **Baseline-red census pins** (`openapi-operational-*`) were re-derived at
   FINAL REVIEW from a measurement on `main` plus the approved deltas (they are
   now green); the pre-existing non-Handyman debts that remain are recorded
   separately in the FINAL REVIEW (§4.3), not repaired inside this PART.
4. **Single-Building configuration scale** — history reads are unbounded per
   Building (a Building's policy history is small by construction); pagination
   was deliberately not invented.
5. **Deactivation idempotency is projection-only** — a repeated deactivate
   returns the `INACTIVE` projection without a second journal entry (chosen so a
   retry cannot fabricate a second audit fact).
6. **No PR, no deployment, no next PART** — as mandated; FINAL REVIEW is the
   next external step.
