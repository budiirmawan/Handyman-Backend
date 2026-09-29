# CR-HM-07 — Arrival Verification — FINAL CERTIFICATION

Date: 2026-09-29 (Asia/Jakarta)
Branch: `arena/01a0e01e-handyman-backend`
Base commit: `2329ed1` (CR-HM-07 PART 04C)

## Certification record

```text
CR_HM_07_STATUS=COMPLETE
CR_HM_07_BLOCKERS=0
CR_HM_07_IMPLEMENTATION_DEFECTS=0
CR_HM_08_PREREQUISITE=ARRIVAL_VERIFIED
ARRIVAL_VERIFIED_EQUALS_WORK_STARTED=NO
API_CO_ID_GEOMETRY_AUTHORITY=NO
FM_COUPLING=NO
```

## Delivered parts

| Part | Commit | Deliverable |
| --- | --- | --- |
| Governance | `6fd9e09`, `3138316` | start governance + location-signal governance freeze |
| PART 01 | `e5244c8` | arrival challenge foundation (migration 0397) |
| PART 02 | `323692a` | expected location + QR signal (migration 0398) |
| PART 03A/03A1 | governance docs | geospatial authority decision + location-signal governance |
| PART 03B | `dc99132` | building geofence policy + signal (migration 0399) |
| PART 03C | `9bd2699` | API.CO.ID location adapter (location-enrichment) |
| PART 04 | governance doc | arrival result governance |
| PART 04A | `01e9498` | arrival result persistence (migration 0400) |
| PART 04B | `b0a56ef` | atomic terminal arrival evaluator |
| PART 04C | `2329ed1` | arrival verification HTTP/OpenAPI exposure |

## Delivered migrations

```text
0397 — create_handyman_arrival_challenges
0398 — create_handyman_arrival_location_identifiers
0399 — create_handyman_building_geospatial_policies
0400 — create_handyman_arrival_verification_results
```

## Final API

```text
POST /handyman/execution-scopes/:executionScopeId/arrival-verification
```

Thin exposure only: auth/context → bounded whitelist validation
(`challengeToken`, `qrOpaqueCode`, nullable `deviceLocation`) →
`evaluateHandymanArrivalVerification` → bounded error mapping →
bounded serialization (id, executionScopeId, challengeId, status,
primaryReason, qrSignal, geofenceSignal, distanceMeters, evaluatedAt).
No decision logic, no authority-shaped body fields, no token/hash/API
key/raw provider payload in the response.

## Frozen invariants verified at certification

1. **TARGET** — `HANDYMAN_EXECUTION_SCOPE` only (AUTHORIZED gate).
2. **ACTOR** — current authoritative assigned Crew Lead only
   (`resolveHandymanAssignmentLead`; mismatch → FAILED /
   ACTOR_ASSIGNMENT_INVALID).
3. **CHALLENGE** — server-issued, scope+actor+token-hash bound,
   hashed at rest (`token_hash`, raw token never persisted),
   short-lived server TTL projection, one-time
   (`one_pending` partial unique index + single consume).
4. **EXPECTED LOCATION** — Execution Scope snapshot only
   (`resolveHandymanExpectedArrivalLocation`).
5. **QR** — location signal only (Part 02 resolver); `MATCH` required
   for `VERIFIED`.
6. **GEOFENCE** — Handyman per-building policy authority
   (migration 0399), server-side calculation only; exactly
   `INSIDE` / `OUTSIDE` / `LOW_ACCURACY` / `UNAVAILABLE`.
7. **API.CO.ID** — Reverse Geocoding = OPTIONAL_CORROBORATION;
   Regional Indonesia = REFERENCE_NORMALIZATION; never geometry or
   verdict authority (evaluator writes enrichment fields NULL;
   zero evaluator/HTTP coupling).
8. **RESULT** — exact statuses `VERIFIED`, `FAILED`,
   `MANUAL_REVIEW_REQUIRED`, `EXPIRED` with the exact 04A reason
   pairing (`ALL_POSITIVE_EVIDENCE`; `QR_MISMATCH`,
   `GEOFENCE_OUTSIDE`, `ACTOR_ASSIGNMENT_INVALID`; `QR_UNKNOWN`,
   `QR_INACTIVE`, `NO_GEOSPATIAL_POLICY`, `LOW_ACCURACY`,
   `GEOFENCE_UNAVAILABLE`; `CHALLENGE_EXPIRED`).
9. **ATOMICITY** — terminal challenge transition + immutable result
   insert in one transaction (row lock → post-lock replay →
   consume/expire projection → insert); replay returns the same
   result, never a second row.
10. **API** — POST arrival-verification is thin exposure only; no
    duplicated decision logic in route/controller.
11. **FIREWALL** — `ARRIVAL VERIFIED != CHECK-IN`,
    `ARRIVAL VERIFIED != START WORK`,
    `ARRIVAL VERIFIED != ATTENDANCE`,
    `ARRIVAL VERIFIED != BILLABLE TIME`; zero
    payment/BAST/FM/`work_order` effects (comment-stripped source
    scan across all six CR-HM-07 modules: zero hits).

## Focused certification suites — 70/70 PASS

| Suite | Part |
| --- | --- |
| `tests/handyman-arrival-challenges.test.ts` | 01 |
| `tests/handyman-arrival-locations.test.ts` | 02 |
| `tests/handyman-geospatial-policies.test.ts` | 03B |
| `tests/location-enrichment.test.ts` | 03C |
| `tests/handyman-arrival-results.test.ts` | 04A |
| `tests/handyman-arrival-evaluation.test.ts` | 04B |
| `tests/handyman-arrival-verification-api.test.ts` | 04C |

7 suites, 70 tests, 0 failures (real migrated PostgreSQL 18.4,
`node --test` concurrency 1).
