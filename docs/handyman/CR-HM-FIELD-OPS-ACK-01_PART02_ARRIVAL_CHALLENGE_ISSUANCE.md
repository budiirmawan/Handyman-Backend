# CR-HM-FIELD-OPS-ACK-01 — PART 02: Arrival Challenge Issuance & Field-Authority Verification

- **Contract:** HANDYMAN FIELD OPERATIONS CONTRACT — PART 02 (continuation)
- **Repository:** `budiirmawan/Handyman-Backend` (only repository touched)
- **Branch:** `arena/a61abf59-handyman-backend` (PART 01 branch, continued — **not** restarted)
- **Baseline for this PART:** `186628c` — `feat(handyman): PART 01 assignment acknowledgment guards (CR-HM-FIELD-OPS-ACK-01)`
- **Parent of PART 01:** `ee20d21` — `Merge pull request #58` (Notification Engine **preserved**)
- **No Biznet / production deployment. No PR opened (reserved for FINAL REVIEW). No full test suite run.**

---

## 0. State recovery (this chat is a continuation, not a new implementation)

The previous Arena chat crashed. Recovery was performed before any code was written:

| Check | Result |
| --- | --- |
| Local clone | **Shallow, single-commit clone of `main`** (`ee20d21`). PART 01 was **not** present locally, and `186628c` did not resolve. |
| Remote branch `arena/a61abf59-handyman-backend` | **Exists**, tip `186628c1450a404d8039c7541f3f6c3164b1c130`. |
| PART 01 content | **Recovered intact** via `git fetch` + `git merge --ff-only 186628c` (fast-forward over `main`; no force, no reset, no rewrite). 23 files / +1506 −11, including migration **0476** and the PR #58 Notification Engine untouched. |
| Uncommitted PART 02 work from the crashed chat | **Unavailable.** No stash, no reflog entry (reflog held only the clone + branch checkout), no dangling objects (`git fsck --lost-found` → empty). |
| Other remote branches | All **91** remote refs fetched shallowly and their trees inspected: the only `CR-HM-FIELD-OPS-ACK-01` artefact anywhere is PART 01 (`docs/handyman/CR-HM-FIELD-OPS-ACK-01_PART01_ASSIGNMENT_ACKNOWLEDGMENT.md`) on this branch. **No prior PART 02 work was lost or duplicated.** |

Nothing was reset or overwritten: PART 02 starts from the confirmed PART 01 commit.

---

## 1. Audit first — what already existed

Every CR-HM-07 authority and every CR-HM-FIELD-AUTHORITY-01 read surface was read before a line was changed.

| Capability | Pre-existing authority found | Verdict before PART 02 |
| --- | --- | --- |
| Arrival challenge **issuer** | `createHandymanArrivalChallenge` (migration `0397`, `handyman-arrival-challenges`): AUTHORIZED-scope gate → BE-02G exact-Building access → CR-HM-04 authoritative CURRENT Crew Lead → declined (`TIDAK_BISA`) refusal → live-PENDING conflict → server TTL (`NOW() + 120s`) → SHA-256 hash at rest | **LOGIC EXISTS, UNREACHABLE.** `grep` over `src/routes/**` and every `*.routes.ts` found **no** route; the function had **zero** production callers. Its own header says “No HTTP/OpenAPI (PART 02+)”, and PART 04C shipped only the *terminal* command. |
| Arrival challenge **consume** primitive | `consumeHandymanArrivalChallenge`: locked row → DB-clock expiry projection → constant-time hash compare → `PENDING → CONSUMED` | **EXISTS**, internal only (tests). Not deleted, not re-exposed. |
| Challenge **revocation** on reassignment | none (no `REVOKED` status; `0397` allows only `PENDING → CONSUMED/EXPIRED`) | **CERTIFIED FAIL-CLOSED DESIGN, NOT A DEFECT** — see D-2. Proven again by new tests. |
| Challenge **expiry** | `expires_at NOW()+120s`, stale-PENDING projection on create, overdue projection on consume, `EXPIRED/CHALLENGE_EXPIRED` terminal result | **EXISTS.** Verified. |
| **QR** signal | `resolveHandymanArrivalQrSignal` → `MATCH/MISMATCH/UNKNOWN/INACTIVE` against the immutable scope snapshot’s most-specific level; foreign-Client codes collapse to `UNKNOWN` | **EXISTS.** Registry write (`create…Identifier` / `deactivate…`) is **internal only** — deliberately deferred by frozen governance (§4 gap G-4). |
| **GPS / geofence** | per-Building policy (`0399`), server-side haversine, exactly `INSIDE/OUTSIDE/LOW_ACCURACY/UNAVAILABLE` | **EXISTS**, verified by execution (its suite previously **skipped itself** — see §3). |
| **Terminal verification** | `POST /handyman/execution-scopes/:id/arrival-verification` (PART 04C, atomic consume+insert, replay-identical) | **EXISTS**, untouched. |
| Reassignment | `reassignHandymanExecutionScopeCrew` (`expectedVersion` + `reason` + `idempotencyKey`); only writer of assignments; ACTIVE-scope + BE-02G guards | **EXISTS.** Re-verified against the arrival path. |
| Permit / access guards | BE-02G `assertBuildingScopedResourceAccess` used by every arrival path; CR-HM-05 readiness + `mobile-permit-work` field authority separate and unchanged | **EXISTS.** Zero permit coupling added (firewall preserved). |
| CR-HM-FIELD-AUTHORITY-01 reads (P0-A…P1) | `GET /handyman/field/execution-scopes/:id`, `…/requests/:id`, `…/materials`, `…/quotation-snapshot`, worker profile | **ROUTES EXIST, THEIR SUITES WERE BROKEN** — see §3. |

### The one blocking gap (G-1) — proven, then closed

The My Jobs feed advertises `CREATE_ARRIVAL_CHALLENGE`
(`computeHandymanFieldJobAvailableActions`), and the terminal command *requires*
a `challengeToken`. With no issuance route:

- a mobile client could **never** obtain a token → terminal verification was
  unreachable;
- the CR-HM-08 `CHECK_IN` gate requires an immutable **VERIFIED** arrival result
  for the same scope → check-in was unreachable;
- the mobile handoff told the app “never cache a challenge token” without ever
  saying where one comes from.

That is a blocked end-to-end journey, not a missing nicety. It is the only
capability added by this PART.

---

## 2. Implementation (additive, thin, no duplicated authority)

| File | Change |
| --- | --- |
| `src/modules/handyman-arrival-challenge-api/handyman-arrival-challenge-api.controller.ts` (new) | Thin shell: `req.auth` actor → bounded UUID scope param → **existing** `createHandymanArrivalChallenge` → bounded DTO → `201`. ZERO decision logic (no scope/Lead/decline/TTL/conflict reasoning). The request body is **never read**, so authority-shaped keys are structurally ignored. |
| `…/handyman-arrival-challenge-api.types.ts` (new) | `ArrivalChallengeIssuedResponse` = `{id, executionScopeId, status, expiresAt, challengeToken}`. `clientId` / `assignmentId` / `actorUserId` / `tokenHash` are **not** projected. |
| `…/handyman-arrival-challenge-api.routes.ts` (new) | `POST /handyman/execution-scopes/:executionScopeId/arrival-challenge`, authentication only (no invented permission vocabulary — authority stays server-side). |
| `…/index.ts` (new) | Module barrel. |
| `src/routes/index.ts` | Mounts the router next to the PART 04C verification router. |
| `docs/api/openapi.yaml` | New operation `createHandymanArrivalChallenge` (`201`, `403/404/409`, `x-error-codes` from the real PART 01 vocabulary) + schema `HandymanArrivalChallengeIssued`; terminal-command description and `challengeToken` now point at the issuer. |
| `docs/api/CR-HM-18_MOBILE_HANDOFF.md` | Two-step contract. Also corrected the documented result vocabulary (`PASS` → the real `VERIFIED … EXPIRED` set) — a documentation defect, not a behaviour change. |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | Surface pin `287 → 288` with the documented delta (the assertion that actually guards the contract is the runtime↔OpenAPI parity, which still holds exactly). |

**Why a separate module instead of adding to `handyman-arrival-verification-api`:**
the CR-HM-07 PART 04C certification asserts that module imports **no**
challenge/geofence/QR authority (its “thin shell, zero duplicated decision
logic” invariant). Adding the issuer there would have broken that frozen
certification assertion. Issuance and terminal verification are therefore two
distinct shells over two distinct authorities — **no duplicate arrival module,
no duplicate authority, no second decision engine.**

### Decisions

- **D-1 — Reuse, never rebuild.** The new route delegates to the PART 01 issuer
  verbatim. No scope/Lead/decline/TTL/conflict check was re-implemented, so the
  two surfaces cannot drift.
- **D-2 — Reassignment “revocation” is the certified fail-closed behaviour.**
  `0397` permits only `PENDING → CONSUMED/EXPIRED`; the frozen result
  vocabulary is `VERIFIED/FAILED/MANUAL_REVIEW_REQUIRED/EXPIRED`. A superseded
  Lead’s live challenge therefore evaluates to `FAILED / ACTOR_ASSIGNMENT_INVALID`
  (certified by CR-HM-07 FINAL CERTIFICATION §8 and re-proven here). Adding a
  `REVOKED` status or a `409` at evaluation time would have rewritten a frozen,
  certified contract to no security benefit. TTL `120s` bounds the stale row,
  the terminal verdict is never `VERIFIED`, and the old Lead can no longer
  issue (`403`).
- **D-3 — One live PENDING is per (scope, ACTOR).** A stale row for a
  superseded Lead never blocks the replacement Lead — proven in test 5.
- **D-4 — The raw token crosses exactly one boundary.** Hash at rest
  (`token_hash`), no journaling of token material, no token in the response
  beyond the single issuing call.
- **D-5 — Additive only.** No schema change (no migration in this PART;
  `0476` from PART 01 preserved), no changed route, no changed status code on an
  existing operation, no Notification Engine edit.

---

## 3. Verification evidence (focused; **0 skipped**)

```text
npx tsc --noEmit                                                        → PASS (0 errors)

NEW  tests/handyman-field-ops-ack-part02.test.ts                        →   9 / 9   PASS
     tests/handyman-arrival-challenges.test.ts                          →  10 / 10  PASS
     tests/handyman-arrival-locations.test.ts                           →         PASS
     tests/handyman-arrival-scope-guard.test.ts                         →         PASS
     tests/handyman-arrival-location-scope-guard.test.ts                →         PASS
     tests/handyman-arrival-results.test.ts                             →         PASS
     tests/handyman-arrival-evaluation.test.ts                          →         PASS
     tests/handyman-arrival-verification-api.test.ts                    →  10 / 10  PASS
     tests/handyman-geospatial-policies.test.ts                         →  10 / 10  PASS  (was SKIPPED ×10)
     tests/handyman-geospatial-policy-scope-guard.test.ts               →   9 / 9   PASS  (was SKIPPED ×9)
     tests/handyman-field-read-authority.test.ts                        →   3 / 3   PASS  (was 0/3 · 3 FAIL)
     tests/handyman-field-feed-authority.test.ts                        →  22 / 22  PASS
     tests/handyman-scope-variations.test.ts                            →   3 / 3   PASS  (was 0/3)
     tests/handyman-material-purchasing.test.ts                         →   2 / 2   PASS  (was 0/2)
     tests/handyman-field-evidence.test.ts                              →   4 / 4   PASS  (was 0/4)
     tests/handyman-worker-profile.test.ts                              →         PASS

PART 01 / PR #58 regression (untouched by this PART):
     tests/handyman-field-ops-ack-part01.test.ts                        →   5 / 5   PASS
     tests/handyman-field-feed-contract.test.ts                          →   4 / 4   PASS
     tests/handyman-assignment-response-part02a|b|c                      →   8/8 · 5/5 · 6/6  PASS
     tests/handyman-notification-producer-part01.test.ts                 →   3 / 3   PASS
     tests/handyman-multiclient-notification-certification.test.ts       →   7 / 7   PASS

Contract:
     tests/handyman-contract-freeze-03-openapi.test.ts                  → 288/288 runtime↔OpenAPI parity PASS
     tests/openapi-contract.test.ts + mobile-openapi-completeness       →         PASS
```

### Suites repaired (assertions **strengthened**, never weakened)

These suites were failing or **silently skipping** on the baseline, so their
assertions proved nothing. Each was repaired to run for real:

| Suite | Baseline | Cause | Repair |
| --- | --- | --- | --- |
| `handyman-field-read-authority.test.ts` (P0-A) | 0/3, three `500`s | TEMP fixture lacked `handyman_execution_scope_assignments.version`, `handyman_inspector_assignments`, `handyman_assignment_responses`, `handyman_work_sessions`, `handyman_dispatch_releases`, `handyman_provider_contexts.provider_type` | Fixture completed; one ACTIVE inspector assignment seeded for the CONFIRMED visit only (the PROPOSED case still fails closed). No assertion changed. |
| `handyman-geospatial-policies.test.ts` (03B) | **10 SKIPPED** (self-skip, no external PG) | suite depended on an external PostgreSQL | Owns a disposable embedded cluster; also fixed its local fixture authoring quotation APPROVE as the platform admin instead of the Tenant PIC (CR-HM-W03 PART 03E), and delegated its drifted crew fixture to the shared one. |
| `handyman-geospatial-policy-scope-guard.test.ts` (SEC-02) | **9 SKIPPED** | same | same embedded-cluster treatment. |
| `handyman-scope-variations.test.ts` (P0-B) | 0/3, `column "provider_type" does not exist` | stale TEMP fixture | added `provider_type` (production column). |
| `handyman-material-purchasing.test.ts` (P0-C) | 0/2, same | stale TEMP fixture | same. |
| `handyman-field-evidence.test.ts` (P0-D) | 0/4, `provider_type` then `receipt_sha256_checksum` | stale TEMP fixture | added `provider_type` and the `receipt_sha256_checksum` column that migration `0470` adds to `handyman_material_purchase_records`. |

### Honest non-pass (reported, **not** hidden or relabelled)

- `tests/openapi-operational-final-parity.test.ts` and
  `tests/openapi-operational-structural-closure.test.ts` are **baseline-red**
  (pre-existing drift, reproduced before this PART): they pin
  `TOTAL_RUNTIME = 2034` / `IN_SCOPE = 1964` / `OPENAPI_OPERATIONAL = 1963`,
  while the tree actually reports **2038 / 1968 / 1967 / 2036**. This PART moves
  both the runtime and the OpenAPI side by exactly `+1`, so their **parity**
  relationship is unchanged; the stale constants were deliberately **not**
  re-pinned, because doing so would disguise pre-existing drift as a fix.
- `tests/work-permit-readiness.test.ts` self-skips (20 cases) without an
  external PostgreSQL. It is CR-HM-05 readiness authority, untouched by this
  PART, and was **not** part of the arrival/field-read scope.
- `tests/mobile-assignment-contract.test.ts` (13 failures) remains the
  pre-existing BE-25C bootstrap debt recorded in PART 01; not re-run here.

---

## 4. Remaining gaps (identified, deliberately **not** implemented)

| ID | Gap | Why it stays open |
| --- | --- | --- |
| **G-2** | Arrival **QR identifier** registration/deactivation has no HTTP surface (`createHandymanArrivalLocationIdentifier`, `deactivate…`) | Frozen governance `CR-HM-07_GEOSPATIAL_AUTHORITY_DECISION.md` §“Exact HTTP/admin UI exposure is **DEFERRED** — no API”. Until it ships, no identifier exists → QR signal is always `UNKNOWN` → `MANUAL_REVIEW_REQUIRED`, never `VERIFIED`. |
| **G-3** | Per-Building **geofence policy** configuration has no HTTP surface (`saveHandymanBuildingGeospatialPolicy`) | Same frozen deferral. Without it the result is `NO_GEOSPATIAL_POLICY`. |
| **G-4** | `consumeHandymanArrivalChallenge` (internal primitive) would still consume a challenge bound to a superseded assignment | Not reachable in production (the terminal evaluator is the only consumer, and it fails closed first). Changing it would alter a certified primitive; documented rather than changed. |
| **G-5** | Operational OpenAPI census pins are stale (`2034` vs `2038`) | Pre-existing main-branch drift, outside this PART’s authority. |

**G-2 + G-3 are the only things standing between the current contract and a
reachable `VERIFIED` arrival in production.** They are configuration surfaces
for the Building/Operations persona (not the worker command this PART owns) and
are blocked by an explicit frozen decision, so they remain **PART 03**
candidates pending an unfreeze.

---

## 5. Explicit non-goals of PART 02

- ❌ No restart of PART 01; no duplicate arrival / field-authority module; no
  second decision engine.
- ❌ No migration in this PART (no schema change; PART 01 `0476` intact).
- ❌ No change to the PR #58 Notification Engine, the 12 assignment events, the
  18 producer call sites or the push transports (their suites re-run green).
- ❌ No reopening of CR-HM-07 PART 01–04C logic (issuer, evaluator, QR resolver,
  geofence evaluator, terminal route, migrations `0397`–`0400`).
- ❌ No full test suite; no Biznet / production deployment; no PR.
- ❌ No permit/work-order/BAST/payment/attendance coupling — the CR-HM-07
  firewall (`ARRIVAL VERIFIED ≠ CHECK-IN ≠ WORK ≠ BILLABLE`) is untouched.
